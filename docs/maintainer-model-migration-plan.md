# Maintainer Model Migration Plan

> **Status:** Waves 1 through 3 are complete. Wave 4A through 4C have landed,
> but an independent review reopened the Wave 4 release gate. Complete the
> Wave 4D stabilization work below before enabling browser membership writes
> or beginning Wave 5 edge-case workflows.
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

## Current implementation state

Waves 1 through 3 have replaced the outgoing directional-authority model:

- reciprocal components are the current authority boundary;
- selected-coordinate lead resolution drives canonical routes;
- repository cards and exact-coordinate readers share deterministic,
  settled component selection; and
- metadata, infrastructure, state, collaboration coordinates, releases, CI,
  and settings consume explicit confirmed-role sets.

Wave 4A through 4C added replicated history, exit interpretation, and guarded
one-at-a-time browser mutation intents. The 2026-08-29 independent review found
that this work is not yet release-ready:

- some current and historical read decisions disagree with the authoritative
  model;
- some nominally supported mutations can discard data or miss consequential
  graph changes;
- relay, Git-object, and publication evidence is not strong enough to prove a
  write safe; and
- several final-model operations are conservatively rejected, but do not yet
  have explicit refusal categories that distinguish them from implementation
  failures.

Wave 4D below is therefore a stabilization wave, not an expansion into edge
workflows. It restores the browser writer safety rail, fixes read-side
semantics, narrows supported writes to cases that can be proved safe, and gives
every remaining final-model operation a named refusal. The authoritative model
permits more than current ngit v3 in areas such as accepting with an existing
same-identifier announcement; Wave 4 follows ngit's conservative refusal there
and Wave 5 implements the fuller model deliberately.

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

| Wave | Outcome                                                     | Release gate                                                                     |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | Reciprocal membership becomes the sole authority boundary   | No unaccepted invitee affects trusted state anywhere                             |
| 2    | Signed lead resolution and browser redirects                | Redirects follow a complete `M` path or a unique legacy vote winner              |
| 3    | One announcement belongs to one active repository component | Search shows one result per repository without invitations merging repositories  |
| 4    | Exits, history, conservative mutations, and stabilization   | The 4D audit closes; every unsupported or incompletely proved write fails closed |
| 5    | Exceptional workflows replace individual refusal cases      | Each edge-case workflow is independently reviewable and verified                 |

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
- [x] Exact-coordinate lists refresh the complete referenced component rather
      than relying on a bounded same-identifier result page.
- [x] Browse, search, profile, pin, follow, star, and NIP-19 results remain in
      resolution until the recursive announcement and mailbox snapshot settles.
- [x] Ordinary metadata comes from one latest confirmed-member announcement;
      clone URLs, relays, Blossom servers, and privacy match ngit's union rules.
- [x] A root item that names multiple unrelated components fails closed instead
      of choosing a repository by tag order.

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

### 4D. Stabilize the supported subset

The independent Wave 4 review found both fail-open defects and final-model
operations that the current browser cannot yet prove safe. Treat those classes
differently: repair current reads and supported normal writes now; give every
larger operation a specific refusal and leave its complete workflow to Wave 5.

#### 4D.0. Restore the writer safety rail

- Disable add, accept, remove, and leave entry points while 4D is incomplete.
  Metadata-only edits remain available with membership and history tags
  preserved byte-for-byte.
- Do not deploy an intermediate 4D commit that enables only part of the
  preflight. Re-enable the four intents together only after the 4D gate passes.
- Quarantine every durable acceptance job created by the pre-4D writer. Its
  signed event may already exist locally or on a relay, so keep that fact
  visible, but do not broaden delivery automatically. Resume only after the
  stored proposal is revalidated under 4D or after an explicit recovery
  workflow; never silently upgrade a legacy or partially preflighted job.

#### 4D.1. Correct read-side authority and history

- Preserve an uninterrupted active self-acknowledgement across an assignment
  removal and restart. Require a fresh candidate start only after the candidate
  ended their own self-role.
- Compute replicated-history distance using confirmed-member graph edges only;
  unconfirmed, invited, and departed edges cannot affect precedence.
- Complete the publication-time authorization audit. PR stack inference,
  merge-base updates, merged-PR matching, and every other immutable
  role-scoped consumer must use `isItemEventAuthorisedAt` and the resolved role
  history rather than the current member set.
- Detect an ended old self-role followed by an active self-`M` as an unsupported
  same-coordinate restart regardless of how many people later join the new
  component.
- Include signed kind `5` deletion evidence in departure and candidate-state
  resolution. Missing data from one relay remains insufficient evidence of a
  departure or deletion.

#### 4D.2. Make normal mutation effects exact

