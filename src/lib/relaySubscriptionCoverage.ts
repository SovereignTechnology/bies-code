import type { ResilientRelayLifecycle } from "@/lib/resilientSubscription";
import { Subject, type Observable } from "rxjs";

export type RelayCoveragePhase = ResilientRelayLifecycle["phase"];

export interface RelayCoverageState {
  relay: string;
  generation: number;
  phase: RelayCoveragePhase;
}

export interface RelaySubscriptionCoverage {
  /** Emits whenever an accepted lifecycle fact changes current coverage. */
  readonly changes$: Observable<RelayCoverageState>;
  /** Consume lifecycle facts from the one stable-filter subscription owner. */
  onLifecycle(event: ResilientRelayLifecycle): void;
  /** Return the latest accepted lifecycle fact for a relay. */
  get(relay: string): RelayCoverageState | undefined;
  /** True only after a real EOSE in the currently owned generation. */
  isCovered(relay: string): boolean;
  /** Permanently invalidate this owner and ignore any late callbacks. */
  stop(): void;
}

/**
 * Project one stable-filter subscription's lifecycle into query coverage.
 *
 * The caller owns both this handle and the subscription which feeds it. It is
 * intentionally not a global filter registry: an EventStore hit or another
 * subscription's EOSE can never validate this handle. See
 * docs/replaceable-preflight.md, "Warm coverage leases".
 */
export function createRelaySubscriptionCoverage(): RelaySubscriptionCoverage {
  const states = new Map<string, RelayCoverageState>();
  const changes = new Subject<RelayCoverageState>();
  let stopped = false;

  return {
    changes$: changes.asObservable(),
    onLifecycle(event) {
      if (stopped) return;
      const current = states.get(event.relay);
      if (current && event.generation < current.generation) return;
      states.set(event.relay, event);
      changes.next(event);
    },
    get(relay) {
      return states.get(relay);
    },
    isCovered(relay) {
      return states.get(relay)?.phase === "covered";
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const [relay, state] of states) {
        const stoppedState: RelayCoverageState = {
          ...state,
          phase: "stopped",
        };
        states.set(relay, stoppedState);
        changes.next(stoppedState);
      }
      changes.complete();
    },
  };
}
