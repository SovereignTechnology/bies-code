import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, of } from "rxjs";
import { map } from "rxjs/operators";
import {
  CIProviderAdvertisement,
  isValidCIProviderAdvertisement,
} from "@/casts/CIProvider";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { CI_NIX_PROVIDER_ADVERTISEMENT_KIND } from "@/lib/ci";
import { ciIdentityEnrichment$ } from "@/services/ciQueries";

export interface CIProviderAdvertisementState {
  advertisement: CIProviderAdvertisement | undefined;
  settled: boolean;
  partial: boolean;
}

/** Discover a provider's latest signed capability advertisement. */
export function useCIProviderAdvertisement(
  pubkey: string | undefined,
): CIProviderAdvertisementState {
  const query = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return ciIdentityEnrichment$(pubkey);
  }, [pubkey]);

  const advertisement = useStoredCIProviderAdvertisement(pubkey);

  return {
    advertisement,
    settled: query?.settled === true,
    partial:
      (query?.failedRelayCount ?? 0) > 0 ||
      (query?.settled === true && (query.relayCount ?? 0) === 0),
  };
}

/** Read a validated advertisement loaded by the owning page, without relay fetching. */
export function useStoredCIProviderAdvertisement(
  pubkey: string | undefined,
): CIProviderAdvertisement | undefined {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;

  return use$(() => {
    if (!pubkey) return of(undefined);
    return combineLatest([
      store.timeline([
        {
          kinds: [CI_NIX_PROVIDER_ADVERTISEMENT_KIND],
          authors: [pubkey],
        } as Filter,
      ]),
    ]).pipe(
      map(([events]) => {
        const advertisements = (events as NostrEvent[])
          .filter(isValidCIProviderAdvertisement)
          .sort((a, b) => b.created_at - a.created_at);
        return advertisements[0]
          ? new CIProviderAdvertisement(advertisements[0], castStore)
          : undefined;
      }),
    );
  }, [pubkey, store]);
}
