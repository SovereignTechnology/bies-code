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
import { combineLatest, type Observable } from "rxjs";
import { distinctUntilChanged, map, switchMap } from "rxjs/operators";
import {
  CI_COORDINATOR_ADVERTISEMENT_KIND,
  CI_NIX_PROVIDER_ADVERTISEMENT_KIND,
  CI_REQUEST_READINESS_KIND,
} from "@/lib/ci";
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
