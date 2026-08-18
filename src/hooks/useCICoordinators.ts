import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { RelayGroup } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, of, timer } from "rxjs";
import { map } from "rxjs/operators";
import {
  CICoordinatorAdvertisement,
  CIRepositoryStatus,
  CIRequestReadiness,
  CIServiceControl,
  isValidCICoordinatorAdvertisement,
  isValidCIRepositoryStatus,
  isValidCIRequestReadiness,
  isValidCIServiceControl,
} from "@/casts/CICoordinator";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_REPOSITORY_STATUS_KIND,
  CI_REQUEST_READINESS_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
} from "@/lib/ci";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import { loadRelayQueryUntilSettled } from "@/lib/relayQuerySettlement";
import { pool } from "@/services/nostr";
import { gitIndexRelays } from "@/services/settings";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";

const EXPIRATION_RECHECK_MS = 30_000;

export type CICoordinatorAvailability = "watching" | "ready" | "available";

export interface CIServiceControlState {
  requested: boolean;
  event: CIServiceControl;
}

export interface CICoordinatorSummary {
  pubkey: string;
  advertisement: CICoordinatorAdvertisement;
  readiness: CIRequestReadiness | undefined;
  repositoryStatus: CIRepositoryStatus | undefined;
  serviceControl: CIServiceControlState | undefined;
  availability: CICoordinatorAvailability;
}

export interface CICoordinatorState {
  coordinators: CICoordinatorSummary[];
  serviceControls: readonly CIServiceControl[];
  currentlyRequestedCoordinatorPubkeys: ReadonlySet<string>;
  previouslyRequestedCoordinatorPubkeys: ReadonlySet<string>;
  /** True once both discovery and repository trust queries have settled. */
  settled: boolean;
  /** True when one or more relevant relay queries could not be completed. */
  partial: boolean;
}

function isLaterControl(a: CIServiceControl, b: CIServiceControl): boolean {
  if (a.event.created_at !== b.event.created_at) {
    return a.event.created_at > b.event.created_at;
  }
  // The CI NIP defines the lexicographically lower id as later at equal time.
  return a.event.id.localeCompare(b.event.id) < 0;
}

function latestByPubkey<T extends { pubkey: string; event: NostrEvent }>(
  events: T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const event of events) {
    const current = latest.get(event.pubkey);
    if (!current || event.event.created_at > current.event.created_at) {
      latest.set(event.pubkey, event);
    }
  }
  return latest;
}

