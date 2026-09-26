import { useEffect, useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import {
  useEventSearch,
  type EventSearchState,
  type RelayGroupSpec,
} from "./useEventSearch";
import type { SearchTarget } from "@/lib/searchForEvent";
import { RelayGroup } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { ignoreUnhealthyRelaysOnPointers } from "applesauce-relay/operators";
import { includeMailboxes } from "applesauce-core";
import { of, merge, Subscription } from "rxjs";
import { map } from "rxjs/operators";
import {
  liveness,
  nip34ListLoader,
  nip34ThreadItemLoader,
  eventStore as globalEventStore,
  pool,
} from "@/services/nostr";
import {
  gitIndexRelays,
  fallbackRelays,
  relayCurationMode,
} from "@/services/settings";
import { normalizeUrl } from "@/lib/url";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";

/** Max healthy inbox relays to take for the item author. */
const MAX_INBOX_RELAYS = 3;

/**
 * Subscribe reactively to a RelayGroup's relay URL list.
 * Re-renders (and re-runs dependent use$() calls) whenever the group gains
 * or loses relays. Returns a stable empty array when group is undefined.
 */
function useRelayGroupUrls(group: RelayGroup | undefined): string[] {
  const urls = use$(() => relayGroupUrls$(group), [group]);
  return urls ?? [];
}

/**
 * Minimum number of the author's inbox relays that must already be present in
 * the group before we consider coverage sufficient and skip adding more.
 */
const INBOX_COVERAGE_THRESHOLD = 2;

export interface Nip34ItemLoaderOptions {
  /**
   * When true, also fires nip34ThreadItemLoader to fetch reactions (kind:7)
   * and zaps (kind:9735) on the root item and recursively on each comment.
   * Enable on detail pages (IssuePage / PRPage).
   * Default: false.
   */
  includeThread?: boolean;
  /**
   * When true, also fetches from the NIP-65 inbox relays of the item author
   * when those relays are not already sufficiently covered by the group.
   * Enable on detail pages (IssuePage / PRPage) for completeness.
   * Default: false.
   */
  includeAuthorNip65?: boolean;
  /**
   * Supplemental relay group whose events must participate in the same
   * item-reference closure as the repository relays. In outbox mode this is
   * the maintainer mailbox delta group.
   */
  supplementalRelayGroup?: RelayGroup;
  /**
   * User-activated search groups whose relays must join the existing item
   * closure without restarting it.
   */
  additionalThreadRelayGroups?: RelayGroupSpec[];
}

/** Add normalized URLs to a RelayGroup without disturbing existing relays. */
function addRelayUrls(group: RelayGroup, urls: string[]): void {
  for (const url of urls) {
    const relay = pool.relay(normalizeUrl(url));
    if (!group.has(relay)) group.add(relay);
  }
}

/**
 * Build one stable, item-scoped relay union for the recursive thread closure.
 *
 * RelayGroup.add() and loadEventReferenceClosure are both additive: a newly
 * discovered relay gets subscriptions for the IDs already in the closure,
 * while subscriptions on existing relays remain open. The group is recreated
 * only when the item, repository, or curation scope changes.
 */
function useAdditiveThreadRelayGroup(
  itemScopeKey: string,
  repoRelayGroup: RelayGroup | undefined,
  supplementalRelayGroup: RelayGroup | undefined,
  additionalGroups: RelayGroupSpec[] | undefined,
  authorInboxDelta: string[],
  enabled: boolean,
): RelayGroup | undefined {
  const group = useMemo(
    () => (enabled ? new RelayGroup([]) : undefined),
    // itemScopeKey and repoRelayGroup intentionally define this resource's
    // lifetime even though the new group does not read their values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemScopeKey, repoRelayGroup, enabled],
  );

  useEffect(() => {
    if (!group) return;

    const subscriptions = new Subscription();
    const relaySources = [
      relayGroupUrls$(repoRelayGroup),
      ...(supplementalRelayGroup
        ? [relayGroupUrls$(supplementalRelayGroup)]
        : []),
      ...(additionalGroups?.map(({ relays$ }) => relays$) ?? []),
    ];

    for (const source of relaySources) {
      subscriptions.add(source.subscribe((urls) => addRelayUrls(group, urls)));
    }

    return () => subscriptions.unsubscribe();
  }, [group, repoRelayGroup, supplementalRelayGroup, additionalGroups]);

  const authorInboxDeltaKey = authorInboxDelta.join(",");
  useEffect(() => {
    if (group) addRelayUrls(group, authorInboxDelta);
    // The stable key avoids rerunning this effect for an equivalent array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, authorInboxDeltaKey]);

  return group;
}

/**
 * Reactively resolve the NIP-65 inbox relays for a single pubkey that are
 * NOT already sufficiently covered by the repo relay group.
 *
 * Returns [] when coverage is already met or when disabled.
 */
function useAuthorInboxDeltaRelays(
  pubkey: string | undefined,
  repoRelayGroup: RelayGroup | undefined,
  enabled: boolean,
): string[] {
  const store = useEventStore();

  const groupRelaySet = new Set(
    repoRelayGroup?.relays.map((r) => normalizeUrl(r.url)) ?? [],
  );
  const groupRelayKey = [...groupRelaySet].sort().join(",");

  const inboxDeltaRelays = use$(() => {
    if (!enabled || !pubkey) return of([] as string[]);
    return of([{ pubkey }]).pipe(
      includeMailboxes(store, "inbox"),
      ignoreUnhealthyRelaysOnPointers(liveness),
      map((enriched) => {
        const online = new Set(liveness.online);
        const authorInboxRelays = (enriched[0]?.relays ?? [])
          .map(normalizeUrl)
          .slice()
          .sort((a, b) => (online.has(a) ? 0 : 1) - (online.has(b) ? 0 : 1));

        const overlapCount = authorInboxRelays.filter((r) =>
          groupRelaySet.has(r),
        ).length;

        if (overlapCount >= INBOX_COVERAGE_THRESHOLD) return [] as string[];

        const seen = new Set<string>(groupRelaySet);
        const delta: string[] = [];
        for (const relay of authorInboxRelays) {
          if (delta.length >= MAX_INBOX_RELAYS) break;
          if (!seen.has(relay)) {
            seen.add(relay);
            delta.push(relay);
          }
        }
        return delta;
      }),
    );
  }, [pubkey, groupRelayKey, enabled, store]);

  return inboxDeltaRelays ?? [];
}

/**
 * Triggers loading for a single NIP-34 item (issue, patch, or PR).
 *
 * Two loading levels:
 *
 *   list (always) — essentials (status, labels, deletions) + comments.
 *     Fires nip34ListLoader. Merges automatically with nip34RepoLoader
 *     calls from useIssues / usePRs because both use the same singleton
 *     loader instances — applesauce batches them into one relay subscription.
 *
 *   thread (when includeThread is true) — reactions + zaps on root and
 *     recursively on each comment. Fires nip34ThreadItemLoader. Does NOT
 *     re-fire essentials or comments.
 *
 * NIP-65 author inbox relays: when includeAuthorNip65 is true, both levels
 * are also fired against the delta inbox relays (those not already covered
 * by the group). Thread loading uses one item-scoped union so an ID discovered
 * on any source is queried on every other source, including repository relays.
 *
 * @param itemId         - The event ID of the issue / patch / PR
 * @param repoRelayGroup - The base relay group from useResolvedRepository
 * @param options        - Thread and NIP-65 options
 */
export function useNip34ItemLoader(
  itemId: string | undefined,
  repoRelayGroup: RelayGroup | undefined,
  options?: Nip34ItemLoaderOptions,
): void {
  const store = useEventStore();
  const includeThread = options?.includeThread ?? false;

  // Reactive relay list — re-subscribes loaders when the group gains new relays
  const repoRelays = useRelayGroupUrls(repoRelayGroup);
  const repoRelayKey = repoRelays.join(",");

  // ── Repo relay loaders ────────────────────────────────────────────────────

  // List level: essentials + comments (always fires)
  use$(() => {
    if (!itemId || repoRelays.length === 0) return undefined;
    return nip34ListLoader(itemId, repoRelays);
  }, [itemId, repoRelayKey]);

  // ── NIP-65 author inbox relay loaders ─────────────────────────────────────
  const authorPubkey = use$(() => {
    if (!itemId || !options?.includeAuthorNip65) return of(undefined);
    return store.event(itemId).pipe(map((ev) => ev?.pubkey));
  }, [itemId, options?.includeAuthorNip65, store]);

  const authorInboxDelta = useAuthorInboxDeltaRelays(
    authorPubkey,
    repoRelayGroup,
    options?.includeAuthorNip65 ?? false,
  );

  const inboxDeltaKey = authorInboxDelta.join(",");

  // List level on inbox delta relays
  use$(() => {
    if (!itemId || authorInboxDelta.length === 0) return undefined;
    return nip34ListLoader(itemId, authorInboxDelta);
  }, [itemId, inboxDeltaKey]);

  // Thread level across one additive union. Neither author-inbox discovery nor
  // RelayGroup growth tears down subscriptions that are already live.
  const threadRelayGroup = useAdditiveThreadRelayGroup(
    `${itemId ?? ""}:${options?.includeAuthorNip65 ? "outbox" : "curated"}`,
    repoRelayGroup,
    options?.supplementalRelayGroup,
    options?.additionalThreadRelayGroups,
    authorInboxDelta,
    includeThread,
  );

  use$(() => {
    if (!itemId || !includeThread || !threadRelayGroup) return undefined;
    return nip34ThreadItemLoader(itemId, relayGroupUrls$(threadRelayGroup));
  }, [itemId, includeThread, threadRelayGroup]);
}

// ---------------------------------------------------------------------------
// Batch loader — fire loaders for multiple item IDs at once
// ---------------------------------------------------------------------------

/**
 * Triggers loading for multiple NIP-34 item IDs simultaneously.
 *
 * Internally calls nip34ListLoader (and optionally nip34ThreadItemLoader)
 * for each ID. Because the singleton loader instances batch all calls within
 * their buffer window, this results in a single merged relay subscription
 * rather than N separate ones.
 *
 * @param itemIds        - Array of event IDs to load
 * @param repoRelayGroup - The base relay group from useResolvedRepository
 * @param options        - Thread and NIP-65 options (applied to all IDs)
 */
export function useNip34ItemLoaderBatch(
  itemIds: string[],
  repoRelayGroup: RelayGroup | undefined,
  options?: Nip34ItemLoaderOptions,
): void {
  const store = useEventStore();
  const includeThread = options?.includeThread ?? false;

  // Reactive relay list — re-subscribes loaders when the group gains new relays
  const repoRelays = useRelayGroupUrls(repoRelayGroup);
  const repoRelayKey = repoRelays.join(",");
  // Stable key for the ID list — re-subscribes only when IDs actually change
  const idsKey = [...itemIds].sort().join(",");

  // List level: essentials + comments for all IDs
  use$(() => {
    if (itemIds.length === 0 || repoRelays.length === 0) return undefined;
    return merge(...itemIds.map((id) => nip34ListLoader(id, repoRelays)));
  }, [idsKey, repoRelayKey]);

  // NIP-65 author inbox relay loading per item
  // (Only fires when includeAuthorNip65 is true — resolves each item's author
  // from the store and loads their inbox delta relays.)
  const authorPubkeys = use$(() => {
    if (!options?.includeAuthorNip65 || itemIds.length === 0)
      return of([] as string[]);
    // Resolve pubkeys from the store synchronously
    const pubkeys = itemIds
      .map(
        (id) =>
          (store.getByFilters([{ ids: [id] }]) as NostrEvent[])[0]?.pubkey,
      )
      .filter((pk): pk is string => !!pk);
    return of([...new Set(pubkeys)]);
  }, [idsKey, options?.includeAuthorNip65, store]);

  const uniquePubkeys = authorPubkeys ?? [];

  // For each unique author pubkey, compute inbox delta relays and load
  // (We reuse useAuthorInboxDeltaRelays for the first pubkey only as a
  // simplification — full multi-author inbox loading is a future enhancement)
  const firstPubkey = uniquePubkeys[0];
  const authorInboxDelta = useAuthorInboxDeltaRelays(
    firstPubkey,
    repoRelayGroup,
    options?.includeAuthorNip65 ?? false,
  );
  const inboxDeltaKey = authorInboxDelta.join(",");

  // List level on inbox delta relays
  use$(() => {
    if (itemIds.length === 0 || authorInboxDelta.length === 0) return undefined;
    return merge(...itemIds.map((id) => nip34ListLoader(id, authorInboxDelta)));
  }, [idsKey, inboxDeltaKey]);

  // Thread level across one additive union for the whole revision batch.
  const threadRelayGroup = useAdditiveThreadRelayGroup(
    `${idsKey}:${options?.includeAuthorNip65 ? "outbox" : "curated"}`,
    repoRelayGroup,
    options?.supplementalRelayGroup,
    options?.additionalThreadRelayGroups,
    authorInboxDelta,
    includeThread,
  );

  use$(() => {
    if (itemIds.length === 0 || !includeThread || !threadRelayGroup)
      return undefined;
    return merge(
      ...itemIds.map((id) =>
        nip34ThreadItemLoader(id, relayGroupUrls$(threadRelayGroup)),
      ),
    );
  }, [idsKey, includeThread, threadRelayGroup]);
}

// ---------------------------------------------------------------------------
// Detail-page loader — shared by useResolvedIssue and useResolvedPR
// ---------------------------------------------------------------------------

export interface Nip34ItemDetailLoaderResult {
  /** Stable string key for use in downstream use$() dep arrays */
  maintainerKey: string;
  /** Search state from useEventSearch — undefined until search starts */
  search: EventSearchState | undefined;
}

/**
 * Merge two EventSearchState objects into one for display.
 *
 * The primary search is the authoritative source; the extra search adds
 * relay statuses and can contribute found/deleted/vanished signals.
 * concludedNotFound is only true when BOTH searches have concluded.
 */
function mergeSearchStates(
  primary: EventSearchState,
  extra: EventSearchState | undefined,
): EventSearchState {
  if (!extra) return primary;

  // If either found the event, use that result
  if (extra.found && !primary.found) {
    return {
      ...extra,
      relayStatuses: { ...primary.relayStatuses, ...extra.relayStatuses },
      settled: primary.settled || extra.settled,
    };
  }

  return {
    relayStatuses: { ...primary.relayStatuses, ...extra.relayStatuses },
    activeGroup: primary.activeGroup ?? extra.activeGroup,
    found: primary.found || extra.found,
    event: primary.event ?? extra.event,
    deleted: primary.deleted || extra.deleted,
    deletionEvent: primary.deletionEvent ?? extra.deletionEvent,
    vanished: primary.vanished || extra.vanished,
    vanishEvent: primary.vanishEvent ?? extra.vanishEvent,
    // Only conclude not-found when both searches are done
    concludedNotFound: primary.concludedNotFound && extra.concludedNotFound,
    settled: primary.settled || extra.settled,
  };
}

/**
 * Fetches a single NIP-34 item's root event from relays and triggers
 * list + thread loading.
 *
 * Shared between useResolvedIssue and useResolvedPR. Both hooks need the same
 * steps:
 *   1. Check if the event is already in the EventStore (skip search if so)
 *   2. Search for the root event via useEventSearch with ordered relay groups:
 *      - repo relays (always)
 *      - outbox mode: also includes extra maintainer mailbox relays
 *      - curated mode: git index + extra relays are NOT auto-added (user must
 *        trigger expansion via the UI)
 *   3. Trigger useNip34ItemLoader with includeThread: true
 *
 * When extraSearchGroups is provided (user clicked "search more relays"), a
 * separate useEventSearch is run for those groups so the primary search is
 * never torn down and restarted. The two states are merged for display.
 *
 * @param itemId          - The event ID of the root issue / PR / patch
 * @param repoRelayGroup  - Base relay group from useResolvedRepository
 * @param extraRelaysForMaintainerMailboxCoverage - Delta relay group for outbox mode
 * @param maintainers     - Effective maintainer set (used to derive a stable key)
 * @param extraSearchGroups - Additional relay groups to search (e.g. when user
 *                            clicks "search more relays" in curated mode)
 * @param retryKey        - Increment to force a fresh search across all relays
 */
export function useNip34ItemDetailLoader(
  itemId: string | undefined,
  repoRelayGroup: RelayGroup | undefined,
  extraRelaysForMaintainerMailboxCoverage: RelayGroup | undefined,
  maintainers: Set<string> | undefined,
  extraSearchGroups?: RelayGroupSpec[],
  retryKey?: number,
  privateRepository = false,
): Nip34ItemDetailLoaderResult {
  const curationMode = use$(relayCurationMode);

  // ── 1. Check if event is already in the store ────────────────────────────
  const alreadyInStore = itemId
    ? globalEventStore.getByFilters([{ ids: [itemId] }]).length > 0
    : false;

  // ── 2. Search for root event via useEventSearch ──────────────────────────
  // Build relay groups based on curation mode:
  //   - Always: repo relays
  //   - Outbox mode: + extra maintainer mailbox relays, + git index, + extra relays
  //   - Curated mode: only repo relays initially; user can add more via extraSearchGroups
  const searchGroups = useMemo<RelayGroupSpec[]>(() => {
    const groups: RelayGroupSpec[] = [];

    // Primary: repo relays (reactive — grows as RepositoryRelayGroup discovers relays)
    if (repoRelayGroup) {
      groups.push({
        label: "repo relays",
        relays$: relayGroupUrls$(repoRelayGroup),
      });
    }

    if (!privateRepository && curationMode === "outbox") {
      // Outbox mode: add maintainer mailbox relays as second group
      if (extraRelaysForMaintainerMailboxCoverage) {
        groups.push({
          label: "maintainer outbox relays",
          relays$: relayGroupUrls$(extraRelaysForMaintainerMailboxCoverage),
        });
      }
      // Then git index + extra relays as fallback
      groups.push({
        label: "git index",
        relays$: gitIndexRelays,
      });
      groups.push({
        label: "fallback relays",
        relays$: fallbackRelays,
        deferred: true,
      });
    }

    // Fallback when no repo relay group yet: use git index relays directly
    if (!privateRepository && !repoRelayGroup) {
      groups.push({
        label: "git index",
        relays$: gitIndexRelays,
      });
    }

    return groups;
  }, [
    repoRelayGroup,
    extraRelaysForMaintainerMailboxCoverage,
    curationMode,
    privateRepository,
  ]);

  const searchTarget = useMemo<SearchTarget | undefined>(() => {
    if (!itemId || alreadyInStore) return undefined;
    return { type: "event", id: itemId };
  }, [itemId, alreadyInStore]);

  const primarySearch = useEventSearch(
    searchTarget,
    searchGroups,
    undefined,
    retryKey,
  );

  // ── Extra relay search (user-triggered "search more relays") ─────────────
  // Run as a completely separate useEventSearch so the primary search is
  // never torn down and restarted when extra groups are added.
  const extraSearchTarget = useMemo<SearchTarget | undefined>(() => {
    if (
      privateRepository ||
      !itemId ||
      alreadyInStore ||
      !extraSearchGroups?.length
    )
      return undefined;
    return { type: "event", id: itemId };
  }, [privateRepository, itemId, alreadyInStore, extraSearchGroups?.length]);

  const extraSearch = useEventSearch(
    extraSearchTarget,
    extraSearchGroups ?? [],
    undefined,
    retryKey,
  );

  // Merge primary + extra search states for the UI
  const search = useMemo(
    () =>
      primarySearch !== undefined
        ? mergeSearchStates(primarySearch, extraSearch)
        : undefined,
    [primarySearch, extraSearch],
  );

  // ── 3. Trigger loading (list + thread) ───────────────────────────────────
  useNip34ItemLoader(itemId, repoRelayGroup, {
    includeThread: true,
    includeAuthorNip65: !privateRepository && curationMode === "outbox",
    supplementalRelayGroup:
      !privateRepository && curationMode === "outbox"
        ? extraRelaysForMaintainerMailboxCoverage
        : undefined,
    additionalThreadRelayGroups: privateRepository
      ? undefined
      : extraSearchGroups,
  });

  const maintainerKey = maintainers
    ? [...maintainers].sort().join(",")
    : "loading";

  return { maintainerKey, search };
}
