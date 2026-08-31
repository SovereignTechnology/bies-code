/**
 * Shared, keyed CI network-query owners.
 *
 * Every observable exported here writes events into the global EventStore and
 * reports RelayQuerySettlement coverage. Owners are module singletons shared
 * across all mounted components (see keyedShared), so identity context is
 * fetched once and read back from the store by leaf components, and a newly
 * discovered identity triggers exactly one enrichment fetch instead of
 * restarting queries for the identities already known.
 */

import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import {
  combineLatest,
  defer,
  of,
  ReplaySubject,
  Subject,
  timer,
  type Observable,
} from "rxjs";
import {
  distinctUntilChanged,
  map,
  share,
  shareReplay,
  switchMap,
} from "rxjs/operators";
import type { RelayGroup } from "applesauce-relay";
import type { AdditiveFilterChunk } from "@/lib/resilientSubscription";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_EVENT_KINDS,
  CI_MANUAL_TRIGGER_KIND,
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
  CI_REPOSITORY_STATUS_KIND,
  CI_REQUEST_READINESS_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
} from "@/lib/ci";
import { REPO_KIND, parseRepoCoordinate } from "@/lib/nip34";
import { KEYED_SHARE_LINGER_MS, keyedShared } from "@/lib/keyedShared";
import {
  RepositoryRelayGroup,
  relayGroupUrls$,
} from "@/models/RepositoryRelayGroup";
import {
  loadAdditiveRelayQueryUntilSettled,
  loadRelayQueryUntilSettled,
  type RelayQuerySettlement,
} from "@/lib/relayQuerySettlement";
import { eventStore, pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

const SETTLED_EMPTY: RelayQuerySettlement = {
  settled: true,
  relayCount: 0,
  failedRelayCount: 0,
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Lookup + index relays as a deduplicated, order-stable reactive list. */
function discoveryRelays$(): Observable<string[]> {
  return combineLatest([lookupRelays, gitIndexRelays]).pipe(
    map(([lookup, indexes]) => sortedUnique([...lookup, ...indexes])),
    distinctUntilChanged<string[]>(sameList),
  );
}

/** Index relays as a deduplicated, order-stable reactive list. */
function indexRelays$(): Observable<string[]> {
  return gitIndexRelays.pipe(
    map((relays) => sortedUnique(relays)),
    distinctUntilChanged<string[]>(sameList),
  );
}

/**
 * A keyed additive query owner: the accumulated chunk set plus the stream
 * feeding chunks added while the shared query is live.
 */
interface AdditiveOwner {
  chunks: Map<string, AdditiveFilterChunk>;
  additions: Subject<AdditiveFilterChunk>;
  query$: Observable<RelayQuerySettlement>;
}

/**
 * Return a per-key shared additive settlement query, folding `chunks` into
 * the owner's accumulated set. New chunk keys reach a live query as delta
 * REQs via additions$; already-known keys are no-ops, so covered values are
 * never re-fetched. Sharing mirrors keyedShared: the latest settlement is
 * replayed and the source lingers KEYED_SHARE_LINGER_MS past the last
 * unsubscribe. After the linger elapses the next subscriber re-runs the
 * query from scratch with every chunk accumulated so far, refreshing cached
 * results. Chunks are never retracted — the union only grows.
 */
function additiveOwnerQuery(
  cache: Map<string, AdditiveOwner>,
  key: string,
  relays: () => Observable<string[]>,
  chunks: readonly AdditiveFilterChunk[],
): Observable<RelayQuerySettlement> {
  let owner = cache.get(key);
  if (!owner) {
    const created: AdditiveOwner = {
      chunks: new Map(),
      additions: new Subject<AdditiveFilterChunk>(),
      query$: of(SETTLED_EMPTY),
    };
    created.query$ = defer(() =>
      loadAdditiveRelayQueryUntilSettled(
        pool,
        relays(),
        {
          initial: [...created.chunks.values()],
          additions$: created.additions,
        },
        eventStore,
      ),
    ).pipe(
      share({
        connector: () => new ReplaySubject<RelayQuerySettlement>(1),
        resetOnRefCountZero: () => timer(KEYED_SHARE_LINGER_MS),
      }),
    );
    cache.set(key, created);
    owner = created;
  }
  for (const chunk of chunks) {
    if (owner.chunks.has(chunk.key)) continue;
    owner.chunks.set(chunk.key, chunk);
    owner.additions.next(chunk);
  }
  return owner.query$;
}

/**
 * Reactive relay URLs for the repository identified by `coordinate`, resolved
 * through the model-cached RepositoryRelayGroup. Owners subscribe to the
 * model themselves rather than capturing a caller's RelayGroup instance:
 * every (re)connection binds whatever group the model cache currently holds,
 * and while the owner is connected (including the share linger) its model
 * subscription keeps the group's relay discovery live.
 */
function repositoryRelays$(
  coordinate: string | undefined,
): Observable<string[]> {
  const parsed = parseRepoCoordinate(coordinate);
  if (!parsed) return of([] as string[]);
  return (
    eventStore.model(
      RepositoryRelayGroup,
      parsed.pubkey,
      parsed.identifier,
    ) as unknown as Observable<RelayGroup>
  ).pipe(
    switchMap((group) => relayGroupUrls$(group)),
    map((urls) => sortedUnique(urls)),
    distinctUntilChanged<string[]>(sameList),
  );
}

/**
 * Kinds fetched once per CI identity: profile, NIP-65 relay list, coordinator
 * advertisement, request readiness, and provider advertisement. One REQ per
 * identity serves every surface that displays or classifies that identity.
 */
export const CI_IDENTITY_ENRICHMENT_KINDS = [
  0,
  10002,
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_REQUEST_READINESS_KIND,
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
] as const;

const identityEnrichment = new Map<string, Observable<RelayQuerySettlement>>();

/**
 * Shared per-pubkey enrichment fetch for CI provider / coordinator
 * identities on the lookup + index relays. All consumers of the same pubkey
 * share one live query; results are read back from the EventStore. A relay
 * added to the discovery lists later joins the live query with one REQ of
 * its own instead of restarting the REQs already open.
 */
export function ciIdentityEnrichment$(
  pubkey: string,
): Observable<RelayQuerySettlement> {
  return keyedShared(identityEnrichment, pubkey, () =>
    loadAdditiveRelayQueryUntilSettled(
      pool,
      discoveryRelays$(),
      {
        initial: [
          {
            key: pubkey,
            filters: [
              {
                kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
                authors: [pubkey],
              } as Filter,
            ],
          },
        ],
      },
      eventStore,
    ),
  );
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(([tagName, value]) => tagName === name && !!value)
    .map(([, value]) => value);
}

/** Per-stage settlement of the viewer's social repository graph. */
export interface ViewerSocialGraphSettlement {
  /** Contact lists (kinds 3 / 10017) for the account. */
  contacts: RelayQuerySettlement;
  /** Repository announcements authored by the account and its follows. */
  repositories: RelayQuerySettlement;
  /** The `#d` graph completing multi-maintainer repository components. */
  graph: RelayQuerySettlement;
}

const viewerSocialGraphs = new Map<
  string,
  Observable<ViewerSocialGraphSettlement>
>();

/**
 * Viewer-scoped social repository graph: the account's contact lists, every
 * kind:30617 announced by the account or its follows, and the `#d` graph
 * completing those repository components. The pipeline is account-scoped and
 * repository-independent, so one shared owner serves every CI trust surface
 * instead of each page (or coordinator-page row) re-running it.
 */
export function viewerSocialGraph$(
  accountPubkey: string,
): Observable<ViewerSocialGraphSettlement> {
  return keyedShared(viewerSocialGraphs, accountPubkey, () => {
    const indexes$ = gitIndexRelays.pipe(
      map((relays) => sortedUnique(relays)),
      distinctUntilChanged<string[]>(sameList),
    );

    const contacts$ = discoveryRelays$().pipe(
      switchMap((relays) =>
        loadRelayQueryUntilSettled(
          pool,
          relays,
          [{ kinds: [3, 10017], authors: [accountPubkey] } as Filter],
          eventStore,
        ),
      ),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    // The account itself is always included so surfaces that reason about
    // the viewer's own repositories share the same fetch.
    const people$ = combineLatest([
      eventStore.replaceable(3, accountPubkey),
      eventStore.replaceable(10017, accountPubkey),
    ]).pipe(
      map(([contacts, gitAuthors]) =>
        sortedUnique([
          accountPubkey,
          ...[contacts, gitAuthors]
            .filter((event): event is NostrEvent => !!event)
            .flatMap((event) => tagValues(event, "p")),
        ]),
      ),
      distinctUntilChanged<string[]>(sameList),
    );

    const repositories$ = combineLatest([contacts$, people$, indexes$]).pipe(
      switchMap(([contacts, people, indexes]) => {
        if (!contacts.settled) {
          return of<RelayQuerySettlement>({
            settled: false,
            relayCount: indexes.length,
            failedRelayCount: 0,
          });
        }
        return loadRelayQueryUntilSettled(
          pool,
          indexes,
          [{ kinds: [REPO_KIND], authors: people } as Filter],
          eventStore,
          { paginate: true },
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    const dTags$ = people$.pipe(
      switchMap(
        (people) =>
          eventStore.timeline([
            { kinds: [REPO_KIND], authors: people } as Filter,
          ]) as Observable<NostrEvent[]>,
      ),
      map((events) =>
        sortedUnique(events.flatMap((event) => tagValues(event, "d"))),
      ),
      distinctUntilChanged<string[]>(sameList),
    );

    const graph$ = combineLatest([repositories$, dTags$, indexes$]).pipe(
      switchMap(([repositories, dTags, indexes]) => {
        if (!repositories.settled) {
          return of<RelayQuerySettlement>({
            settled: false,
            relayCount: indexes.length,
            failedRelayCount: 0,
          });
        }
        if (dTags.length === 0) {
          return of<RelayQuerySettlement>({
            settled: true,
            relayCount: indexes.length,
            failedRelayCount: 0,
          });
        }
        return loadRelayQueryUntilSettled(
          pool,
          indexes,
          [{ kinds: [REPO_KIND], "#d": dTags } as Filter],
          eventStore,
          { paginate: true },
        );
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    return combineLatest([contacts$, repositories$, graph$]).pipe(
      map(([contacts, repositories, graph]) => ({
        contacts,
        repositories,
        graph,
      })),
    );
  });
}

const socialActivity = new Map<string, Observable<RelayQuerySettlement>>();

/**
 * Observed CI activity and follow-authored requests near the viewer's follow
 * graph for one identity. Keyed per identity (plus the social context), so a
 * newly appearing identity fetches only itself and identical queries mounted
 * by several surfaces (e.g. coordinator-page repository rows) share one REQ.
 */
export function ciSocialActivity$(
  identity: string,
  follows: readonly string[],
  coordinates: readonly string[],
  relays: readonly string[],
): Observable<RelayQuerySettlement> {
  const followList = sortedUnique(follows);
  const coordinateList = sortedUnique(coordinates);
  const relayList = sortedUnique(relays);
  const key = [
    identity,
    followList.join(","),
    coordinateList.join(","),
    relayList.join(","),
  ].join("|");
  return keyedShared(socialActivity, key, () => {
    const filters: Filter[] = [
      {
        kinds: [...CI_EVENT_KINDS],
        authors: [identity],
        "#a": coordinateList,
      } as Filter,
    ];
    if (followList.length) {
      filters.push({
        kinds: [CI_MANUAL_TRIGGER_KIND, CI_SERVICE_REQUEST_KIND],
        authors: followList,
        "#p": [identity],
        "#a": coordinateList,
      } as Filter);
    }
    return loadRelayQueryUntilSettled(pool, relayList, filters, eventStore, {
      paginate: true,
    });
  });
}

const coordinatorDiscovery = new Map<string, AdditiveOwner>();

/**
 * Coordinator discovery on the index relays: every coordinator advertisement
 * plus request readiness targeting any of the repository's confirmed
 * coordinates or maintainers. Shared by the Actions-tab presence probe in
 * RepoLayout and every repository surface that lists coordinators.
 *
 * The owner is keyed by the repository's first sorted coordinate, so a
 * coordinate or maintainer confirmed later grows the live query with one
 * delta REQ per relay instead of restarting it, and an index relay added
 * later joins with one REQ of its own. Both call sites derive their inputs
 * from the same confirmed sets, so they keep sharing one owner per repo.
 */
export function ciCoordinatorDiscovery$(
  repositoryCoordinates: readonly string[],
  maintainers: readonly string[],
): Observable<RelayQuerySettlement> {
  const coordinates = sortedUnique(repositoryCoordinates);
  const pubkeys = sortedUnique(maintainers);
  return additiveOwnerQuery(
    coordinatorDiscovery,
    coordinates[0] ?? "",
    indexRelays$,
    [
      {
        key: "advertisements",
        filters: [{ kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND] } as Filter],
        deltaSafe: true,
      },
      ...coordinates.map(
        (coordinate): AdditiveFilterChunk => ({
          key: `a:${coordinate}`,
          filters: [
            {
              kinds: [CI_REQUEST_READINESS_KIND],
              "#a": [coordinate],
            } as Filter,
          ],
          deltaSafe: true,
        }),
      ),
      ...pubkeys.map(
        (pubkey): AdditiveFilterChunk => ({
          key: `p:${pubkey}`,
          filters: [
            {
              kinds: [CI_REQUEST_READINESS_KIND],
              "#p": [pubkey],
            } as Filter,
          ],
          deltaSafe: true,
        }),
      ),
    ],
  );
}

const repositoryCoordinatorStatus = new Map<
  string,
  Observable<RelayQuerySettlement>
>();

/**
 * Repository status claims plus maintainer-authored service controls for the
 * selected coordinate, fetched from the repository relays. The relay set is
 * derived from the model-cached RepositoryRelayGroup for the selected
 * coordinate (falling back to the first coordinate), so it is a pure
 * function of the cache key rather than a captured caller argument.
 */
export function ciRepositoryCoordinatorStatus$(
  repositoryCoordinates: readonly string[],
  selectedCoordinate: string | undefined,
  maintainers: readonly string[],
): Observable<RelayQuerySettlement> {
  const coordinates = sortedUnique(repositoryCoordinates);
  const pubkeys = sortedUnique(maintainers);
  const key = `${coordinates.join(",")}|${selectedCoordinate ?? ""}|${pubkeys.join(",")}`;
  return keyedShared(repositoryCoordinatorStatus, key, () =>
    repositoryRelays$(selectedCoordinate ?? coordinates[0]).pipe(
      switchMap((relays) => {
        const filters: Filter[] = [
          { kinds: [CI_REPOSITORY_STATUS_KIND], "#a": coordinates } as Filter,
        ];
        if (selectedCoordinate && pubkeys.length) {
          filters.push({
            kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
            authors: pubkeys,
            "#a": [selectedCoordinate],
          } as Filter);
        }
        return loadRelayQueryUntilSettled(pool, relays, filters, eventStore);
      }),
    ),
  );
}

const repoCIActivityQueries = new Map<
  string,
  Observable<RelayQuerySettlement>
>();

/**
 * Live repo-wide CI activity (every CI kind by #a) on the repository relays.
 * One shared subscription per repository serves the PR list, Actions, and
 * coordinator surfaces; RepoLayout pins it while the repository shows CI
 * signals so tab navigation reuses it instead of reopening it per page.
 */
export function repoCIActivity$(
  repositoryCoordinates: readonly string[],
  selectedCoordinate: string | undefined,
): Observable<RelayQuerySettlement> {
  const coordinates = sortedUnique(repositoryCoordinates);
  const key = `${coordinates.join(",")}|${selectedCoordinate ?? ""}`;
  return keyedShared(repoCIActivityQueries, key, () =>
    repositoryRelays$(selectedCoordinate ?? coordinates[0]).pipe(
      switchMap((relays) =>
        loadRelayQueryUntilSettled(
          pool,
          relays,
          [{ kinds: [...CI_EVENT_KINDS], "#a": coordinates } as Filter],
          eventStore,
        ),
      ),
    ),
  );
}

const repositoryServiceControls = new Map<
  string,
  Observable<RelayQuerySettlement>
>();

/**
 * Maintainer-authored service request / stop history for a repository across
 * all confirmed coordinates, fetched from the repository's declared relays.
 * Shared by coordinator-page repository rows revisiting the same repository.
 */
export function ciRepositoryServiceControls$(
  repositoryCoordinates: readonly string[],
  maintainers: readonly string[],
  relays: readonly string[],
): Observable<RelayQuerySettlement> {
  const coordinates = sortedUnique(repositoryCoordinates);
  const pubkeys = sortedUnique(maintainers);
  const relayList = sortedUnique(relays);
  const key = `${coordinates.join(",")}|${pubkeys.join(",")}|${relayList.join(",")}`;
  return keyedShared(repositoryServiceControls, key, () =>
    loadRelayQueryUntilSettled(
      pool,
      relayList,
      [
        {
          kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
          authors: pubkeys,
          "#a": coordinates,
        } as Filter,
      ],
      eventStore,
      { paginate: true },
    ),
  );
}

/**
 * Combine per-identity settlements into one settlement snapshot: settled when
 * every query settled, with the most pessimistic relay coverage (smallest
 * relay count, largest failure count) so partial-coverage warnings surface if
 * any identity's query was incomplete.
 */
export function combineSettlements(
  settlements: readonly RelayQuerySettlement[],
): RelayQuerySettlement {
  if (settlements.length === 0) return SETTLED_EMPTY;
  return {
    settled: settlements.every((settlement) => settlement.settled),
    relayCount: Math.min(
      ...settlements.map((settlement) => settlement.relayCount),
    ),
    failedRelayCount: Math.max(
      ...settlements.map((settlement) => settlement.failedRelayCount),
    ),
  };
}
