import type {
  ResilientRelayLifecycle,
  ResilientRelayUnavailableReason,
} from "@/lib/resilientSubscription";
import { Subject, type Observable } from "rxjs";

export type RelayCoveragePhase =
  | ResilientRelayLifecycle["phase"]
  | "not-responding";

export interface RelayCoverageState {
  relay: string;
  generation: number;
  phase: RelayCoveragePhase;
  reason?: ResilientRelayUnavailableReason;
}

export interface RelaySubscriptionCoverageOptions {
  /** Project initial/catching-up generations into not-responding after this. */
  settlementTimeoutMs?: number;
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
export function createRelaySubscriptionCoverage(
  options: RelaySubscriptionCoverageOptions = {},
): RelaySubscriptionCoverage {
  const states = new Map<string, RelayCoverageState>();
  const settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const changes = new Subject<RelayCoverageState>();
  let stopped = false;

  const clearSettlementTimer = (relay: string) => {
    const timerId = settlementTimers.get(relay);
    if (timerId !== undefined) clearTimeout(timerId);
    settlementTimers.delete(relay);
  };

  const scheduleSettlementDeadline = (state: RelayCoverageState) => {
    const timeoutMs = options.settlementTimeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;

    const timerId = setTimeout(() => {
      settlementTimers.delete(state.relay);
      if (stopped) return;
      const current = states.get(state.relay);
      if (
        current?.generation !== state.generation ||
        (current.phase !== "initial" && current.phase !== "catching-up")
      ) {
        return;
      }

      const timedOut: RelayCoverageState = {
        relay: current.relay,
        generation: current.generation,
        phase: "not-responding",
      };
      states.set(state.relay, timedOut);
      changes.next(timedOut);
    }, timeoutMs);
    settlementTimers.set(state.relay, timerId);
  };

  return {
    changes$: changes.asObservable(),
    onLifecycle(event) {
      if (stopped) return;
      const current = states.get(event.relay);
      if (current && event.generation < current.generation) return;
      clearSettlementTimer(event.relay);
      const next: RelayCoverageState = {
        relay: event.relay,
        generation: event.generation,
        phase: event.phase,
        ...(event.phase === "unavailable" && event.reason !== undefined
          ? { reason: event.reason }
          : {}),
      };
      states.set(event.relay, next);
      changes.next(next);
      if (next.phase === "initial" || next.phase === "catching-up") {
        scheduleSettlementDeadline(next);
      }
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
      for (const relay of settlementTimers.keys()) {
        clearSettlementTimer(relay);
      }
      for (const [relay, state] of states) {
        const stoppedState: RelayCoverageState = {
          relay,
          generation: state.generation,
          phase: "stopped",
        };
        states.set(relay, stoppedState);
        changes.next(stoppedState);
      }
      changes.complete();
    },
  };
}
