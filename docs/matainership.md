# Selected Maintainer Model for Web Clients

**Purpose:** Reference document for web client developers displaying ngit repositories  
**Audience:** Client developers who need to understand how to discover, validate, and display multi-maintainer repositories

---

## What Is a Repository?

A repository in the ngit model is **not** simply a pubkey + identifier pair. A repository is:

> **An identifier string plus the directional maintainer graph rooted at a selected maintainer.**
> Following each `maintainers` tag recursively defines who is authorized for
> that selected repository coordinate.

Authorization and public identity are deliberately separate. A listed pubkey is
authorized immediately, matching ngit and ngit-grasp, while the UI presents that
relationship as an invitation until the listed maintainer links their own
announcement back into the accepted group.

## Repository Announcements (NIP-34 Kind 30617)

Each participant in a repository publishes a **repository announcement event** (kind 30617), signed by their Nostr keypair, containing:

- `d` tag: the repository identifier (e.g. `my-project`)
- `name` tag: human-readable name
- `description` / content: description text
- `clone` tag: git clone URLs for their copy
- `relays` tag: Nostr relays where events for this repo are published
- `maintainers` tag: zero or more pubkeys they recognize as co-maintainers
- `r` tag: earliest unique commit (root commit for original repos, a later commit for forks)
- `web` tag: web URLs (e.g. gitworkshop.dev link)

---

## The Maintainer Chain

### Direct Maintainers

An announcement can list additional maintainers:

```
Alice's announcement for "my-project":
  maintainers: [Bob, Carol]
```

Bob and Carol are authorized to push state events for Alice's copy of `my-project`.

### Recursive Maintainers

Any listed maintainer can themselves publish an announcement for the same identifier, listing further maintainers:

```
Bob's announcement for "my-project":
  maintainers: [Dave]
```

Dave is now a **recursive maintainer** — authorized because Alice lists Bob, and Bob lists Dave. Alice's full authorized set = {Alice, Bob, Dave}.
The chain can be arbitrarily deep. The relay computes the full transitive closure via `get_maintainers_recursive()` (`src/git/authorization.rs:386`) with cycle detection to prevent infinite loops.

### Reciprocal Listing = Accepted Membership

When two pubkeys list each other (directly or transitively), they form a single repository unit:

```
Alice's announcement for "my-project": maintainers: [Bob]
Bob's announcement for "my-project":   maintainers: [Alice]
```

These announcements form an accepted repository group. State events from either
were already authoritative from Alice's directional graph; reciprocation is the
signed acknowledgement that makes Bob safe to present publicly as an accepted
co-maintainer and enables maintainer publishing controls.

### Splitting: When the Chain Breaks

The repository unit **splits** when the maintainer chain is severed — i.e. when one party removes the other and the transitive connection no longer exists.
Example: Alice removes Bob from her maintainers list:

```
Alice's new announcement for "my-project": maintainers: []
Bob's announcement for "my-project":       maintainers: [Alice]
```

Alice no longer authorizes Bob from Alice's coordinate. Bob still reaches and
authorizes Alice, so the split is intentionally asymmetric until Bob also
removes Alice.

---

## What the Maintainer Set Makes Authoritative

When a set of pubkeys forms a connected repository unit, **all of them are authoritative** for that repository. Specifically, clients SHOULD treat events from the recursive maintainer set as authoritative:

### State Events (Kind 30618)

A state event declares the current branch/tag heads of the repository. State events from **any pubkey in the recursive maintainer set** are authoritative for the repository. The latest state event (by timestamp) from any authorized maintainer defines the canonical state.

### Issue, PR, and Patch Status Events

Status updates on issues (kind 1621), pull requests (kind 1618/1619), and patches are authoritative when authored by any member of the recursive maintainer set. A maintainer closing an issue or merging a PR carries the same weight regardless of which specific maintainer in the set authored the event.

### NIP-32 Labels

NIP-32 labels (kind 1985) applied to repository content (commits, issues, PRs) by members of the recursive maintainer set are **authoritative**. Labels from outside the maintainer set are **helpful suggestions** — they may be displayed but should be visually distinguished from maintainer-authored labels.

