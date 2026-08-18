import type { Filter, NostrEvent } from "applesauce-core/helpers";
import "window.nostrdb.js";

const DELETION_PERSIST_TIMEOUT_MS = 5_000;
const DELETION_PERSIST_POLL_MS = 25;

/**
 * Request events from the IndexedDB cache.
 * Used by event loaders to check cache before querying relays.
 * Returns empty array if cache is not available.
 */
export async function cacheRequest(filters: Filter[]) {
  return window.nostrdb.filters(filters);
}

/** Save events to the cache */
export async function saveEvents(events: NostrEvent[]) {
  await Promise.allSettled(events.map((e) => window.nostrdb.add(e)));
}

/** Load durable kind-5 tombstones before any cached originals are consumed. */
export async function loadDeletionEvents(): Promise<NostrEvent[]> {
  return window.nostrdb.filters([{ kinds: [5] }]);
}

/** Persist a verified kind-5 event outside EventStore.insert$. */
export async function saveDeletionEvent(event: NostrEvent): Promise<void> {
  // Strip Applesauce's symbol metadata and detach nested tag arrays before the
  // asynchronous nostr-idb write queue observes the event.
  const durableEvent: NostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };

  await window.nostrdb.add(durableEvent);

  // window.nostrdb.add() acknowledges its in-memory write queue, not the
  // eventual IndexedDB commit. Wait for the public exact-event read to prove
  // durability so an immediate reload cannot race the queued tombstone.
  const deadline = Date.now() + DELETION_PERSIST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await window.nostrdb.event(durableEvent.id)) return;

    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.min(DELETION_PERSIST_POLL_MS, deadline - Date.now()),
      );
    });
  }

  throw new Error(
    `Deletion tombstone ${durableEvent.id} was not durably stored within ${DELETION_PERSIST_TIMEOUT_MS}ms`,
  );
}
