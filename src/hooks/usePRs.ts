import { useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import type { RelayGroup } from "applesauce-relay";
import {
  coordsCacheKey,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
  type ResolvedPRLite,
  type RepoQueryOptions,
} from "@/lib/nip34";
import { PRListModel } from "@/models/PRListModel";
import type { Observable } from "rxjs";
import { EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { nip34RepoLoader } from "@/services/nostr";

// ---------------------------------------------------------------------------
// Bulk hook (repo PR list)
// ---------------------------------------------------------------------------

/**
 * Fetch and reactively resolve PRs and root patches for a repository.
 *
 * Parallel to useIssues but queries kinds [1617, 1618] and uses PRListModel.
 */
export function usePRs(
  repoCoords: string | string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  _options: RepoQueryOptions,
  roleHistory?: RepositoryRoleHistory,
): ResolvedPRLite[] | undefined {
  const store = useEventStore();

  const coords = useMemo(() => {
    if (!repoCoords) return undefined;
    const arr = Array.isArray(repoCoords) ? repoCoords : [repoCoords];
    return [...arr].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(repoCoords) ? repoCoords.join(",") : repoCoords]);

  const cacheKey = coords ? coordsCacheKey(coords) : "";

  // Structural key: the resolver rebuilds roleHistory on every
  // announcement-graph emission, so identity-based deps would restart the
  // relay subscription (fresh seenIds, full re-fetch) on emissions that did
  // not change role content.
  const roleHistoryKey = useMemo(
    () => roleHistoryCacheKey(roleHistory),
    [roleHistory],
  );

  // Fetch PRs/patches from relay and pipe each newly discovered root item ID
  // into nip34ListLoader via nip34RepoLoader. The factory handles dedup
  // (seenIds in closure) and closes cleanly on unsubscribe. Filter merging
  // with useNip34ItemLoader calls is automatic because both share the same
  // singleton loader instances.
  use$(() => {
    if (!coords || coords.length === 0 || !repoRelayGroup) return undefined;
    return nip34RepoLoader(coords, repoRelayGroup, roleHistory).pipe(
      catchError(() => EMPTY),
    );
  }, [cacheKey, repoRelayGroup, roleHistoryKey]);

  // Subscribe to the model — cached by the store, shared across components.
  return use$(() => {
    if (!coords || coords.length === 0) return undefined;
    return store.model(
      PRListModel,
      cacheKey,
      roleHistory,
    ) as unknown as Observable<ResolvedPRLite[]>;
  }, [cacheKey, roleHistoryKey, store]);
}
