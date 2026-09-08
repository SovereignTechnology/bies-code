import { useMemo } from "react";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { IEventStore } from "applesauce-core/event-store";
import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { RelayGroup } from "applesauce-relay";
import { makeCacheRequest } from "applesauce-loaders/helpers";
import { combineLatest, EMPTY, merge, of, type Observable } from "rxjs";
import {
  catchError,
  endWith,
  filter,
  ignoreElements,
  map,
  share,
  startWith,
} from "rxjs/operators";
import {
  SoftwareApplication,
  SoftwareAsset,
  SoftwareRelease,
  isValidSoftwareApplication,
  isValidSoftwareAsset,
  isValidSoftwareRelease,
  SOFTWARE_APPLICATION_KIND,
  SOFTWARE_ASSET_KIND,
  SOFTWARE_RELEASE_KIND,
} from "@/casts/Software";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  ZAPSTORE_RELAY_URL,
  useSoftwarePublisherApplications,
  type AccountSoftwareApplications,
} from "@/hooks/useSoftwarePublisherPreflight";
import {
  resilientRequest,
  resilientSubscription,
} from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import { cacheRequest } from "@/services/cache";
import { addressLoader, pool } from "@/services/nostr";

export { ZAPSTORE_RELAY_URL };
const RELEASE_DISCOVERY_LIMIT = 30;
const ASSET_FILTER_CHUNK_SIZE = 100;

export interface RepoSoftwareReleases {
  applications: SoftwareApplication[];
  releases: SoftwareRelease[];
  assetsById: Map<string, SoftwareAsset>;
  applicationsSettled: boolean;
  releasesSettled: boolean;
  assetsSettled: boolean;
}

