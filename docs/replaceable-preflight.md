# Replaceable-event preflight

## Purpose

Updating a replaceable or addressable Nostr event can destroy information if
the replacement is based on a stale local copy. GitWorkshop therefore takes
reasonable steps to discover the current event before signing a replacement.
Those steps must not make an otherwise healthy application depend on every
configured relay responding promptly.

In this document, **preflight** means the action-time decision over evidence
already accumulated by the application. It does not necessarily mean opening a
new relay request when the user clicks a button. Relevant pages and account
sessions should normally keep that evidence warm so the decision is immediate.

EOSE is evidence that one relay answered one exact query. It is not evidence of
global Nostr truth, and an open WebSocket alone is not evidence that the query
was ever live or completed its initial backfill.

## Execution pattern

Every writer of a replaceable or addressable event should follow this pattern:

1. Classify the event using the categories below and declare any modifiers.
2. Define the evidence scope: coordinate or filter, trusted authors, relay
   groups, deletion evidence, and the category-specific sufficiency rule.
3. Start the relevant subscription at the account or page-session boundary.
4. Expand discovery without blocking as user intent becomes known, such as
   when an identifier is entered or a prospective maintainer is selected.
5. At action time, freeze the authority and relay scope used for the decision.
6. Reuse current warm coverage. When an owned subscription covers the exact
   evidence scope and satisfies the category's relay threshold, do not repeat
   that request at action time. Wait for relevant in-flight warm work. Issue a
   bounded, focused read only for required authors, coordinates, filters, or
   relay groups that the existing requests do not cover.
7. Pass the resolved winning event into the writer. Rebase the user's intended
   change onto it, preserving fields that the editing surface does not own,
   then apply category invariants. The writer must not reopen a model whose
   fallback loader would repeat covered relay work.
8. Sign only after preflight succeeds.
9. Publish with the transition guarantees required by the category. Publication
   acknowledgement and post-write verification are separate from read
   preflight.

A second request for an already-covered filter on the same relays does not
increase freshness assurance: the subscription's EOSE establishes its initial
snapshot (including the absence of a matching event), and its continued
ownership supplies subsequent live updates. Repeating the request only adds
latency and relay load.

A bounded one-shot read can satisfy genuinely new evidence required by the
current action, but it does not create lasting warm coverage after that request
closes. Prefer starting that discovery as soon as the new scope is known so it
can become warm before action time.

## Categories

Categories define common ownership and evidence rules. A modifier records an
exception without creating a bespoke preflight design.

| Category                     | Examples                                                                                  | Natural warm scope                                                                            | General rule                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Personal singleton           | Profile, NIP-65 mailboxes, follows, Git author/repository lists, GRASP list, Blossom list | Active user's outboxes and configured lookup relays                                           | Establish the owner's latest event before replacing it                                |
| Publisher-owned addressable  | Software application and release events                                                   | Publisher outboxes and relevant distribution relays                                           | Establish the author's current coordinate before replacing it                         |
| Repository authority graph   | Kind `30617` announcements                                                                | One identifier-wide owner on repository relays, enriched by Git index and maintainer outboxes | Resolve authority only from reciprocally confirmed announcements                      |
| Repository operational state | Kind `30618` state                                                                        | The same repository owner, filtered to confirmed maintainers on repository relays             | Establish the latest valid state across the frozen authority set                      |
| Convergent application state | Notification envelopes and similar mergeable state                                        | Active account session                                                                        | Reconcile or merge; do not put a fresh network round-trip before every frequent write |

Regular, append-only, and ephemeral events are outside this policy unless a
writer is replacing another event as part of a larger transition. A fresh,
unique addressable coordinate may also declare that no prior value is expected,
but collision-sensitive creation still needs an absence policy.

## Modifiers and explicit exceptions

- **Create or prove absence:** a new repository, release, or application
  coordinate needs enough evidence to avoid overwriting an unseen coordinate.
- **External-subject discovery:** an action introduces another user whose relay
  routing and existing events are not covered by the active account session.
- **Relay-frontier transition:** changing mailboxes or repository relays requires
  evidence from the old and proposed relay sets and transition-safe publishing.
- **Confidential scope:** private events and private repositories must not add
  public relays merely to satisfy a generic quorum.
