# Maintainer Model Migration Plan

> **Status:** Waves 1 and 2 implemented. Wave 3 is next.
>
> **Approach:** Land the maintainer-model change in deployable waves. Each
> wave must leave gitworkshop with one internally consistent authority model;
> mixed old/new authorization is not an acceptable intermediate state.

## Authority and alignment

The sources of truth, in precedence order, are:

1. [`ngit` maintainer model](../../ngit/docs/architecture/maintainer-model.md)
   — desired final behavior and client safety posture.
2. [NIP-34](../../nips/34.md) — concise wire-format specification.
3. The current `ngit` implementation and fixtures — the closest executable
   reference, but not authoritative where the desired model explicitly says
   that work remains.
4. [`ngit` follow-up actions](../../ngit/docs/architecture/maintainer-model-follow-up-actions.md)
   — known gaps between the desired model and the current implementation.

This plan was prepared after reviewing both documents and the relevant `ngit`
implementation. The implementation areas used for alignment were:

- [`src/lib/repo_ref.rs`](../../ngit/src/lib/repo_ref.rs): indexed-role
  parsing, numeric/deferred history, self-role departure precedence,
  reciprocal fixpoint confirmation, moderator confirmation, authority seeding,
  and the seven-result lead resolver.
- [`src/lib/client.rs`](../../ngit/src/lib/client.rs): announcement discovery,
  latest-event reduction, confirmed-member-only repository data, coordinate
  construction, and confirmed-maintainer filtering of kind `30618` state.
- [`src/bin/ngit/sub_commands/repo/preflight.rs`](../../ngit/src/bin/ngit/sub_commands/repo/preflight.rs):
  mutation simulation and state-collision preflight.
- [`src/bin/ngit/sub_commands/repo/edit.rs`](../../ngit/src/bin/ngit/sub_commands/repo/edit.rs),
  [`accept.rs`](../../ngit/src/bin/ngit/sub_commands/repo/accept.rs),
  [`leave.rs`](../../ngit/src/bin/ngit/sub_commands/repo/leave.rs), and
  [`follow_lead.rs`](../../ngit/src/bin/ngit/sub_commands/repo/follow_lead.rs):
  the currently supported normal mutations and fail-closed transition rules.

The alignment target is semantic parity, not a line-for-line TypeScript port.
When `ngit` source and the desired model differ, record the discrepancy and
follow the desired model unless the model or NIP is changed first.

## Current gitworkshop gaps

The current implementation predates the new authority model:

- `getRepoMaintainers()` reads only the deprecated `maintainers` tag.
- `resolveChain()` follows every directional listing and places all reachable
  pubkeys in `maintainerSet`.
- `maintainerSet` is then used for kind `30618` state, collaboration-event
  authority, releases, CI, relay discovery, and some mutation controls. An
  unaccepted invitation can therefore affect trusted state.
- `confirmedMaintainers` is primarily a display and publishing-control subset,
  rather than the sole maintainer-authority boundary.
- `computeMaintainerLeadership()` infers a lead from confirmed in-degree
  instead of resolving signed `M` pointers from the selected coordinate.
- Repository grouping repeatedly resolves directional closures and then tries
  to deduplicate them. Invitations and same-identifier repositories require
  special presentation logic as a result.
- Repository settings rewrite a complete legacy roster. Metadata edits can
  unintentionally change membership representation.
- Browser acceptance publishes a legacy reciprocal announcement and performs
  only a narrow state check. It does not implement the complete component,
  identity, history, and state preflight required by the final model.
- [`docs/matainership.md`](matainership.md), repository instructions, and parts
  of [`NIP.md`](../NIP.md) describe the outgoing directional-authority model.

## Non-negotiable migration rules

1. Reciprocity changes real authority, not merely labels or display.
2. Announcement discovery and event authority are separate concepts.
3. Invited, unacknowledged, departed, and malformed-role authors remain
   discovery inputs only; their events do not alter trusted repository data.
4. Indexed `M`, `m`, and `o` roles win whenever any indexed role is present.
   A contradictory `maintainers` compatibility tag never broadens authority.
5. Metadata-only edits preserve membership, role history, unknown tags, and
   compatibility tags without silently migrating them.
6. Every membership write is expressed as one named relationship intent. The
   browser must not replace a complete roster.
