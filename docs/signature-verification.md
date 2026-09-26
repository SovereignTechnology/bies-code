# Signature Verification

> **BIES Code fork:** verification is **enabled**. `src/services/nostr.ts` sets
> `eventStore.verifyEvent = createDedupedVerifyEvent(eventStore, verifyEvent)`
> (`src/lib/dedupeVerifyEvent.ts`), so every event is fully verified once and
> only field-identical duplicates skip the check. We reverted upstream's
> `fakeVerifyEvent` because, until the spot-check model below exists, it lets
> any relay the client queries inject forged repository state, CI coordinator
> advertisements and relay lists that the app trusts or signs on top of.
> `src/lib/dedupeVerifyEvent.test.ts` fails if a merge re-disables it. The
> upstream text below is kept for context.

## Current state: verification is disabled

Since August 2026, the global `EventStore` in `src/services/nostr.ts` does not
verify event signatures: `eventStore.verifyEvent` is set to `fakeVerifyEvent`
(from `applesauce-core/helpers`), which marks every event verified without
checking its hash or schnorr signature. applesauce's `EventStore` verifies by
default, so the override is deliberate and must not be removed casually.

**Why.** CPU profiling of a cold repository load showed schnorr verification
consuming 31–37% of active main-thread CPU. Commit `77c9271b` first removed the
redundant re-verification of cross-relay duplicate copies (84–93% of all
verifications), cutting cold-load time-to-stable from 25.9s to 16.6s. The
remaining verification of unique events still cost roughly 2s of main-thread
work per cold load. Disabling verification entirely follows widespread
nostr-community practice: clients trust that relays validated signatures on
ingestion, and most popular clients do not re-verify on read.

**Exception.** The `PersistentDeleteManager` keeps its own real
`verifyEvent` (nostr-tools). Deletion tombstones rehydrated from IndexedDB are
locally persisted authority to _drop_ other events; the volume is tiny and the
integrity value is real, so they remain fully verified.

## Planned replacement: relay-trust with randomized spot-checks

The compensating control we intend to build is provenance-based trust with
after-the-fact spot-check verification:

- **Trusted provenance → no verification.** An event is trusted when its
  seen-relays provenance includes a _trusted relay_. applesauce records the
  relays an event was seen on under `SeenRelaysSymbol`, accumulated by
  `EventStore.add`'s duplicate merging — every relay that delivers a copy of an
  already-stored event contributes to the stored event's seen-relays set.
- **Trusted relay** is defined as either:
  - a GRASP server of a repository the user follows, or
  - an inbox/outbox relay (NIP-65, kind 10002) of someone the user follows.
- **Untrusted-only provenance → spot-checks.** Events seen only on other
  relays are accepted immediately but subject to randomized after-the-fact
  verification. A spot-check failure evicts the event from the store and flags
  the relay that delivered it.

The dedupe-verification wrapper removed alongside this change
(`src/lib/dedupeVerifyEvent.ts`, recoverable from commit `77c9271b`) is a
useful starting point for the spot-check implementation: its safety argument
about `EventStore.add`'s verify-then-dedupe ordering still applies to any
verification reintroduced at the store boundary.

## Known gaps to solve before implementing

- **`VerifyEventMethod` has no relay context.** The store's `verifyEvent`
  callback receives only the event, so it cannot know which relay delivered
  the copy being considered. The trust policy therefore has to live at the
  ingestion layer (where the delivering relay is known) rather than inside the
  store's verify hook.
- **Seen-relays does not survive reload.** `SeenRelaysSymbol` is an in-memory
  Symbol property; it is not serialized into the IndexedDB event cache. After
  a reload, cached events have no provenance, so trust decisions for them
  require explicit provenance persistence alongside the cached events.

## Caution: tiering

If spot-checking is ever tiered rather than uniform, the priority candidates
for stricter treatment are the trust-bearing kinds: repository announcements
and state (30617/30618), membership/role events, and merge/status events
(1630–1633). A forged social event is noise; a forged state or status event
can misrepresent repository authority.