- Compare maintainers, moderators, maintainer invitations, moderator
  invitations, lead, and the exact authored relationship delta before and
  after every proposal. A lost invitation returns `invitation_withdrawal`.
- Build a fresh acceptance only from the NIP-01-latest confirmed-member
  announcement, including the lowest-event-ID tie-break. Unconfirmed and
  invited announcements supply no shared metadata.
- Preserve the final model's ordinary moderator self-leave: close the active
  self-`o` while preserving unrelated roles, history, metadata, and the lead
  redirect. Moderator assignment and removal remain Wave 5 workflows.
- Capture a new role start at the final proposal construction immediately
  before signing, after the second safety snapshot. The first simulation is a
  shape check and must not freeze an earlier authorization boundary.
- Refuse acceptance when the actor already has a same-identifier announcement.
  Use `unsupported_existing_announcement`, preserve that announcement
  unchanged, and defer full reconciliation to Wave 5.
- Refuse an add that would confirm its target immediately. Use
  `unsupported_immediate_confirmation` and defer its state, history, local-ref,
  and role-scoped-action preflight to Wave 5.
- Refuse any proposed confirmation that could import a prior role interval or
  newly authoritative role-scoped result with
  `unsupported_role_effect_import`. The supported fresh-acceptance subset has
  no earlier candidate history; Wave 5 performs the full before/after event
  evaluation.
- Continue refusing any target-authored state event in Wave 4 even when it is
  non-winning or data-equivalent. Use `unsupported_existing_state` rather than
  claiming that safe state reconciliation has already been implemented.

#### 4D.3. Require complete safety evidence

- Give both mailbox discovery and announcement/state snapshots bounded
  deadlines.
- Track per-relay EOSE and error outcomes. Aggregate EOSE means the read is no
  longer waiting; it is not proof of a complete write snapshot. Every relay in
  the required safety set must return a real EOSE, otherwise refuse with
  `incomplete_relay_view` before signing.
- Define the required safety set from the selected component, named pubkeys,
  refreshed NIP-65 mailbox lists, repository relays, and configured index,
  lookup, and fallback relays. Record that exact set in both snapshots so a
  mailbox or relay-set change is itself a concurrent change.
- Recheck every latest kind `30617`, kind `30618`, and applicable deletion
  event used by the decision. A changed winner or candidate aborts with
  `concurrent_change`.
- Verify every exact post-change branch and tag OID through a bounded,
  cache-bypassing network probe against the post-change component's advertised
  Git URLs. A warm memory or IndexedDB object is not availability evidence.

#### 4D.4. Verify publication rather than local insertion

- Do not treat the optimistic EventStore insertion as publication evidence.
- Require at least one positive relay acknowledgement from a designated
  repository or index relay, then refetch the exact replacement from an
  acknowledged safety relay and resolve the graph again.
- If signing succeeded but acknowledgement or refetch did not, expose the
  operation as queued or pending delivery. Do not report it as completed and
  do not encourage an immediate retry that could create a competing
  replacement.
- Keep durable delivery to additional relays and GRASP servers visible and
  resumable without weakening the acknowledgement required for initial
  success.

#### Independent-review disposition

| Finding                                                                 | Wave 4 disposition                                                      | Later workflow                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Relay snapshot may hang or use an incomplete view                       | Fix in 4D.3; every required relay must EOSE before signing              | Relay-divergent reconciliation remains Wave 5               |
| Existing-announcement acceptance can discard relationships and metadata | Refuse explicitly in 4D.2                                               | Reconcile and preserve the existing announcement in Wave 5  |
| Moderator invitation withdrawal is not checked                          | Fix exact invitation and relationship effects in 4D.2                   | None                                                        |
| Standing acceptance is lost after assignment restart                    | Fix current and historical resolution in 4D.1                           | None                                                        |
| Acceptance can copy unconfirmed metadata                                | Fix the confirmed canonical source in 4D.2                              | None                                                        |
| An add that immediately confirms is rejected generically                | Keep it refused with a precise 4D.2 category                            | Implement complete confirmation preflight in Wave 5         |
| Role-scoped effects are absent from preflight                           | Restrict Wave 4 to fresh acceptance and refuse imported history/effects | Compare complete before/after role-scoped results in Wave 5 |
| Git availability can pass from cache                                    | Require a network-only proof in 4D.3                                    | None                                                        |
| Unconfirmed edges influence history precedence                          | Fix confirmed-graph distance in 4D.1                                    | None                                                        |
| PR stack and merge attribution uses current roles                       | Finish the historical authorization audit in 4D.1                       | None                                                        |
| Publication verification observes only local state                      | Require relay acknowledgement and refetch in 4D.4                       | Richer delivery policy may evolve independently             |
| Multi-person coordinate restart evades the unsupported marker           | Fix restart classification in 4D.1                                      | An explicit restart/fork workflow remains Wave 5            |
| Confirmed moderators cannot leave                                       | Support ordinary moderator self-leave in 4D.2                           | Moderator add/remove remains Wave 5                         |

