import type { Model } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import { combineLatest, of, type Observable } from "rxjs";
import { map } from "rxjs/operators";

import { parseRepoCoordinate, REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { RepositoryModel } from "@/models/RepositoryModel";
import {
  SettledRepositoryModel,
  type SettledRepositorySnapshot,
} from "@/models/SettledRepositoryModel";
import { deletionEvents$ } from "@/services/nostr";

/** Stable serialized argument for the EventStore model cache. */
export function repositorySelectionKey(coordinates: Iterable<string>): string {
  return JSON.stringify([...coordinates]);
}

/** Exact address filters for explicit repository coordinates. */
export function repositoryCoordinateFilters(
  coordinates: Iterable<string>,
): Filter[] {
  return [...coordinates].flatMap((coordinate) => {
    const parsed = parseRepoCoordinate(coordinate);
    return parsed
      ? [
          {
            kinds: [REPO_KIND],
            authors: [parsed.pubkey],
            "#d": [parsed.identifier],
            limit: 1,
          } as Filter,
        ]
      : [];
  });
}

/**
 * Resolve explicit coordinates in input order from the current EventStore
 * snapshot and collapse references that belong to the same component.
 *
 * Trust-sensitive callers use settled snapshots by default. Presentation
 * callers can opt into progressive updates as missing linked announcements
 * arrive; those snapshots must not drive routing or authority decisions.
 */
export function RepositorySelectionModel(
  coordinatesKey: string,
  confirmedForPubkey?: string,
  requireSettled = true,
): Model<ResolvedRepo[]> {
  return (store) => {
    let coordinates: string[] = [];
    try {
      const parsed = JSON.parse(coordinatesKey) as unknown;
      if (Array.isArray(parsed)) {
        coordinates = parsed.filter(
          (value): value is string => typeof value === "string",
        );
      }
    } catch {
      return of([]);
    }

    const pointers = coordinates.flatMap((coordinate) => {
      const parsed = parseRepoCoordinate(coordinate);
      return parsed ? [parsed] : [];
    });
    if (pointers.length === 0) return of([]);

    const repositories = pointers.map(({ pubkey, identifier }) => {
      if (!requireSettled) {
        return store.model(
          RepositoryModel,
          pubkey,
          identifier,
          deletionEvents$,
        ) as unknown as Observable<ResolvedRepo | undefined>;
      }
      return (
        store.model(
          SettledRepositoryModel,
          pubkey,
          identifier,
        ) as unknown as Observable<SettledRepositorySnapshot>
      ).pipe(
        map((snapshot) => (snapshot.settled ? snapshot.repository : undefined)),
      );
    });

    return combineLatest(repositories).pipe(
      map((repositories) => {
        const byComponent = new Map<string, ResolvedRepo>();
        for (const repository of repositories) {
          if (
            !repository ||
            (confirmedForPubkey &&
              !repository.confirmedMembers.includes(confirmedForPubkey)) ||
            byComponent.has(repository.componentId)
          ) {
            continue;
          }
          byComponent.set(repository.componentId, repository);
        }
        return [...byComponent.values()];
      }),
    );
  };
}