7. Unsupported or incompletely observed mutations fail before signing,
   publishing, changing refs, or navigating to another selected coordinate.
8. `--force` semantics are not approximated in the browser. They are added
   only with the complete state-only preflight and verification workflow.
9. The pure resolver is the sole source of authority decisions. Components
   and hooks consume typed results rather than recreating graph checks.
10. Every phase updates the relevant developer documentation so later work
    does not reintroduce the retired model.

## Wave overview

| Wave | Outcome                                                     | Release gate                                                                    |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | Reciprocal membership becomes the sole authority boundary   | No unaccepted invitee affects trusted state anywhere                            |
| 2    | Signed lead resolution and browser redirects                | Redirects follow a complete `M` path or a unique legacy vote winner             |
| 3    | One announcement belongs to one active repository component | Search shows one result per repository without invitations merging repositories |
| 4    | Exits, history, and conservative normal mutations           | Every unsupported topology change publishes nothing                             |
| 5    | Exceptional workflows replace individual refusal cases      | Each edge-case workflow is independently reviewable and verified                |

## Wave 1 — Reciprocal authority

This wave contains the security boundary and must not expose a partially
converted authority model.

### 1A. Install write safety rails

Before changing reads:

- Disable the current complete-roster membership editor.
- Disable browser invitation acceptance until it publishes the new role shape
  and passes the supported-case preflight.
- Quarantine persisted `gitworkshop:maintainer-acceptance:v2` jobs so a legacy
  signed acceptance cannot be delivered after the upgrade.
- Keep metadata-only settings available only when the existing membership and
  role tags are preserved byte-for-byte.
- Do not add a self `maintainers` tag to a role-free sole-maintainer event.
- Do not migrate a legacy membership representation during an unrelated edit.

This safety change may be deployed before the authority switch. The old read
model remains internally consistent while unsafe writers are unavailable.

### 1B. Add the pure role and graph resolver

Create a focused pure module beside `src/lib/nip34.ts`. It must:

- Select the latest kind `30617` announcement per author using greatest
  `created_at`, then lowest event ID at equal timestamps.
- Parse at most one effective record per role letter and subject while
  retaining conflicts for health reporting.
- Accept numeric alternating start/end boundaries.
- Accept `defer` only as the final value in an end position.
- Treat a role as active when it has no boundaries or its final numeric
  boundary is a start.
- Treat a record ending in `defer` as inactive for authorization and routing.
- Treat malformed role history as unable to grant authority.
- Ignore the deprecated `maintainers` tag whenever an announcement contains
  any `M`, `m`, or `o` tag.
- Use the deprecated tag as the legacy co-maintainer assignment only on
  role-free announcements.
- Treat an author absent from every role tag as an implicit maintainer.
- Treat an author with self-role records but no active self-`M` or self-`m` as
  having declined or left maintainership.
- Discover active maintainer and moderator subjects without granting them
  authority merely because their announcement was fetched.
- Root explicit-lead authority at the terminal confirmed self-`M`; a selected
  coordinate alone must not seed an incomplete, cyclic, or conflicting `M`
  path.
- Resolve legacy and explicitly leadless repositories through the reciprocal
  active-assignment fixpoint rooted at the selected maintainer.
- Confirm a lead-shaped co-maintainer only when a confirmed maintainer assigns
  them and their latest announcement contains an active self-`m` plus an active
  `M` path to the same lead.
- Confirm moderators only through assignment by a confirmed maintainer and a
  matching self-`o` acknowledgement naming an existing confirmed member.
- Keep invited maintainers and moderators separate from confirmed members.

The first wave needs current-role parsing, including ended and deferred
records, so current authority is correct. Full historical precedence and
authorization-at-event-time land in Wave 4.

### 1C. Replace ambiguous resolved-repository fields

Do not silently redefine `maintainerSet`. Remove or replace ambiguous fields
so TypeScript forces every consumer to choose the correct trust boundary.
The resolver should expose explicit equivalents of:

- `confirmedMaintainers`
- `confirmedModerators`
- `confirmedMembers`
- `invitedMaintainers`
- `invitedModerators`
- discovery-only announcement pubkeys and events
- confirmed-maintainer coordinates
- confirmed-member coordinates
- assignment edges and their indexed/legacy provenance
- repository-health warnings

