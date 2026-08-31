import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { mapEventsToStore } from "applesauce-core";
import { getSeenRelays, type Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, EMPTY, of, timer, type Observable } from "rxjs";
import { catchError, map } from "rxjs/operators";
import {
  CICoordinatorAdvertisement,
  CIRepositoryStatus,
  CIRequestReadiness,
  isValidCICoordinatorAdvertisement,
  isValidCIRepositoryStatus,
  isValidCIRequestReadiness,
} from "@/casts/CICoordinator";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_REPOSITORY_STATUS_KIND,
  CI_REQUEST_READINESS_KIND,
} from "@/lib/ci";
import { parseRepoCoordinate, REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { loadRelayQueryUntilSettled } from "@/lib/relayQuerySettlement";
import { ciIdentityEnrichment$ } from "@/services/ciQueries";
import { pool } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";

const EXPIRATION_RECHECK_MS = 30_000;

export interface CICoordinatorProfileState {
  advertisement: CICoordinatorAdvertisement | undefined;
  readiness: CIRequestReadiness | undefined;
  activeStatuses: CIRepositoryStatus[];
  historicalStatuses: CIRepositoryStatus[];
  outboxes: string[];
  inboxes: string[];
  hasRelayList: boolean;
  targetedRepositories: ResolvedRepo[] | undefined;
  settled: boolean;
  partial: boolean;
}

function latestByCreatedAt<T extends { event: NostrEvent }>(
  events: T[],
): T | undefined {
  return events.reduce<T | undefined>((latest, event) => {
    if (!latest || event.event.created_at > latest.event.created_at) {
      return event;
    }
    return latest;
  }, undefined);
}

export interface CICoordinatorAdvertisementState {
  advertisement: CICoordinatorAdvertisement | undefined;
  settled: boolean;
  partial: boolean;
}

/** Discover whether an identity has published a coordinator advertisement. */
export function useCICoordinatorAdvertisement(
  pubkey: string | undefined,
): CICoordinatorAdvertisementState {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;

  const query = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return ciIdentityEnrichment$(pubkey);
  }, [pubkey]);

  const advertisement = use$(() => {
    if (!pubkey) return undefined;
    return store
      .timeline([
        {
          kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND],
          authors: [pubkey],
        } as Filter,
      ])
      .pipe(
        map((events) =>
          latestByCreatedAt(
            (events as NostrEvent[]).flatMap((event) =>
              isValidCICoordinatorAdvertisement(event)
                ? [new CICoordinatorAdvertisement(event, castStore)]
                : [],
            ),
          ),
        ),
      );
  }, [pubkey, store]);

  return {
    advertisement,
    settled: query?.settled === true,
    partial:
      (query?.failedRelayCount ?? 0) > 0 ||
      (query?.settled === true && (query.relayCount ?? 0) === 0),
  };
}

function wasSeenOnOutbox(event: NostrEvent, outboxes: readonly string[]) {
  if (outboxes.length === 0) return false;
  const expected = new Set(outboxes.map(normalizeUrl));
  return [...(getSeenRelays(event) ?? [])].some((relay) =>
    expected.has(normalizeUrl(relay)),
  );
}

function wasSeenOnRepositoryRelay(
  status: CIRepositoryStatus,
  repositories: readonly ResolvedRepo[],
): boolean {
  const seenRelays = new Set(
    [...(getSeenRelays(status.event) ?? [])].map(normalizeUrl),
  );
  if (seenRelays.size === 0) return false;

  const statusCoordinates = new Set(status.repositoryCoordinates);
  return repositories.some(
    (repo) =>
      repo.confirmedMaintainerCoordinates.some((coordinate) =>
        statusCoordinates.has(coordinate),
      ) && repo.relays.some((relay) => seenRelays.has(normalizeUrl(relay))),
  );
}

/**
 * Load one coordinator's discovery events and repository status claims.
 *
 * Advertisements, readiness, and NIP-65 relay metadata are discovered on the
 * configured index/lookup relays. Repository status is fetched from both the
 * coordinator's declared NIP-65 outboxes and the relays declared by targeted
 * repositories. A status is accepted only when EventStore provenance confirms
 * it was observed on an appropriate outbox or matching repository relay.
 */
