import { useMemo } from "react";
import type { Observable } from "rxjs";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { coordsCacheKey } from "@/lib/nip34";
import type { InferredPRParentRelation } from "@/lib/inferredPRParents";
import { InferredPRParentsModel } from "@/models/InferredPRParentsModel";

export function useInferredPRParents(repoCoords: string[] | undefined) {
  const store = useEventStore();
  const key = useMemo(
    () => (repoCoords ? coordsCacheKey([...repoCoords].sort()) : ""),
    [repoCoords],
  );
  return use$(() => {
    if (!key) return undefined;
    return store.model(InferredPRParentsModel, key) as unknown as Observable<
      Map<string, InferredPRParentRelation>
    >;
  }, [key, store]);
}