`allCoordinates` should be replaced by a name that states whether it contains
maintainers or all confirmed members. Invitation coordinates must not be mixed
into collaboration tags or trusted repository queries.

### 1D. Audit every authority consumer

| Data or operation                                      | Authority after Wave 1                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Kind `30618` repository state                          | Current confirmed maintainers only                                                        |
| Merge creation and push controls                       | Current confirmed maintainers only                                                        |
| Repository settings and state publication              | Current confirmed maintainers only                                                        |
| CI service controls, manual triggers, and secrets      | Current confirmed maintainers only                                                        |
| Status, labels, subject changes, and cover notes       | Root-item author plus confirmed members; Wave 4 adds historical-at-publication evaluation |
| Shared metadata, infrastructure, and privacy           | Confirmed member announcements only                                                       |
| Repository coordinates on new collaboration events     | Confirmed member coordinates only                                                         |
| Issues, PRs, comments, reactions, and public discovery | Remain open where the protocol intentionally allows arbitrary authors                     |

At minimum, audit `RepositoryModel`, `RepositoryRelayGroup`,
`useResolvedRepository`, `useRepositoryState`, `repoStateLoader`, issue and PR
models, merge controls, releases, CI, notification hydration, repository
settings, and every use of `maintainerSet` or `allCoordinates`.

### Wave 1 gate

- [x] A unilateral legacy listing is an invitation and grants no authority.
- [x] A unilateral indexed assignment is an invitation and grants no
      authority.
- [x] A cycle of unconfirmed invitees cannot bootstrap authority.
- [x] An accepted reciprocal chain resolves to the same current maintainer set
      as `ngit`.
- [x] An ended self-role defeats active assignments in other announcements.
- [x] A `defer` record grants no authority.
- [x] A moderator can perform member actions but cannot publish state or merge.
- [x] Invited, departed, and unconfirmed moderator announcements contribute no
      trusted metadata, infrastructure, or privacy.
- [x] No old acceptance job or complete-roster editor can publish the retired
      shape.

## Wave 2 — Lead resolution and redirects

### 2A. Implement the complete lead result

Replace `computeMaintainerLeadership()` with lead resolution rooted at the
selected coordinate. Expose:

- `implicit_sole`
- `explicit`
- `legacy_inferred`
- `explicit_none`
- `none`
- `pending`
- `conflict`

Also expose the ordered `leadPath` and the terminal or failed target. Different
active targets outside the selected pointer path are not a global conflict.

Legacy vote inference remains only while the selected announcement is legacy.
Selected indexed `m` without `M` is an explicit leadless boundary.

### 2B. Canonical browser routing

- Automatically redirect a repository route when either:
  - an explicit signed `M` path is complete, acyclic, and terminates at a
    confirmed self-`M` lead; or
  - the selected announcement remains legacy and the legacy voting model
    resolves one unique confirmed lead.
- Preserve the repository subpath, query string, and hash.
- Use replacement navigation so the old coordinate does not create a back-loop.
- Refresh every announcement in the current author/relay closure before
  redirecting. Any newly discovered author or relay invalidates the prior
  settled result and must settle again.
- Never redirect through `defer`, a missing announcement, multiple active `M`
  entries, a cycle, a departed target, or an incomplete prepared handover.
- Redirect legacy repository routes to their unique inferred lead as well as
  using that lead for preferred discovery links. A tied or absent legacy vote
  remains on the selected coordinate.
- Show selected maintainer and resolved lead separately in repository details.
- Keep lead authority equal to co-maintainer authority; lead affects
  coordination and routing only.

### Wave 2 gate

- [x] `Alice -> Bob -> Bob` routes to Bob and preserves the complete URL
      suffix.
- [x] `defer`, missing, conflicting, and cyclic paths never redirect.
- [x] An explicit leadless repository remains on the selected coordinate.
- [x] A unique legacy-inferred lead rewrites explicit routes, while tied or
      absent legacy votes remain on the selected coordinate.
- [x] No route redirect changes an announcement or publishes an event.

## Wave 3 — Repository components and search

Replace repeated directional resolution with a repository-component index for
each identifier:

1. Reduce to the latest announcement for every author.
2. Parse active assignments, acknowledgements, self-role exits, and lead paths.
3. Partition announcements into reciprocal confirmed components.
4. Assign an author's active announcement to at most one active component.
5. Keep invitation edges as relationships between components; they do not
   merge components.
