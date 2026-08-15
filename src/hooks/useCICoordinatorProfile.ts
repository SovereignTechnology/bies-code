import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { mapEventsToStore } from "applesauce-core";
import { getSeenRelays, type Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, EMPTY, timer, type Observable } from "rxjs";
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
import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";
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

function wasSeenOnOutbox(event: NostrEvent, outboxes: readonly string[]) {
  if (outboxes.length === 0) return false;
  const expected = new Set(outboxes.map(normalizeUrl));
  return [...(getSeenRelays(event) ?? [])].some((relay) =>
    expected.has(normalizeUrl(relay)),
  );
}

/**
 * Load one coordinator's discovery events and repository status claims.
 *
 * Advertisements, readiness, and NIP-65 relay metadata are discovered on the
 * configured index/lookup relays. Repository status is deliberately fetched
 * from the coordinator's declared NIP-65 outboxes and accepted into this view
 * only after EventStore provenance confirms it was observed on one of them.
 */
export function useCICoordinatorProfile(
  pubkey: string | undefined,
): CICoordinatorProfileState | undefined {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const indexRelays = use$(() => gitIndexRelays, []) ?? [];
  const lookup = use$(() => lookupRelays, []) ?? [];
  const discoveryRelays = [...new Set([...indexRelays, ...lookup])];
  const discoveryRelayKey = discoveryRelays.join(",");

  use$(() => {
    if (!pubkey || discoveryRelays.length === 0) return undefined;
    return resilientSubscription(pool, discoveryRelays, [
      {
        kinds: [
          10002,
          CI_COORDINATOR_ADVERTISEMENT_KIND,
          CI_REQUEST_READINESS_KIND,
        ],
        authors: [pubkey],
      } as Filter,
    ]).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [pubkey, discoveryRelayKey, store]);

  const mailboxes = use$(() => {
    if (!pubkey) return undefined;
    return store.mailboxes(pubkey);
  }, [pubkey, store]);
  const outboxes = mailboxes?.outboxes ?? [];
  const inboxes = mailboxes?.inboxes ?? [];
  const outboxKey = [...outboxes].sort().join(",");

  use$(() => {
    if (!pubkey || outboxes.length === 0) return undefined;
    return resilientSubscription(
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
      { paginate: true },
    ).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [pubkey, outboxKey, store]);

  const state = use$(() => {
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
      store.timeline([
        {
          kinds: [CI_REPOSITORY_STATUS_KIND],
          authors: [pubkey],
        } as Filter,
      ]),
      timer(0, EXPIRATION_RECHECK_MS),
    ]).pipe(
      map(([advertisementEvents, readinessEvents, statusEvents]) => {
        const advertisement = latestByCreatedAt(
          (advertisementEvents as NostrEvent[]).flatMap((event) =>
            isValidCICoordinatorAdvertisement(event)
              ? [new CICoordinatorAdvertisement(event, castStore)]
              : [],
          ),
        );
        const readiness = latestByCreatedAt(
          (readinessEvents as NostrEvent[]).flatMap((event) =>
            isValidCIRequestReadiness(event)
              ? [new CIRequestReadiness(event, castStore)]
              : [],
          ),
        );
        const now = Math.floor(Date.now() / 1000);
        const statuses = (statusEvents as NostrEvent[])
          .flatMap((event) =>
            isValidCIRepositoryStatus(event) && wasSeenOnOutbox(event, outboxes)
              ? [new CIRepositoryStatus(event, castStore)]
              : [],
          )
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
  }, [pubkey, outboxKey, store]);

  if (!state) return undefined;
  return {
    ...state,
    outboxes,
    inboxes,
    hasRelayList: mailboxes !== undefined,
  };
}

/** Fetch and resolve repositories covered by pubkey-wide readiness entries. */
export function useCITargetedRepositories(
  pubkeys: readonly string[],
): ResolvedRepo[] | undefined {
  const store = useEventStore();
  const pubkeyKey = [...pubkeys].sort().join(",");

  use$(() => {
    if (pubkeys.length === 0) return undefined;
    return resilientSubscription(
      pool,
      gitIndexRelays,
      [{ kinds: [REPO_KIND], authors: [...pubkeys] } as Filter],
      { paginate: true },
    ).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [pubkeyKey, store]);

  return use$(() => {
    if (pubkeys.length === 0) return undefined;
    const targetSet = new Set(pubkeys);
    return (
      store.model(RepositoryListModel) as unknown as Observable<ResolvedRepo[]>
    ).pipe(
      map((repositories) =>
        repositories.filter((repo) =>
          repo.announcements.some((event) => targetSet.has(event.pubkey)),
        ),
      ),
    );
  }, [pubkeyKey, store]);
}