> Clients SHOULD treat labels from the recursive maintainer set as authoritative, and non-maintainer-provided labels as helpful suggestions.

## This distinction is important: a random user labeling an issue "bug" is a suggestion. A maintainer labeling it "bug" is a definitive classification.

## The `RepoRef`: How a Client Resolves a Repository

The ngit CLI's `RepoRef` struct (`src/lib/repo_ref.rs:34`) is the canonical in-memory representation of a resolved repository. Understanding how it is built is essential for client implementors.

### The `selected_maintainer` Field

`RepoRef` has a `selected_maintainer: PublicKey` field — the single pubkey that was the starting point for resolution. This is the npub the user navigated to (e.g. from a nostr URL or a link). It anchors the coordinate used to reference the repository: `naddr` coordinates always point to the selected maintainer's pubkey + identifier.
This is distinct from the full `maintainers` list, which contains all pubkeys in the connected chain.

### Recursive Discovery in `get_repo_ref_from_cache`

The function `get_repo_ref_from_cache` (`src/lib/client.rs:1428`) shows exactly how a client should resolve a repository from a starting coordinate:

```
1. Start with the selected maintainer's pubkey in a set
2. Fetch all kind 30617 events for (pubkey, identifier) for every pubkey in the set
3. For each event found, add all listed maintainers to the set
4. If any new pubkeys were added, loop back to step 2
5. Continue until no new pubkeys are discovered (fixed point)
```

This is the recursive chain resolution. The loop terminates because the set only grows and pubkeys are only added once.

### Field Merging: Latest vs Union

Once all maintainer announcement events are collected, fields are merged with two different strategies:
**Fields taken from the latest event (by `created_at`) across all maintainers:**

- `name`
- `description`
- `web`
  These are "shared metadata" — the most recently updated version wins, regardless of which maintainer published it. This reflects that any maintainer can update the project's display name or description.
  **Fields unioned across all maintainer events:**
- `relays` — all relays from all announcements, deduplicated
- `git_server` (clone URLs) — all clone URLs from all announcements, deduplicated
- `blossoms` — all blossom server URLs, deduplicated
  These are "infrastructure" — each maintainer hosts their own copy, and clients should know about all of them.
  **Fields taken from the selected maintainer's own event:**
- `identifier`
- `root_commit` (earliest unique commit)
- `selected_maintainer` (always the starting pubkey)
  **The full maintainer set:**
- `maintainers` — the complete set of all pubkeys discovered through the recursive chain, not just those listed in the selected maintainer's own event
  The `maintainers_without_announcement` field tracks pubkeys that are listed as maintainers but have not yet published their own announcement event for this identifier.

---

## How Issues, PRs, and Patches Reference the Repository

Issues, PRs (pull requests), and patches all tag **every maintainer's announcement** using NIP-01 `a` tags (addressable event coordinates). This is the mechanism that ties these events to the full repository unit rather than to a single pubkey's copy.
From `src/lib/git_events.rs`, when generating a patch, PR, or cover letter event.
This means every patch/PR/issue event contains `a` tags of the form:

```
["a", "30617:<maintainer-pubkey>:<identifier>", "<relay-hint>"]
```

— one for each maintainer in the connected set.

### Why This Matters for Clients

A client querying for issues/PRs/patches for a repository should **filter by any of the maintainer coordinates**, not just the selected maintainer's coordinate. An issue tagged with Bob's coordinate is just as much a part of the repository as one tagged with Alice's coordinate, provided Alice and Bob are in the same maintainer chain.
Practically: to fetch all issues for a repository, query for kind 1621 events that have an `a` tag matching `30617:<any-maintainer-pubkey>:<identifier>`.
Also note: maintainer pubkeys are also added as `p` tags on patches/PRs (for notification routing), but the `a` tags are the authoritative repository reference.

### Confirming Item Attribution

The broad recursive query is a discovery boundary, not sufficient proof that
every returned item belongs to the accepted repository group. For each issue,
PR, or patch, intersect its `a` coordinates with the selected maintainer and
the reciprocally confirmed maintainer coordinates.

- If the intersection is non-empty, display the item normally.
- If the item references only requested/unreciprocated coordinates, keep it
  discoverable but show a prominent unconfirmed-attribution warning on list and
  detail views.