export function useCICoordinatorProfile(
  pubkey: string | undefined,
): CICoordinatorProfileState | undefined {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;

  // Relay list, advertisement, and readiness arrive via the shared per-pubkey
  // enrichment query (deduped with every other surface showing this identity).
  const discoveryQuery = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return ciIdentityEnrichment$(pubkey);
  }, [pubkey]);

  const mailboxes = use$(() => {
    if (!pubkey) return undefined;
    return store.mailboxes(pubkey);
  }, [pubkey, store]);
  const outboxes = mailboxes?.outboxes ?? [];
  const inboxes = mailboxes?.inboxes ?? [];
  const outboxKey = [...outboxes].sort().join(",");

  const outboxQuery = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    if (!discoveryQuery?.settled) {
      return of({ settled: false, relayCount: 0, failedRelayCount: 0 });
    }
    if (outboxes.length === 0) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      outboxes,
      [
        {
          kinds: [
            CI_COORDINATOR_ADVERTISEMENT_KIND,
            CI_REQUEST_READINESS_KIND,
            CI_REPOSITORY_STATUS_KIND,
          ],
          authors: [pubkey],
        } as Filter,
      ],
      store,
      { paginate: true },
    );
  }, [pubkey, discoveryQuery?.settled, outboxKey, store]);

  const discoveryState = use$(() => {
    if (!pubkey) return undefined;
    return combineLatest([
      store.timeline([
        {
          kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND],
          authors: [pubkey],
        } as Filter,
      ]),
      store.timeline([
        {
          kinds: [CI_REQUEST_READINESS_KIND],
          authors: [pubkey],
        } as Filter,
      ]),
    ]).pipe(
      map(([advertisementEvents, readinessEvents]) => ({
        advertisement: latestByCreatedAt(
          (advertisementEvents as NostrEvent[]).flatMap((event) =>
            isValidCICoordinatorAdvertisement(event)
              ? [new CICoordinatorAdvertisement(event, castStore)]
              : [],
          ),
        ),
        readiness: latestByCreatedAt(
          (readinessEvents as NostrEvent[]).flatMap((event) =>
            isValidCIRequestReadiness(event)
              ? [new CIRequestReadiness(event, castStore)]
              : [],
          ),
        ),
      })),
    );
  }, [pubkey, store]);

  const readinessPubkeys = discoveryState?.readiness?.repositoryPubkeys ?? [];
  const readinessCoordinates =
    discoveryState?.readiness?.repositoryCoordinates ?? [];
  const targetedRepositories = useCITargetedRepositories(
    readinessPubkeys,
    readinessCoordinates,
  );
  const repositoryRelays = [
    ...new Set(
      (targetedRepositories ?? []).flatMap((repository) => repository.relays),
    ),
  ];
  const repositoryCoordinates = [
    ...new Set(
      (targetedRepositories ?? []).flatMap(
        (repository) => repository.confirmedMaintainerCoordinates,
      ),
    ),
  ];
  const repositoryStatusQueryKey = `${[...repositoryRelays].sort().join(",")}|${[
    ...repositoryCoordinates,
  ]
    .sort()
    .join(",")}`;
  const hasReadinessTargets =
    readinessPubkeys.length > 0 || readinessCoordinates.length > 0;

  const repositoryStatusQuery = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    if (!discoveryQuery?.settled) {
      return of({ settled: false, relayCount: 0, failedRelayCount: 0 });
    }
    if (hasReadinessTargets && targetedRepositories === undefined) {
      return of({ settled: false, relayCount: 0, failedRelayCount: 0 });
    }
    if (repositoryRelays.length === 0 || repositoryCoordinates.length === 0) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }

    return loadRelayQueryUntilSettled(
      pool,
      repositoryRelays,
      [
        {
          kinds: [CI_REPOSITORY_STATUS_KIND],
          authors: [pubkey],
          "#a": repositoryCoordinates,
        } as Filter,
      ],
      store,
      { paginate: true },
    );
  }, [
    pubkey,
    discoveryQuery?.settled,
    hasReadinessTargets,
    repositoryStatusQueryKey,
    targetedRepositories !== undefined,
    store,
  ]);

  const state = use$(() => {
    if (!pubkey || !discoveryState) return undefined;
    return combineLatest([
      store.timeline([
        {
          kinds: [CI_REPOSITORY_STATUS_KIND],
          authors: [pubkey],
        } as Filter,
      ]),
      timer(0, EXPIRATION_RECHECK_MS),
    ]).pipe(
      map(([statusEvents]) => {
        const { advertisement, readiness } = discoveryState;
        const now = Math.floor(Date.now() / 1000);
        const statuses = (statusEvents as NostrEvent[])
          .flatMap((event) => {
            if (!isValidCIRepositoryStatus(event)) return [];
            const status = new CIRepositoryStatus(event, castStore);
            return wasSeenOnOutbox(event, outboxes) ||
              wasSeenOnRepositoryRelay(status, targetedRepositories ?? [])
              ? [status]
              : [];
          })
          .sort((a, b) => b.event.created_at - a.event.created_at);
        const advertisementIsLive =
          advertisement !== undefined && advertisement.expiration > now;

        return {
          advertisement,
          readiness,
          activeStatuses: statuses.filter(
            (status) => advertisementIsLive && status.expiration > now,
          ),
          historicalStatuses: statuses.filter(
            (status) => !advertisementIsLive || status.expiration <= now,
          ),
        };
      }),
    );
  }, [
    pubkey,
    discoveryState?.advertisement?.event.id,
    discoveryState?.readiness?.event.id,
    outboxKey,
    repositoryStatusQueryKey,
    store,
  ]);

  if (!state) return undefined;
  const settled =
    discoveryQuery?.settled === true &&
    outboxQuery?.settled === true &&
    repositoryStatusQuery?.settled === true;
  return {
    ...state,
    outboxes,
    inboxes,
    hasRelayList: mailboxes !== undefined,
    targetedRepositories,
    settled,
    partial:
      (discoveryQuery?.failedRelayCount ?? 0) > 0 ||
      (outboxQuery?.failedRelayCount ?? 0) > 0 ||
      (repositoryStatusQuery?.failedRelayCount ?? 0) > 0 ||
      (settled && (discoveryQuery?.relayCount ?? 0) === 0),
  };
}

