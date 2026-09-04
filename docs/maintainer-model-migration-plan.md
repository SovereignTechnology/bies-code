# Maintainer Model Follow-up Plan

> **Scope:** Work remaining after the pre-v3 compatibility candidate. Ship and
> observe that candidate before adding exceptional membership workflows.
>
> **Compatibility baseline:** Existing repositories are role-free or use the
> legacy `maintainers` representation. Their discovery, repository pages,
> collaboration, and Git experience must remain progressive while indexed
> `M`/`m`/`o` adoption begins.

## Authority and alignment

Use these sources in precedence order:

1. [`ngit` maintainer model](../../ngit/docs/architecture/maintainer-model.md)
2. [NIP-34](../../nips/34.md)
3. Current `ngit` v3 and `ngit-grasp` v3 behavior and fixtures
4. [`ngit` follow-up actions](../../ngit/docs/architecture/maintainer-model-follow-up-actions.md)

Where executable behavior differs from the authoritative model, clarify the
model or NIP first and then align both clients. Do not silently make
GitWorkshop's interpretation authoritative.

## Phase 1 — Release the compatibility baseline

Do not start the edge-case membership work until this release has a stable
legacy baseline.

- [ ] Push and deploy the current release candidate with `ngit-grasp` v3.
- [ ] Repeat production smoke tests for:
  - cold landing-page repository discovery;
  - repository search by repository name, maintainer name, npub, and hex key;
  - mixed healthy and unavailable index/profile relays;
  - an all-index-unavailable terminal result;
  - role-free and reciprocal-legacy repository code, issues, pull requests,
    profiles, pinned/followed/starred lists, and phone layouts;
  - direct item links containing one repository coordinate.
- [ ] Confirm that cards and repository content render progressively and that
      no presentation surface waits for the strict membership-mutation snapshot.
- [ ] Confirm that degraded empty results identify unavailable or unfinished
      relay coverage instead of claiming authoritative absence.
- [ ] Monitor client exceptions, relay request volume, time to first card,
      time to terminal relay state, redirect loops, and failed membership
      preflights during the initial rollout.
- [ ] Hold exceptional writes if a regression appears; do not weaken the
      complete-relay mutation preflight to repair a read-side UX problem.

The release gate is a stable ordinary repository experience. The presence of
the new protocol parser alone is not sufficient.

## Phase 2 — Make read settlement explicitly complete or degraded

The current bounded aggregate relay window is useful for progressive reads,
but it is not proof that every relay returned EOSE. Replace the ambiguous
boolean contract before relying on it for repositories that actively use
indexed roles.

1. Replace `settled: boolean` and `announcementsSettled` with an explicit
   result such as `progressive`, `complete`, or `incomplete`.
2. Define the required relay set for each decision. Track actual per-relay
   EOSE and terminal errors against a fixed snapshot and a bounded deadline.
3. Continue rendering repository content and cards from progressive snapshots.
4. Permit canonical lead redirects, archived/deleted/restarted lifecycle
   notices, and CI trust decisions only from a complete snapshot. Timeout,
   relay failure, or relay set changes must remain visible and fail closed.
5. Keep membership mutations on their existing stricter two-snapshot contract;
   do not substitute the read-side settlement result.
6. Make stabilized repository resolution deletion-aware:
   - subscribe to verified persisted deletion evidence;
   - query kind `5` evidence by exact `#a` and known `#e` references;
   - retain enough signed history to prevent stale relay copies from reviving
     deleted announcements.
7. For multi-coordinate NIP-19 routing, require every candidate to reach a
   complete result before proving that all pointers name one component. An
   unavailable or unrelated pointer must fail closed.
8. Batch strict graph hydration for CI trust and other global consumers so the
   number of relay requests is bounded by page/query batches rather than the
   number of cached repository coordinates.
9. Page or batch local repository-model subscriptions so deletion updates do
   not recompute every cached repository before the visible page is selected.

### Phase 2 gate

- [ ] A slow healthy relay cannot be dropped after another relay's EOSE.
- [ ] A failed or timed-out relay produces `incomplete`, never `complete`.
- [ ] Progressive content remains usable while a safety decision is incomplete.
- [ ] A newer replacement or tombstone on a slower relay prevents a stale
      redirect, lifecycle notice, or trust decision.
- [ ] Mixed-relay and all-relay-failure tests have bounded observable
      deadlines and no fixed sleeps.

## Phase 3 — Certify the first indexed-role repositories