6. Anchor explicit-lead components at the terminal lead coordinate.
7. Give leadless and legacy components a deterministic identity derived from
   their confirmed membership rather than event discovery order.

Search and discovery then follow these rules:

- Show one card per active component.
- A search hit for any confirmed member returns that component.
- A same-identifier invitation does not absorb the invitee's existing
  repository into the inviter's search result.
- A pubkey's one active announcement cannot be presented as membership in two
  active repositories.
- Metadata, clone URLs, relays, Blossom servers, and privacy come only from the
  confirmed component.
- Invitations remain visible as invitations or repository-join requests, not
  as accepted members or duplicate repository cards.
- Hold a result in a resolving state when necessary instead of briefly showing
  duplicate cards before graph hydration completes.
- `RepositoryModel`, `RepositoryListModel`, search, user repositories, pinned
  repositories, and NIP-19 repository redirects consume the same component
  index.

Update `docs/matainership.md`, `AGENTS.md`, and relevant `NIP.md` authorization
language in this wave. The documentation must name the new typed authority
fields and stop recommending the removed directional set.

### Wave 3 gate

- [x] Every confirmed component appears once in global browse results.
- [x] Searching for any confirmed member returns the same repository card.
- [x] Two unrelated same-identifier components remain separate.
- [x] An invitation between those components does not merge their cards.
- [x] Accepting the invitation moves the announcement into exactly one joined
      component after the new event is observed.
- [x] Grouping is deterministic regardless of relay/event arrival order.

## Wave 4 — Exits, history, and conservative mutations

### 4A. Resolve replicated history

Resolve conflicting historical records using:

1. The selected maintainer's present record, when it exists.
2. Otherwise, the record at shortest confirmed-graph distance.
3. Lowest author pubkey for equal-distance ties.
4. Preserve all disagreements for health and audit display.

Keep current authority and historical authorization separate:

- Kind `30618`, merge, settings, and present-tense controls use the current
  confirmed maintainer graph.
- Status, label, subject, cover-note, and other role-scoped collaboration
  events are evaluated against the role held at the event's `created_at`.
- A historical record ending in `defer` can retain an interval but never grant
  current authority or route lead resolution.
- Unknown or disputed history fails closed for the disputed action without
  making current membership unknowable.

### 4B. Interpret ordinary exits

- An ended self-role overrides another member's still-active assignment.
- A lead's ordinary removal revokes authority immediately when no other real
  active relationship retains the person.
- Deferred copies cannot delay removal.
- A later invitation requires a new self-role start; an older acceptance
  interval cannot silently reactivate.
- A departed maintainer may retain an active `M` redirect to the lead.
- A coordinate with neither an active role nor an active redirect produces a
  dead-coordinate error rather than guessing another repository.
- A same-coordinate self-led restart is interpreted deterministically but is
  initially presented as an unsupported aggressive-fork transition.
- Do not invent departure timestamps. Prefer a signed role end, then a signed
  deletion request, and otherwise show the boundary as unknown until an
  explicitly designed estimate workflow exists.

### 4C. Reintroduce only safe normal mutations

Replace the complete-roster UI with one-at-a-time intent operations:

- Add one maintainer.
- Accept one invitation.
- Remove one relationship.
- Leave the repository.

Before signing, each operation must:

1. Fetch and settle every announcement and state event required by the
   affected component and named pubkey.
2. Preserve unrelated roles, intervals, metadata, infrastructure, unknown
   tags, and compatibility projection.
3. Construct the proposed replacement in memory.
4. Resolve before/after maintainers, moderators, invitations, lead, identity,
   and state.
5. Confirm that the graph effect is exactly the named intent.
6. Refuse any component join, unexpected addition/removal, invitation
   withdrawal, identity/history conflict, ref change, or unavailable object.
7. Recheck every predecessor announcement and state event immediately before
   signing.
8. Publish, observe, and verify the result before reporting completion.

Initially, no browser mutation may use force. A state-only difference is still
an unsupported transition until Wave 5 implements the full bidirectional ref
preview and verified replacement.

Use stable refusal categories, including:

- `unsupported_component_join`
- `unsupported_lead_transition`
- `membership_side_effect`
- `invitation_withdrawal`
- `state_conflict`
- `identity_conflict`
- `history_conflict`
- `incomplete_relay_view`
- `concurrent_change`
- `unavailable_git_object`

