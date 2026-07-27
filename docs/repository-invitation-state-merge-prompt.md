# Repository Invitation State Merge — Implementation Prompt

Implement the interactive ref-combination flow for the one maintainer
invitation case that gitworkshop intentionally leaves to ngit CLI today:

- the invitee has a kind `30618` state event for the repository identifier;
- the canonical state is authored by another maintainer and has a strictly
  newer `created_at`; and
- that newer state changes or omits one or more refs in the invitee's state.

The current UI accepts invitations with no invitee state, an equal or newer
invitee state, or a newer canonical state that preserves every invitee ref.
Preserve those paths and the narrow destructive-state guard until the complete
flow below is implemented and validated.

## Required outcome

Acceptance in this destructive-state case must not let the owner's newer event
silently orphan the invitee's branches, tags, or commits. The user must
explicitly choose a combined repository state, after which the client prepares
the minimum missing Git objects and synchronizes every writable Grasp server
listed across the joining maintainer announcements.

## Start by reading

- `AGENTS.md`
- `docs/matainership.md`
- `src/pages/repo/RepoLayout.tsx`
- `src/hooks/useRepositoryState.ts`
- `src/lib/git-grasp-pool/`
- `src/lib/git-grasp-pool/grasp-push.ts`
- `src/lib/git-grasp-pool/merge.ts`
- `src/factories/RepoStateFactory.ts`
- `src/factories/RepoAnnouncementFactory.ts`
- `e2e/README.md`
- the sibling `../ngit-grasp` purgatory and authorization implementation

Use `git-grasp-pool` exclusively for Git HTTP and object transfer. Use
`resilientSubscription` / `resilientRequest` exclusively for Nostr event
fetching. Filter every trust-bearing repository query by the resolved
maintainer authors.

## State-resolution UI

1. Wait for repository-state EOSE before classifying the invitation.
2. Show both repositories' complete ref sets, including:
   - `HEAD`;
   - every `refs/heads/*`;
   - lightweight and annotated `refs/tags/*`, including peeled values;
   - which maintainer/state event supplied each value;
   - whether each commit is available from at least one announced Git server.
3. Pre-resolve identical refs.
4. For a ref present on only one side, default to preserving it.
5. For the same ref name pointing at different objects:
   - identify fast-forward relationships where possible;
   - never pick a winner from `created_at` alone;
   - require an explicit choice when neither value safely contains the other;
   - offer preserving both values under distinct ref names instead of dropping
     one.
6. Require an explicit `HEAD` choice when the repositories disagree.
7. Present the exact final kind `30618` ref set for confirmation before any
   event is published.

## Bandwidth-efficient Git synchronization

1. Build the union of writable Grasp clone URLs from every relevant maintainer
   announcement. Deduplicate normalized URLs.
2. Read each server's advertised receive-pack refs.
3. Determine the object closure each server is missing for the chosen combined
   state.
4. Fetch missing objects from whichever announced server has them, using the
   existing content-addressed cache and Git protocol negotiation. Do not clone
   whole repositories and do not fetch the same object repeatedly.
5. Prepare one deduplicated pack and one atomic receive-pack transaction per
   destination server. Each transaction must include every required ref update,
   rather than issuing one push per ref.
6. Refuse any automatic non-fast-forward deletion or rewrite. A destructive ref
   choice must have been explicitly selected in the state-resolution UI.

The existing `pushRefUpdateToGraspServers` API is centered on one primary ref.
Extend or complement it with a multi-ref transaction API rather than looping
over it and creating multiple pushes.

## Event and push ordering

Prepare and validate the complete operation before publishing anything:

1. Build the combined state template and reciprocal announcement template.
2. Fetch/prepare all required Git objects and per-server ref updates.
3. Sign the kind `30618` state and kind `30617` announcement.
4. Publish both events to the corresponding Grasp relays so they enter
   purgatory/authorization scope.
5. Push exactly once to each Grasp Git server.
6. Confirm the advertised refs match the signed combined state.
7. Only then broadcast the state and reciprocal announcement through the
   normal outbox/index relay groups and unlock maintainer controls.

If some servers fail, preserve the signed events and prepared operation so the
user can retry only the failed destinations. Do not silently report full
success. Clearly distinguish complete, partial, and failed synchronization.

## Safety constraints

- Do not publish the reciprocal announcement through broad relays before the
  combined Git state has succeeded.
- Do not generate a state event that omits an existing branch or tag unless the
  user explicitly removed it.
- Do not use the newest state event as an implicit merge strategy.
- Do not roll custom Git HTTP, pack parsing, caching, or relay subscriptions.
- Keep all existing maintainer relationships unless the user explicitly
  changes them.
- Ensure timestamps supersede the invitee's prior addressable events without
  relying on local clock equality.
- Abort before publishing if any selected ref cannot be obtained from the
  announced Git servers.

## Validation and handoff

Use the repository's normal commit hook for TypeScript, lint, formatting, unit
tests, and build. Because this changes GRASP/purgatory/push behavior, also run
the live end-to-end suite when `ngit-grasp` is available.

In the handoff, report:

- how conflicting refs are represented and resolved;
- how object availability and missing-object transfer are computed;
- how one-push-per-server atomicity is achieved;
- partial-failure and retry behavior;
- exact validation results.
