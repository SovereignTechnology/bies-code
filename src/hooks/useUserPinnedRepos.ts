/**
 * useUserPinnedRepos — reactive ordered list of a user's pinned repositories.
 *
 * Pinned repos are stored in kind:10617 as `a` tags with the repo coordinate
 * "30617:<pubkey>:<dtag>". The order of tags in the event is preserved so the
 * user's chosen display order is respected.
 *
 * Strategy:
 *   1. Subscribe reactively to the user's kind:10617 from the EventStore
 *      (populated by useUserProfileSubscription / userIdentitySubscription).
 *   2. Extract the `a` tag coordinates (in order).
 *   3. Fetch the actual kind:30617 repo announcements for those coordinates
 *      from the git index relays.
 *   4. Resolve those coordinates through the shared component index, in pin
 *      order with duplicate component references collapsed.
 */

import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { pool } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";
import { mapEventsToStore } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { type ResolvedRepo } from "@/lib/nip34";
import { PINNED_REPOS_KIND } from "@/actions/pinnedRepoActions";
import type { Observable } from "rxjs";
import { switchMap, map, of } from "rxjs";
import {
  RepositorySelectionModel,
  repositoryCoordinateFilters,
  repositorySelectionKey,
} from "@/models/RepositorySelectionModel";

/**
 * Return the ordered list of repositories pinned by the given user.
 *
 * @param pubkey - The user's hex pubkey, or undefined to skip
 * @returns ResolvedRepo[] in pin order when loaded, undefined while loading
 */
export function useUserPinnedRepos(
  pubkey: string | undefined,
): ResolvedRepo[] | undefined {
  const store = useEventStore();

  // Layer 1: watch kind:10617 reactively; when coords change, fetch the
  // corresponding repo announcements from the git index relays.
  use$(() => {
    if (!pubkey) return undefined;

    return store.replaceable(PINNED_REPOS_KIND, pubkey).pipe(
      map((event) => {
        if (!event) return [];
        return event.tags
          .filter(([t]) => t === "a")
          .map(([, v]) => v)
          .filter((v): v is string => !!v);
      }),
      switchMap((coords) => {
        if (coords.length === 0) return of(undefined);

        const filters = repositoryCoordinateFilters(coords);
        if (filters.length === 0) return of(undefined);

        return resilientSubscription(pool, gitIndexRelays, filters).pipe(
          onlyEvents(),
          mapEventsToStore(store),
        );
      }),
    );
  }, [pubkey, store]);

  // Layer 2: read resolved repos from the store, filtered to only the coords
  // in the user's kind:10617 list, preserving pin order.
  return use$(() => {
    if (!pubkey) return undefined;

    return store.replaceable(PINNED_REPOS_KIND, pubkey).pipe(
      map((event) => {
        const coords = event
          ? event.tags
              .filter(([t]) => t === "a")
              .map(([, v]) => v)
              .filter((v): v is string => !!v)
          : [];
        return coords;
      }),
      switchMap((coords) => {
        if (coords.length === 0) return of([] as ResolvedRepo[]);
        return store.model(
          RepositorySelectionModel,
          repositorySelectionKey(coords),
          undefined,
          false,
        ) as unknown as Observable<ResolvedRepo[]>;
      }),
    );
  }, [pubkey, store]);
}

/**
 * Return the ordered list of pinned repo coordinates for a user.
 * Lightweight — reads only the kind:10617 event, no repo resolution.
 *
 * @param pubkey - The user's hex pubkey, or undefined to skip
 * @returns string[] of "30617:<pubkey>:<dtag>" coords in pin order, or undefined
 */
export function useUserPinnedCoords(
  pubkey: string | undefined,
): string[] | undefined {
  const store = useEventStore();

  return use$(() => {
    if (!pubkey) return undefined;

    return store.replaceable(PINNED_REPOS_KIND, pubkey).pipe(
      map((event) => {
        if (!event) return [] as string[];
        return event.tags
          .filter(([t]) => t === "a")
          .map(([, v]) => v)
          .filter((v): v is string => !!v);
      }),
    );
  }, [pubkey, store]);
}
