import { combineLatest, of } from "rxjs";
import { map, switchMap } from "rxjs/operators";
import type { Model } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { PR_KIND, PR_UPDATE_KIND } from "@/lib/nip34";
import {
  buildStackCandidateFilter,
  resolveInferredPRParents,
  type InferredPRParentRelation,
} from "@/lib/inferredPRParents";

export function InferredPRParentsModel(
  coordsCacheKey: string,
): Model<Map<string, InferredPRParentRelation>> {
  return (store) => {
    const coords = coordsCacheKey ? coordsCacheKey.split(",") : [];
    const roots$ = store.timeline([
      { kinds: [PR_KIND], "#a": coords } as Filter,
    ]);
    const updates$ = store.timeline([
      { kinds: [PR_UPDATE_KIND], "#a": coords } as Filter,
    ]);
    return combineLatest([roots$, updates$]).pipe(
      switchMap(([rawRoots, rawUpdates]) => {
        const roots = rawRoots as NostrEvent[];
        const updates = rawUpdates as NostrEvent[];
        const mergeBases = [...roots, ...updates]
          .map(
            (event) => event.tags.find(([name]) => name === "merge-base")?.[1],
          )
          .filter((value): value is string => Boolean(value));
        const filter = buildStackCandidateFilter(coords, mergeBases);
        if (!filter)
          return of(resolveInferredPRParents(roots, updates, [], coords));
        return store
          .timeline([filter])
          .pipe(
            map((events) =>
              resolveInferredPRParents(
                roots,
                updates,
                events as NostrEvent[],
                coords,
              ),
            ),
          );
      }),
    );
  };
}