- **Derived signer or high-frequency merge:** state written by a derived key or
  frequent background process normally needs reconciliation rather than a
  blocking preflight for every write.
- **Bootstrap identity:** the first profile or mailbox event cannot depend on a
  mailbox event already existing.

Exceptions must name their base category, document why the common rule is not
sufficient, and retain every applicable safety property.

## Warm coverage leases

Warm coverage is owned by the subscription that produced it. It is not inferred
globally from EventStore contents or from a relay connection. For a stable
filter, a relay can have one of these phases:

- `initial`: the current request cycle has not returned a real EOSE;
- `covered`: the current cycle returned EOSE and remains continuously owned;
- `catching-up`: foreground resume or another gap-recovery pass is in progress;
- `not-responding`: the current `initial` or `catching-up` generation exceeded
  its bounded EOSE deadline, while its request remains owned and may recover;
- `unavailable`: the current cycle disconnected, closed, was rate-limited,
  required authentication, or failed;
- `stopped`: the owning session ended or removed the relay.

Coverage becomes valid only after a real EOSE for the complete declared filter.
Before the owner has received that baseline EOSE, every retry repeats the full
filter. Afterwards reconnect and foreground recovery may use a bounded `since`
cursor; the cursor is clamped to the current time before subtracting its overlap
to prevent a future-dated event from skipping ordinary events. It is invalidated
by:

- a relay disconnect or subscription-cycle restart;
- foreground resume until its gap-fill request receives EOSE;
- a change to the filter or frozen authority scope;
- relay removal;
- owner teardown or account/session replacement.

Each cycle has a generation. Completion from an older request or gap fill must
never validate a newer generation. When the subscription owner can add relays
reactively, newly added relays start at `initial` without invalidating unchanged
relays. The current account wiring updates lookup relays this way, but an outbox
list change replaces the identity owner and therefore invalidates every relay
until the replacement subscription reaches EOSE.

The coverage projection gives `initial` and `catching-up` generations a bounded
settlement deadline. Crossing it projects `not-responding` so a silent relay no
longer votes as in-flight forever, but does not cancel or restart the underlying
request. A late EOSE for the same generation still restores `covered`.
`unavailable` facts retain a compact reason so action errors can distinguish
disconnected, rate-limited, authentication, rejection, and recovery states.

The coverage layer reports lifecycle facts. It does not decide whether one,
one-third, a majority, or every relay is enough. Category policy intersects its
relay groups with current coverage and makes that decision separately.

Once that policy is satisfied, the covered subscription is the preflight read
for its exact filter and relay scope. Writers must consume its EventStore state
without issuing a duplicate action-time request. A focused read is appropriate
only when the action introduces required evidence outside that scope; it must
name the uncovered evidence rather than re-querying covered relays defensively.

Dynamic additive filters are not covered by the first implementation. Correct
coverage for them requires per-filter-revision or per-chunk generations,
including additions during initial settlement and consolidation after
reconnect. Until that complexity is justified, their writers use bounded,
focused action-time reads for missing evidence.

Limited and paginated filters are also excluded from full-snapshot coverage. An
EOSE for their first page does not establish confirmed absence, so lifecycle
coverage must not be combined with `limit`, automatic pagination, or manual
pagination until the lifecycle can represent completion of the whole scope.

## Repository-scoped adoption decision

Repository announcements and state share one page-owned logical scope. Its
stable lease contains the identifier-wide kind `30617` filter, the kind `30618`
filter for the currently confirmed maintainer set, and coordinate-addressed
kind `5` deletions. A second repository-wide lease batches exact event-ID
deletion filters for the current announcement and state candidates. It is not
one subscription per kind or writer. A change to the authority set starts a new
stable revision; relay-list changes are handled by the reactive relay frontier.
Repository pages consume events from the EventStore and lifecycle coverage from
these leases instead of repeating their filters at action time.

For a confidential repository, the same owner begins only after private
discovery admits the repository relay set, and it queries only those private
repository relays. It must not add public Git index, fallback, or maintainer
mailbox relays: lifecycle reuse is not permission to disclose a private
coordinate.

For an existing author coordinate, one currently covered repository relay is
sufficient to write. Git index relays and maintainer mailbox relays remain
valuable evidence contributors and publication targets, but they do not vote
on repository preflight: they are not required to answer promptly, and a
repository must not become uneditable because one of them is flaky. The
repository relay voters are frozen before signing so a relay-frontier edit is
judged against the old frontier.

