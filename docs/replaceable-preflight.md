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
6. Reuse current warm coverage. Wait for in-flight warm work or issue bounded,
   focused reads only for evidence that is genuinely missing.
7. Rebase the user's intended change onto the current winning event, preserving
   fields that the editing surface does not own, then apply category invariants.
8. Sign only after preflight succeeds.
9. Publish with the transition guarantees required by the category. Publication
   acknowledgement and post-write verification are separate from read
   preflight.

A bounded one-shot read can satisfy the current action, but it does not create
lasting warm coverage after that request closes.

## Categories

Categories define common ownership and evidence rules. A modifier records an
exception without creating a bespoke preflight design.

| Category                     | Examples                                                                                  | Natural warm scope                                                                            | General rule                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Personal singleton           | Profile, NIP-65 mailboxes, follows, Git author/repository lists, GRASP list, Blossom list | Active user's outboxes and configured lookup relays                                           | Establish the owner's latest event before replacing it                                |
| Publisher-owned addressable  | Software application and release events                                                   | Publisher outboxes and relevant distribution relays                                           | Establish the author's current coordinate before replacing it                         |
| Repository authority graph   | Kind `30617` announcements                                                                | Identifier-wide discovery on repository and Git index relays, enriched by maintainer outboxes | Resolve authority only from reciprocally confirmed announcements                      |
| Repository operational state | Kind `30618` state                                                                        | Confirmed maintainers on repository relays                                                    | Establish the latest valid state across the frozen authority set                      |
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
- `unavailable`: the current cycle disconnected, closed, or failed;
- `stopped`: the owning session ended.

Coverage becomes valid only after a real EOSE for the declared filter. It is
invalidated by:

- a relay disconnect or subscription-cycle restart;
- foreground resume until its gap-fill request receives EOSE;
- a change to the filter or frozen authority scope;
- relay removal;
- owner teardown or account/session replacement.

Each cycle has a generation. Completion from an older request or gap fill must
never validate a newer generation. Newly added relays start at `initial`; their
presence does not invalidate still-current coverage on unchanged relays.

The coverage layer reports lifecycle facts. It does not decide whether one,
one-third, a majority, or every relay is enough. Category policy intersects its
relay groups with current coverage and makes that decision separately.

Dynamic additive filters are not covered by the first implementation. Correct
coverage for them requires per-filter-revision or per-chunk generations,
including additions during initial settlement and consolidation after
reconnect. Until that complexity is justified, their writers use bounded,
focused action-time reads for missing evidence.

## Maintainer invitation example

Adding a maintainer is a **repository authority graph** action with the
**external-subject discovery** modifier. The intended eventual flow is:

1. Keep the repository's identifier-wide kind `30617` discovery warm on its
   repository relays and the configured Git index relays.
2. Let selecting a prospective maintainer remain immediate.
3. On selection, begin non-blocking discovery of that user's NIP-65 mailboxes.
4. If outboxes are found, warm a focused kind `30617` query for that author and
   repository identifier, including the deletion evidence needed by authority
   resolution.
5. At invitation time, consume the accumulated evidence and wait or request
   only for missing coverage.

The current Phase 1 work does not implement this flow.

## Adoption

### Phase 1: stable-filter proof

The first implementation is deliberately limited to personal singleton events
for the active account:

- expose cycle-valid per-relay coverage from the existing persistent identity
  subscription;
- require relays counted by `useRobustReplaceableAction` to have current
  subscription coverage, not merely an open and healthy connection;
- retain its existing outbox/lookup sufficiency policy and bounded focused-read
  safety net;
- verify initial EOSE, reconnect, foreground gap fill, relay membership changes,
  stale generations, and teardown with focused tests.

This phase does not introduce a global filter registry, change repository
preflight, or define universal relay thresholds.

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

## Writer checklist

Before adding or changing a replaceable/addressable writer, answer:

- Which category and modifiers apply?
- What exact event coordinate and deletion evidence must be preserved?
- Which authors are trusted, and how is that authority frozen?
- Which relay groups vote toward sufficiency and which only contribute evidence?
- Which subscription normally warms the evidence, and who owns its lifetime?
- What invalidates that coverage?
- What bounded fallback runs when warm coverage is insufficient?
- How is the user's delta rebased without losing unknown fields?
- What publication and post-write guarantees are separate from read preflight?
