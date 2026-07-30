/**
 * useRepositorySearch
 *
 * Two-mode hook for the RepositoriesPage:
 *
 * Mode 1 — Browse (empty query):
 *   Opens a resilientSubscription with manualPaginate$ against gitIndexRelays
 *   (or relayOverride). Events stream into the EventStore as they arrive;
 *   the EOSE settle signal clears isLoading. The IntersectionObserver sentinel
 *   calls loadMore() which fires the manualPaginate$ subject to fetch the next
 *   backward page. hasMore goes false when a page returns fewer than PAGE_SIZE
 *   events.
 *
 * Mode 2 — Search (non-empty committedQuery):
 *   Opens a resilientSubscription with manualPaginate$ for NIP-50
 *   { kinds: [30617], search: query } against gitIndexRelays. Simultaneously
 *   searches four NIP-50 profile relays for kind:0 candidates, validates and
 *   ranks their current EventStore winners, then fetches repositories for the
 *   newly matched authors in bounded, relay-settled requests.
 *   Results are pushed into a per-session BehaviorSubject so the UI always
 *   updates even when eventStore.add() is a no-op (dedup case).
 *
 *   Pubkey-query short-circuit: when the query decodes to a pubkey (raw 64-char
 *   hex or `npub1…`), NIP-50 over kind:0 content won't match — the pubkey is
 *   a top-level event field, not inside `content`. In that case we skip the
 *   kind:0 NIP-50 search entirely, treat the decoded pubkey as the matched
 *   user, and immediately fan out `{ kinds: [REPO_KIND], authors: [hex] }`
 *   against the gitIndexRelays. We still fire a fire-and-forget
 *   `{ kinds: [0], authors: [hex] }` against the profile-search relays and the
 *   gitIndex relays so the matched-user badge has profile metadata to render.
 *
 * RelayPage fix:
 *   When relayOverride is set, the displayed list is scoped to events that
 *   were actually received from those relays (via isFromRelay). This prevents
 *   EventStore events from other relays bleeding into the view.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BehaviorSubject, Subject, timer } from "rxjs";
import {
  getProfileContent,
  getPublicContacts,
  getTagValue,
  isFromRelay,
  isValidProfile,
} from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers";
import { useActiveAccount } from "applesauce-react/hooks";
import type { NostrEvent } from "nostr-tools";
import { pool, eventStore } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";
import {
  REPO_KIND,
  groupIntoResolvedRepos,
  type ResolvedRepo,
} from "@/lib/nip34";
import { use$ } from "./use$";
import { useEventStore } from "./useEventStore";
import { map, takeUntil } from "rxjs/operators";
import type { Observable } from "rxjs";
import {
  resilientSubscription,
  resilientRequest,
} from "@/lib/resilientSubscription";
import { decodePubkeyIdentifier } from "@/lib/routeUtils";
import { rankProfileSearchCandidates } from "@/lib/profileSearchRanking";
import { RepositoryModel } from "@/models/RepositoryModel";

const PROFILE_SEARCH_RELAYS = [
  "wss://relay.ditto.pub",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://search.nos.today",
];

const PAGE_SIZE = 20;
const PROFILE_CANDIDATE_LIMIT = 50;
const PROFILE_SEARCH_TIMEOUT_MS = 10_000;
const PROFILE_INTEGRATION_SETTLE_MS = 200;
// Each non-paginated author request is bounded per relay.
const USER_REPO_RESULT_LIMIT = 200;
const USER_REPO_TIMEOUT_MS = 10_000;
const GIT_AUTHORS_KIND = 10017;
const SOCIAL_FOLLOWS_KIND = 3;
const EMPTY_PUBKEYS: string[] = [];
// How long to wait after the last event in a pagination page before concluding
// the page is done. Covers both the normal case (events arrive then stop) and
// the zero-events case (relay exhausted — timer fires with count=0).
const PAGE_SETTLE_MS = 600;

/**
 * Per-relay query outcome for the current search/browse subscription.
 *
 * - "searching" — REQ sent, waiting for EOSE
 * - "success"   — EOSE received (relay answered, regardless of event count)
 * - "error"     — transport failure, permanent CLOSED, or retries exhausted
 */
export type RelayQueryStatus = "searching" | "success" | "error";