Private repositories vote with their admitted private relay group, not every
relay named in an announcement. A malformed public announcement with no relay
list may use an admitted route relay hint as a repair frontier; the writer shows
that degraded basis to the user so the settings screen remains capable of
adding an explicit repository relay.

An absent public author coordinate is different when the write will create that
coordinate. Before creating it, the action must also establish absence on at
least one of the author's current NIP-65 outbox relays. Kind `30618` is selected
across confirmed maintainers, so a merge or HEAD edit with a warm state winner
does not need a separate absence proof for the signer's unused coordinate.
Confidential repository writes use admitted private repository relays for both
presence and absence and never disclose their coordinates to public mailbox
relays.

A completely new public repository has no old repository frontier, so its
focused collision check requires an EOSE from at least one proposed repository
relay and at least one current author outbox relay. The query covers both
coordinates and their coordinate deletion pointers. A signer-owned
announcement with the same clone and relay frontiers but no state is an
incomplete, resumable creation rather than a collision. Confidential repository
creation keeps its existing private-service-only collision check.

A public-creation retry retains the original signed announcement and state,
commit hash, clone and relay frontiers, and packfile for seven days in local
browser storage. A later attempt for the same coordinate may use that record
only after the focused collision check finds either no competing event or the
exact retained state. It re-publishes the same announcement and state to the
GRASP relays before pushing the same Git objects, re-arming expired purgatory
without creating a state/commit mismatch. Account identity is checked before
either side effect, and successful Git plus durable state delivery removes the
record.

Signed kind `5` requests are a modifier on the repository snapshot. Stable
coordinate pointers stay in the base lease. Candidate-dependent exact `e`
pointers are coalesced for one second into the shared exact-deletion lease; only
that lease is replaced when the candidate set changes. Preflight requires its
EOSE-backed evidence for the winner it freezes. This avoids restarting the
announcement/state query on ordinary event arrivals.

The writer freezes the relevant EventStore winner after those checks and
compares it with the event the editor or operation was based on. A changed
winner aborts before signing. This does not attempt a compare-and-swap protocol
for a relay event that lands after the freeze.

GRASP kind `30618` writes retain their special transition order:

1. run the read preflight before signing;
2. publish the signed state to the GRASP repository relays and require at least
   one relay `OK` as pre-push acceptance;
3. push the dependent Git objects;
4. broadcast the state through the durable outbox path.

A `purgatory:` acknowledgement means the server staged the state until its Git
objects arrive. A plain successful `OK` is weaker: a GRASP implementation
without purgatory may broadcast the state immediately. As of September 8,
2026, Pyramid implements GRASP without purgatory and therefore has the latter
behavior. If the subsequent Git push fails, a purgatory-capable server can
expire its staged state, while a non-purgatory server may leave the accepted
state visible and require the Git push to be recovered.

A purgatory relay is not required to return the staged state from a new query
before the Git objects exist. A non-purgatory relay may return it, but that does
not strengthen the transition. Therefore repository preflight must never
insert a post-signing echo request between steps 2 and 3.

While steps 2 and 3 are in progress, the page freezes its authority revision
and additions to its dynamic exact-deletion lease. A state that becomes visible
immediately on a non-purgatory server therefore cannot trigger a hidden
background REQ in that window. Once the Git transition finishes, pending
authority and candidate changes are adopted and warmed normally.

### Maintainer invitation example

Adding a maintainer is a **repository authority graph** action with the
**external-subject discovery** modifier. The category flow is:

1. Keep the repository's identifier-wide kind `30617` discovery warm on its
   repository relays, while Git index and maintainer mailbox relays enrich the
   same owner without becoming required voters.
2. Let selecting a prospective maintainer remain immediate.
3. At invitation time, consume the repository owner's accumulated evidence.
4. If the prospective candidate's coordinates remain absent, discover that
   user's NIP-65 mailboxes and run one focused kind `30617`/`30618` plus
   deletion query on their outboxes. If the acting maintainer's own kind
   `30617` coordinate is absent, the common writer separately checks that one
   coordinate on the acting maintainer's outbox.
