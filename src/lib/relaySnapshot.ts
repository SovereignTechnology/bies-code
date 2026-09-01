import type { Filter } from "applesauce-core/helpers";
import { onlyEvents, type RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { firstValueFrom, timeout, toArray } from "rxjs";

import { resilientRequest } from "@/lib/resilientSubscription";

export interface RelaySnapshot {
  events: NostrEvent[];
  complete: boolean;
}

/**
 * Read one relay to EOSE without mistaking an isolated relay failure for an
 * authoritative empty result. resilientRequest deliberately contains relay
 * failures, so privacy-sensitive callers must also observe its settle state.
 */
export async function requestRelaySnapshot(
  relayPool: RelayPool,
  relay: string,
  filters: Filter[],
  timeoutMs: number,
): Promise<RelaySnapshot> {
  let sawEose = false;
  let failed = false;

  try {
    const events = await firstValueFrom(
      resilientRequest(relayPool, [relay], filters, {
        retryCount: 1,
        paginate: false,
        onRelayEose: () => {
          sawEose = true;
        },
        onRelayError: () => {
          failed = true;
        },
      }).pipe(onlyEvents(), toArray(), timeout({ first: timeoutMs })),
    );
    return { events, complete: sawEose && !failed };
  } catch {
    return { events: [], complete: false };
  }
}