function getFollowPubkeys(event: NostrEvent | undefined): string[] {
  if (!event) return [];
  return [
    ...new Set(getPublicContacts(event).map((contact) => contact.pubkey)),
  ].sort();
}

export interface UseRepositorySearchResult {
  /** Resolved repos to display. undefined = initial loading. */
  repos: ResolvedRepo[] | undefined;
  /** True while a fetch is in flight (initial load, search, or pagination). */
  isLoading: boolean;
  /** True when there are more pages to load. */
  hasMore: boolean;
  /** Trigger the next page (called by IntersectionObserver sentinel). */
  loadMore: () => void;
  /**
   * Pubkeys that matched the NIP-50 kind:0 user search.
   * Empty set in browse mode or when no users matched.
   * Use to show a "matched user" badge on RepoCards.
   */
  matchedUserPubkeys: Set<string>;
  /**
   * Per-relay query status for the active subscription.
   * All relays start as "searching" when the subscription opens and
   * transition to "success" (EOSE) or "error" (failure) as results arrive.
   * Resets to all-"searching" whenever the relay list or query changes.
   */
  relayStatuses: Record<string, RelayQueryStatus>;
  /**
   * Per-relay status for the kind:0 candidate search.
   * Empty outside non-empty text searches.
   */
  profileRelayStatuses: Record<string, RelayQueryStatus>;
}

/**
 * Core hook for repository discovery and search.
 *
 * @param query         - Committed search query. Empty string = browse mode.
 * @param relayOverride - When set, query only these relays (RelayPage).
 */