export function useCICoordinators(
  repositoryCoordinates: string[] | undefined,
  selectedCoordinate: string | undefined,
  confirmedMaintainers: string[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
): CICoordinatorState | undefined {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;

  const coordinatesKey = repositoryCoordinates
    ? [...repositoryCoordinates].sort().join(",")
    : "";
  const maintainersKey = confirmedMaintainers
    ? [...confirmedMaintainers].sort().join(",")
    : "";
  const selectedMaintainer = selectedCoordinate?.split(":")[1];

  const indexRelays = use$(() => gitIndexRelays, []) ?? [];
  const indexRelayKey = indexRelays.join(",");
  const repoRelays =
    use$(() => relayGroupUrls$(repoRelayGroup), [repoRelayGroup]) ?? [];
  const repoRelayKey = repoRelays.join(",");

  // Coordinator discovery and repository-readiness hints live on index relays.
  const indexQuery = use$(() => {
    const filters: Filter[] = [
      { kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND] } as Filter,
    ];
    if (selectedCoordinate) {
      filters.push({
        kinds: [CI_REQUEST_READINESS_KIND],
        "#a": [selectedCoordinate],
      } as Filter);
    }
    if (selectedMaintainer) {
      filters.push({
        kinds: [CI_REQUEST_READINESS_KIND],
        "#p": [selectedMaintainer],
      } as Filter);
    }

    return loadRelayQueryUntilSettled(pool, indexRelays, filters, store);
  }, [coordinatesKey, maintainersKey, indexRelayKey, store]);

  // Repository status is public coordinator state. Service controls are
  // trust-bearing and therefore fetched only from current confirmed maintainers.
  const repoQuery = use$(() => {
    if (!repositoryCoordinates?.length) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }

    const filters: Filter[] = [
      {
        kinds: [CI_REPOSITORY_STATUS_KIND],
        "#a": repositoryCoordinates,
      } as Filter,
    ];
    if (selectedCoordinate && confirmedMaintainers?.length) {
      filters.push({
        kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
        authors: confirmedMaintainers,
        "#a": [selectedCoordinate],
      } as Filter);
    }

    return loadRelayQueryUntilSettled(pool, repoRelays, filters, store);
  }, [coordinatesKey, maintainersKey, repoRelayKey, selectedCoordinate, store]);

  const summaries = use$(() => {
    if (!repositoryCoordinates || !confirmedMaintainers) return undefined;

    const advertisement$ = store.timeline([
      { kinds: [CI_COORDINATOR_ADVERTISEMENT_KIND] } as Filter,
    ]);
    const readinessFilters: Filter[] = [];
    if (selectedCoordinate) {
      readinessFilters.push({
        kinds: [CI_REQUEST_READINESS_KIND],
        "#a": [selectedCoordinate],
      } as Filter);
    }
    if (selectedMaintainer) {
      readinessFilters.push({
        kinds: [CI_REQUEST_READINESS_KIND],
        "#p": [selectedMaintainer],
      } as Filter);
    }
    const readiness$ =
      readinessFilters.length > 0
        ? store.timeline(readinessFilters)
        : of([] as NostrEvent[]);
    const status$ = store.timeline([
      {
        kinds: [CI_REPOSITORY_STATUS_KIND],
        "#a": repositoryCoordinates,
      } as Filter,
    ]);
    const controls$ =
      selectedCoordinate && confirmedMaintainers.length > 0
        ? store.timeline([
            {
              kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
              authors: confirmedMaintainers,
              "#a": [selectedCoordinate],
            } as Filter,
          ])
        : undefined;

    return combineLatest([
      advertisement$,
      readiness$,
      status$,
      controls$ ?? of([] as NostrEvent[]),
      timer(0, EXPIRATION_RECHECK_MS),
    ]).pipe(
      map(
        ([
          advertisementEvents,
          readinessEvents,
          statusEvents,
          controlEvents,
        ]) => {
          const now = Math.floor(Date.now() / 1000);
          const advertisements = (advertisementEvents as NostrEvent[]).flatMap(
            (event) => {
              if (!isValidCICoordinatorAdvertisement(event)) return [];
              const advertisement = new CICoordinatorAdvertisement(
                event,
                castStore,
              );
              return advertisement.expiration > now ? [advertisement] : [];
            },
          );
          const readiness = (readinessEvents as NostrEvent[]).flatMap(
            (event) => {
              if (!isValidCIRequestReadiness(event)) return [];
              const item = new CIRequestReadiness(event, castStore);
              return item.expiration > now &&
                item.supportsRepository(
                  selectedCoordinate ? [selectedCoordinate] : [],
                  selectedMaintainer ? [selectedMaintainer] : [],
                )
                ? [item]
                : [];
            },
          );
          const statuses = (statusEvents as NostrEvent[]).flatMap((event) => {
            if (!isValidCIRepositoryStatus(event)) return [];
            const status = new CIRepositoryStatus(event, castStore);
            return status.expiration > now &&
              status.matchesRepository(repositoryCoordinates)
              ? [status]
              : [];
          });
          const controls = (controlEvents as NostrEvent[]).flatMap((event) => {
            if (!isValidCIServiceControl(event)) return [];
            return [new CIServiceControl(event, castStore)];
          });
          const orderedControls = [...controls].sort((a, b) => {
            if (a.event.created_at !== b.event.created_at) {
              return b.event.created_at - a.event.created_at;
            }
            // At equal timestamps the protocol treats the lower id as later.
            return a.event.id.localeCompare(b.event.id);
          });

          const advertisementByPubkey = latestByPubkey(advertisements);
          const readinessByPubkey = latestByPubkey(readiness);
          const statusByPubkey = latestByPubkey(statuses);
          const controlsByCoordinator = new Map<string, CIServiceControl>();
          const everRequestedCoordinatorPubkeys = new Set<string>();
          for (const control of orderedControls) {
            if (control.isRequest) {
              everRequestedCoordinatorPubkeys.add(control.coordinatorPubkey);
            }
            const current = controlsByCoordinator.get(
              control.coordinatorPubkey,
            );
            if (!current || isLaterControl(control, current)) {
              controlsByCoordinator.set(control.coordinatorPubkey, control);
            }
          }
          const currentlyRequestedCoordinatorPubkeys = new Set<string>();
          for (const [pubkey, control] of controlsByCoordinator) {
            if (control.isRequest) {
              currentlyRequestedCoordinatorPubkeys.add(pubkey);
            }
          }
          const previouslyRequestedCoordinatorPubkeys = new Set(
            [...everRequestedCoordinatorPubkeys].filter(
              (pubkey) => !currentlyRequestedCoordinatorPubkeys.has(pubkey),
            ),
          );

          const result: CICoordinatorSummary[] = [];
          for (const [pubkey, advertisement] of advertisementByPubkey) {
            const repositoryStatus = statusByPubkey.get(pubkey);
            const ready = readinessByPubkey.get(pubkey);
            const control = controlsByCoordinator.get(pubkey);
            result.push({
              pubkey,
              advertisement,
              readiness: ready,
              repositoryStatus,
              serviceControl: control
                ? { requested: control.isRequest, event: control }
                : undefined,
              availability: repositoryStatus
                ? "watching"
                : ready
                  ? "ready"
                  : "available",
            });
          }

          const rank: Record<CICoordinatorAvailability, number> = {
            watching: 0,
            ready: 1,
            available: 2,
          };
          return {
            coordinators: result.sort(
              (a, b) =>
                rank[a.availability] - rank[b.availability] ||
                b.advertisement.event.created_at -
                  a.advertisement.event.created_at,
            ),
            serviceControls: orderedControls,
            currentlyRequestedCoordinatorPubkeys,
            previouslyRequestedCoordinatorPubkeys,
          };
        },
      ),
    );
  }, [coordinatesKey, maintainersKey, selectedCoordinate, store]);

  if (!summaries) return undefined;
  const settled = indexQuery?.settled === true && repoQuery?.settled === true;
  return {
    ...summaries,
    settled,
    partial:
      (indexQuery?.failedRelayCount ?? 0) > 0 ||
      (repoQuery?.failedRelayCount ?? 0) > 0 ||
      (settled &&
        ((indexQuery?.relayCount ?? 0) === 0 ||
          (repoQuery?.relayCount ?? 0) === 0)),
  };
}