/** Fetch and resolve repositories covered by readiness coordinates/pubkeys. */
export function useCITargetedRepositories(
  pubkeys: readonly string[],
  coordinates: readonly string[] = [],
): ResolvedRepo[] | undefined {
  const store = useEventStore();
  const pubkeyKey = [...pubkeys].sort().join(",");
  const coordinateKey = [...coordinates].sort().join(",");
  const coordinatePointers = coordinates.flatMap((coordinate) => {
    const parsed = parseRepoCoordinate(coordinate);
    return parsed ? [parsed] : [];
  });

  use$(() => {
    if (pubkeys.length === 0 && coordinatePointers.length === 0) {
      return undefined;
    }
    const filters: Filter[] = [];
    if (pubkeys.length > 0) {
      filters.push({ kinds: [REPO_KIND], authors: [...pubkeys] } as Filter);
    }
    filters.push(
      ...coordinatePointers.map(
        ({ pubkey, identifier }) =>
          ({
            kinds: [REPO_KIND],
            authors: [pubkey],
            "#d": [identifier],
          }) as Filter,
      ),
    );
    return resilientSubscription(pool, gitIndexRelays, filters, {
      paginate: true,
    }).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [pubkeyKey, coordinateKey, store]);

  return use$(() => {
    if (pubkeys.length === 0 && coordinates.length === 0) return undefined;
    const targetSet = new Set(pubkeys);
    const coordinateSet = new Set(coordinates);
    return (
      store.model(RepositoryListModel) as unknown as Observable<ResolvedRepo[]>
    ).pipe(
      map((repositories) =>
        repositories.filter(
          (repo) =>
            repo.confirmedAnnouncements.some((event) =>
              targetSet.has(event.pubkey),
            ) ||
            repo.confirmedMaintainerCoordinates.some((coordinate) =>
              coordinateSet.has(coordinate),
            ),
        ),
      ),
    );
  }, [pubkeyKey, coordinateKey, store]);
}