- Explain that the item may belong to another repository with the same
  identifier. Its maintainers can resolve this by accepting the
  relationship; an unintended invitation should be removed by the selected
  maintainer.

---

## The Selected Maintainer: A User's Starting Anchor

### The Problem

A web client cannot independently verify every repository on the network. Anyone can publish a kind 30617 announcement claiming to maintain any project. The client needs a starting point for resolution.

### The Solution: One Selected Maintainer Per User

Each user configures **a single selected maintainer** — one npub they have chosen (e.g. a developer whose identity they have verified out-of-band). This is the root of their discovery graph.
From that single anchor, the client discovers repositories and other maintainers by following the maintainer chain recursively. This mirrors how discovery works in practice: you select specific people, and through them you discover others.
This is a deliberate design constraint. Multiple roots would complicate the model significantly and are not needed — the recursive chain handles the multi-maintainer case naturally.

### Discovery Flow

Given a user's selected maintainer T:

1. Fetch T's announcements (kind 30617 authored by T)
2. For each announcement, resolve the full recursive maintainer chain (as above)
3. The resulting interconnected set of pubkeys + identifier = one repository to display
   Different users with different selected maintainers may arrive at the same repository from different directions. User 1 selects Alice, User 2 selects Bob — if Alice and Bob are in the same maintainer chain for `my-project`, both users see the same repository. The `selected_maintainer` field in each user's resolved `RepoRef` will differ (Alice vs Bob), but the underlying repository — its name, description, git data, issues, PRs — is the same.

---

## The Scam: Unilateral Listing

### The Attack

Eve wants her repository to appear legitimate. She publishes:

```
Eve's announcement for "my-project":
  maintainers: [Alice]   ← Alice is a well-known developer
```

Alice has never heard of Eve's project. But if a client naively displays "Alice is a maintainer of this repository", users may trust Eve's repo because of Alice's reputation.

### Authorization Is Directional

From Eve's selected coordinate, Alice is in the recursive authorization set.
This permissive read model is required for interoperability and matches
ngit-grasp push authorization. It does not mean Alice accepted the association.

### Why It IS a Display Problem

A client that shows Alice as a maintainer of Eve's repo is misleading users. It could be used to lend false legitimacy to a scam project, a malicious fork, or a phishing repository.

### The Solution: Distinguish Authorized from Accepted

A client uses every reachable pubkey for state, issue, PR, patch, and label
authorization, but shows only reciprocally connected pubkeys as accepted
maintainers. Present every directly listed, unreciprocated pubkey under the
familiar **Invited maintainers** heading:

- Present every invitation the same way unless the invitee has authored a
  repository state event that requires explicit reconciliation.

Keep the invited-maintainers list compact. Show who sent an invitation only
when fewer than all confirmed maintainers listed that recipient. Do not expose
whether the recipient already has an announcement for the identifier.

Repository-wide warnings should combine related join requests into one
sentence: list all direct recipients, then list the requested repository groups
as natural-language links rather than rendering one warning row per group.

Derive the direction of every invitation from the direct announcement edge:
the confirmed maintainer who lists another pubkey sent the invitation, and the
maintainer they directly listed received it. A lead maintainer may represent
the recipient's existing repository group, but must not be presented as the
invitation recipient unless the direct edge names them.

If the logged-in account is requested, the repository page should offer an
explicit acceptance flow that publishes the account's own updated announcement.
The flow preserves the account's existing maintainer relationships and lets the
account choose which accepted maintainers in the joining repository to list. It
defaults to the sole maintainer when there is only one option, or the unique
lead maintainer when one exists. When multiple maintainers have ambiguous
leadership, it defaults to no selection and requires the invitee to choose one
or more lead maintainers explicitly.

For every invitation without an invitee-authored state event, the client
publishes a reciprocal announcement to the invitee's selected GRASP servers.
Server choices default, in order, to the invitee's existing repository
announcement, their kind:10317 User Grasp List, or the other maintainers'
servers. The client backfills from its default server list until three choices
are selected.

The selected servers MUST advertise GRASP-02. They discover the canonical state
event from the relays and fetch its missing Git data from the other maintainers'
clone URLs. The UI treats the invitation as accepted as soon as the reciprocal
announcement is published, then shows **Syncing up your GRASP servers** while
the client polls each new Git endpoint until every canonical ref is advertised.