5. Reuse that focused evidence inside the authority snapshot; do not repeat it.

An already discovered candidate announcement needs no mailbox EOSE. If the
candidate coordinate is absent from the repository snapshot, its outbox is the
new scope and must settle before absence is used in the authority transition.
Starting steps 3 and 4 speculatively when a user is selected remains a possible
latency optimization. It needs an owned candidate-coverage lease so the action
can distinguish a completed absence check from an in-flight prefetch; this
phase deliberately keeps the one focused request inside the bounded action.

## Adoption

### Phase 1: stable-filter proof

The first implementation is deliberately limited to personal singleton events
for the active account:

- expose cycle-valid per-relay coverage from the existing persistent identity
  subscription;
- require relays counted by `useRobustReplaceableAction` to have current
  subscription coverage, not merely an open and healthy connection;
- wait up to the five-second warm-coverage deadline when connected identity
  queries are still capable of reaching the threshold, and wake as soon as
  their coverage changes rather than requiring a second user action;
- retain its existing outbox/lookup sufficiency policy and use the covered
  identity subscription directly, without a duplicate action-time request;
- when that snapshot has no target event, perform a bounded exact local cache
  lookup and route any result through the EventStore before writing; this adds
  no relay request and preserves the previous cache evidence;
- pass the resulting event directly into contact and mailbox writers, avoiding
  Applesauce model fallback reads after confirmed absence; relay arrays are
  retained on contact actions for API parity, while mailbox actions use them to
  freeze their old relay frontier; GitWorkshop's global runner chooses ordinary
  publication groups and interprets the mailbox frontier explicitly; the other
  Phase 1 writers already consume local absence without subscribing to the
  loader;
- stop treating a relay as in-flight after its five-second EOSE deadline while
  leaving the live request open for a late recovery, and report an exact status
  breakdown for the outbox and lookup groups;
- verify initial EOSE, reconnect, foreground gap fill, relay membership changes,
  stale generations, and teardown with focused tests.

This phase does not introduce a global filter registry, change repository
preflight, define universal relay thresholds, query fallback relays, or add a
relay-details popover. The network decision waits at most five seconds for the
already-running identity coverage to settle; only the absence path may then add
up to one second for the local cache lookup.

### Phase 2: category adoption

Audit every remaining replaceable/addressable writer, assign its category and
modifiers, and record its relay voters, evidence contributors, deletion scope,
and sufficiency rule. Reuse the stable-filter coverage mechanism where its
semantics fit; do not conceal focused reads or additive-filter complexity behind
an inaccurate common abstraction.

Once a category is adopted, its central subscription owner and preflight helper
should reference this document. Exceptional call sites should name the category
and modifier in a short comment. When a new category or exception is required,
update this document in the same change.

#### Personal-singleton adoption decision

Phase 2 starts by applying one policy to every active-account personal
singleton. This section records both the decision and its current implementation
so differences between later categories remain visible and reviewable.

The category contains kinds `0`, `3`, `10002`, `10017`, `10018`, `10063`,
`10317`, `10318`, and `10617`. A kind does not leave the category merely because
its content is encrypted (`10318`) or because GitWorkshop does not currently
offer an editor for it (`10063`). Kind `62` is not part of the editable state or
its preflight: after requesting a global vanish, a user is not expected to keep
editing personal state in this application.

The common policy is:

1. One account-owned subscription covers all of these singleton kinds for the
   active author on the same normalized union of NIP-65 outboxes and configured
   user-index/lookup relays. Writers must not create a per-kind subscription.
2. Preserve the Phase 1 sufficiency rule. At least one outbox must answer. A
   single answered outbox also needs two answered lookup relays; with multiple
   answered outboxes, three or half of the declared outboxes is sufficient.
   Lookup relays contribute backup evidence but do not make an unknown mailbox
   set safe by themselves.
3. The first-account creation of kinds `0` and `10002` declares the existing
   bootstrap-identity modifier. Every later edit uses the common preflight.
4. Kind `10002` additionally declares the relay-frontier modifier. Its snapshot
   freezes the old mailbox event rather than silently deriving every destination
   from whichever list wins optimistic local insertion. Publication attempts the
   retiring frontier as best-effort and requires the proposed frontier: a dead
   relay being removed must not keep the durable outbox pending for seven days.
