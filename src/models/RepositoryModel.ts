import { Observable, Subscription } from "rxjs";
import type { Model } from "applesauce-core/event-store";
import {
  REPO_KIND,
  resolveChain,
  getRepoHistorySubjects,
  getRepoRoleSubjects,
  type ResolvedRepo,
} from "@/lib/nip34";
import type { NostrEvent } from "nostr-tools";

/**
 * RepositoryModel — reactively resolves a selected coordinate through the
 * deterministic repository-component index.
 *
 * How it works:
 * 1. Subscribe to the selected maintainer's announcement via store.addressable()
 * 2. Read the maintainers tag and subscribe to each listed pubkey's announcement
 * 3. For each of those, read their maintainers tags and subscribe further
 * 4. Repeat until no new pubkeys are discovered (fixed point)
 * 5. Re-index the hydrated closure whenever any announcement changes
 *
 * The EventStore's eventLoader (wired to addressLoader in nostr.ts) will
 * automatically fetch any co-maintainer announcements that aren't in the
 * store yet when we subscribe to them via store.addressable().
 *
 * Model cache key: (selectedMaintainer, dTag) — one instance per repo page.
 *
 * Emit timing: store.addressable() emits synchronously (either the event or
 * undefined) for events already in the store. When new co-maintainer
 * subscriptions are opened, all their synchronous callbacks complete before
 * subscribe() returns — so by the time we call emit() after the loop, all
 * currently-known co-maintainer states are already in latestByPubkey.
 */
export function RepositoryModel(
  selectedMaintainer: string,
  dTag: string,
  deletionEvents?: Observable<NostrEvent[]>,
): Model<ResolvedRepo | undefined> {
  return (store) =>
    new Observable<ResolvedRepo | undefined>((observer) => {
      // Track which pubkeys we're currently subscribed to
      const subscriptionsByPubkey = new Map<string, boolean>();
      // All inner subscriptions — collected so the teardown can unsubscribe them
      const subs = new Subscription();
      // Latest announcement event per pubkey
      const latestByPubkey = new Map<string, NostrEvent | undefined>();
      const retainedAnnouncements = new Map<string, NostrEvent>();
      let deletions: NostrEvent[] = [];

      // Emit a resolved repo from the current snapshot
      function emit() {
        const events = Array.from(latestByPubkey.values()).filter(
          (ev): ev is NostrEvent => ev !== undefined,
        );
        const currentIds = new Set(events.map(({ id }) => id));
        const deletedEvents = [...retainedAnnouncements.values()].filter(
          (event) =>
            !currentIds.has(event.id) &&
            deletions.some(
              (deletion) =>
                deletion.pubkey === event.pubkey &&
                deletion.created_at >= event.created_at &&
                deletion.tags.some(
                  ([name, value]) =>
                    (name === "e" && value === event.id) ||
                    (name === "a" &&
                      value === `${REPO_KIND}:${event.pubkey}:${dTag}`),
                ),
            ),
        );
        observer.next(
          resolveChain(
            [...events, ...deletedEvents, ...deletions],
            selectedMaintainer,
            dTag,
          ),
        );
      }

      // Subscribe to a pubkey's announcement and recursively subscribe to
      // any newly-discovered maintainers
      function subscribe(pubkey: string, traverseCurrentGraph: boolean) {
        const previousMode = subscriptionsByPubkey.get(pubkey);
        if (previousMode !== undefined) {
          if (traverseCurrentGraph && !previousMode) {
            subscriptionsByPubkey.set(pubkey, true);
            const event = latestByPubkey.get(pubkey);
            if (event) discoverFrom(event, true);
          }
          return;
        }
        subscriptionsByPubkey.set(pubkey, traverseCurrentGraph);

        function discoverFrom(ev: NostrEvent, traverse: boolean) {
          if (!traverse) return;
          for (const subject of getRepoRoleSubjects(ev)) {
            subscribe(subject, true);
          }
          for (const subject of getRepoHistorySubjects(ev)) {
            subscribe(subject, false);
          }
        }

        subs.add(
          store
            .addressable({ kind: REPO_KIND, pubkey, identifier: dTag })
            .subscribe((ev) => {
              const prev = latestByPubkey.get(pubkey);
              latestByPubkey.set(pubkey, ev ?? undefined);

              if (ev) {
                retainedAnnouncements.set(pubkey, ev);
                // Subscribe to any newly-discovered co-maintainers.
                // store.addressable() emits synchronously, so all their
                // initial states are populated in latestByPubkey before
                // the loop returns — emit() sees the full picture.
                discoverFrom(ev, subscriptionsByPubkey.get(pubkey) ?? false);
                emit();
              } else {
                // Announcement absent or removed — only re-emit if this is
                // a change (not the initial undefined for a new subscription
                // that will never have an event).
                if (prev !== undefined) emit();
              }
            }),
        );
      }

      // Start from the selected maintainer
      subscribe(selectedMaintainer, true);
      if (deletionEvents) {
        subs.add(
          deletionEvents.subscribe((events) => {
            deletions = events;
            emit();
          }),
        );
      }

      return () => {
        // Unsubscribe all inner store.addressable() subscriptions collected
        // in `subs`. Without this they would leak on component unmount.
        subs.unsubscribe();
      };
    });
}

/**
 * Cache by stable coordinate scalars and deletion-awareness mode. Hashing the
 * Observable argument itself is unsafe because RxJS subscriber state is
 * mutable, which would create duplicate model trees for the same repository.
 */
RepositoryModel.getKey = (
  selectedMaintainer: string,
  dTag: string,
  deletionEvents?: Observable<NostrEvent[]>,
) =>
  JSON.stringify([
    selectedMaintainer,
    dTag,
    deletionEvents ? "deletion-aware" : "current-only",
  ]);