If the invitee already has both an announcement and a kind:30618 state event,
the client MUST NOT accept by publishing only a reciprocal announcement. The
two state histories must first be reconciled into an explicit combined ref set,
then synchronized to every Grasp server involved before the reciprocal
announcement is treated as complete.

Infrastructure and metadata from directionally authorized invited repositories
remain active consumption inputs. Detailed provenance views must label those
sources as invited repositories rather than presenting them as accepted
co-maintainers.

---

## Practical Display Guidelines

### Defining a Repository for Display

A repository shown to the user is:

- A single identifier string
- Plus the full directional recursive authorization set reachable from the
  selected maintainer.
- Plus an accepted subset used for maintainer identity and publishing controls.

### Displaying Repository Metadata

| Field       | Source                                                             |
| ----------- | ------------------------------------------------------------------ |
| Name        | Latest event (by `created_at`) across all maintainer announcements |
| Description | Latest event across all maintainer announcements                   |
| Web URLs    | Latest event across all maintainer announcements                   |
| Clone URLs  | Union of all maintainer announcements (all copies available)       |
| Relays      | Union of all maintainer announcements                              |
| Maintainers | Reciprocally confirmed subset; group the remainder by repository   |

### Authoritative vs Suggestive Content

| Content type                    | Authoritative if authored by | Otherwise             |
| ------------------------------- | ---------------------------- | --------------------- |
| State events (branch/tag heads) | Any recursive maintainer     | Ignore                |
| Issue/PR/patch status           | Any recursive maintainer     | Ignore                |
| NIP-32 labels                   | Any recursive maintainer     | Display as suggestion |
| General comments/reactions      | Any participant              | Display as-is         |

### Querying Issues, PRs, and Patches

To fetch all issues/PRs/patches for a repository, query for the relevant kinds with an `a` tag matching any of the maintainer coordinates:

```
kinds: [1621]  (issues)
#a: ["30617:<alice-pubkey>:<identifier>", "30617:<bob-pubkey>:<identifier>", ...]
```

Include all maintainer pubkeys in the filter, not just the selected maintainer's.

### Handling Forks / Splits

When two announcements share an identifier but are **not** connected through the maintainer chain:

- Treat them as separate repositories
- The user will see only the one(s) reachable from their selected maintainer
- If both are reachable (e.g. the user trusts someone in each chain), display them distinctly — they are different projects that share a name
- Consider a "related repositories" note if they share git history (same `r` root commit tag)

### The No-Trusted-Maintainer Case

Without a trust anchor the client has no basis for filtering. Options:

- Prompt the user to configure a selected maintainer before showing repositories
- Show all repositories with a clear "unverified" warning
- Default to showing only repositories where the logged-in user is in the maintainer chain

---

## Summary

| Concept                        | Definition                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Repository identity            | An identifier + a directional graph rooted at the selected maintainer                     |
| Maintainer chain               | Recursive: owner lists maintainers, who list their own maintainers, etc.                  |
| Accepted maintainer            | A reachable pubkey whose announcement links back to the accepted component                |
| Invited maintainer             | A directly listed pubkey that has not reciprocated the listing                            |
| Existing-repository invitation | An invitation whose recipient already maintains a repository with the same identifier     |
| Split                          | Directional authorization ends when an upstream maintainer removes the outgoing path      |
| Selected maintainer            | The single user-chosen npub that anchors all discovery                                    |
| `selected_maintainer` field    | The starting pubkey for resolution; used in naddr coordinates                             |
| Name / description / web       | Taken from the latest announcement event across all maintainers                           |
| Clone URLs / relays            | Unioned across all maintainer announcements                                               |
| Authoritative events           | State, issue/PR/patch status, and NIP-32 labels from any recursive maintainer             |
| Suggestive events              | NIP-32 labels from outside the maintainer set                                             |
| `a` tags on issues/PRs/patches | One per maintainer — all maintainer coordinates tagged, not just the selected one         |
| Scam prevention                | Use unilateral listings for authorization, but distinguish invitations from join requests |

---
