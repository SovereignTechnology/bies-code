import { useEffect, useMemo } from "react";
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
import { BehaviorSubject, EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { nip34RepoLoader, type Nip34RepoLoaderInputs } from "@/services/nostr";

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

  // Reactive loader inputs anchored on the relay group, which is model-cached
  // per (pubkey, dTag) — so the relay subscription below survives coordinate
  // growth and role-history changes, restarting only when the repository
  // identity changes.
  const inputs$ = useMemo(
    () =>
      new BehaviorSubject<Nip34RepoLoaderInputs>({
        coords: coords ?? [],
        roleHistory,
      }),
    // Intentionally NOT keyed on coords/roleHistory — they are fed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoRelayGroup],
  );
  useEffect(() => {
    if (!coords || coords.length === 0) return;
    inputs$.next({ coords, roleHistory });
    // Content-keyed deps: pushes happen only when the coordinate set or the
    // role-history content changes; the loader additionally no-ops on
    // unchanged inputs, so re-pushes are free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs$, cacheKey, roleHistoryKey]);

  // Fetch PRs/patches from relay and pipe each newly discovered root item ID
  // into nip34ListLoader via nip34RepoLoader. The factory handles dedup
  // (seenIds in closure) and closes cleanly on unsubscribe. Coordinate
  // growth and role-history changes flow through inputs$ as additive delta
  // REQs instead of restarting the subscription. Filter merging with
  // useNip34ItemLoader calls is automatic because both share the same
  // singleton loader instances.
  const hasCoords = !!coords && coords.length > 0;
  use$(() => {
    if (!hasCoords || !repoRelayGroup) return undefined;
    return nip34RepoLoader(inputs$, repoRelayGroup).pipe(
      catchError(() => EMPTY),
    );
  }, [hasCoords, repoRelayGroup, inputs$]);

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
