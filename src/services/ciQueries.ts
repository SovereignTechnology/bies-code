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
import { combineLatest, of, type Observable } from "rxjs";
import {
  distinctUntilChanged,
  map,
  shareReplay,
  switchMap,
} from "rxjs/operators";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_EVENT_KINDS,
  CI_MANUAL_TRIGGER_KIND,
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
  CI_REQUEST_READINESS_KIND,
  CI_SERVICE_REQUEST_KIND,
} from "@/lib/ci";
import { REPO_KIND } from "@/lib/nip34";
import { keyedShared } from "@/lib/keyedShared";
import {
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
 * share one live query; results are read back from the EventStore.
 */
export function ciIdentityEnrichment$(
  pubkey: string,
): Observable<RelayQuerySettlement> {
  return keyedShared(identityEnrichment, pubkey, () =>
    discoveryRelays$().pipe(
      switchMap((relays) =>
        loadRelayQueryUntilSettled(
          pool,
          relays,
          [
            {
              kinds: [...CI_IDENTITY_ENRICHMENT_KINDS],
              authors: [pubkey],
            } as Filter,
          ],
          eventStore,
        ),
      ),
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
