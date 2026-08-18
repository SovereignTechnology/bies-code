import type { IEventStore } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import type { RelayPool } from "applesauce-relay";
import { combineLatest, defer, of, type Observable } from "rxjs";
import { catchError, filter, map, startWith, tap } from "rxjs/operators";
import { resilientSubscription } from "@/lib/resilientSubscription";

export interface RelayQuerySettlement {
  settled: boolean;
  relayCount: number;
  failedRelayCount: number;
}

interface RelaySettlement {
  settled: boolean;
  failed: boolean;
}

/**
 * Keep a relay query live, write events into the shared store, and report when
 * every relay's initial query has settled. Relay failures count as settled so
 * the UI cannot spin forever, but remain visible as incomplete coverage.
 */
export function loadRelayQueryUntilSettled(
  pool: RelayPool,
  relays: readonly string[],
  filters: Filter[],
  store: IEventStore,
  options: { paginate?: boolean } = {},
): Observable<RelayQuerySettlement> {
  if (relays.length === 0) {
    return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
  }

  const relayStates = relays.map((relay) =>
    defer(() => {
      let failed = false;
      return resilientSubscription(pool, [relay], filters, {
        paginate: options.paginate,
        onRelayError: () => {
          failed = true;
        },
      }).pipe(
        tap((message) => {
          if (message !== "EOSE") store.add(message);
        }),
        filter((message): message is "EOSE" => message === "EOSE"),
        map((): RelaySettlement => ({ settled: true, failed })),
        catchError(() => of<RelaySettlement>({ settled: true, failed: true })),
        startWith<RelaySettlement>({ settled: false, failed: false }),
      );
    }),
  );

  return combineLatest(relayStates).pipe(
    map((states) => ({
      settled: states.every((state) => state.settled),
      relayCount: states.length,
      failedRelayCount: states.filter((state) => state.failed).length,
    })),
  );
}