### Wave 4 gate

- [ ] Historical member actions remain effective only when their author held
      the required role at publication time.
- [x] A removed maintainer immediately loses current state and merge authority.
- [ ] Standing acceptance survives reassignment until the candidate ends their
      self-role; after that end, reinvitation requires a new acceptance interval.
- [ ] A safe ordinary add, fresh accept, remove, maintainer leave, and moderator
      leave changes exactly one intended relationship.
- [ ] Existing-announcement acceptance, immediate-confirmation add, imported
      role effects, and existing target state have distinct fail-closed errors.
- [ ] A supported mutation preserves metadata and unrelated current and
      historical relationships byte-for-byte.
- [ ] Every required safety relay returns EOSE twice within a bounded deadline,
      and any relay or predecessor-set change aborts before signing.
- [ ] Git-object availability is proved from advertised servers without using
      the local cache as evidence.
- [ ] A signed replacement is acknowledged by a relay, refetched, and resolved
      to the preview before the UI reports completion.
- [ ] Every unsupported graph, identity, history, or state case refuses before
      signing or publication.
- [ ] A concurrent announcement, state, deletion, mailbox, or safety-relay
      replacement aborts the mutation.

## Wave 5 — Edge-case workflows

Each item below replaces one narrow refusal with a complete workflow. Do not
bundle unrelated exceptional transitions.

Recommended order after the Wave 4D gate closes:

1. **Health and convergence repairs.** Add compatibility-roster mismatch
   health and standalone repair, malformed-acceptance repair, and active
   third-party assignment convergence.
2. **Complete confirmation preflight.** Replace the Wave 4 refusals for an
   existing invitee announcement and an immediately confirming add. Preserve
   the invitee's relationships, metadata, personal infrastructure, identity,
   and history; compare complete local and signed state; enumerate newly
   authoritative role-scoped results; and invalidate former-component state
   before the next push.
3. **State collision and scoped force.** Accept equivalent state with distinct
   event authors, show bidirectional ref changes for real conflicts, prove
   every OID, and add only the narrowly scoped state-only force workflow.
4. **Prepared lead handover and follow-lead convergence.** Implement complete
   roster preparation, direct pointer convergence, history sync, and selected
   coordinate changes.
5. **Component adoption and deliberate repository merge.** Reconcile identity,
   Git history and refs, imported members, role history, infrastructure, and
   recovery without treating an ordinary add or accept as a merge command.
6. **Moderator roster management.** Add one-at-a-time moderator invitation and
   removal APIs. Ordinary moderator self-leave is already part of Wave 4D.
7. **Relay-divergent history reconciliation.** Add signed deletion handling
   beyond the deterministic Wave 4 read boundary, conflicting-copy repair, and
   explicitly labelled estimated departure boundaries.
8. **Redirect and coordinate-fork workflows.** Handle abandoned redirects and
   aggressive same-identifier forks while recommending a new identifier for a
   friendly fork.

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
5. **Wave 4A/4B:** replicated history and exit interpretation.
6. **Wave 4C:** land the guarded one-at-a-time mutation architecture.
7. **Wave 4D.0:** restore the membership-writer safety rail.
8. **Wave 4D.1:** correct standing acceptance, confirmed-graph history,
   historical consumers, deletion evidence, and restart classification.
9. **Wave 4D.2:** preserve exact normal mutation effects, support moderator
   self-leave, and install explicit refusals for larger confirmation cases.
10. **Wave 4D.3:** require bounded relay-completeness and network-only Git
    object evidence.
11. **Wave 4D.4:** require relay acknowledgement, exact refetch, and resolved
    verification before re-enabling writers.
12. **Wave 5:** replace one explicit refusal at a time with a complete,
    independently reviewable workflow.

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
- an uninterrupted standing acknowledgement across removal and reassignment;
- a fresh invitation after the candidate ends their own self-role;
- acceptance with an existing same-identifier announcement and unknown tags;
- a moderator invitation withdrawn as a removal side effect;
- confirmed moderator self-leave;
- history precedence in which an unconfirmed edge shortens a raw graph path;
- a multi-person component rooted at an aggressive same-coordinate restart;
- state events from invited and departed authors;
- equivalent, non-winning, and conflicting target-authored state events;
- warm cached OIDs with every advertised Git server unavailable;
- successful and failed relay acknowledgement followed by exact refetch;
- required safety relays that EOSE, fail, hang, or change between snapshots;
- signed deletion requests that affect announcement or state eligibility;
- publication-time PR updates, stack inference, status, and merged-commit
  matching before, during, and after a role interval;
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
