import type { NostrEvent } from "nostr-tools";
import { Observable, of, Subscription } from "rxjs";
import { normalizeUrl } from "@/lib/url";

export type EventReferenceClosureResponse = NostrEvent | "EOSE";

export type EventReferenceLoader = (
  eventId: string,
  relays: string[],
) => Observable<EventReferenceClosureResponse>;

/**
 * Recursively load the complete event-reference closure for a root event.
 *
 * Every event returned by `loadReferences` becomes a new target. Each
 * event/relay pair is loaded once, including when relays arrive reactively
 * after part of the closure has already been discovered.
 */
export function loadEventReferenceClosure(
  rootId: string,
  relays: Observable<string[]> | string[],
  loadReferences: EventReferenceLoader,
): Observable<EventReferenceClosureResponse> {
  return new Observable<EventReferenceClosureResponse>((subscriber) => {
    const subscriptions = new Subscription();
    const knownRelays = new Set<string>();
    const discoveredIds = new Set<string>([rootId]);
    const loadedRelaysById = new Map<string, Set<string>>();

    const loadTarget = (eventId: string, relayUrls: string[]): void => {
      const loadedRelays = loadedRelaysById.get(eventId) ?? new Set<string>();
      loadedRelaysById.set(eventId, loadedRelays);

      const newRelays = relayUrls.filter((relay) => !loadedRelays.has(relay));
      if (newRelays.length === 0) return;

      // Mark coverage before subscribing so synchronous loader emissions
      // cannot schedule the same event/relay pair recursively.
      for (const relay of newRelays) loadedRelays.add(relay);

      subscriptions.add(
        loadReferences(eventId, newRelays).subscribe({
          next: (message) => {
            subscriber.next(message);
            if (message === "EOSE" || discoveredIds.has(message.id)) return;

            discoveredIds.add(message.id);
            loadTarget(message.id, [...knownRelays]);
          },
          error: (error) => subscriber.error(error),
        }),
      );
    };

    const relayUrls$ = Array.isArray(relays) ? of(relays) : relays;
    subscriptions.add(
      relayUrls$.subscribe({
        next: (relayUrls) => {
          const newRelays: string[] = [];
          for (const relay of relayUrls.map(normalizeUrl)) {
            if (knownRelays.has(relay)) continue;
            knownRelays.add(relay);
            newRelays.push(relay);
          }

          if (newRelays.length === 0) return;
          for (const eventId of discoveredIds) loadTarget(eventId, newRelays);
        },
        error: (error) => subscriber.error(error),
      }),
    );

    return subscriptions;
  });
}
