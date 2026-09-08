import { useEffect, useMemo } from "react";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import {
  useEventSearch,
  type EventSearchState,
  type RelayGroupSpec,
} from "./useEventSearch";
import type { SearchTarget } from "@/lib/searchForEvent";
import { includeMailboxes, mapEventsToStore } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { RelayGroup } from "applesauce-relay";
import type { RelayGroup as RelayGroupType } from "applesauce-relay";
import { ignoreUnhealthyRelaysOnPointers } from "applesauce-relay/operators";
import {
  pool,
  liveness,
  eventStore as globalEventStore,
  deletionEvents$,
} from "@/services/nostr";
import {
  resilientSubscription,
  resilientRequest,
} from "@/lib/resilientSubscription";
import { announcementSnapshot } from "@/lib/announcementSnapshot";
import type { RelayQuerySettlement } from "@/lib/relayQuerySettlement";
import { REPO_KIND, REPO_STATE_KIND, type ResolvedRepo } from "@/lib/nip34";
import {
  gitIndexRelays,
  fallbackRelays,
  lookupRelays,
} from "@/services/settings";
import { RepositoryModel } from "@/models/RepositoryModel";
import { RepositoryRelayGroup } from "@/models/RepositoryRelayGroup";
import type { Filter } from "applesauce-core/helpers";
import { BehaviorSubject, combineLatest, defer, Observable, of } from "rxjs";
import {
  debounceTime,
  distinctUntilChanged,
  map,
  switchMap,
} from "rxjs/operators";
import { normalizeUrl } from "@/lib/url";
import {
  usePrivateRepositoryProbe,
  type PrivateRepositoryProbeState,
} from "@/hooks/usePrivateRepositoryProbe";
import { markPrivateRepositoryCoordinate } from "@/services/privateRepositoryScope";
import {
  createRelaySubscriptionCoverage,
  type RelaySubscriptionCoverage,
} from "@/lib/relaySubscriptionCoverage";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";

/** Max healthy mailbox relays to take per maintainer when querying NIP-65 relays. */
const MAX_MAILBOX_RELAYS_PER_USER = 3;
export const REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS = 5_000;

export interface ResolvedRepository {
  repo: ResolvedRepo;
  /** Base RelayGroup: repo-declared relays + relay hints only.
   *  Always pass to useIssues / usePRs / useNip34ItemLoader. */
  repoRelayGroup: RelayGroupType;
  /** Delta RelayGroup: maintainer outbox + inbox relays that are NOT already
   *  in repoRelayGroup (up to MAX_MAILBOX_RELAYS_PER_USER each, prioritising
   *  connected relays). Empty until NIP-65 resolution completes.
   *  When outbox curation mode is enabled, subscribe to this group IN ADDITION
   *  to repoRelayGroup — do not swap one for the other. */
  extraRelaysForMaintainerMailboxCoverage: RelayGroupType;
  /** Lifecycle evidence owned by the shared announcement/state subscription. */
  replaceableCoverage: RelaySubscriptionCoverage;
  /** Exact-ID deletion evidence for the current announcement/state candidates. */
  replaceableDeletionCoverage: RelaySubscriptionCoverage;
  /** Candidate IDs covered by replaceableDeletionCoverage. */
  replaceableDeletionCandidateIds: readonly string[];
  /** Prevents dynamic deletion evidence from opening a REQ during GRASP writes. */
  replaceableWriteWindow: RepositoryReplaceableWriteWindow;
}

export interface RepositoryReplaceableWriteWindow {
  readonly changes$: Observable<number>;
  isHeld(): boolean;
  hold(): () => void;
}

function createRepositoryReplaceableWriteWindow(): RepositoryReplaceableWriteWindow {
  const changes$ = new BehaviorSubject(0);
  let holds = 0;
  return {
    changes$,
    isHeld: () => holds > 0,
    hold: () => {
      holds += 1;
      changes$.next(changes$.value + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        changes$.next(changes$.value + 1);
      };
    },
  };
}

/** Full result from useResolvedRepository, including search state for the
 *  repo announcement itself. */
