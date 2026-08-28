import { Observable, Subscription } from "rxjs";
import { map } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import { RelayGroup } from "applesauce-relay";
import type { Relay } from "applesauce-relay";
import { REPO_KIND, getRepoRelays, getRepoRoleSubjects } from "@/lib/nip34";
import { pool } from "@/services/nostr";
import { normalizeUrl } from "@/lib/url";

/**
 * Return a reactive Observable<string[]> of normalized relay URLs for a
 * RelayGroup. Emits whenever the group gains or loses relays.
 *
 * relays$ is protected in TypeScript but public at runtime — we cast to
 * access it so we can react to relay additions without polling.
 *
 * Returns an observable of [] when group is undefined.
 */
export function relayGroupUrls$(
  group: RelayGroup | undefined,
): Observable<string[]> {
  if (!group) return new Observable((s) => s.next([]));
  return (group as unknown as { relays$: Observable<Relay[]> }).relays$.pipe(
    map((relays) => relays.map((r) => normalizeUrl(r.url))),
  );
}

/**
 * RepositoryRelayGroup — a long-lived RelayGroup for a repository, cached by
 * the EventStore model system alongside RepositoryModel.
 *
 * Starts with the selected coordinate's relay hints, then grows from the
 * confirmed component resolved by useResolvedRepository. Relay tags on merely
 * discovered or invited announcements never enter this shared group.
 *
 * Because RelayGroup.add() is idempotent (checks has() before next()) and
 * internalSubscription uses a WeakMap cache keyed on the Relay instance,
 * adding a relay that is already in the group is a no-op, and adding a new
 * relay opens a subscription only to that relay — existing subscriptions are
 * untouched.
 *
 * Model cache key: (selectedMaintainer, dTag) — same as RepositoryModel, so
 * the two models share a lifetime and are torn down together.
 */
export function RepositoryRelayGroup(
  selectedMaintainer: string,
  dTag: string,
): Model<RelayGroup> {
  return (store) => {
    const group = new RelayGroup([]);

    return new Observable<RelayGroup>((observer) => {
      const subs = new Subscription();

      // Subscribe to every kind:30617 event for this dTag in the store.
      // store.addressable() re-emits whenever the event changes (new version
      // of a replaceable event). We watch all pubkeys we discover via BFS,
      // mirroring what RepositoryModel does — but here we only care about
      // the relay tags, not the full chain resolution.
      const subscribed = new Set<string>();

      function subscribe(pubkey: string) {
        if (subscribed.has(pubkey)) return;
        subscribed.add(pubkey);

        subs.add(
          store
            .addressable({ kind: REPO_KIND, pubkey, identifier: dTag })
            .subscribe((ev) => {
              if (!ev) return;

              // The selected event is a discovery anchor. Confirmed member
              // relays are added later from ResolvedRepo; invitation relays
              // must never become shared repository infrastructure here.
              if (pubkey === selectedMaintainer) {
                for (const url of getRepoRelays(ev)) {
                  const relay = pool.relay(normalizeUrl(url));
                  if (!group.has(relay)) group.add(relay);
                }
              }

              // Follow active role assignments to discover member announcements.
              for (const mp of getRepoRoleSubjects(ev)) {
                subscribe(mp);
              }

              // Emit the group (same instance) so subscribers know it grew
              observer.next(group);
            }),
        );
      }

      subscribe(selectedMaintainer);

      // Emit immediately so consumers get the group reference synchronously
      observer.next(group);

      return () => {
        subs.unsubscribe();
      };
    });
  };
}
