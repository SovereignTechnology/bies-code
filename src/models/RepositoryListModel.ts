import { combineLatest, of, type Observable } from "rxjs";
import { map, debounceTime, switchMap } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import { getReplaceableIdentifier } from "applesauce-core/helpers";
import {
  REPO_KIND,
  groupIntoResolvedRepos,
  type ResolvedRepo,
} from "@/lib/nip34";
import type { Filter } from "applesauce-core/helpers";
import { RepositoryModel } from "@/models/RepositoryModel";

const repoFilter: Filter[] = [{ kinds: [REPO_KIND] }];

/**
 * RepositoryListModel — subscribes to all 30617 events in the store and
 * emits a deduplicated list of resolved repositories.
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
 * debounceTime(150) prevents groupIntoResolvedRepos (O(n²)) from running on
 * every individual event during bulk-fetch (NIP-77 sync / pagination walk),
 * which would otherwise cause thousands of expensive recomputations.
 */
export function RepositoryListModel(forPubkey?: string): Model<ResolvedRepo[]> {
  return (store) => {
    if (!forPubkey) {
      return store.timeline(repoFilter).pipe(
        debounceTime(150),
        map((events) => groupIntoResolvedRepos(events)),
      );
    }

    return store
      .timeline([{ kinds: [REPO_KIND], authors: [forPubkey] } as Filter])
      .pipe(
        debounceTime(150),
        map((events) =>
          [
            ...new Set(
              events
                .map(getReplaceableIdentifier)
                .filter((dTag): dTag is string => !!dTag),
            ),
          ].sort(),
        ),
        switchMap((dTags) => {
          if (dTags.length === 0) return of([] as ResolvedRepo[]);
          return combineLatest(
            dTags.map(
              (dTag) =>
                store.model(
                  RepositoryModel,
                  forPubkey,
                  dTag,
                ) as unknown as Observable<ResolvedRepo | undefined>,
            ),
          ).pipe(
            map((repositories) => {
              const byComponent = new Map<string, ResolvedRepo>();
              for (const repository of repositories) {
                if (
                  repository?.confirmedMembers.includes(forPubkey) &&
                  !byComponent.has(repository.componentId)
                ) {
                  byComponent.set(repository.componentId, repository);
                }
              }
              return [...byComponent.values()].sort(
                (a, b) =>
                  b.updatedAt - a.updatedAt ||
                  a.componentId.localeCompare(b.componentId),
              );
            }),
          );
        }),
      );
  };
}