export interface ResolvedRepositoryResult {
  /** The resolved repository data and relay groups, or undefined while loading. */
  resolved: ResolvedRepository | undefined;
  /** Search state for the repo announcement — undefined if the event was
   *  already in the store (no search needed). */
  repoSearch: EventSearchState | undefined;
  /**
   * First-fresh-EOSE readiness tier: true once any initial-snapshot relay has
   * delivered an actual EOSE for the identifier-only announcement wave this
   * session. Cached store data alone never sets it, so a stale cached graph
   * from a previous visit cannot cause a redirect-then-bounce. Gates the
   * lead-maintainer redirect.
   */
  announcementsFreshEose: boolean;
  /**
   * Full-snapshot readiness tier: true once the identifier-only announcement
   * wave plus the one-shot deletion follow-up have settled on every initial
   * relay. Monotonic — enrichment discovery never resets it. Gates absence
   * conclusions (archived, deleted, or restarted coordinate) and the
   * fail-closed membership surfaces.
   */
  announcementsSettled: boolean;
  /** Coverage detail for the full snapshot (relay and failure counts). */
  announcementSettlement: RelayQuerySettlement;
  /** Private discovery always settles before ordinary repository discovery. */
  privateProbe: PrivateRepositoryProbeState | undefined;
}

/**
 * Add relay URLs from an enriched pointer list to a delta RelayGroup, skipping
 * any relay already present in either the delta group or the base group.
 * Prioritises online relays and caps at MAX_MAILBOX_RELAYS_PER_USER per pointer.
 *
 * @param enriched  - Pointers with resolved relay lists
 * @param deltaGroup - The delta group to populate (only receives new relays)
 * @param baseGroup  - The base group whose relays are excluded from the delta
 */
function addMailboxRelaysToGroup(
  enriched: { pubkey: string; relays?: string[] }[],
  deltaGroup: RelayGroupType,
  baseGroup: RelayGroupType,
): void {
  const online = new Set(liveness.online);
  // Exclude relays already in either group so the delta stays truly additive.
  const seen = new Set<string>([
    ...baseGroup.relays.map((r) => r.url),
    ...deltaGroup.relays.map((r) => r.url),
  ]);
  for (const pointer of enriched) {
    const relays = (pointer.relays ?? [])
      .slice()
      .sort((a, b) => (online.has(a) ? 0 : 1) - (online.has(b) ? 0 : 1));
    let count = 0;
    for (const relay of relays) {
      if (count >= MAX_MAILBOX_RELAYS_PER_USER) break;
      if (!seen.has(relay)) {
        seen.add(relay);
        const r = pool.relay(relay);
        if (!deltaGroup.has(r)) deltaGroup.add(r);
      }
      count++;
    }
  }
}

/**
 * Fetch and reactively resolve a single repository by selected maintainer
 * pubkey + d-tag.
 *
 * Layer 1: search for the selected maintainer's announcement via useEventSearch.
 *          Searches ordered relay groups sequentially (git index + relay hints
 *          first, then outbox-mode extras). Skips the search if the announcement
 *          is already in the store. Provides per-relay status signals and
 *          not-found / deleted / vanished detection.
 *
 * Layer 2: RepositoryModel — reactive BFS chain resolution. Emits a new
 *          ResolvedRepo whenever any announcement in the chain changes.
 *          Cached by the store — multiple components on the same page share
 *          one model instance.
 *
 * Layer 3: once the ResolvedRepo is known, re-query the repo's own declared
 *          relays for ALL maintainer announcements. Adds relays to both groups.
 *
 * Layer 4: resolve each maintainer's NIP-65 outbox AND inbox relays and add
 *          any not already in repoRelayGroup to extraRelaysForMaintainerMailboxCoverage.
 *          Always runs (not gated on useItemAuthorRelays) so announcement
 *          discovery is always thorough.
 *
 * Returns both groups plus search state. Callers always use repoRelayGroup
 * and, when outbox curation mode is enabled, additionally subscribe to
 * extraRelaysForMaintainerMailboxCoverage.
 */