Each error names the affected people, paths, coordinates, or refs and states
that gitworkshop does not yet support making that transition. A refusal must
leave no signed event, relay publication, Git mutation, or route change.

### Wave 4 gate

- [ ] Historical member actions remain effective only when their author held
      the required role at publication time.
- [ ] A removed maintainer immediately loses current state and merge authority.
- [ ] Reinvitation requires a new acceptance interval.
- [ ] A safe ordinary add, accept, remove, and leave changes exactly one
      intended relationship.
- [ ] Every unsupported graph, identity, history, or state case refuses before
      signing or publication.
- [ ] A concurrent announcement or state replacement aborts the mutation.

## Wave 5 — Edge-case workflows

Each item below replaces one narrow refusal with a complete workflow. Do not
bundle unrelated exceptional transitions.

Recommended order:

1. Compatibility-roster mismatch health and standalone repair.
2. Malformed acceptance and active third-party assignment convergence.
3. Prepared lead handover and direct follow-lead convergence.
4. Complete state-collision preview and narrowly scoped state-only force.
5. Component adoption and deliberate repository merge.
6. One-at-a-time moderator add and remove APIs.
7. Relay-divergent history reconciliation and estimated departure boundaries.
8. Abandoned redirects and aggressive same-identifier fork workflows.

The existing
[`repository-invitation-state-merge-prompt.md`](repository-invitation-state-merge-prompt.md)
must be reviewed against the final preflight contract before the state-collision
workflow begins. Its current permissive acceptance cases belong to the outgoing
model and must not be carried forward automatically.

## Delivery sequence

The expected implementation sequence is:

1. **Wave 1A:** writer safety rails and preservation-only metadata editing.
2. **Wave 1B:** parser, reciprocal resolver, typed authority contract, and all
   authorization consumers switched together.
3. **Wave 2:** lead result, route behavior, and selected/lead UI.
4. **Wave 3:** component index, discovery/search grouping, and documentation.
5. **Wave 4A:** replicated history and exit interpretation.
6. **Wave 4B:** safe normal one-at-a-time mutations and structured refusals.
7. **Wave 5:** one exceptional workflow per independently reviewable change.

Each step should be an atomic commit or short atomic series. If splitting a
step would expose mixed authority semantics, keep the changes in one PR and do
not deploy an intermediate commit.

## Validation strategy

Use the `ngit` fixtures as the semantic parity corpus while keeping the model
and NIP authoritative. Extend existing gitworkshop test files rather than
creating unrelated test suites.

The shared scenario matrix must include:

- role-free sole maintainer;
- legacy one-way invitation;
- legacy reciprocal two- and three-person chains;
- an unconfirmed invitation cycle;
- indexed lead invitation and active lead/self acceptance;
- `defer` on a third-party history record;
- rejection of `defer` on either required acceptance record;
- numeric removal and reinvitation;
- ended maintainer and moderator self-roles;
- active, invited, departed, and malformed moderators;
- contradictory compatibility projection;
- missing, multiple, cyclic, and departed lead targets;
- an indirect handover path;
- two unrelated same-identifier components;
- an invitation between those components;
- an add that would confirm immediately;
- state events from invited and departed authors;
- metadata and infrastructure from invited, moderator, departed, and confirmed
  member announcements;
- every structured mutation refusal with proof that nothing was published.

For each implementation step:

- Let the repository pre-commit hook run type checking, linting, formatting,
  unit tests, and the production build.
- Use browser testing for repository routing, search grouping, invitation and
  exit presentation, keyboard behavior, and mobile/desktop layouts.
- Run the live end-to-end suite whenever changes reach Git/GRASP state,
  acceptance publication, or repository mutation behavior.
- Wait on observable conditions with bounded deadlines; do not add fixed test
  sleeps.

## Overall completion criteria

The migration is complete when:

- no unilateral assignment can make another author's repository data
  authoritative;
- indexed roles, legacy fallback, history, moderators, and lead forwarding
  match the authoritative documents;
- every announcement participates in at most one active repository component;
- search, routing, state, metadata, collaboration items, releases, CI, and
  settings all consume the same resolver contract;
- ordinary membership changes are safe and one-at-a-time;
- every unimplemented edge case has a named fail-closed error; and
- the old directional-authority documentation and APIs have been removed.
