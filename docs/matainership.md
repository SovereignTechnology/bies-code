# Repository Maintainership

**Audience:** Client developers implementing NIP-34 repository discovery,
authorization, and presentation.

The authoritative protocol model is
[`ngit/docs/architecture/maintainer-model.md`](../../ngit/docs/architecture/maintainer-model.md),
with the concise wire format in [`nips/34.md`](../../nips/34.md). This document
records how GitWorkshop consumes that model.

## Repository identity

A NIP-34 repository is an identifier plus a reciprocally confirmed component
of kind `30617` announcements. A selected `30617:<pubkey>:<identifier>`
coordinate is the discovery anchor; selecting or directionally reaching a
pubkey does not itself grant that pubkey authority.

Two people may publish the same identifier without describing the same
repository. Their announcements join one virtual repository only through the
reciprocal membership rules below. Invitation edges are discovery
relationships and do not merge components.

GitWorkshop indexes all currently known announcements for an identifier before
presenting repositories. It reduces replacements per author, resolves every
coordinate-rooted view, unions overlapping confirmed maintainer sets, and then
assigns each announcement coordinate to at most one component. An explicit
component uses its deterministic terminal lead as the discovery-card anchor;
legacy and leadless components use the lexicographically stable confirmed
membership set. `repo.componentId` encodes that identifier plus sorted
maintainer set and is the UI identity used to deduplicate cards.

Search, browse, profile repositories, stars, pins, follows, and NIP-19
repository redirects all consume this component index. A hit for any confirmed
member returns the same component. A unilateral same-identifier invitation may
be shown as a relationship, but it cannot absorb the invitee's existing
component or contribute its metadata, infrastructure, or privacy.

## Current role records

Indexed role tags have the form:

```text
["M"|"m"|"o", "<pubkey>", <start>, <end>, <start>, <end>, ...]
```

- `M` is a signed lead-forwarding relationship.
- `m` assigns or acknowledges co-maintainership.
- `o` assigns or acknowledges moderatorship.
- With numeric boundaries, an empty history or an odd number of boundaries is
  active. An even number is ended.
- `defer` is valid only as the final end value. It preserves history but is
  inactive for current authority and routing.
- Malformed and conflicting role records cannot grant authority.

When any `M`, `m`, or `o` tag is present, indexed roles are authoritative and
the deprecated `maintainers` tag is only a compatibility projection. A
contradictory projection is a health error and never broadens authority.

On a role-free announcement, `maintainers` supplies legacy co-maintainer
assignments. With no role or legacy membership tags, the author is the
implicit sole maintainer. An indexed-role author absent from every self-role
is also an implicit maintainer; an author with self-role records but no active
self-`M` or self-`m` has explicitly declined or left maintainership.

## Discovery is not authority

Starting at the selected coordinate, GitWorkshop recursively fetches the
latest announcement for every active maintainer or moderator subject. Latest
replacement selection uses greatest `created_at`, then the lexicographically
lowest event ID at equal timestamps.

This produces `repo.discoveryPubkeys` and `repo.discoveredAnnouncements`.
These fields exist to fetch acknowledgements, show invitations, and diagnose
the graph. They must never be used as author filters for trusted repository
state or as sources of shared metadata and infrastructure.

## Reciprocal maintainer confirmation

For a normal lead-shaped repository, the selected announcement's single active
`M` path must terminate at a non-departed author with an active self-`M`.
Incomplete, cyclic, and conflicting paths seed no authority. The terminal lead
seeds a fixed point:

1. A confirmed maintainer actively assigns a candidate through `M` or `m` (or
   the legacy fallback).
2. The candidate's latest announcement acknowledges an already-confirmed
   maintainer and has not ended its own maintainer role.
3. The candidate becomes confirmed and can extend the same fixed point.

Legacy and deliberately leadless repositories seed the reciprocal fixed point
at the selected maintainer. A cycle made only of unconfirmed invitees cannot
bootstrap itself into authority. A self-role end takes precedence over active
assignments in other announcements.

The resulting authority set is `repo.confirmedMaintainers`. Only this set may:

- publish authoritative kind `30618` repository state;
- create or push merges;
- edit repository settings or publish state replacements;
- mutate CI service, trigger, and secret controls; and
- publish maintainer-only release or repository operations.

`repo.invitedMaintainers` remains discovery and presentation state only.

## Moderator confirmation

An active `o` assignment from a confirmed maintainer is a moderator
invitation. It becomes confirmed only when the candidate publishes an active
self-`o` and an active role relationship naming an existing confirmed member.
Moderator announcements never assign roles to third parties.

`repo.confirmedMembers` is the union of `repo.confirmedMaintainers` and
`repo.confirmedModerators`. Confirmed moderators may author member actions such
as status, label, subject, and cover-note events. They may not publish kind
`30618` state, push or create merges, change repository settings, or operate
maintainer-only CI controls.

## Coordinates and collaboration events

New issues, PRs, patches, comments, and related collaboration events reference
`repo.confirmedMemberCoordinates`. Invitations are never included. Queries for
open collaboration data use every confirmed member coordinate because content
may have been filed against any accepted member's announcement.

Authority remains separate from discovery:

| Data or operation                                | Accepted authors                              |
| ------------------------------------------------ | --------------------------------------------- |
| Kind `30618` state, merge, settings, CI controls | `confirmedMaintainers` only                   |
| Status, labels, subjects, cover notes            | Root author plus `confirmedMembers`           |
| Shared metadata, clone URLs, relays, privacy     | `confirmedAnnouncements` only                 |
| Issues, PRs, comments, reactions                 | Open protocol participation; no author filter |

Wave 4 will add authorization-at-publication-time from resolved role history.
Until then, these checks use current confirmed membership.

## Merged repository fields

Only confirmed member announcements contribute trusted repository fields:

- Name, description, and web URLs follow the existing latest-wins rule.
- Clone URLs, relays, labels, and other union fields are collected only across
  `repo.confirmedAnnouncements`.
- Invited, departed, malformed-role, and unconfirmed moderator announcements
  contribute nothing to those fields.

The selected coordinate remains a permanent signed discovery perspective.
Direct routes retain that perspective while following a complete explicit lead
path or unique legacy lead; discovery cards use the component's deterministic
anchor.

## Browser mutation safety during migration

GitWorkshop's old complete-roster editor and legacy invitation acceptance are
disabled. Metadata-only edits preserve every existing `M`, `m`, `o`, and
`maintainers` tag byte-for-byte, including role history and contradictory
compatibility projections. A role-free sole-maintainer announcement remains
role-free.

Until the browser implements ngit's relationship-intent API and complete
preflight, membership changes must be made with a compatible ngit v3 client.
Persisted v2 acceptance jobs are deliberately not hydrated or delivered.

## Resolver contract

Callers consume the pure resolver through `useResolvedRepository` and must
choose the narrowest explicit field:

- `componentId` for repository-card and component identity
- `confirmedMaintainers` / `confirmedMaintainerCoordinates`
- `confirmedModerators`
- `confirmedMembers` / `confirmedMemberCoordinates`
- `invitedMaintainers` / `invitedModerators`
- `discoveryPubkeys` / `discoveredAnnouncements`
- `confirmedAnnouncements`
- `maintainerEdges` / `moderatorEdges`
- `repositoryHealth`

Do not recreate membership checks in components and do not treat a fetched
announcement, matching identifier, or repository coordinate as proof of
authority. Discovery lists must use the shared component index rather than
grouping announcements in relay arrival order.
