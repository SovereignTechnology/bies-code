import { useMemo } from "react";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { IEventStore } from "applesauce-core/event-store";
import { mapEventsToStore } from "applesauce-core";
import { getSeenRelays, type Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { RelayGroup } from "applesauce-relay";
import { combineLatest, EMPTY, merge, of, type Observable } from "rxjs";
import {
  catchError,
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
  resilientRequest,
  resilientSubscription,
} from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import { pool } from "@/services/nostr";

export const ZAPSTORE_RELAY_URL = "wss://relay.zapstore.dev";

export interface RepoSoftwareReleases {
  applications: SoftwareApplication[];
  releases: SoftwareRelease[];
  assetsById: Map<string, SoftwareAsset>;
  applicationsSettled: boolean;
  releasesSettled: boolean;
  assetsSettled: boolean;
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
 * An empty relay list remains unsettled because RepositoryRelayGroup starts
 * empty and is populated asynchronously from the repository announcement.
 */
function loadIntoStoreUntilSettled(
  relays: string[],
  filters: Filter[],
  store: IEventStore,
  paginate = false,
): Observable<boolean> {
  if (relays.length === 0) return of(false);
  return combineLatest(
    relays.map((relay) => loadRelayIntoStore(relay, filters, store, paginate)),
  ).pipe(map((settled) => settled.every(Boolean)));
}

function castApplications(
  events: Parameters<typeof isValidSoftwareApplication>[0][],
  store: CastRefEventStore,
  repoRelays: string[],
): SoftwareApplication[] {
  const repoRelaySet = new Set(repoRelays.map(normalizeUrl));
  return events.flatMap((event) => {
    if (!isValidSoftwareApplication(event)) return [];
    const seenRelays = getSeenRelays(event);
    if (
      !seenRelays ||
      ![...seenRelays].some((relay) => repoRelaySet.has(normalizeUrl(relay)))
    ) {
      return [];
    }
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
): SoftwareRelease[] {
  return events
    .flatMap((event) => {
      if (!isValidSoftwareRelease(event)) return [];
      try {
        return [new SoftwareRelease(event, store)];
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
): SoftwareAsset[] {
  return events.flatMap((event) => {
    if (!isValidSoftwareAsset(event)) return [];
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
  const appIdsByAuthor = new Map<string, Set<string>>();
  for (const application of applications) {
    const appIds = appIdsByAuthor.get(application.pubkey) ?? new Set<string>();
    appIds.add(application.appId);
    appIdsByAuthor.set(application.pubkey, appIds);
  }

  return [...appIdsByAuthor].map(
    ([author, appIds]) =>
      ({
        kinds: [SOFTWARE_RELEASE_KIND],
        authors: [author],
        "#i": [...appIds],
        ...(limit === undefined ? {} : { limit }),
      }) as Filter,
  );
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
        .pipe(map((events) => castApplications(events, castStore, repoRelays)));
    }, [coordsKey, maintainerKey, repoRelayKey, store]) ?? [];

  const appIds = [...new Set(applications.map((app) => app.appId))];
  const appAuthors = [...new Set(applications.map((app) => app.pubkey))];
  const appIdsKey = [...appIds].sort().join(",");
  const appAuthorsKey = [...appAuthors].sort().join(",");
  const appPairsKey = applications
    .map((application) => `${application.pubkey}:${application.appId}`)
    .sort()
    .join(",");
  const releaseRelays = uniqueRelayUrls([...repoRelays, ZAPSTORE_RELAY_URL]);
  const releaseRelayKey = releaseRelays.join(",");

  const releaseFilters = releaseFiltersForApplications(applications);

  const releasesSettled =
    use$(() => {
      if (appIds.length === 0 || appAuthors.length === 0) {
        return of(applicationsSettled);
      }
      return loadIntoStoreUntilSettled(
        releaseRelays,
        releaseFilters,
        store,
        true,
      );
    }, [
      appIdsKey,
      appAuthorsKey,
      appPairsKey,
      applicationsSettled,
      releaseRelayKey,
      store,
    ]) ?? false;

  const releases =
    use$(() => {
      if (appIds.length === 0 || appAuthors.length === 0) return of([]);
      return store
        .timeline(releaseFilters)
        .pipe(map((events) => castReleases(events, castStore)));
    }, [appIdsKey, appAuthorsKey, appPairsKey, store]) ?? [];

  const assetIds = [
    ...new Set(
      releases.flatMap((release) => release.assets.map(({ id }) => id)),
    ),
  ];
  const assetIdsKey = [...assetIds].sort().join(",");
  const assetRelays = uniqueRelayUrls([
    ...releaseRelays,
    ...releases.flatMap((release) =>
      release.assets.flatMap(({ relayHint }) => (relayHint ? [relayHint] : [])),
    ),
  ]);
  const assetRelayKey = assetRelays.join(",");
  const assetFilter: Filter = {
    kinds: [SOFTWARE_ASSET_KIND],
    ids: assetIds,
  } as Filter;

  const assetsSettled =
    use$(() => {
      if (assetIds.length === 0) return of(releasesSettled);
      return loadIntoStoreUntilSettled(assetRelays, [assetFilter], store);
    }, [assetIdsKey, assetRelayKey, releasesSettled, store]) ?? false;

  const assets = use$(() => {
    if (assetIds.length === 0) return of([]);
    return store
      .timeline([assetFilter])
      .pipe(map((events) => castAssets(events, castStore)));
  }, [assetIdsKey, store]);

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
 * Cheap presence probe used by RepoLayout to decide whether Releases belongs
 * in repository navigation. Trusted application events arrive through the
 * priority nip34RepoLoader subscription; this hook reads them from the store,
 * then requests at most one matching release per publisher from the repository
 * relays plus Zapstore. Assets are not fetched.
 */
export function useRepoHasReleases(
  repoCoords: string[] | undefined,
  maintainerPubkeys: string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
): boolean {
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

  const applications =
    use$(() => {
      if (!repoCoords?.length || !maintainerPubkeys?.length) return of([]);
      return store
        .timeline([applicationFilter])
        .pipe(map((events) => castApplications(events, castStore, repoRelays)));
    }, [coordsKey, maintainerKey, repoRelayKey, store]) ?? [];

  const appPairsKey = applications
    .map((application) => `${application.pubkey}:${application.appId}`)
    .sort()
    .join(",");
  const releaseFilters = releaseFiltersForApplications(applications, 1);
  const releaseRelays = uniqueRelayUrls([...repoRelays, ZAPSTORE_RELAY_URL]);
  const releaseRelayKey = releaseRelays.join(",");

  use$(() => {
    if (releaseFilters.length === 0) return undefined;
    return resilientRequest(pool, releaseRelays, releaseFilters).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [appPairsKey, releaseRelayKey, store]);

  const hasReleases = use$(() => {
    if (releaseFilters.length === 0) return of(false);
    return store
      .timeline(releaseFilters)
      .pipe(map((events) => events.some(isValidSoftwareRelease)));
  }, [appPairsKey, store]);

  return hasReleases ?? false;
}
