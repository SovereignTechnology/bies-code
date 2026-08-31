import { useEffect, useMemo } from "react";
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
import { BehaviorSubject, EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { nip34RepoLoader, type Nip34RepoLoaderInputs } from "@/services/nostr";

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

  // Fetch issues from relay and pipe each newly discovered issue ID into
  // nip34ListLoader via nip34RepoLoader. The factory handles dedup (seenIds
  // in closure) and closes cleanly on unsubscribe. Coordinate growth and
  // role-history changes flow through inputs$ as additive delta REQs instead
  // of restarting the subscription. Filter merging with useNip34ItemLoader
  // calls is automatic because both share the same singleton loader
  // instances.
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
    return store.model(IssueListModel, cacheKey, {
      roleHistory,
    }) as unknown as Observable<ResolvedIssueLite[]>;
  }, [cacheKey, roleHistoryKey, store]);
}