Before recommending indexed-role adoption, exercise the same signed fixtures
through `ngit` v3, `ngit-grasp` v3, and GitWorkshop.

- [ ] Create a role-free repository and confirm unchanged behavior in every
      client.
- [ ] Create an indexed lead, invite a maintainer, accept reciprocally, and
      verify identical component, authority, lead, metadata, state, and route
      results.
- [ ] Exercise a moderator invitation and acknowledgement without granting
      state or merge authority.
- [ ] End and re-open role intervals, including `defer`, and compare current
      and publication-time authorization.
- [ ] Verify that self-`defer` is reported as invalid history without hiding
      the repository or granting authority; only the affected signer is gated
      without a strictly later signed self-role, while other maintainers and a
      superseded signer's current writes continue.
- [ ] Exercise signer-approved self-`defer` repair using an unambiguous
      successor boundary, an explicit continue/end choice, and acceptance of a
      new role; unrelated announcement edits must preserve the malformed tag.
- [ ] Verify that deletion and a numeric self-role end retain the final signed
      snapshot and show the actor and lifecycle time on the direct route.
- [ ] Verify that a gapped same-coordinate restart renders the current
      repository with a lifecycle notice instead of a terminal refusal.
- [ ] Verify that a one-way invitation remains a separate repository result
      and contributes no trusted metadata or infrastructure.
- [ ] Verify signed announcement and state deletion behavior across split
      relays and after a cold cache reload.
- [ ] Verify ngit-created repository state and refs against `ngit-grasp` v3,
      including a browser read and a supported browser membership operation.
- [ ] Document operator recovery and rollback for incomplete relay coverage;
      never prescribe a force operation that the browser cannot yet prove safe.

## Phase 4 — Replace one exceptional refusal at a time

Each item is an independent workflow. It replaces a named fail-closed refusal
only when its complete preflight, preservation rules, publication proof, and
cross-client fixtures are ready.

Recommended order:

1. **Health and convergence repairs** — compatibility-roster mismatch,
   malformed acceptance, and active third-party assignment convergence.
2. **Existing-announcement and immediate confirmation** — preserve the
   invitee's relationships, metadata, infrastructure, identity, history, and
   former-component state while replacing
   `unsupported_existing_announcement`,
   `unsupported_immediate_confirmation`, and
   `unsupported_role_effect_import`.
3. **State collision and scoped force** — distinguish equivalent state from
   real bidirectional ref conflicts, prove every object ID, and add only the
   narrowly scoped state-only force workflow. This replaces
   `unsupported_existing_state` and eligible `state_conflict` cases.
4. **Prepared lead handover and follow-lead convergence** — prepare rosters,
   converge direct pointers, preserve history, and deliberately change the
   selected coordinate before replacing `unsupported_lead_transition`.
5. **Component adoption and repository merge** — reconcile identity, Git
   history and refs, imported members, role history, infrastructure, state,
   and recovery before replacing `unsupported_component_join`.
6. **Moderator roster management** — add one-at-a-time moderator invitation
   and removal. Keep ordinary moderator self-leave as the simple case.
7. **Relay-divergent history reconciliation** — repair conflicting signed
   copies and label estimated departure boundaries explicitly.
8. **Redirect and coordinate-fork write workflows** — handle abandoned
   redirects and aggressive same-identifier fork mutations while recommending
   a new identifier for friendly forks. Read-side lifecycle history remains
   visible independently of these write workflows.

Review
[`repository-invitation-state-merge-prompt.md`](repository-invitation-state-merge-prompt.md)
against the final state-collision contract before implementing item 3. Its
older permissive cases must not bypass the current proof requirements.

## Validation contract for every phase

- Treat the authoritative model and NIP as the semantic specification and use
  `ngit` fixtures as the parity corpus.
- Keep commits atomic; do not deploy an intermediate state with mixed
  authority rules.
- Let the repository pre-commit hook run type checking, linting, formatting,
  unit tests, and the production build.
- Use fresh browser profiles for loading, routing, degraded-relay, keyboard,
  mobile, and desktop checks.
- Run the live end-to-end suite for Git/GRASP state, publication, acceptance,
  or membership changes.
- Wait on observable conditions with bounded deadlines. Fixed test sleeps are
  prohibited.
- For every refused mutation, prove that nothing was signed, published,
  pushed, or queued.
- For every newly supported mutation, prove relay acknowledgement, exact
  refetch, resolved-result equality, and unchanged unrelated metadata,
  history, relationships, infrastructure, and refs.
