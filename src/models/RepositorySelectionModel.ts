import type { Model } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import { combineLatest, of, type Observable } from "rxjs";
import { map } from "rxjs/operators";

import { parseRepoCoordinate, REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import {
  SettledRepositoryModel,
  type SettledRepositorySnapshot,
} from "@/models/SettledRepositoryModel";

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
 * Resolve explicit coordinates in input order, omitting unresolved snapshots
 * and collapsing references that settle into the same component.
 */
export function RepositorySelectionModel(
  coordinatesKey: string,
  confirmedForPubkey?: string,
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

    return combineLatest(
      pointers.map(
        ({ pubkey, identifier }) =>
          store.model(
            SettledRepositoryModel,
            pubkey,
            identifier,
          ) as unknown as Observable<SettledRepositorySnapshot>,
      ),
    ).pipe(
      map((snapshots) => {
        const byComponent = new Map<string, ResolvedRepo>();
        for (const snapshot of snapshots) {
          const repository = snapshot.settled ? snapshot.repository : undefined;
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
