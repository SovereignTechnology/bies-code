import { useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import type { RelayGroup } from "applesauce-relay";
import {
  coordsCacheKey,
  roleHistoryCacheKey,
  type RepositoryRoleHistory,
  type ResolvedIssueLite,
  type RepoQueryOptions,
} from "@/lib/nip34";
import { IssueListModel } from "@/models/IssueListModel";
import type { Observable } from "rxjs";
import { EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { nip34RepoLoader } from "@/services/nostr";

// ---------------------------------------------------------------------------
// Bulk hook (repo issue list)
// ---------------------------------------------------------------------------

/**
 * Fetch and reactively resolve issues for a repository.
 *
 * Accepts either a single coordinate string or an array of coordinate strings
 * (one per maintainer in the chain). Passing all maintainer coordinates
 * ensures issues tagged against any co-maintainer's announcement are included.
 *
 * Returns a flat list of ResolvedIssueLite objects — each combining the raw
 * issue event with its current status, labels, and subject from essentials
 * events. Consumers can filter and display directly without holding separate
 * maps.
 *
 * The resolved list is backed by IssueListModel, which is cached by the store
 * keyed on the sorted coordinate string. Multiple components subscribing to
 * the same repo share one model instance and one set of store subscriptions.
 *
 * Always pass repoRelayGroup from useResolvedRepository. When outbox curation
 * mode is enabled, the caller is responsible for separately subscribing to
 * extraRelaysForMaintainerMailboxCoverage so events from those relays land in
 * the store; this hook reads from the store regardless of which group fetched
 * the events.
 *
 * @param repoCoords     - Coordinate string(s) for the repository
 * @param repoRelayGroup - Base RelayGroup from useResolvedRepository
 * @param options        - Query options including relay hints from the URL/settings
 */
export function useIssues(
  repoCoords: string | string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  _options: RepoQueryOptions,
  roleHistory?: RepositoryRoleHistory,
): ResolvedIssueLite[] | undefined {
  const store = useEventStore();

  // Normalise to a sorted array for consistent filter building and cache keys.
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

  // Fetch issues from relay and pipe each newly discovered issue ID into
  // nip34ListLoader via nip34RepoLoader. The factory handles dedup (seenIds
  // in closure) and closes cleanly on unsubscribe. Filter merging with
  // useNip34ItemLoader calls is automatic because both share the same
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
    return store.model(IssueListModel, cacheKey, {
      roleHistory,
    }) as unknown as Observable<ResolvedIssueLite[]>;
  }, [cacheKey, roleHistoryKey, store]);
}
