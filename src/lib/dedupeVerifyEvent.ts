import type { NostrEvent } from "nostr-tools";

/** Minimal read surface needed from the EventStore for id-based dedupe. */
interface EventIdIndex {
  hasEvent(id: string): boolean;
}

/**
 * Wrap an event verifier so each event id is fully verified at most once.
 *
 * Cross-relay duplication means every relay delivers its own parsed copy of
 * the same event. nostr-tools memoizes verification per *object* (via
 * `verifiedSymbol`), so each copy would otherwise pay a full schnorr
 * verification even though `EventStore.add` discards same-id duplicates —
 * profiling shows 84–93% of verifications on a cold repo load are redundant.
 *
 * Skipping is safe because of the order of operations inside
 * `EventStore.add` (applesauce-core v6):
 *
 * 1. The first copy of an id is never in the store, so it always gets the
 *    full `verify` (nostr-tools checks the id matches the event hash *and*
 *    the schnorr signature) before insertion.
 * 2. When `hasEvent(id)` is true, the very next step after this check is the
 *    store's synchronous id-based dedupe, which returns the already-stored
 *    (already-verified) instance and discards the incoming copy. A tampered
 *    copy claiming a stored id therefore never enters the store; at most it
 *    merges seen-relay metadata onto the stored event, exactly as a verified
 *    duplicate would. It carries no `verifiedSymbol` (we never verified it),
 *    so applesauce's symbol-copying cannot mark anything verified from it.
 * 3. An event removed from the store (deleted, expired, replaced) fails the
 *    `hasEvent` check and is re-verified on re-delivery.
 *
 * An event whose id has never passed full verification can therefore never
 * be accepted into the store.
 */
export function createDedupedVerifyEvent(
  store: EventIdIndex,
  verify: (event: NostrEvent) => boolean,
): (event: NostrEvent) => boolean {
  return (event) => {
    if (store.hasEvent(event.id)) return true;
    return verify(event);
  };
}