export function useRepositorySearch(
  query: string,
  relayOverride?: string[],
): UseRepositorySearchResult {
  const store = useEventStore();
  const account = useActiveAccount();
  const accountPubkey = account?.pubkey;
  const gitFollowPubkeys =
    use$(() => {
      if (!accountPubkey) return undefined;
      return store
        .replaceable(GIT_AUTHORS_KIND, accountPubkey)
        .pipe(map(getFollowPubkeys));
    }, [accountPubkey, store]) ?? EMPTY_PUBKEYS;
  const socialFollowPubkeys =
    use$(() => {
      if (!accountPubkey) return undefined;
      return store
        .replaceable(SOCIAL_FOLLOWS_KIND, accountPubkey)
        .pipe(map(getFollowPubkeys));
    }, [accountPubkey, store]) ?? EMPTY_PUBKEYS;
  const gitFollowKey = gitFollowPubkeys.join(",");
  const socialFollowKey = socialFollowPubkeys.join(",");

  // Subscribe to gitIndexRelays reactively so relay changes re-trigger
  const liveGitIndexRelays =
    use$(() => gitIndexRelays, []) ?? gitIndexRelays.getValue();

  const relays = relayOverride ?? liveGitIndexRelays;
  const relayKey = relays.join(",");

  const trimmedQuery = query.trim();
  const isSearchMode = trimmedQuery.length > 0;
  // When the query is a raw hex pubkey or `npub1…` bech32, decode it once
  // here so the search effect can short-circuit the kind:0 NIP-50 search
  // (which doesn't index pubkey fields, only content).
  const pubkeyHexFromQuery = isSearchMode
    ? decodePubkeyIdentifier(trimmedQuery)
    : undefined;

  // ── Shared state ───────────────────────────────────────────────────────────

  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  // Browse mode: how many resolved repos to expose to the UI. Starts at
  // PAGE_SIZE and grows by PAGE_SIZE on each loadMore() call so the store
  // timeline is sliced lazily rather than dumping all cached events at once.
  const [browseDisplayLimit, setBrowseDisplayLimit] = useState(PAGE_SIZE);

  // Per-relay query status — initialised to all-"searching" when a subscription
  // opens, then flipped to "success" on actual EOSE or "error" on failure.
  const [relayStatuses, setRelayStatuses] = useState<
    Record<string, RelayQueryStatus>
  >({});
  const [profileRelayStatuses, setProfileRelayStatuses] = useState<
    Record<string, RelayQueryStatus>
  >({});

  // Subject that triggers the next backward page in the active subscription.
  const paginateSubRef = useRef<Subject<void> | null>(null);

  // Settle timer for pagination pages. Started immediately when loadMore() fires
  // (handles zero-events case) and reset on each incoming event. When it fires,
  // the page is considered done.
  const pageSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Count of events received in the current pagination page.
  const pageEventCountRef = useRef(0);
  // Whether we are currently waiting for a pagination page to settle.
  const paginatingRef = useRef(false);

  // Start (or restart) the page settle timer. Called immediately on loadMore()
  // and on every event that arrives while paginatingRef is true.
  const armPageSettleTimer = useCallback((onSettle: () => void) => {
    if (pageSettleTimerRef.current) clearTimeout(pageSettleTimerRef.current);
    pageSettleTimerRef.current = setTimeout(onSettle, PAGE_SETTLE_MS);
  }, []);

  const clearPageSettleTimer = useCallback(() => {
    if (pageSettleTimerRef.current) {
      clearTimeout(pageSettleTimerRef.current);
      pageSettleTimerRef.current = null;
    }
  }, []);

  // ── Browse mode ────────────────────────────────────────────────────────────

  // Full resolved repo list from the store — not sliced here so the
  // subscription stays stable and never briefly returns undefined when the
  // display limit advances (which would hide the sentinel and break scrolling).
  const allBrowseRepos = use$(() => {
    if (isSearchMode) return undefined;

    return store.timeline([{ kinds: [REPO_KIND] } as Filter]).pipe(
      map((events) => {
        const scoped =
          relayOverride && relayOverride.length > 0
            ? events.filter((ev) =>
                relayOverride.some((r) => isFromRelay(ev, r)),
              )
            : events;
        return groupIntoResolvedRepos(scoped);
      }),
    ) as unknown as Observable<ResolvedRepo[]>;
  }, [isSearchMode, store, relayKey]);

  // Apply the display limit outside of use$ so advancing it never causes a
  // re-subscribe (which would briefly yield undefined and hide the sentinel).
  const browseRepos = useMemo(
    () => allBrowseRepos?.slice(0, browseDisplayLimit),
    [allBrowseRepos, browseDisplayLimit],
  );

  // Hydrate each visible repository's recursive maintainer graph. The global
  // grouping already prefers a unique lead, but it can only do so after the
  // related announcements have reached the EventStore.
  useEffect(() => {
    if (isSearchMode || !browseRepos) return;

    const subscriptions = browseRepos.map((repo) =>
      (
        store.model(
          RepositoryModel,
          repo.selectedMaintainer,
          repo.dTag,
        ) as unknown as Observable<ResolvedRepo | undefined>
      ).subscribe(),
    );

    return () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
    };
  }, [browseRepos, isSearchMode, store]);

  useEffect(() => {
    if (isSearchMode) return;

    setIsLoading(true);
    setHasMore(true);
    setProfileRelayStatuses({});
    setBrowseDisplayLimit(PAGE_SIZE);
    paginatingRef.current = false;

    // Initialise all relays as "searching" for this subscription.
    setRelayStatuses(Object.fromEntries(relays.map((r) => [r, "searching"])));

    const paginate$ = new Subject<void>();
    paginateSubRef.current = paginate$;

    // Events received before EOSE (the initial page).
    let initialPageCount = 0;

    const sub = resilientSubscription(
      pool,
      relays,
      [{ kinds: [REPO_KIND], limit: PAGE_SIZE } as Filter],
      {
        manualPaginate$: paginate$,
        limit: PAGE_SIZE,
        onRelayEose: (relay) =>
          setRelayStatuses((prev) => ({ ...prev, [relay]: "success" })),
        onRelayError: (relay) =>
          setRelayStatuses((prev) => ({ ...prev, [relay]: "error" })),
      },
    ).subscribe({
      next: (msg) => {
        if (msg === "EOSE") {
          setHasMore(initialPageCount >= PAGE_SIZE);
          setIsLoading(false);
          return;
        }
        const ev = msg as NostrEvent;
        eventStore.add(ev);

        if (paginatingRef.current) {
          // Counting events in a pagination page — reset the settle timer.
          pageEventCountRef.current++;
          armPageSettleTimer(() => {
            paginatingRef.current = false;
            setHasMore(pageEventCountRef.current >= PAGE_SIZE);
            setIsLoading(false);
          });
        } else {
          initialPageCount++;
        }
      },
      error: () => {
        clearPageSettleTimer();
        setIsLoading(false);
      },
      complete: () => {
        clearPageSettleTimer();
        setIsLoading(false);
      },
    });

    return () => {
      sub.unsubscribe();
      paginate$.complete();
      paginateSubRef.current = null;
      clearPageSettleTimer();
    };
  }, [relayKey, isSearchMode, armPageSettleTimer, clearPageSettleTimer]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Search mode ────────────────────────────────────────────────────────────

  const [matchedUserPubkeys, setMatchedUserPubkeys] = useState<Set<string>>(
    new Set(),
  );

  // A BehaviorSubject that emits the current session's resolved repos directly.
  // Using a subject rather than store.timeline() + filter avoids the dedup
  // problem: when a repeated query causes the relay to re-deliver events that
  // are already in the EventStore, eventStore.add() is a no-op and never
  // notifies store.timeline() subscribers — so the results would stay blank.
  // By pushing resolved repos into this subject ourselves whenever an event
  // arrives (or is confirmed already in the store), we always get an emission.
  const searchReposSubjectRef = useRef<
    BehaviorSubject<ResolvedRepo[] | undefined>
  >(new BehaviorSubject<ResolvedRepo[] | undefined>(undefined));
  // Bumped each time a new search session starts so that use$ re-subscribes
  // to the freshly-created BehaviorSubject.
  const [searchSessionKey, setSearchSessionKey] = useState(0);

  // Reactive read of search results — driven by the subject above.
  // searchSessionKey in deps ensures use$ re-subscribes to the new subject
  // instance created for each query.
  const searchRepos = use$(() => {
    if (!isSearchMode) return undefined;
    return searchReposSubjectRef.current;
  }, [isSearchMode, searchSessionKey]);

  useEffect(() => {
    if (!isSearchMode) {
      setMatchedUserPubkeys(new Set());
      setProfileRelayStatuses({});
      setIsLoading(false);
      return;
    }

    // Start a fresh search session.
    setMatchedUserPubkeys(new Set());
    setProfileRelayStatuses({});
    setHasMore(true);
    paginatingRef.current = false;
    clearPageSettleTimer();

    // Initialise all relays as "searching" for this subscription.
    setRelayStatuses(Object.fromEntries(relays.map((r) => [r, "searching"])));

    let repoSub: { unsubscribe(): void } | null = null;
    let userSub: { unsubscribe(): void } | null = null;
    const userRepoSubs: { unsubscribe(): void }[] = [];
    const repoResolutionSubs = new Map<string, { unsubscribe(): void }>();

    setIsLoading(true);

    // Track direct and user-derived coordinates independently. Rebuilding the
    // result list resolves each coordinate through the EventStore so a stale
    // relay response can never displace the current addressable winner.
    const directRepoCoordinates = new Map<
      string,
      { pubkey: string; dTag: string }
    >();
    const userRepoCoordinates = new Map<
      string,
      { pubkey: string; dTag: string }
    >();
    const subject = new BehaviorSubject<ResolvedRepo[] | undefined>(undefined);
    searchReposSubjectRef.current = subject;
    // Bump the session key so use$ re-subscribes to this new subject instance.
    setSearchSessionKey((k) => k + 1);

    // Helper: rebuild and push the current resolved repo list into the subject.
    // Called on every incoming event (new or duplicate-in-store) so the UI
    // always updates even when eventStore.add() is a no-op (dedup case).
    const rememberRepoCoordinate = (
      event: NostrEvent,
      coordinates: Map<string, { pubkey: string; dTag: string }>,
    ) => {
      const dTag = getTagValue(event, "d");
      if (!dTag) return;
      coordinates.set(`${event.pubkey}:${dTag}`, {
        pubkey: event.pubkey,
        dTag,
      });

      const coordinateKey = `${event.pubkey}:${dTag}`;
      if (!repoResolutionSubs.has(coordinateKey)) {
        const resolutionSub = (
          store.model(
            RepositoryModel,
            event.pubkey,
            dTag,
          ) as unknown as Observable<ResolvedRepo | undefined>
        ).subscribe(() => pushResults());
        repoResolutionSubs.set(coordinateKey, resolutionSub);
      }
    };

    const pushResults = () => {
      const activeCoordinates = new Set<string>();
      const activeDTags = new Set<string>();
      for (const { pubkey, dTag } of [
        ...directRepoCoordinates.values(),
        ...userRepoCoordinates.values(),
      ]) {
        activeCoordinates.add(`${pubkey}:${dTag}`);
        activeDTags.add(dTag);
      }
      if (activeDTags.size === 0) {
        subject.next([]);
        return;
      }

      // Resolve each active coordinate with every current same-d announcement
      // in the store so reciprocal maintainer chains and merged metadata remain
      // intact. Filter the resolved components back to one with a confirmed
      // coordinate received by this session; same-d repositories in unrelated
      // components must not leak into the results.
      const currentAnnouncements = eventStore.getByFilters([
        {
          kinds: [REPO_KIND],
          "#d": [...activeDTags],
        } as Filter,
      ]);
      const resolved = groupIntoResolvedRepos(currentAnnouncements).filter(
        (repo) =>
          repo.confirmedMaintainers.some((pubkey) =>
            activeCoordinates.has(`${pubkey}:${repo.dTag}`),
          ),
      );
      subject.next(resolved);
    };

    const paginate$ = new Subject<void>();
    paginateSubRef.current = paginate$;

    // Initial loading ends after both independent search paths have produced
    // their first settled response: direct repository search, and profile
    // resolution followed by its first author-scoped repository request.
    // Slower relays keep streaming results and updating statuses afterward.
    let initialLoadingCleared = false;
    let directInitialDone = false;
    let userPathDone = false;
    let initialPageCount = 0;

    const maybeClearInitialLoading = () => {
      if (!initialLoadingCleared && directInitialDone && userPathDone) {
        initialLoadingCleared = true;
        // Always push results so an empty search transitions undefined → []
        // only after neither path can still produce an initial result.
        pushResults();
        setIsLoading(false);
      }
    };

    const finishDirectInitial = () => {
      if (directInitialDone) return;
      directInitialDone = true;
      setHasMore(initialPageCount >= PAGE_SIZE);
      maybeClearInitialLoading();
    };

    const finishUserPath = () => {
      if (userPathDone) return;
      userPathDone = true;
      maybeClearInitialLoading();
    };

    // NIP-50 repo search with manual pagination.
    repoSub = resilientSubscription(
      pool,
      relays,
      [
        {
          kinds: [REPO_KIND],
          search: trimmedQuery,
          limit: PAGE_SIZE,
        } as Filter,
      ],
      {
        manualPaginate$: paginate$,
        limit: PAGE_SIZE,
        onRelayEose: (relay) => {
          setRelayStatuses((prev) => ({ ...prev, [relay]: "success" }));
        },
        onRelayError: (relay) => {
          setRelayStatuses((prev) => ({ ...prev, [relay]: "error" }));
        },
      },
    ).subscribe({
      next: (msg) => {
        if (msg === "EOSE") {
          finishDirectInitial();
          return;
        }
        const ev = msg as NostrEvent;
        eventStore.add(ev);
        rememberRepoCoordinate(ev, directRepoCoordinates);
        // Push results regardless of whether eventStore.add was a no-op.
        pushResults();

        if (paginatingRef.current) {
          pageEventCountRef.current++;
          armPageSettleTimer(() => {
            paginatingRef.current = false;
            const more = pageEventCountRef.current >= PAGE_SIZE;
            setHasMore(more);
            setIsLoading(false);
          });
        } else {
          initialPageCount++;
        }
      },
      error: () => {
        clearPageSettleTimer();
        finishDirectInitial();
      },
      complete: () => {
        clearPageSettleTimer();
        finishDirectInitial();
      },
    });

    const profileCandidatePubkeys = new Set<string>();
    const dispatchedAuthors = new Set<string>();
    let profileStatusTrackingFinished = false;
    let profileSearchTimeout: ReturnType<typeof setTimeout> | null = null;
    let profileIntegrationTimer: ReturnType<typeof setTimeout> | null = null;

    const startUserRepoFetch = (authors: string[]) => {
      if (authors.length === 0) {
        finishUserPath();
        return;
      }

      // Fetch each newly matched author once. Slower profile relays add another
      // bounded request for only their undispatched matches; earlier requests
      // and results remain intact.
      const sub = resilientRequest(
        pool,
        relays,
        [
          {
            kinds: [REPO_KIND],
            authors,
            limit: USER_REPO_RESULT_LIMIT,
          } as Filter,
        ],
        {
          // This relay's events have already streamed into the results by EOSE.
          // Stop showing the initial loader without waiting for slower relays;
          // their events continue to integrate through the subscription.
          onRelayEose: finishUserPath,
        },
      )
        .pipe(takeUntil(timer(USER_REPO_TIMEOUT_MS)))
        .subscribe({
          next: (msg) => {
            if (msg === "EOSE") return;
            const ev = msg as NostrEvent;
            eventStore.add(ev);
            rememberRepoCoordinate(ev, userRepoCoordinates);
            pushResults();
          },
          error: finishUserPath,
          complete: finishUserPath,
        });
      userRepoSubs.push(sub);
    };

    const setProfileRelayStatus = (relay: string, status: RelayQueryStatus) => {
      setProfileRelayStatuses((prev) => ({ ...prev, [relay]: status }));
    };

    const integrateProfileCandidates = () => {
      if (profileIntegrationTimer) {
        clearTimeout(profileIntegrationTimer);
        profileIntegrationTimer = null;
      }
      const candidates = [...profileCandidatePubkeys].flatMap((pubkey) => {
        const event = eventStore.getReplaceable(0, pubkey);
        if (!event || !isValidProfile(event)) return [];
        const profile = getProfileContent(event);
        return profile
          ? [{ pubkey, profile, createdAt: event.created_at }]
          : [];
      });

      const matchedAuthors = rankProfileSearchCandidates(
        candidates,
        trimmedQuery,
        new Set(gitFollowPubkeys),
        new Set(socialFollowPubkeys),
      ).map((candidate) => candidate.pubkey);
      const newAuthors = matchedAuthors.filter(
        (pubkey) => !dispatchedAuthors.has(pubkey),
      );
      for (const pubkey of newAuthors) dispatchedAuthors.add(pubkey);
      setMatchedUserPubkeys(new Set(dispatchedAuthors));
      if (newAuthors.length > 0) {
        startUserRepoFetch(newAuthors);
      } else if (dispatchedAuthors.size === 0) {
        finishUserPath();
      }
    };

    const scheduleProfileIntegration = () => {
      if (profileIntegrationTimer) clearTimeout(profileIntegrationTimer);
      profileIntegrationTimer = setTimeout(
        integrateProfileCandidates,
        PROFILE_INTEGRATION_SETTLE_MS,
      );
    };

    const finishProfileStatusTracking = () => {
      if (profileStatusTrackingFinished) return;
      profileStatusTrackingFinished = true;
      if (profileSearchTimeout) {
        clearTimeout(profileSearchTimeout);
        profileSearchTimeout = null;
      }

      // Any relay still searching when the request completes or times out is
      // terminally unavailable for this search. Candidate integration is
      // intentionally independent: it normally starts shortly after the first
      // actual EOSE instead of waiting for these terminal statuses.
      setProfileRelayStatuses((prev) =>
        Object.fromEntries(
          PROFILE_SEARCH_RELAYS.map((relay) => [
            relay,
            prev[relay] === "searching" || prev[relay] === undefined
              ? "error"
              : prev[relay],
          ]),
        ),
      );
      integrateProfileCandidates();
    };

    if (pubkeyHexFromQuery) {
      // Pubkey-query short-circuit. NIP-50 `search:` indexes the kind:0
      // content blob, which does not contain the author's pubkey. Searching
      // for the pubkey string against any relay returns zero kind:0 events,
      // so the matched-user path never fires and the search appears broken.
      //
      // Instead: treat the decoded pubkey as the matched user immediately
      // (no kind:0 round-trip needed), and fetch profile metadata via an
      // `authors:` filter so the UserLink badge can render the name/avatar.
      // The metadata fetch is fire-and-forget. Initial loading still waits for
      // both the direct repository search and the author-scoped request below.
      dispatchedAuthors.add(pubkeyHexFromQuery);
      profileStatusTrackingFinished = true;
      const pubkeySet = new Set([pubkeyHexFromQuery]);
      setMatchedUserPubkeys(pubkeySet);
      // Fetch profile metadata from the user-search relay AND the gitIndex
      // relays — profile events are commonly carried by both.
      const profileRelays = Array.from(
        new Set([...PROFILE_SEARCH_RELAYS, ...relays]),
      );
      userSub = resilientRequest(pool, profileRelays, [
        { kinds: [0], authors: [pubkeyHexFromQuery] } as Filter,
      ])
        .pipe(takeUntil(timer(PROFILE_SEARCH_TIMEOUT_MS)))
        .subscribe({
          next: (msg) => {
            if (msg === "EOSE") return;
            eventStore.add(msg as NostrEvent);
          },
        });
      startUserRepoFetch([pubkeyHexFromQuery]);
    } else {
      const initialProfileStatuses = Object.fromEntries(
        PROFILE_SEARCH_RELAYS.map((relay) => [
          relay,
          "searching" as RelayQueryStatus,
        ]),
      );
      setProfileRelayStatuses(initialProfileStatuses);

      profileSearchTimeout = setTimeout(() => {
        userSub?.unsubscribe();
        finishProfileStatusTracking();
      }, PROFILE_SEARCH_TIMEOUT_MS);

      userSub = resilientRequest(
        pool,
        PROFILE_SEARCH_RELAYS,
        [
          {
            kinds: [0],
            search: trimmedQuery,
            limit: PROFILE_CANDIDATE_LIMIT,
          } as Filter,
        ],
        {
          onRelayEose: (relay) => {
            setProfileRelayStatus(relay, "success");
            // The relay's candidates have all arrived. Give other fast relays a
            // brief settle window, then rank and query repositories while slow
            // relays continue independently.
            scheduleProfileIntegration();
          },
          onRelayError: (relay) => setProfileRelayStatus(relay, "error"),
        },
      ).subscribe({
        next: (msg) => {
          // Per-relay EOSE callbacks above drive progressive integration. The
          // aggregate sentinel may also represent cooldown settle, so it is not
          // evidence that a profile relay actually answered.
          if (msg === "EOSE") return;
          const ev = msg as NostrEvent;
          profileCandidatePubkeys.add(ev.pubkey);
          eventStore.add(ev);
        },
        error: finishProfileStatusTracking,
        complete: finishProfileStatusTracking,
      });
    }

    return () => {
      repoSub?.unsubscribe();
      userSub?.unsubscribe();
      for (const sub of userRepoSubs) sub.unsubscribe();
      for (const sub of repoResolutionSubs.values()) sub.unsubscribe();
      if (profileSearchTimeout) clearTimeout(profileSearchTimeout);
      if (profileIntegrationTimer) clearTimeout(profileIntegrationTimer);
      paginateSubRef.current = null;
      clearPageSettleTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relays captured via relayKey
  }, [
    trimmedQuery,
    relayKey,
    isSearchMode,
    pubkeyHexFromQuery,
    accountPubkey,
    gitFollowKey,
    socialFollowKey,
    armPageSettleTimer,
    clearPageSettleTimer,
  ]);

  // ── loadMore ───────────────────────────────────────────────────────────────

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading || !paginateSubRef.current) return;
    setIsLoading(true);
    // Advance the display window so the newly-fetched events become visible
    // once they arrive.
    if (!isSearchMode) {
      setBrowseDisplayLimit((prev) => prev + PAGE_SIZE);
    }
    pageEventCountRef.current = 0;
    paginatingRef.current = true;
    // Arm the settle timer immediately — handles the zero-events case where the
    // relay is exhausted and no events arrive to reset the timer.
    armPageSettleTimer(() => {
      paginatingRef.current = false;
      setHasMore(pageEventCountRef.current >= PAGE_SIZE);
      setIsLoading(false);
    });
    paginateSubRef.current.next();
  }, [hasMore, isLoading, isSearchMode, armPageSettleTimer]);

  // ── Assemble final result ──────────────────────────────────────────────────

  if (isSearchMode) {
    return {
      repos: searchRepos,
      isLoading,
      hasMore,
      loadMore,
      matchedUserPubkeys,
      relayStatuses,
      profileRelayStatuses,
    };
  }

  return {
    repos: browseRepos,
    isLoading,
    hasMore,
    loadMore,
    matchedUserPubkeys: new Set(),
    relayStatuses,
    profileRelayStatuses: {},
  };
}