5. Personal-singleton events are published to the user's outboxes and user
   index relays. Kinds `0` and `10002` are explicitly included because they are
   what other clients need to discover the user and the user's mailboxes. User
   index delivery remains required for the previously routed kinds `0`, `3`,
   `10002`, `10017`, `10018`, and `10317`; delivery of the newly routed
   application lists `10063`, `10318`, and `10617` is best-effort because
   generic user-index acceptance of those kinds is not established. Kind
   `10317` also retains required Git-index publication. Encryption does not
   give kind `10318` a different read-preflight rule; its decryption and
   private-repository effects remain downstream concerns.
6. A missing warm winner triggers the existing bounded local-cache hydration.
   It does not trigger another relay request for the singleton filter.

NIP-09 deletion evidence applies to kinds `10017`, `10018`, `10063`, `10317`,
`10318`, and `10617`. It is deliberately not added for the foundational kinds
`0`, `3`, and `10002` in this phase. Coordinate deletion filters can be declared
up front. Exact `e`-pointer filters depend on candidate IDs, so one account-owned
batcher should accumulate pointers across all personal singleton kinds for a
deliberately generous coalescing window and issue one shared focused deletion
request per relay/batch. It must not open one subscription per kind or per
writer. An action reached before that evidence settles may wait within the
existing bounded preflight deadline. The action-time wait budgets the
one-second coalescing window before the relay's full five-second coverage
settlement window, so a rapid second edit does not lose relay response time.
This is new, uncovered evidence under step 6 of the execution pattern, not
permission to repeat the covered singleton query.

Long-lived editors that replace a complete list declare the **full-replacement
draft** modifier. They freeze the displayed event ID when editing begins and
must abort if preflight resolves a different winner, including one recovered
from the local cache. Kind `10317` and `10318` editors currently use this guard.
It prevents a locally detectable stale draft from replacing data the user never
saw without adding relay work or a rebase protocol.

Concurrent cross-client edits can still land after preflight freezes the winner
and before its replacement is published. Adding compare-and-rebase retries
would introduce a second transaction protocol for a rare race, so this phase
records but does not implement it. The shared signing path should contain a
short extension-point comment identifying where a future winner-stability check
and rebase would run. Revisit it only with evidence that the remaining race
occurs often enough to justify that complexity.

Ordinary personal-singleton writes do not require a post-write relay echo in
this phase. They retain the durable outbox retry/status behavior, while the warm
subscription naturally receives later relay updates. A writer must never open a
fresh post-write REQ for an event already covered by that subscription. If a
future category needs stronger confirmation, consume a relay `OK` or expose
event-receipt provenance from the existing live subscription instead.

GRASP repository transitions are not personal-singleton writes. They need
pre-push acceptance from a required repository relay before dependent Git data
is pushed, followed by the category's post-Git broadcast check. A standard
`purgatory:` response proves staging; a plain successful `OK` proves only
acceptance and may mean the state is already visible. Those receipt and
broadcast guarantees belong to the repository transition; they are not a
reason to impose echo confirmation on profile and list settings.

The implementation is intentionally split into independently reviewable
commits: the shared kind scope, batched deletion evidence, publication routing,
mailbox relay-frontier handling, public list writers, and encrypted private-list
projection. Current writers for kinds `3`, `10002`, `10017`, `10018`, `10317`,
`10318`, and `10617` consume the common preflight snapshot. Kind `10063` has no
editor, and current kind `0` creation is the documented bootstrap path. The
kind `10318` projection decrypts the winner supplied by the shared identity
subscription and does not own another network request. It does not project an
absent list until every preferred outbox has settled; accounts without outboxes
use the same rule over the warm lookup-relay set.

#### Notification-state adoption decision

Notification read/archive state is **convergent application state** with the
**confidential scope**, **derived signer**, and **high-frequency merge**
modifiers. It is represented by two kind `30078` addressable events that form
one logical state:

- `git-notifications-nsec`, authored by the active account, contains the
  encrypted notification-state private key;
- `git-notifications-state`, authored by that derived key, contains the
  encrypted read/archive state.

