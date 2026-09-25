import type { IEventStore } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import type { RelayPool } from "applesauce-relay";
import { combineLatest, defer, of, Observable, ReplaySubject } from "rxjs";
import { catchError, filter, map, startWith, tap } from "rxjs/operators";
import {
  resilientAdditiveSubscription,
  resilientSubscription,
  type AdditiveFilterPlan,
} from "@/lib/resilientSubscription";

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

/**
 * Additive variant of loadRelayQueryUntilSettled for owners whose relay list
 * or filter-value set grows over the query's lifetime.
 *
 * One resilientAdditiveSubscription spans the whole owner lifetime: a relay
 * joining the reactive list opens one REQ (carrying the full chunk set) on
 * that relay alone, and chunks arriving via `plan.additions$` open one delta
 * REQ per healthy relay — existing REQs are never closed.
 *
 * The settlement projection mirrors loadRelayQueryUntilSettled over the
 * current relay list: a relay error counts as settled but failed, and a
 * newly joined relay is unsettled until its first EOSE. Chunk additions
 * never unsettle the projection — delta REQs do not drive settlement.
 * Nothing is emitted until the relay list emits for the first time, matching
 * the switchMap gating this replaces; an empty list reports settled empty
 * coverage.
 */
export function loadAdditiveRelayQueryUntilSettled(
  pool: RelayPool,
  relays: Observable<string[]>,
  plan: AdditiveFilterPlan,
  store: IEventStore,
): Observable<RelayQuerySettlement> {
  return new Observable<RelayQuerySettlement>((subscriber) => {
    const states = new Map<string, RelaySettlement>();
    let seenRelayList = false;

    const emit = () => {
      if (!seenRelayList) return;
      const list = [...states.values()];
      subscriber.next({
        settled: list.every((state) => state.settled),
        relayCount: list.length,
        failedRelayCount: list.filter((state) => state.failed).length,
      });
    };

    const mark = (relay: string, failed: boolean) => {
      const state = states.get(relay);
      if (!state) return;
      state.settled = true;
      if (failed) state.failed = true;
      emit();
    };

    // Mirror the relay list into per-relay settlement slots before the
    // additive subscription reacts to it, so its relay callbacks always
    // find their slot.
    const trackedRelays = new ReplaySubject<string[]>(1);
    const relaySub = relays.subscribe({
      next: (urls) => {
        seenRelayList = true;
        const next = new Set(urls);
        for (const url of next) {
          if (!states.has(url)) {
            states.set(url, { settled: false, failed: false });
          }
        }
        for (const url of [...states.keys()]) {
          if (!next.has(url)) states.delete(url);
        }
        trackedRelays.next([...next]);
        emit();
      },
      error: (err) => subscriber.error(err),
      // Completion keeps the current relays live, matching the reactive
      // relay-list handling inside resilientAdditiveSubscription.
    });

    const querySub = resilientAdditiveSubscription(pool, trackedRelays, plan, {
      settle: false,
      onRelaySettle: (relay) => mark(relay, false),
      onRelayError: (relay) => mark(relay, true),
    }).subscribe({
      next: (message) => {
        if (message !== "EOSE") store.add(message);
      },
      error: (err) => subscriber.error(err),
    });

    return () => {
      relaySub.unsubscribe();
      querySub.unsubscribe();
    };
  });
}