export function useResolvedRepository(
  pubkey: string | undefined,
  dTag: string | undefined,
  relayHints: string[] = [],
  nip05Relays: string[] = [],
): ResolvedRepositoryResult {
  const store = useEventStore();
  const key = `${pubkey}:${dTag}`;
  const hintsKey = relayHints.join(",");
  const nip05RelaysKey = nip05Relays.join(",");
  const privateProbe = usePrivateRepositoryProbe(pubkey, dTag, [
    ...nip05Relays,
    ...relayHints,
  ]);
  const privateProbeStatus = privateProbe?.status;

  // ── Layer 1: search for the repo announcement via useEventSearch ─────────
  // Check if the event is already in the store — skip the search if so.
  const alreadyInStore =
    pubkey && dTag
      ? !!globalEventStore.getReplaceable(REPO_KIND, pubkey, dTag)
      : false;

  // Build relay groups based on curation mode:
  //   - Always: git index relays + relay hints (merged into one group)
  //   - Outbox mode: + extra relays as fallback
  //   - Curated mode: only git index + hints
  const searchGroups = useMemo<RelayGroupSpec[]>(() => {
    const groups: RelayGroupSpec[] = [];

    // First: NIP-05 identity relays — most authoritative for nip05 routes.
    if (nip05Relays.length > 0) {
      groups.push({
        label: "NIP-05 relays",
        relays$: of(nip05Relays),
      });
    }

    // Second: URL relay hints (naddr hints etc.), excluding any NIP-05 relays.
    const urlOnlyHints = relayHints.filter((r) => !nip05Relays.includes(r));
    if (urlOnlyHints.length > 0) {
      groups.push({
        label: "relay hints",
        relays$: of(urlOnlyHints),
      });
    }

    // Third: git index relays (excluding hints already covered above).
    const allHints = new Set([...nip05Relays, ...relayHints].map(normalizeUrl));
    groups.push({
      label: "git index",
      relays$: gitIndexRelays.pipe(
        map((gitRelays) =>
          gitRelays.filter((r) => !allHints.has(normalizeUrl(r))),
        ),
      ),
    });

    // Extra relays are deferred: they start only after the immediate tier
    // (NIP-05 relays + relay hints + git index) has settled — i.e. first
    // relay response + 200 ms debounce, or 4 s hard timeout.
    // Curation mode only gates issue/PR subscription breadth — the initial
    // repo announcement search should always fall back to fallback relays so
    // repos not indexed by the git index can still be found.
    groups.push({
      label: "fallback relays",
      relays$: fallbackRelays,
      deferred: true,
    });

    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintsKey, nip05RelaysKey]);

  const searchTarget = useMemo<SearchTarget | undefined>(() => {
    if (!pubkey || !dTag || alreadyInStore || privateProbeStatus !== "absent")
      return undefined;
    return { type: "address", kind: REPO_KIND, pubkey, dTag };
  }, [pubkey, dTag, alreadyInStore, privateProbeStatus]);

  const repoSearch = useEventSearch(searchTarget, searchGroups);

  // No separate background refresh is needed when the event is already in the
  // store: the monotonic snapshot below always sends the identifier-only
  // announcement wave over the same hint + git index relays at mount, which
  // is a strict superset of the old authors-scoped refresh.

  // Layer 2: subscribe to the model.
  const publicRepo = use$(() => {
    if (!pubkey || !dTag || privateProbeStatus !== "absent") return undefined;
    return store.model(
      RepositoryModel,
      pubkey,
      dTag,
      deletionEvents$,
    ) as unknown as Observable<ResolvedRepo | undefined>;
  }, [key, store, privateProbeStatus]);
  const repo = privateProbeStatus === "found" ? privateProbe?.repo : publicRepo;
  const stateCandidates = use$(() => {
    if (!repo || !dTag || repo.confirmedMaintainers.length === 0)
      return undefined;
    return store.timeline([
      {
        kinds: [REPO_STATE_KIND],
        authors: repo.confirmedMaintainers,
        "#d": [dTag],
      } as Filter,
    ]);
  }, [dTag, repo?.confirmedMaintainers.join(","), store]);
  const privateCoordinateKey = repo?.isPrivate
    ? repo.confirmedMemberCoordinates.join(",")
    : "";
  useEffect(() => {
    if (!repo?.isPrivate) return;
    markPrivateRepositoryCoordinate(repo.selectedCoordinate);
    for (const coordinate of repo.confirmedMemberCoordinates) {
      markPrivateRepositoryCoordinate(coordinate);
    }
  }, [repo, privateCoordinateKey]);

  // Base RelayGroup: repo-declared relays + relay hints only.
  // Backed by the RepositoryRelayGroup model so it's cached and shared.
  const publicRepoRelayGroup = use$(() => {
    if (!pubkey || !dTag || privateProbeStatus !== "absent") return undefined;
    return store.model(
      RepositoryRelayGroup,
      pubkey,
      dTag,
    ) as unknown as Observable<RelayGroupType>;
  }, [key, store, privateProbeStatus]);
  const privateRelayKey = privateProbe?.relayUrls.join(",") ?? "";
  const privateRepoRelayGroup = useMemo(
    () =>
      privateProbeStatus === "found"
        ? new RelayGroup(
            (privateProbe?.relayUrls ?? []).map((relay) => pool.relay(relay)),
          )
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [privateProbeStatus, privateRelayKey],
  );
  const repoRelayGroup = privateRepoRelayGroup ?? publicRepoRelayGroup;

  // Seed the relay group with URL relay hints immediately so subscriptions
  // can start before the announcement event arrives.
  useMemo(() => {
    if (
      privateProbeStatus !== "absent" ||
      !repoRelayGroup ||
      relayHints.length === 0
    )
      return;
    for (const url of relayHints) {
      const relay = pool.relay(url);
      if (!repoRelayGroup.has(relay)) repoRelayGroup.add(relay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRelayGroup, hintsKey, privateProbeStatus]);

  // Delta group: maintainer outbox + inbox relays not already in repoRelayGroup.
  // Stable reference — created once per (pubkey, dTag) pair.
  const extraRelaysForMaintainerMailboxCoverage = useMemo(
    () => (pubkey && dTag ? new RelayGroup([]) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Parallel BehaviorSubject tracking the extra group's relay URLs so we can
  // pass a reactive relay list to resilientSubscription without needing access
  // to RelayGroup's protected relays$ observable.
  const extraRelays$ = useMemo(
    () => (pubkey && dTag ? new BehaviorSubject<string[]>([]) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // One page-owned logical scope has two leases over the same relay frontier.
  // The base lease stays live across ordinary event arrivals. Exact-ID NIP-09
  // evidence is isolated in a coalesced lease because those filters are
  // candidate-dependent and must not restart the stable announcement/state
  // query every time a new winner arrives.
  const currentMaintainers = repo?.confirmedMaintainers ?? [];
  const currentDeletionAuthors = repo
    ? [
        ...new Set([
          ...repo.discoveryPubkeys,
          ...repo.historyPubkeys,
          ...repo.confirmedMaintainers,
        ]),
      ].sort()
    : [];
  const currentDeletionCandidateIds = repo
    ? [
        ...new Set([
          ...repo.discoveredAnnouncements.map(({ id }) => id),
          ...repo.historicalAnnouncements.map(({ id }) => id),
          ...(stateCandidates ?? []).map(({ id }) => id),
        ]),
      ].sort()
    : [];
  const replaceableWriteWindow = useMemo(
    () => createRepositoryReplaceableWriteWindow(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const writeWindowRevision = use$(
    () => replaceableWriteWindow.changes$,
    [replaceableWriteWindow],
  );
  const authorityInput$ = useMemo(
    () =>
      new BehaviorSubject({
        maintainers: [] as string[],
        deletionAuthors: [] as string[],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const currentMaintainerKey = currentMaintainers.join(",");
  const currentDeletionAuthorsKey = currentDeletionAuthors.join(",");
  useEffect(() => {
    if (!replaceableWriteWindow.isHeld()) {
      authorityInput$.next({
        maintainers: currentMaintainers,
        deletionAuthors: currentDeletionAuthors,
      });
    }
    // The keys capture content equality while repository resolution recreates
    // the arrays. A held GRASP transition adopts pending authority on release.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentMaintainerKey,
    currentDeletionAuthorsKey,
    authorityInput$,
    replaceableWriteWindow,
    writeWindowRevision,
  ]);
  const coverageAuthority =
    use$(() => authorityInput$, [authorityInput$]) ?? authorityInput$.value;
  const coverageMaintainers = coverageAuthority.maintainers;
  const deletionAuthors = coverageAuthority.deletionAuthors;
  const maintainerKey = coverageMaintainers.join(",");
  const deletionAuthorsKey = deletionAuthors.join(",");
  const deletionCandidateInput$ = useMemo(
    () => new BehaviorSubject<string[]>([]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const currentDeletionCandidateKey = currentDeletionCandidateIds.join(",");
  useEffect(() => {
    if (!replaceableWriteWindow.isHeld()) {
      deletionCandidateInput$.next(currentDeletionCandidateIds);
    }
    // The key captures content equality; the array itself is recreated while
    // repository models project the same candidate set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentDeletionCandidateKey,
    deletionCandidateInput$,
    replaceableWriteWindow,
    writeWindowRevision,
  ]);
  const deletionCandidateIds =
    use$(
      () =>
        deletionCandidateInput$.pipe(
          debounceTime(1_000),
          distinctUntilChanged(
            (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
          ),
        ),
      [deletionCandidateInput$],
    ) ?? [];
  const deletionCandidateKey = deletionCandidateIds.join(",");
  const replaceableCoverage = useMemo(
    () =>
      createRelaySubscriptionCoverage({
        settlementTimeoutMs: REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, maintainerKey, deletionAuthorsKey, privateProbeStatus],
  );
  const replaceableDeletionCoverage = useMemo(
    () =>
      createRelaySubscriptionCoverage({
        settlementTimeoutMs: REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, deletionAuthorsKey, deletionCandidateKey, privateProbeStatus],
  );

  use$(() => {
    if (
      (privateProbeStatus !== "absent" && privateProbeStatus !== "found") ||
      !pubkey ||
      !dTag ||
      !repoRelayGroup ||
      !extraRelays$
    )
      return undefined;
    const repoRelayUrls$ = relayGroupUrls$(repoRelayGroup);
    // Private repository coordinates must never leak to public maintainer
    // mailbox or index relays. Their admitted private repository relays own the
    // same lifecycle proof by themselves. Public repositories retain mailbox
    // enrichment, but only the base repository relays vote in preflight.
    const enrichmentRelays$ =
      privateProbeStatus === "found"
        ? repoRelayUrls$
        : combineLatest([repoRelayUrls$, extraRelays$]).pipe(
            map(([base, extra]) => [...new Set([...base, ...extra])]),
            distinctUntilChanged(
              (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
            ),
          );
    const filters: Filter[] = [
      { kinds: [REPO_KIND], "#d": [dTag] } as Filter,
      ...(coverageMaintainers.length
        ? [
            {
              kinds: [REPO_STATE_KIND],
              authors: coverageMaintainers,
              "#d": [dTag],
            } as Filter,
          ]
        : []),
      ...(deletionAuthors.length > 0
        ? [
            {
              kinds: [5],
              authors: deletionAuthors,
              "#a": deletionAuthors.flatMap((author) => [
                `${REPO_KIND}:${author}:${dTag}`,
                `${REPO_STATE_KIND}:${author}:${dTag}`,
              ]),
            } as Filter,
          ]
        : []),
    ];
    const source = resilientSubscription(pool, enrichmentRelays$, filters, {
      settle: false,
      retryCount: Infinity,
      onRelayLifecycle: (event) => replaceableCoverage.onLifecycle(event),
    }).pipe(onlyEvents(), mapEventsToStore(store));

    return new Observable((subscriber) => {
      const subscription = source.subscribe(subscriber);
      return () => {
        replaceableCoverage.stop();
        subscription.unsubscribe();
      };
    });
  }, [
    key,
    maintainerKey,
    deletionAuthorsKey,
    store,
    repoRelayGroup,
    extraRelays$,
    privateProbeStatus,
    replaceableCoverage,
  ]);

  // Exact event-pointer deletions are one batched REQ per relay for the whole
  // repository, never one subscription per kind or writer. The candidate set
  // is frozen while a GRASP state transition is between relay acceptance and
  // Git push, so a newly visible state cannot trigger a hidden read there.
  use$(() => {
    if (
      (privateProbeStatus !== "absent" && privateProbeStatus !== "found") ||
      !repoRelayGroup ||
      !extraRelays$ ||
      deletionAuthors.length === 0 ||
      deletionCandidateIds.length === 0
    )
      return undefined;
    const repoRelayUrls$ = relayGroupUrls$(repoRelayGroup);
    const enrichmentRelays$ =
      privateProbeStatus === "found"
        ? repoRelayUrls$
        : combineLatest([repoRelayUrls$, extraRelays$]).pipe(
            map(([base, extra]) => [...new Set([...base, ...extra])]),
            distinctUntilChanged(
              (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
            ),
          );
    const source = resilientSubscription(
      pool,
      enrichmentRelays$,
      [
        {
          kinds: [5],
          authors: deletionAuthors,
          "#e": deletionCandidateIds,
        } as Filter,
      ],
      {
        settle: false,
        retryCount: Infinity,
        onRelayLifecycle: (event) =>
          replaceableDeletionCoverage.onLifecycle(event),
      },
    ).pipe(onlyEvents(), mapEventsToStore(store));

    return new Observable((subscriber) => {
      const subscription = source.subscribe(subscriber);
      return () => {
        replaceableDeletionCoverage.stop();
        subscription.unsubscribe();
      };
    });
  }, [
    key,
    deletionAuthorsKey,
    deletionCandidateKey,
    store,
    repoRelayGroup,
    extraRelays$,
    privateProbeStatus,
    replaceableDeletionCoverage,
  ]);

  // Layer 3: once known, add the repository's declared relays to the reactive
  // group. The shared replaceable owner above opens its full filter revision
  // on each joining relay.
  const repoRelayKey = repo?.relays.join(",") ?? "";
  const discoveryKey = repo?.discoveryPubkeys.join(",") ?? "";
  // If a relay was previously added to extraRelaysForMaintainerMailboxCoverage
  // (Layer 4) and is now declared by the repo itself, remove it from the delta
  // group — repoRelayGroup now covers it and the delta subscription closes cleanly.
  use$(() => {
    if (
      privateProbeStatus !== "absent" ||
      !dTag ||
      !repo ||
      !repoRelayGroup ||
      repo.relays.length === 0
    )
      return undefined;

    for (const url of repo.relays) {
      const relay = pool.relay(url);
      if (!repoRelayGroup.has(relay)) repoRelayGroup.add(relay);
      // Evict from the delta group if it was added there before the announcement
      // arrived — repoRelayGroup now provides coverage for this relay.
      if (extraRelaysForMaintainerMailboxCoverage?.has(relay)) {
        extraRelaysForMaintainerMailboxCoverage.remove(relay);
        if (extraRelays$) {
          extraRelays$.next(
            extraRelaysForMaintainerMailboxCoverage.relays.map((r) => r.url),
          );
        }
      }
    }

    return of(null);
  }, [
    dTag,
    repoRelayKey,
    discoveryKey,
    store,
    repoRelayGroup,
    extraRelays$,
    extraRelaysForMaintainerMailboxCoverage,
    privateProbeStatus,
  ]);

  // Layer 4: resolve maintainer outbox + inbox relays. Only relays not already
  // in repoRelayGroup are added to the enrichment frontier. They receive the
  // same query but never become repository preflight voters.
  use$(() => {
    if (
      privateProbeStatus !== "absent" ||
      !dTag ||
      !repo ||
      !repoRelayGroup ||
      !extraRelaysForMaintainerMailboxCoverage ||
      !extraRelays$ ||
      repo.discoveryPubkeys.length === 0
    )
      return undefined;

    const pointers = repo.discoveryPubkeys.map((pk) => ({ pubkey: pk }));
    const outbox$ = of(pointers).pipe(
      includeMailboxes(store, "outbox"),
      ignoreUnhealthyRelaysOnPointers(liveness),
    );
    const inbox$ = of(pointers).pipe(
      includeMailboxes(store, "inbox"),
      ignoreUnhealthyRelaysOnPointers(liveness),
    );

    return combineLatest([outbox$, inbox$]).pipe(
      switchMap(([outboxEnriched, inboxEnriched]) => {
        addMailboxRelaysToGroup(
          outboxEnriched,
          extraRelaysForMaintainerMailboxCoverage,
          repoRelayGroup,
        );
        addMailboxRelaysToGroup(
          inboxEnriched,
          extraRelaysForMaintainerMailboxCoverage,
          repoRelayGroup,
        );

        const urls = extraRelaysForMaintainerMailboxCoverage.relays.map(
          (r) => r.url,
        );
        extraRelays$.next(urls);

        return of(null);
      }),
    ) as unknown as Observable<null>;
  }, [
    dTag,
    discoveryKey,
    store,
    repoRelayGroup,
    extraRelaysForMaintainerMailboxCoverage,
    extraRelays$,
    privateProbeStatus,
  ]);

  // Mailbox enrichment (kind 10002): demoted from the settlement critical
  // path unconditionally. Resolving maintainer relay lists only widens the
  // Layer 4 mailbox coverage above and never gates readiness — announcements
  // that exist solely on a maintainer's mailbox relays arrive progressively.
  const historyKey = repo?.historyPubkeys.join(",") ?? "";
  use$(() => {
    if (
      privateProbeStatus !== "absent" ||
      !repo ||
      repo.discoveryPubkeys.length === 0
    )
      return undefined;
    const authors = [
      ...new Set([...repo.discoveryPubkeys, ...repo.historyPubkeys]),
    ];
    const relays = [
      ...new Set(
        [...lookupRelays.getValue(), ...fallbackRelays.getValue()].map(
          normalizeUrl,
        ),
      ),
    ];
    if (relays.length === 0) return undefined;
    return resilientRequest(pool, relays, [
      { kinds: [10002], authors } as Filter,
    ]).pipe(onlyEvents(), mapEventsToStore(store));
  }, [discoveryKey, historyKey, store, privateProbeStatus]);

  // ── Monotonic initial routing snapshot ────────────────────────────────────
  // Keyed once per route: (pubkey, dTag, relay hints). R0 is read at
  // subscription time — NIP-05/URL hints plus the configured git index
  // relays, with the fallback relays as a deferred tier that joins only when
  // the immediate tier yields no announcement (mirrors the useEventSearch
  // group ordering above). The identifier-only filter never changes as
  // maintainers are discovered, so the snapshot settles exactly once; the
  // authors, repo-declared relays, and mailbox relays discovered later feed
  // the enrichment subscriptions above and never re-gate any readiness tier.
  // The snapshot also settles with failedRelayCount > 0 — degraded coverage
  // is surfaced through announcementSettlement, not blocking.
  const snapshotState = use$(() => {
    if (!pubkey || !dTag || privateProbeStatus !== "absent") return undefined;
    return defer(() =>
      announcementSnapshot({
        pool,
        store,
        pubkey,
        dTag,
        primaryRelays: [
          ...nip05Relays,
          ...relayHints,
          ...gitIndexRelays.getValue(),
        ],
        deferredRelays: fallbackRelays.getValue(),
      }),
    );
  }, [key, hintsKey, nip05RelaysKey, store, privateProbeStatus]);
  const privateFound = privateProbeStatus === "found";
  const announcementsFreshEose = privateFound
    ? true
    : (snapshotState?.firstFreshEose ?? false);
  const announcementSettlement: RelayQuerySettlement = privateFound
    ? {
        settled: true,
        relayCount: privateProbe?.relayUrls.length ?? 0,
        failedRelayCount: 0,
      }
    : (snapshotState?.settlement ?? {
        settled: false,
        relayCount: 0,
        failedRelayCount: 0,
      });
  const announcementsSettled = announcementSettlement.settled;

  const resolved: ResolvedRepository | undefined =
    repo && repoRelayGroup && extraRelaysForMaintainerMailboxCoverage
      ? {
          repo,
          repoRelayGroup,
          extraRelaysForMaintainerMailboxCoverage,
          replaceableCoverage,
          replaceableDeletionCoverage,
          replaceableDeletionCandidateIds: deletionCandidateIds,
          replaceableWriteWindow,
        }
      : undefined;

  return {
    resolved,
    repoSearch: privateProbeStatus === "absent" ? repoSearch : undefined,
    announcementsFreshEose,
    announcementsSettled,
    announcementSettlement,
    privateProbe,
  };
}