export interface RepoReleaseSummary {
  hasReleases: boolean;
  latestRelease: SoftwareRelease | undefined;
  latestApplication: SoftwareApplication | undefined;
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

function uniqueRelayUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isWebSocketUrl(value)) continue;
    const normalized = normalizeUrl(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function loadCacheIntoStore(
  filters: Filter[],
  store: IEventStore,
): Observable<never> {
  return hydrateCacheIntoStore(filters, store).pipe(ignoreElements());
}

function hydrateCacheIntoStore(
  filters: Filter[],
  store: IEventStore,
): Observable<boolean> {
  return makeCacheRequest(cacheRequest, filters).pipe(
    mapEventsToStore(store),
    ignoreElements(),
    endWith(true),
    catchError(() => of(true)),
    startWith(false),
  );
}

/**
 * Keep one resilient relay subscription live, write its events to the shared
 * EventStore, and expose its initial EOSE settle state to the hook.
 */
function loadRelayIntoStore(
  relay: string,
  filters: Filter[],
  store: IEventStore,
  paginate = false,
): Observable<boolean> {
  const raw$ = resilientSubscription(pool, [relay], filters, {
    paginate,
  }).pipe(
    catchError(() => of("EOSE" as const)),
    share(),
  );

  return merge(
    raw$.pipe(onlyEvents(), mapEventsToStore(store), ignoreElements()),
    raw$.pipe(
      filter((message): message is "EOSE" => message === "EOSE"),
      map(() => true),
    ),
  ).pipe(startWith(false));
}

/**
 * A multi-relay resilientSubscription emits its aggregate EOSE after the first
 * relay settles plus a short debounce. That is useful for progressive feeds,
 * but it is too early to conclude that a staged lookup is empty: a later relay
 * (notably Zapstore) may still hold the requested events. Track each relay's
 * own EOSE and report settled only once every current relay has settled.
 *
 * Persistent cache results are hydrated alongside the relay work. Settlement
 * waits for both cache hydration and every relay probe so a fast EOSE cannot
 * expose a false empty state while IndexedDB is still loading. An empty relay
 * list remains unsettled because RepositoryRelayGroup starts empty and is
 * populated asynchronously.
 */
function loadIntoStoreUntilSettled(
  relays: string[],
  filters: Filter[],
  store: IEventStore,
  paginate = false,
): Observable<boolean> {
  const relaySettled$ =
    relays.length === 0
      ? of(false)
      : combineLatest(
          relays.map((relay) =>
            loadRelayIntoStore(relay, filters, store, paginate),
          ),
        ).pipe(map((settled) => settled.every(Boolean)));

  return combineLatest([
    hydrateCacheIntoStore(filters, store),
    relaySettled$,
  ]).pipe(
    map(([cacheSettled, relaysSettled]) => cacheSettled && relaysSettled),
  );
}

function castApplications(
  events: Parameters<typeof isValidSoftwareApplication>[0][],
  store: CastRefEventStore,
): SoftwareApplication[] {
  return events.flatMap((event) => {
    if (!isValidSoftwareApplication(event)) return [];
    try {
      return [new SoftwareApplication(event, store)];
    } catch {
      return [];
    }
  });
}

function castReleases(
  events: Parameters<typeof isValidSoftwareRelease>[0][],
  store: CastRefEventStore,
  applications?: SoftwareApplication[],
): SoftwareRelease[] {
  const applicationPublishers = applications
    ? new Map(
        applications.map((application) => [
          application.coordinate,
          application.pubkey,
        ]),
      )
    : undefined;
  return events
    .flatMap((event) => {
      if (!isValidSoftwareRelease(event)) return [];
      try {
        const release = new SoftwareRelease(event, store);
        if (
          applicationPublishers &&
          applicationPublishers.get(release.applicationCoordinate) !==
            release.pubkey
        ) {
          return [];
        }
        return [release];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        b.event.id.localeCompare(a.event.id),
    );
}

function castAssets(
  events: Parameters<typeof isValidSoftwareAsset>[0][],
  store: CastRefEventStore,
  permittedPublishers?: Map<string, Set<string>>,
): SoftwareAsset[] {
  return events.flatMap((event) => {
    if (!isValidSoftwareAsset(event)) return [];
    if (
      permittedPublishers &&
      !permittedPublishers.get(event.id)?.has(event.pubkey)
    ) {
      return [];
    }
    try {
      return [new SoftwareAsset(event, store)];
    } catch {
      return [];
    }
  });
}

function releaseFiltersForApplications(
  applications: SoftwareApplication[],
  limit?: number,
): Filter[] {
  // Compatibility (2026-08-06): Zapstore-published kind 30063 events do not
  // yet include application `a` tags. Fran agreed with our NIP-82 suggestion
  // and said he will add them. Since `i` remains required either way, one
  // author + app ID filter covers both forms without doubling this bounded
  // history request.
  return applications.map(
    (application) =>
      ({
        kinds: [SOFTWARE_RELEASE_KIND],
        authors: [application.pubkey],
        "#i": [application.appId],
        ...(limit === undefined ? {} : { limit }),
      }) as Filter,
  );
}

/**
 * Discover every software application published by one account from its
 * outbox, the current repository relays, and Zapstore. This is intentionally
 * author-scoped: these events are candidates the account can republish to add
 * a repository association, not trusted state for the current repository.
 */
export function useAccountSoftwareApplications(
  pubkey: string | undefined,
  repoRelayGroup: RelayGroup | undefined,
): AccountSoftwareApplications {
  return useSoftwarePublisherApplications(pubkey, repoRelayGroup);
}

/**
 * Discover NIP-82 applications on repository relays, then load their releases
 * and linked assets from the repository relays plus Zapstore.
 *
 * Application discovery is deliberately restricted to the repository's
 * transitive maintainer set and #a coordinates. Release authors are further
 * restricted to the publishers of those trusted application events. Assets
 * are fetched only by immutable IDs endorsed by a trusted release event.
 */
export function useSoftwareReleases(
  repoCoords: string[] | undefined,
  maintainerPubkeys: string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  privateRepository = false,
): RepoSoftwareReleases {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const coordsKey = [...(repoCoords ?? [])].sort().join(",");
  const maintainerKey = [...(maintainerPubkeys ?? [])].sort().join(",");

  const repoRelays =
    use$(() => relayGroupUrls$(repoRelayGroup), [repoRelayGroup]) ?? [];
  const repoRelayKey = repoRelays.join(",");

  const applicationFilter: Filter = {
    kinds: [SOFTWARE_APPLICATION_KIND],
    authors: maintainerPubkeys ?? [],
    "#a": repoCoords ?? [],
  } as Filter;

  const applicationsSettled =
    use$(() => {
      if (!repoCoords?.length || !maintainerPubkeys?.length) {
        return of(true);
      }
      return loadIntoStoreUntilSettled(repoRelays, [applicationFilter], store);
    }, [coordsKey, maintainerKey, repoRelayKey, store]) ?? false;

  const applications =
    use$(() => {
      if (!repoCoords?.length || !maintainerPubkeys?.length) return of([]);
      return store
        .timeline([applicationFilter])
        .pipe(map((events) => castApplications(events, castStore)));
    }, [coordsKey, maintainerKey, store]) ?? [];

  const appIds = [...new Set(applications.map((app) => app.appId))];
  const appAuthors = [...new Set(applications.map((app) => app.pubkey))];
  const appIdsKey = [...appIds].sort().join(",");
  const appAuthorsKey = [...appAuthors].sort().join(",");
  const appPairsKey = applications
    .map((application) => application.coordinate)
    .sort()
    .join(",");

  // Releases are published to their author's NIP-65 outbox as well as the
  // repository relays. Resolve every trusted application publisher's mailbox
  // before declaring version discovery complete, otherwise a release visible
  // only on the publisher's outbox could be replaced accidentally.
  const applicationMailboxesSettled =
    use$(() => {
      if (privateRepository) return of(true);
      if (appAuthors.length === 0) return of(applicationsSettled);
      return combineLatest(
        appAuthors.map((pubkey) =>
          addressLoader({ kind: 10002, pubkey }).pipe(
            ignoreElements(),
            endWith(true),
            catchError(() => of(true)),
            startWith(false),
          ),
        ),
      ).pipe(map((settled) => settled.every(Boolean)));
    }, [appAuthorsKey, applicationsSettled, privateRepository]) ?? false;

  const applicationOutboxRelays =
    use$(() => {
      if (privateRepository) return of([]);
      if (appAuthors.length === 0) return of([]);
      return combineLatest(
        appAuthors.map((pubkey) =>
          store.mailboxes(pubkey).pipe(startWith(undefined)),
        ),
      ).pipe(
        map((mailboxes) =>
          uniqueRelayUrls(
            mailboxes.flatMap((mailbox) => mailbox?.outboxes ?? []),
          ),
        ),
      );
    }, [appAuthorsKey, privateRepository, store]) ?? [];
  const releaseRelays = uniqueRelayUrls(
    privateRepository
      ? repoRelays
      : [...repoRelays, ...applicationOutboxRelays, ZAPSTORE_RELAY_URL],
  );
  const releaseRelayKey = releaseRelays.join(",");

  // Keep a useful recent history while bounding release and asset metadata
  // work. The create dialog separately checks the exact address before
  // publishing, so overwrite protection does not depend on this window.
  const releaseFilters = releaseFiltersForApplications(
    applications,
    RELEASE_DISCOVERY_LIMIT,
  );

  const releasesSettled =
    use$(() => {
      if (appIds.length === 0 || appAuthors.length === 0) {
        return of(applicationsSettled);
      }
      // Start with repository relays and Zapstore immediately. Waiting for
      // every publisher mailbox before opening this request can leave the
      // release page behind unrelated relay traffic. When mailbox events
      // arrive, releaseRelayKey changes and this request restarts with the
      // publisher outboxes included. Only report final settlement after that
      // mailbox discovery has completed.
      return loadIntoStoreUntilSettled(
        releaseRelays,
        releaseFilters,
        store,
      ).pipe(map((settled) => settled && applicationMailboxesSettled));
    }, [
      appIdsKey,
      appAuthorsKey,
      appPairsKey,
      applicationsSettled,
      applicationMailboxesSettled,
      releaseRelayKey,
      store,
    ]) ?? false;

  const releases =
    use$(() => {
      if (appIds.length === 0 || appAuthors.length === 0) return of([]);
      return store
        .timeline(releaseFilters)
        .pipe(map((events) => castReleases(events, castStore, applications)));
    }, [appIdsKey, appAuthorsKey, appPairsKey, store]) ?? [];

  const assetIds = [
    ...new Set(
      releases.flatMap((release) => release.assets.map(({ id }) => id)),
    ),
  ];
  const assetIdsKey = [...assetIds].sort().join(",");
  const assetPublishers = new Map<string, Set<string>>();
  for (const release of releases) {
    for (const { id } of release.assets) {
      const publishers = assetPublishers.get(id) ?? new Set<string>();
      publishers.add(release.pubkey);
      assetPublishers.set(id, publishers);
    }
  }
  const assetRelays = uniqueRelayUrls(
    privateRepository
      ? releaseRelays
      : [
          ...releaseRelays,
          ...releases.flatMap((release) =>
            release.assets.flatMap(({ relayHint }) =>
              relayHint ? [relayHint] : [],
            ),
          ),
        ],
  );
  const assetRelayKey = assetRelays.join(",");
  const assetFilters: Filter[] = [];
  for (
    let index = 0;
    index < assetIds.length;
    index += ASSET_FILTER_CHUNK_SIZE
  ) {
    assetFilters.push({
      kinds: [SOFTWARE_ASSET_KIND],
      ids: assetIds.slice(index, index + ASSET_FILTER_CHUNK_SIZE),
    } as Filter);
  }

  const assetsSettled =
    use$(() => {
      if (assetIds.length === 0) return of(releasesSettled);
      return loadIntoStoreUntilSettled(assetRelays, assetFilters, store);
    }, [assetIdsKey, assetRelayKey, releasesSettled, store]) ?? false;

  const assets = use$(() => {
    if (assetIds.length === 0) return of([]);
    return store
      .timeline(assetFilters)
      .pipe(map((events) => castAssets(events, castStore, assetPublishers)));
  }, [assetIdsKey, appPairsKey, store]);

  const assetsById = useMemo(
    () =>
      new Map((assets ?? []).map((asset) => [asset.event.id, asset] as const)),
    [assets],
  );

  return {
    applications,
    releases,
    assetsById,
    applicationsSettled,
    releasesSettled,
    assetsSettled,
  };
}

/**
 * Cheap summary probe used by RepoLayout for repository navigation and the
 * code-page sidebar. Trusted application events arrive through the priority
 * nip34RepoLoader subscription or the persistent cache; this hook reads them
 * from the store, then requests at most one matching release per publisher
 * from the cache, repository relays, publisher outboxes, and Zapstore. It also
 * requests the latest main-channel release so a newer prerelease does not hide
 * the latest stable release. Assets are not fetched.
 */
export function useRepoReleaseSummary(
  repoCoords: string[] | undefined,
  maintainerPubkeys: string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
  probeRelays = true,
): RepoReleaseSummary {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const coordsKey = [...(repoCoords ?? [])].sort().join(",");
  const maintainerKey = [...(maintainerPubkeys ?? [])].sort().join(",");
  const repoRelays =
    use$(() => relayGroupUrls$(repoRelayGroup), [repoRelayGroup]) ?? [];

  const applicationFilter: Filter = {
    kinds: [SOFTWARE_APPLICATION_KIND],
    authors: maintainerPubkeys ?? [],
    "#a": repoCoords ?? [],
  } as Filter;

  use$(() => {
    if (!repoCoords?.length || !maintainerPubkeys?.length) return undefined;
    return loadCacheIntoStore([applicationFilter], store);
  }, [coordsKey, maintainerKey, store]);

  const applications =
    use$(() => {
      if (!repoCoords?.length || !maintainerPubkeys?.length) return of([]);
      return store
        .timeline([applicationFilter])
        .pipe(map((events) => castApplications(events, castStore)));
    }, [coordsKey, maintainerKey, store]) ?? [];

  const appAuthors = [...new Set(applications.map((app) => app.pubkey))];
  const appAuthorsKey = [...appAuthors].sort().join(",");
  const appPairsKey = applications
    .map((application) => application.coordinate)
    .sort()
    .join(",");

  use$(() => {
    if (!probeRelays || appAuthors.length === 0) return undefined;
    return merge(
      ...appAuthors.map((pubkey) =>
        addressLoader({ kind: 10002, pubkey }).pipe(catchError(() => EMPTY)),
      ),
    ).pipe(ignoreElements());
  }, [appAuthorsKey, probeRelays]);

  const applicationOutboxRelays =
    use$(() => {
      if (appAuthors.length === 0) return of([]);
      return combineLatest(
        appAuthors.map((pubkey) =>
          store.mailboxes(pubkey).pipe(startWith(undefined)),
        ),
      ).pipe(
        map((mailboxes) =>
          uniqueRelayUrls(
            mailboxes.flatMap((mailbox) => mailbox?.outboxes ?? []),
          ),
        ),
      );
    }, [appAuthorsKey, store]) ?? [];
  const releaseFilters = releaseFiltersForApplications(applications, 1);
  const latestMainFilters = releaseFilters.map(
    (releaseFilter) =>
      ({
        ...releaseFilter,
        "#c": ["main"],
      }) as Filter,
  );
  const summaryFilters = [...releaseFilters, ...latestMainFilters];
  const releaseRelays = uniqueRelayUrls([
    ...repoRelays,
    ...applicationOutboxRelays,
    ZAPSTORE_RELAY_URL,
  ]);
  const releaseRelayKey = releaseRelays.join(",");

  use$(() => {
    if (summaryFilters.length === 0) return undefined;
    if (!probeRelays) return loadCacheIntoStore(summaryFilters, store);
    return merge(
      loadCacheIntoStore(summaryFilters, store),
      resilientRequest(pool, releaseRelays, summaryFilters).pipe(
        onlyEvents(),
        mapEventsToStore(store),
        ignoreElements(),
        catchError(() => EMPTY),
      ),
    );
  }, [appPairsKey, probeRelays, releaseRelayKey, store]);

  const releases =
    use$(() => {
      if (summaryFilters.length === 0) return of([]);
      return store
        .timeline(summaryFilters)
        .pipe(map((events) => castReleases(events, castStore, applications)));
    }, [appPairsKey, store]) ?? [];

  const latestRelease =
    releases.find((release) => release.channel === "main") ?? releases[0];
  const latestApplication = latestRelease
    ? applications.find(
        (application) =>
          application.coordinate === latestRelease.applicationCoordinate,
      )
    : undefined;

  return useMemo(
    () => ({
      hasReleases: releases.length > 0,
      latestRelease,
      latestApplication,
    }),
    [latestApplication, latestRelease, releases.length],
  );
}