The account-owned notification store is the sole network owner for both
coordinates. It keeps one request open on the union of the user's NIP-65
outboxes and the configured fallback relays. The request uses two exact filters,
not the cross-product of both authors and both identifiers. When the derived
pubkey is already cached, both filters start together. Otherwise the owner first
warms the envelope filter, decrypts the winning envelope, then replaces that
lease with a new lease covering both exact filters. Replacing the filter
invalidates all prior coverage until the new request receives EOSE.

The relay rule follows the personal-state precedent but counts fallback relays
instead of user-index relays, because generic indexes commonly reject kind
`30078` while fallback relays are actual publication destinations:

1. The outbox frontier is not considered known merely because the mailbox
   model currently has no value. A real kind `10002` winner establishes it
   immediately; otherwise the personal-singleton identity owner must first
   cover two thirds of the configured user-index relays, capped at three and
   floored at one, to establish covered mailbox absence.
2. With configured outboxes, at least one outbox must be covered. While exactly
   one outbox is covered, regardless of the total configured, two covered
   fallback relays are also required. Once two or more outboxes are covered,
   three covered outboxes or half of the configured outboxes is sufficient.
3. With covered mailbox absence and therefore no configured outboxes, two
   thirds of the fallback set, capped at three relays and floored at one, must
   be covered.
4. `initial` and `catching-up` relays may be awaited within the existing bounded
   settlement deadline. Failed, disconnected, rate-limited, and
   `not-responding` relays do not block indefinitely.

Once this threshold is warm for the current two-filter lease, writers consume
the EventStore winners and decrypted projection without an action-time relay
request. A missing envelope may create a fresh random derived key only after the
envelope-only lease proves absence at the same threshold and a bounded exact
cache read has also found no cached envelope. Both exact notification
coordinates are hydrated from the cache when their owner starts, with cached
events routed through the EventStore. Once per owner revision, its first
bootstrap attempt checks the envelope and kind `10002` mailbox coordinates
again so a previously observed outbox frontier also tightens the decision.
These reads restore the useful local evidence from the old address loader
without querying the configured relay frontier. The cache backend is normally
IndexedDB, but development installations may provide it through the optional
local relay at `ws://localhost:4869`. The resulting state coordinate is a fresh
unique address under that random key, but the combined warm lease is still
established before its first state write. Both encrypted events publish to the
same outbox and fallback frontier so the read evidence and durable destinations
agree. Publishing encrypted content to those relays still reveals event
existence, timing, and approximate size; it does not reveal the plaintext.

Read/archive actions remain immediate while coverage or decryption is pending.
The store records their updater functions as local deltas, decrypts the current
remote winner, and replays those deltas over it before signing. It must not
publish a stale whole-state snapshot merely because local UI state changed
first. Several rapid actions are debounced into one write. A new remote winner
replaces the accepted base state, after which still-pending local deltas are
replayed; this preserves remote reversals such as marking an item unread or
restoring it. A failed current-envelope or current-state decrypt is not retried
passively on every store or lifecycle emission. The UI exposes an explicit
retry and describes the failure as paused cross-device state sync, because
notification delivery and the local read/archive controls still work. Retry
reuses the current warm owner for decrypt and publish failures, but replaces an
owner whose coverage can no longer reach quorum so terminal or silent relay
checks receive a fresh generation. A pause caused specifically by unavailable
mailbox-discovery coverage belongs to the separate personal-singleton identity
owner; restarting that owner from this service is deliberately deferred until
identity-owner recovery can be exposed as a shared operation for every personal
writer.

This adoption removes the older address-loader relay reads and overlapping
NIP-78 subscriptions while retaining bounded cache-backend hydration. It does
not add NIP-09 deletion discovery, a post-write echo request, or a
compare-and-swap protocol between concurrent clients. Later warm-subscription
events continue to reconcile cross-client updates, while the durable outbox
reports publication delivery separately.

## Writer checklist

Before adding or changing a replaceable/addressable writer, answer:

- Which category and modifiers apply?
- What exact event coordinate and deletion evidence must be preserved?
- Which authors are trusted, and how is that authority frozen?
- Which relay groups vote toward sufficiency and which only contribute evidence?
- Which subscription normally warms the evidence, and who owns its lifetime?
- What invalidates that coverage?
- Which required evidence lies outside the warm scope, and what bounded focused
  read obtains only that evidence?
- How is the user's delta rebased without losing unknown fields?
- What publication and post-write guarantees are separate from read preflight?
