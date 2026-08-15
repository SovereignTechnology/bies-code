# ngitstack Custom Nostr Events

GitWorkshop's software release implementation follows the vendored [NIP-82 Software Applications](docs/NIP-82.md), including its release asset clarifications.

## Notification Read State (kind 30078)

Uses [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) (Arbitrary Custom App Data) to persist notification read/archived state across devices.

Notification state uses two addressable events. The user's primary account only creates and decrypts a key envelope; routine state updates use the dedicated keypair stored in that envelope.

### Key Envelope

The key envelope is authored by the user's primary account and NIP-44 encrypted to the same account:

```json
{
  "kind": 30078,
  "tags": [["d", "git-notifications-nsec"]],
  "content": "<NIP-44 encrypted JSON>"
}
```

When decrypted, its content contains the hex-encoded private key for a dedicated notification keypair:

```json
{
  "nsec-for-notification-state": "<hex private key>"
}
```

The field contains the raw private key encoded as hexadecimal, not a Bech32 `nsec1...` string. Readers MUST also accept the legacy `{ "nsec": "<hex private key>" }` content schema, but writers MUST use `nsec-for-notification-state` for newly created envelopes.

### State Event

The state event is authored by the dedicated notification keypair and NIP-44 encrypted to that keypair's own pubkey:

```json
{
  "kind": 30078,
  "tags": [["d", "git-notifications-state"]],
  "content": "<NIP-44 encrypted JSON>"
}
```

### State Content Schema

When decrypted with the dedicated notification keypair, the state event contains a JSON object with the following fields:

| Field | Type       | Description                                                                                            |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `rb`  | `number`   | Unix timestamp (seconds). All notification events with `created_at <= rb` are considered **read**.     |
| `ri`  | `string[]` | Event IDs individually marked as read that have `created_at > rb` (exceptions after the cutoff).       |
| `ab`  | `number`   | Unix timestamp (seconds). All notification events with `created_at <= ab` are considered **archived**. |
| `ai`  | `string[]` | Event IDs individually marked as archived that have `created_at > ab` (exceptions after the cutoff).   |

### Example (decrypted content)

```json
{
  "rb": 1711900000,
  "ri": ["aabb...", "ccdd..."],
  "ab": 1711800000,
  "ai": ["eeff..."]
}
```

### Design Rationale

Separating the key envelope from the state event avoids repeatedly invoking the user's primary signer. The primary signer is needed when creating the envelope and when decrypting a newer envelope received from another device. The decrypted dedicated key is cached locally, and all subsequent state encryption, decryption, and signing use that keypair.

The high-water-mark model keeps the payload compact:

- The timestamp cutoff (`rb`/`ab`) marks everything older as read/archived without storing individual IDs.
- The ID arrays (`ri`/`ai`) only hold exceptions — events newer than the cutoff that have been individually acted on.
- Periodically the cutoff is advanced and the arrays are pruned, keeping the payload bounded.

