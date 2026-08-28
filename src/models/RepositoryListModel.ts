import { of, type Observable } from "rxjs";
import {
  map,
  debounceTime,
  distinctUntilChanged,
  switchMap,
} from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import { getReplaceableIdentifier } from "applesauce-core/helpers";
import { REPO_KIND, repoCoordinate, type ResolvedRepo } from "@/lib/nip34";
import type { Filter } from "applesauce-core/helpers";
import {
  RepositorySelectionModel,
  repositorySelectionKey,
} from "@/models/RepositorySelectionModel";

const repoFilter: Filter[] = [{ kinds: [REPO_KIND] }];

/**
 * RepositoryListModel — subscribes to all 30617 events in the store and
 * emits a settled, deduplicated list of resolved repositories.
 *
 * Multi-maintainer repos (where pubkeys mutually list each other) are merged
 * into a single ResolvedRepo.
 *
 * @param forPubkey - If provided, hydrate each announcement authored by that
 *   pubkey and return only components where it is a confirmed member.
 *
 * This model does NOT fetch from relays — pair it with a relay fetch in the
 * hook layer (e.g. useUserRepositories) that populates the store first.
 *
 * Model cache key: (forPubkey) — one shared instance per pubkey
 * (or one global instance when called with no args).
 *
 * debounceTime(150) batches bulk-fetch insertion. Each coordinate then flows
 * through RepositorySelectionModel, which withholds it until its recursive
 * graph refresh has settled and collapses references to the same component.
 */
export function RepositoryListModel(forPubkey?: string): Model<ResolvedRepo[]> {
  return (store) => {
    const filters = forPubkey
      ? ([{ kinds: [REPO_KIND], authors: [forPubkey] } as Filter] as Filter[])
      : repoFilter;
    return store.timeline(filters).pipe(
      debounceTime(150),
      map((events) =>
        repositorySelectionKey(
          [
            ...new Set(
              events.flatMap((event) => {
                const dTag = getReplaceableIdentifier(event);
                return dTag ? [repoCoordinate(event.pubkey, dTag)] : [];
              }),
            ),
          ].sort(),
        ),
      ),
      distinctUntilChanged(),
      switchMap((coordinatesKey) => {
        if (coordinatesKey === "[]") return of([] as ResolvedRepo[]);
        return (
          store.model(
            RepositorySelectionModel,
            coordinatesKey,
            forPubkey,
          ) as unknown as Observable<ResolvedRepo[]>
        ).pipe(
          map((repositories) =>
            [...repositories].sort(
              (a, b) =>
                b.updatedAt - a.updatedAt ||
                a.componentId.localeCompare(b.componentId),
            ),
          ),
        );
      }),
    );
  };
}
