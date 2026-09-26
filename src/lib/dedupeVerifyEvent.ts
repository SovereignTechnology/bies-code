import type { NostrEvent } from "nostr-tools";

/** Minimal read surface needed from the EventStore for id-based dedupe. */
interface EventIdIndex {
  getEvent(id: string): NostrEvent | undefined;
}

/**
 * Wrap an event verifier so each event is fully verified at most once.
 *
 * Cross-relay duplication means every relay delivers its own parsed copy of
 * the same event. nostr-tools memoizes verification per *object* (via
 * `verifiedSymbol`), so each copy would otherwise pay a full schnorr
 * verification — profiling upstream showed 84–93% of verifications on a cold
 * repo load are redundant.
 *
 * A copy skips verification only when it is field-for-field identical (id,
 * sig, pubkey, kind, created_at, content and tags) to an event already in the
 * store. Every stored event passed full verification (nostr-tools checks that
 * the id matches the event hash *and* the schnorr signature), so an identical
 * copy is valid by construction. Anything else — including a tampered copy
 * that claims a stored id — gets the full check and is rejected when it fails.
 *
 * Comparing contents instead of trusting `hasEvent(id)` keeps the argument
 * independent of `EventStore.add` internals: `hasEvent` also answers true for
 * events held only in the database (e.g. after `memory.prune`), where the
 * add path would otherwise accept the unverified copy as the live instance.
 */
export function createDedupedVerifyEvent(
  store: EventIdIndex,
  verify: (event: NostrEvent) => boolean,
): (event: NostrEvent) => boolean {
  return (event) => {
    const stored = store.getEvent(event.id);
    if (stored && isIdenticalEvent(stored, event)) return true;
    return verify(event);
  };
}

function isIdenticalEvent(a: NostrEvent, b: NostrEvent): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.sig !== b.sig ||
    a.pubkey !== b.pubkey ||
    a.kind !== b.kind ||
    a.created_at !== b.created_at ||
    a.content !== b.content ||
    !Array.isArray(b.tags) ||
    a.tags.length !== b.tags.length
  ) {
    return false;
  }
  return a.tags.every((tag, i) => {
    const other = b.tags[i];
    return (
      Array.isArray(other) &&
      tag.length === other.length &&
      tag.every((value, j) => value === other[j])
    );
  });
}