This is the same model used by [gitworkshop.dev](https://gitworkshop.dev) for notification state, adapted from localStorage to NIP-78 for cross-device sync.

---

## Pinned Git Repositories (kind 10617)

A NIP-51 standard replaceable list that stores a user's curated, ordered set of their own repositories to highlight on their profile page.

### Event Structure

```json
{
  "kind": 10617,
  "tags": [
    ["a", "30617:<pubkey>:<dtag>"],
    ["a", "30617:<pubkey>:<dtag>"]
  ],
  "content": ""
}
```

### Tag Schema

| Tag | Description                                                                       |
| --- | --------------------------------------------------------------------------------- |
| `a` | Address pointer to a kind:30617 repository announcement. One tag per pinned repo. |

### Ordering

The order of `a` tags in the event is significant — it defines the display order of pinned repositories on the user's profile page. Clients SHOULD preserve tag order when modifying the list and SHOULD append new pins to the end.

### Design Rationale

Follows the same NIP-51 standard list pattern as:

- kind:10017 — Git authors follow list
- kind:10018 — Git repositories follow list

Uses `a` tags (address pointers to kind:30617 announcements) consistent with kind:10018. The list is intended for a user's **own** repositories only, acting as a curated showcase rather than a general-purpose follow list.

---

## Inline Code Review Comments (kind:1111)

Inline comments on NIP-34 patches and pull requests follow [NIP-22](https://github.com/nostr-protocol/nips/blob/master/22.md) with additional tags for code location context.

The NIP-22 root (`E`/`K`/`P`) is always the original PR (kind:1618) or patch (kind:1617). The parent (`e`/`k`/`p`) is either that same event or a PR update (kind:1619) when commenting on a specific revision.

```jsonc
{
  "kind": 1111,
  "content": "<comment>",
  "tags": [
    // NIP-22 root — the PR or patch
    ["E", "<pr-or-patch-event-id>", "<relay>", "<author-pubkey>"],
    ["K", "<1618-or-1617>"],
    ["P", "<author-pubkey>", "<relay>"],

    // NIP-22 parent — same as root, or a PR update (1619) for revision-specific comments
    ["e", "<pr-patch-or-update-event-id>", "<relay>", "<author-pubkey>"],
    ["k", "<1618-or-1617-or-1619>"],
    ["p", "<author-pubkey>"],

    // repository reference — one per maintainer
    ["q", "30617:<maintainer-pubkey>:<repo-id>", "<relay>"],
    ["q", "30617:<co-maintainer-pubkey>:<repo-id>", "<relay>"], // repeat for each maintainer

    // file path
    ["f", "<path/to/file.rs>"],

    // the commit for which the comment applies, typically where the lines in question were added/removed
    ["c", "<commit-id>"],

    // line or range within the file at the specified commit (optional), e.g. "42" or "42-48"
    // to refer to pre-commit removed lines use `["line", "3-6", "del"]` instead
    ["line", "<line-or-range>"],
  ],
}
```

Replies to an inline comment are standard NIP-22 replies: `E`/`K`/`P` remain the original PR/patch; `e`/`k`/`p` point to the inline comment (kind:1111).

### Inline Suggestions

A reviewer can propose a specific replacement for the lines referenced by the `line` tag by including a fenced code block with the language identifier `suggestion` in the comment `content`. The fence contains the exact replacement lines (without indentation changes relative to the original). The `line` tag on the same event defines the range being replaced.

````markdown
```suggestion
    let result = compute(x, y);
    result
```
````

Clients that understand suggestions SHOULD render an "Apply suggestion" button that constructs a patch replacing the referenced lines with the suggestion content and presents it to the PR author. Clients that do not understand suggestions display the fenced block as a normal code block, so the suggestion remains human-readable.

Rules:

- A suggestion MUST have a `line` tag specifying the range to replace.
- A suggestion MUST have an `f` tag specifying the file.
- A suggestion MUST have a `c` tag specifying the commit the suggestion applies to.
- The suggestion content replaces the referenced lines verbatim; reviewers SHOULD preserve surrounding indentation.
- A comment MAY contain prose outside the suggestion fence.

### Resolving a Thread

Any sub-thread (an inline comment or any NIP-22 comment thread) can be resolved by posting a kind:1111 reply with a `l` tag of `"resolved"`. Clients that don't support resolution see it as a normal comment. The thread is considered resolved if such an event exists and has not been deleted.

```jsonc
{
  "kind": 1111,
  "content": "marked as resolved",
  "tags": [
    // NIP-22 root — unchanged from the rest of the thread
    ["E", "<pr-or-patch-event-id>", "<relay>", "<author-pubkey>"],
    ["K", "<1618-or-1617>"],
    ["P", "<author-pubkey>", "<relay>"],

    // NIP-22 parent — the sub-thread root being resolved
    ["e", "<thread-root-comment-id>", "<relay>", "<author-pubkey>"],
    ["k", "1111"],
    ["p", "<author-pubkey>"],

    // resolution state
    ["l", "resolved"],
  ],
}
```

To check whether a specific comment thread is resolved without fetching the whole PR thread:

```jsonc
{ "kinds": [1111], "#e": ["<thread-root-comment-id>"], "#l": ["resolved"] }
```

### Relay Queries

```jsonc
// all inline comments on a repository
{ "kinds": [1111], "#q": ["30617:<pubkey>:<repo-id>"] }

// all inline comments on a specific file
{ "kinds": [1111], "#q": ["30617:<pubkey>:<repo-id>"], "#f": ["src/parser/mod.rs"] }

// all inline comments on a PR (all revisions)
{ "kinds": [1111], "#E": ["<pr-event-id>"] }

// all inline comments targeting a specific commit
{ "kinds": [1111], "#c": ["<commit-id>"] }
```

---

## Pull Request Reviews (kind:7321)

A PR review groups one or more inline comments (kind:1111) under a single verdict event. Any user can submit a review; the verdict is not authoritative over the PR's open/merged/closed state (that remains with NIP-34 kinds 1630–1633).

### Verdict values (`s` tag)

| Value              | Meaning                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACK`              | Reviewer has tested or carefully read the code and approves it as-is.                                                                                            |
| `NACK`             | Reviewer objects to the change; the PR should not be merged in its current form.                                                                                 |
| `Concept ACK`      | Reviewer agrees with the goal/approach but has not fully reviewed the implementation.                                                                            |
| `Concept NACK`     | Reviewer disagrees with the goal or approach regardless of implementation quality.                                                                               |
| `Changes Required` | Reviewer has identified specific changes that must be made before the PR can be merged; typically accompanied by inline comments detailing what needs to change. |

### Event Structure

```jsonc
{
  "kind": 7321,
  "content": "<optional overall review summary / prose>",
  "tags": [
    // NIP-34 PR or patch being reviewed (required)
    ["e", "<pr-or-patch-event-id>", "<relay>", "root"],
    ["p", "<pr-or-patch-author-pubkey>"],

    // verdict (required)
    ["s", "<ACK|NACK|Concept ACK|Concept NACK|Changes Required>"],

    // inline comments included in this review (zero or more)
    // each q tag references a kind:1111 comment event published by the same author
    ["q", "<comment-event-id>", "<relay>"],
    ["q", "<comment-event-id>", "<relay>"],

    // NIP-31 alt tag for clients that don't understand kind:7321
    [
      "alt",
      "Pull request review: <ACK|NACK|Concept ACK|Concept NACK|Changes Required>",
    ],
  ],
}
```

### Rules

- The review event MUST be authored by the reviewer (not the PR author or a maintainer acting on their behalf).
- Each `q` tag referencing a comment MUST point to a kind:1111 event authored by the same pubkey as the review event.
- The `s` tag value MUST be one of the five verdict strings above (case-sensitive).
- `content` is optional but SHOULD be used for an overall summary when the verdict alone is insufficient.
- A review is immutable once published. To change a verdict, publish a new kind:7321 event; the most recent event by `created_at` from a given pubkey for a given PR is considered the current verdict.

### Relay Queries

```jsonc
// all reviews on a PR or patch
{ "kinds": [7321], "#e": ["<pr-or-patch-event-id>"] }

// all ACK reviews on a PR
{ "kinds": [7321], "#e": ["<pr-event-id>"], "#s": ["ACK"] }

// all reviews by a specific reviewer
{ "kinds": [7321], "authors": ["<reviewer-pubkey>"] }
```

### Design Rationale

- **Regular (not replaceable) kind**: review history is preserved. Clients display the most recent verdict per reviewer by sorting on `created_at`.
- **`s` tag for verdict**: single-letter tag, relay-indexed, enabling efficient filtering by verdict without fetching event content.
- **`q` tags for comments**: comments are explicitly enumerated so clients can reconstruct the exact set of comments belonging to a review without scanning all PR comments.
- **Separate from 1630–1633 status kinds**: those are authoritative state changes by maintainers; a review is a reviewer's opinion and carries no merge authority.

---

## Shared Issue / Patch / PR Metadata

The following features apply uniformly to all three NIP-34 root item kinds — issues (kind:1621), patches (kind:1617), and pull requests (kind:1618). They let an item be re-tagged, re-titled, or annotated **after the fact**, without modifying (or being able to modify — these are regular, immutable events) the original root event.

### Authorisation

All three features share the same authorisation rule: an event is only **authoritative** if its author is either

1. the **root item author** (the pubkey that published the issue/patch/PR), or
2. a **confirmed maintainer** of the repository (a pubkey in the repo's transitive maintainer set — see the "Repository authorization model" in `AGENTS.md`).

Events from any other pubkey are ignored when deriving the item's effective state. Because the maintainer set is only known once the repo announcements load, clients MAY treat the root author as authorised before maintainers resolve to avoid a flash of missing metadata.

### After-the-fact Labels (NIP-32, kind:1985)

Labels are attached to an item with a [NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md) label event. The label namespace is `#t` (the same convention NIP-34 root items use for inline `t` tags), declared with an `L` tag and carried in one or more `l` tags.

```jsonc
{
  "kind": 1985,
  "content": "",
  "tags": [
    // root item being labelled (NIP-10 root pointer)
    ["e", "<issue-patch-or-pr-event-id>", "<relay>", "root"],

    // namespace declaration
    ["L", "#t"],

    // one l tag per label, all in the #t namespace
    ["l", "bug", "#t"],
    ["l", "needs-triage", "#t"],
  ],
}
```

An item's effective label set is the union of:

- the root event's own inline `t` tags, and
- every `l` tag (namespace `#t`) from **authorised** kind:1985 events referencing it,

deduplicated and sorted. Labels are additive across multiple label events; a label event is itself a regular event and can be removed with a NIP-09 deletion (kind:5) by its author. Label events are fetched as part of the per-item "essentials" loader (`#e` fan-out).

### Subject Edits (NIP-32, kind:1985 with `#subject` namespace)

A subject (title) edit reuses the same kind:1985 label event but with the dedicated namespace `#subject`. The label value is the new subject string.

```jsonc
{
  "kind": 1985,
  "content": "",
  "tags": [
    // root item being re-titled (NIP-10 root pointer)
    ["e", "<issue-patch-or-pr-event-id>", "<relay>", "root"],

    // subject-rename namespace
    ["L", "#subject"],

    // the new subject/title
    ["l", "Fix race condition in the merge queue", "#subject"],
  ],
}
```

The item's **effective subject** is the value of the latest authorised `#subject` rename event by `created_at` (ties broken by event ID); if no authorised rename exists, the subject falls back to the root event's original `subject` tag. Clients SHOULD render renames as timeline entries distinct from `#t` labels so the edit history is visible.

### Cover Notes (kind:1624)

A cover note is a pinned, editable note posted by the item author or a maintainer that renders **above** the item's first description card — useful for status banners, summaries, or "blocked on X" context. Unlike the root event, a cover note can be superseded at any time by publishing a newer one.

```jsonc
{
  "kind": 1624,
  "content": "<markdown body>",
  "tags": [
    // root item being annotated (NIP-10 #e with "root" marker)
    ["e", "<issue-patch-or-pr-event-id>", "<relay>", "root"],
    ["p", "<root-item-author-pubkey>"],
    ["k", "<1621-1617-or-1618>"],

    // optional NIP-94 imeta tags for embedded Blossom uploads
    ["imeta", "url https://...", "..."],

    // NIP-31 alt tag for clients that don't understand kind:1624
    ["alt", "Cover note for a git issue or PR"],
  ],
}
```

Resolution rules:

- Only **authorised** cover notes (root author or maintainer) are considered.
- The **latest** authorised cover note by `created_at` (ties broken by event ID, descending) is the one displayed.
- All authorised cover notes are retained so clients MAY surface edit history; older notes by other authorised authors remain queryable.

Cover notes reference the root via **lowercase** NIP-10 `#e` (not the uppercase NIP-22 `#E`), so they thread alongside legacy NIP-34 replies and are fetched by the repo-level cover-note loader.

### Relay Queries

```jsonc
// all labels and subject renames on an item (both are kind:1985)
{ "kinds": [1985], "#e": ["<item-event-id>"] }

// cover notes on an item
{ "kinds": [1624], "#e": ["<item-event-id>"] }
```

### Design Rationale

- **Regular, immutable events**: the root issue/patch/PR is never mutated. Labels, renames, and cover notes are separate events whose authority is decided by the author + maintainer rule, so anyone can _propose_ but only authorised pubkeys _affect state_.
- **NIP-32 for labels and subjects**: reuses a standard kind rather than minting a custom one; the `#subject` namespace cleanly separates renames from `#t` categorisation while sharing the same event shape and loader.
- **`#t` namespace alignment**: matches the inline `t` tags on root items so the union of both sources is the natural label set.
- **Cover note as kind:1624 with lowercase `#e`**: mirrors gitworkshop's CoverNote feature and keeps cover notes inside the NIP-10 thread the repo loader already fetches.

---

## NIP-34 CI extension — consumed and emitted

gitworkshop implements the experimental CI protocol published by [`ngit-ci`](https://gitworkshop.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit-ci/tree/master/NIP.md). That working NIP is authoritative; this section records the client behavior and trust boundaries.

|  Kind | Event                         | Client behavior                                                                                                                                                               |
| ----: | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19843 | Coordinator Advertisement     | Consumed from Git index relays as the short-lived coordinator liveness, capability, admission, execution, billing, and secret-recipient signal.                               |
| 19844 | Request-Readiness List        | Consumed from Git index relays for exact repository `a` items and maintainer-rooted `p` items. It is a discovery hint, never authority.                                       |
| 19845 | Nix Provider Advertisement    | Understood as the capability and allocation-inbox event quoted by native Nix allocations. It does not confer provider trust.                                                  |
| 39844 | Coordinator Repository Status | Consumed from repository relays to show effective workflow paths, runner capabilities, and a value-free secret inventory for coordinators currently acting on the repository. |
|  9843 | Service Request               | Emitted by a confirmed maintainer to request standing service from one coordinator for the selected repository perspective.                                                   |
|  9844 | Service Stop                  | Emitted by a confirmed maintainer to stop earlier standing requests for the selected perspective.                                                                             |
|  9845 | Nix Job Allocation            | Understood through the allocation quote on a provider-signed Job Result, preserving coordinator-versus-provider provenance.                                                   |
| 29846 | Repository Secret Update      | Emitted ephemerally to the exact inbox relays and NIP-44 recipient from a live Coordinator Advertisement.                                                                     |
|  9840 | Manual Trigger                | Emitted by a confirmed maintainer to replay an exact workflow/commit combination.                                                                                             |
|  9841 | Job Result                    | Consumed as the compute provider's direct execution claim, including logs, artifacts, public outputs, and omitted outputs.                                                    |
|  9842 | Workflow Result               | Consumed as the coordinator's combined conclusion and acceptance of its quoted Job Results.                                                                                   |
| 39842 | Workflow Progress             | Consumed as an expiring, replaceable queued/in-progress/recently-concluded marker.                                                                                            |

### Coordinator discovery and service control

A kind:19843 Advertisement is actionable only while its NIP-40 expiry is live. gitworkshop validates the required `W`, `R`, `M`, `X`, and `expiration` shape and never interprets an unknown policy as open, automatic, or free service. Runner selectors use `<family>:<selector>`; `runs_on` remains result-only metadata.

The Actions page separates coordinators into:

- **Watching** — a live Advertisement plus a matching, unexpired kind:39844 status on a repository relay.
- **Ready for this repo** — a live Advertisement plus a matching `a` or maintainer-rooted `p` entry in the coordinator's kind:19844 list.
- **Available coordinator** — a live Advertisement which may be selected or requested according to its published admission policy.

All live coordinators remain visible because independent service discovery is intentionally open. The signing identity, policy, software version, families, and selectors are shown; a discovery event is not presented as repository authority.

For request-required execution, a confirmed maintainer can publish kind:9843 or kind:9844 with exactly the selected repository `a` coordinate and coordinator `p` tag. These events are sent to the maintainer outbox, repository relays, and the coordinator's NIP-65 inbox. Reads are filtered by the repository's current confirmed maintainer authors. Controls are ordered by `created_at`, with the lexicographically lower event ID later at equal timestamps.

### Repository secret updates

Secret controls appear only for confirmed maintainers and coordinators whose live Advertisement contains a valid `secrets-key` tag. gitworkshop:

1. creates a fresh secp256k1 sender key for each submission;
2. binds the plaintext `author` and `created_at` to the outer maintainer-signed event;
3. encrypts the atomic `set`/`remove` mutation using NIP-44 v2 and the exact advertised recipient;
4. erases the temporary sender and conversation keys after encryption;
5. signs kind:29846 with exactly the protocol tags, without a client or `alt` tag;
6. publishes directly to every advertised secret-inbox relay and requires at least one relay acknowledgement.

The signed update is deliberately not added to the general EventStore or durable outbox. Secret names and values are encrypted together. Relay acknowledgement proves delivery to an inbox, not coordinator acceptance or storage, so every submitted name remains pending in the UI until a newer kind:39844 status reports the matching set or removal. That status may disclose only effective names, source maintainer pubkeys, update timestamps, and the optional `sealed` marker; the UI never expects or displays a value from public repository status.

The reserved name `WORKFLOW_SECRETS_DECRYPTION_BUNKER` is managed through a dedicated control. Its value must be a NIP-46 `bunker://` URI and is never injected into jobs. It lets a compatible coordinator choose to store values sealed against a maintainer-controlled remote signer, which is asked to unlock them once per workflow at job time. The client keeps the URI in a protected input, validates it with the same NIP-46 parser used for login, and submits or removes it through the ordinary atomic kind:29846 mutation. Replacing or removing the binding warns that values sealed to the previous bunker may need to be resubmitted.

Secret updates use the active maintainer's own `30617:<author>:<repo-id>` perspective. This preserves the NIP's job-time authorization boundary: stored values remain usable only while that perspective is in the current confirmed maintainership.

The client also rejects the coordinator/runner-owned names `PATH`, `HOME`, `CI`, `DOCKER_HOST`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`, plus the `GITHUB_`, `NGIT_CI_`, `RUNNER_`, and `ACTIONS_` namespaces, before encryption. The bunker binding name is rejected from generic secret fields and accepted only through its dedicated control.

For Nostr-provisioned inventory entries, gitworkshop accepts the optional fifth literal field in `["secret","<name>","<maintainer>","<created-at>","sealed"]` and labels that value as bunker-sealed. The reserved bunker binding is shown as at-rest configuration rather than as a workflow secret.

### Workflow and job interpretation

Workflow events share repository `a`, commit `c`, workflow `w`, and normalized trigger `o` tags. Push contexts use a Git-ref `r`; pull-request contexts use uppercase `E`/`K`/`P` root tags and lowercase `e`/`k`/`p` parent tags.

Every Workflow Result includes its workflow-run ID as the non-Git-ref `r` value matching Workflow Progress `d`. gitworkshop uses this exact pair to retire the pending marker. For older publishers without the result run ID, the conservative compatibility fallback remains coordinator + `queued_at` + complete shared trigger context; ambiguous fallbacks never hide a pending attempt.

A queued request-gated Progress event intentionally has no Service Request quote. From the first `in_progress` replacement onward, the frozen provenance is:

```jsonc
[
  "q",
  "<9843-request-id>",
  "<relay-url>",
  "<requester-pubkey>",
  "service-request",
]
```

Manual replays analogously use the `manual-trigger` marker. gitworkshop fetches the exact signed request from its quoted relay, labels the run **Maintainer requested**, and shows the requester as the first timeline phase. Runs without either quote are not given that treatment.

Job Results are rendered only inside a Workflow Result or Progress event which quotes them. The provider signer is always shown separately from the coordinator. A marked `job-allocation` quote identifies directed native Nix execution and its coordinator. Artifact tags retain both the per-file path and artifact group name. Public `output` values and `output-omitted` reasons (`missing`, `oversized`, or `unresolved`) are displayed distinctly; an omitted output is never treated as an empty value.

### Query strategy

```jsonc
// Live coordinator discovery and repo-specific readiness, on Git index relays
{ "kinds": [19843] }
{ "kinds": [19844], "#a": ["30617:<pubkey>:<repo-id>"] }
{ "kinds": [19844], "#p": ["<confirmed-maintainer-pubkey>"] }

// Acting coordinator state, on repository relays
{ "kinds": [39844], "#a": ["30617:<pubkey>:<repo-id>", "..."] }

// Coordinator profile discovery, followed by author-filtered acting state
// from its own outbox and the relays of readiness-targeted repositories
{ "kinds": [10002, 19843, 19844], "authors": ["<coordinator-pubkey>"] }
{ "kinds": [39844], "authors": ["<coordinator-pubkey>"] }
{ "kinds": [39844], "authors": ["<coordinator-pubkey>"], "#a": ["<target-repository-coordinate>", "..."] }

// Trust-bearing standing controls, author-filtered on repository relays
{ "kinds": [9843, 9844], "authors": ["<confirmed-maintainer>", "..."], "#a": ["30617:<selected-maintainer>:<repo-id>"] }

// PR activity through the pre-wired #E fan-out
{ "kinds": [9841, 9842, 39842], "#E": ["<pr-event-id>"] }

// Commit ticks and Actions history
{ "kinds": [9841, 9842, 39842], "#c": ["<commit-id>", "..."] }
{ "kinds": [9841, 9842, 39842], "#a": ["30617:<pubkey>:<repo-id>", "..."] }
```

All relay reads use the resilient subscription/request layer. PR events continue to ride the pre-wired NIP-22 loaders; commit queries use the singleton batched `#c` loader; repo-wide result/log history loads only on the Actions page. A live Coordinator Advertisement also makes the Actions tab visible before the repository's first run.

The coordinator profile discovers kind:10002, Advertisement, and Request-Readiness events on Git index and lookup relays. It fetches Repository Status from the coordinator's declared NIP-65 write relays and from the relays declared by every readiness-targeted repository, with an author filter fixed to the coordinator. A status is included only when EventStore provenance confirms it was observed on an outbox or on a matching target repository relay. This repository-relay path preserves acting-state discovery before a coordinator publishes NIP-65 metadata. Unexpired status with a live Advertisement is shown as current activity; expired status is retained separately as history. Exact readiness `a` entries and pubkey-wide `p` entries are resolved to repositories before querying their relay sets; all maintainer coordinates are treated as the same repository when excluding active repositories from the readiness-only list.

When the coordinator publishes a NIP-05 identity, the profile resolves it back to the coordinator pubkey before requesting the domain's NIP-11 document. The page reports advertised GRASP capabilities and whether the NIP-11 operator `pubkey` matches the coordinator signer. This is identity and infrastructure evidence, not repository authority.

### Trust boundaries

- Repository service controls are accepted into the UI state only from current confirmed maintainers.
- Coordinator Advertisements, Readiness Lists, and Repository Status are independent signed service claims. Matching a repository does not make their author a maintainer or trusted runner.
- A Job Result is the provider's execution claim. A Workflow Result is the coordinator's claim that it scheduled or accepted those quoted results. gitworkshop shows both identities instead of collapsing them.
- Repository coordinate matching uses the full multi-maintainer coordinate set, while mutations retain the exact selected or author-rooted perspective required by the CI NIP.
