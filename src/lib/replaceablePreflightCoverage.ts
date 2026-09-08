/**
 * Shared mechanics for replaceable-event coverage decisions.
 *
 * This module deliberately does not define a relay quorum. Category owners
 * supply their own assessment callback; see docs/replaceable-preflight.md.
 */

import type { IEventStore } from "applesauce-core/event-store";
import { getOutboxes, type Filter } from "applesauce-core/helpers";
import { firstValueFrom, race, timer, type Observable } from "rxjs";
import { map, startWith, take } from "rxjs/operators";
import type {
  RelayCoveragePhase,
  RelayCoverageState,
  RelaySubscriptionCoverage,
} from "@/lib/relaySubscriptionCoverage";
import { normalizeUrl } from "@/lib/url";

export type MailboxDiscovery = "known" | "checking" | "unavailable";

export interface PreflightCoverageAssessment {
  met: boolean;
  possible: boolean;
  summary: string;
}

export interface WaitForCoverageDecisionOptions<T> {
  timeoutMs: number;
  getSnapshot(): T | Promise<T>;
  assess(snapshot: T): PreflightCoverageAssessment;
  changes(snapshot: T): Observable<unknown>;
  error(assessment: PreflightCoverageAssessment): Error;
}

export type RelayPreflightStatus =
  | "ready"
  | "checking"
  | "not-responding"
  | "rate-limited"
  | "disconnected"
  | "authentication-required"
  | "request-rejected"
  | "recovering"
  | "unavailable"
  | "not-checked";

export interface RelayTransportFacts {
  connected: boolean;
  healthy: boolean;
  rateLimitCooldownMs: number;
}

export interface RelayCoverageDetail {
  relay: string;
  phase: RelayCoveragePhase | "not-checked";
  reason?: RelayCoverageState["reason"];
}

export interface RelayCoverageGroup {
  label: string;
  relays: RelayCoverageDetail[];
}

const RELAY_STATUS_LABELS: Record<RelayPreflightStatus, string> = {
  ready: "ready",
  checking: "checking",
  "not-responding": "not responding",
  "rate-limited": "rate-limited",
  disconnected: "disconnected",
  "authentication-required": "requiring authentication",
  "request-rejected": "rejecting the request",
  recovering: "recovering",
  unavailable: "unavailable",
  "not-checked": "not checked",
};

const RELAY_STATUS_ORDER: RelayPreflightStatus[] = [
  "ready",
  "checking",
  "not-responding",
  "rate-limited",
  "disconnected",
  "authentication-required",
  "request-rejected",
  "recovering",
  "unavailable",
  "not-checked",
];

/** Combine one owner's lifecycle state with its transport health. */
export function classifyRelayPreflightStatus(
  state: RelayCoverageState | undefined,
  transport: RelayTransportFacts,
): RelayPreflightStatus {
  if (!transport.connected) return "disconnected";
  if (state?.phase === "covered") {
    return transport.healthy ? "ready" : "unavailable";
  }
  if (state?.reason === "rate-limited" || transport.rateLimitCooldownMs > 0) {
    return "rate-limited";
  }
  if (state?.phase === "unavailable") {
    switch (state.reason) {
      case "auth":
        return "authentication-required";
      case "permanent":
        return "request-rejected";
      case "transport":
      case "closed":
      case "error":
        return "recovering";
      default:
        return "unavailable";
    }
  }
  if (!transport.healthy) return "unavailable";
  if (state?.phase === "initial" || state?.phase === "catching-up") {
    return "checking";
  }
  if (state?.phase === "not-responding") return "not-responding";
  return "not-checked";
}

/** Format a group summary while retaining one stable status ordering. */
export function formatRelayPreflightGroup(
  name: string,
  statuses: readonly RelayPreflightStatus[],
): string {
  if (statuses.length === 0) return `${name}: none configured.`;
  const counts = new Map<RelayPreflightStatus, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const details = RELAY_STATUS_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [`${count} ${RELAY_STATUS_LABELS[status]}`] : [];
  });
  return `${name}: ${details.join(", ")}.`;
}

/** Preserve per-relay lifecycle facts for an optional diagnostic surface. */
export function buildRelayCoverageGroup(
  label: string,
  relays: readonly string[],
  coverage: RelaySubscriptionCoverage | undefined,
): RelayCoverageGroup {
  return {
    label,
    relays: [...new Set(relays.map(normalizeUrl))].sort().map((relay) => {
      const state = coverage?.get(relay);
      return {
        relay,
        phase: state?.phase ?? "not-checked",
        ...(state?.reason !== undefined ? { reason: state.reason } : {}),
      };
    }),
  };
}

/** True while a current owner can still complete its initial or catch-up REQ. */
export function isRelayCoverageInFlight(
  coverage: RelaySubscriptionCoverage | undefined,
  relay: string,
): boolean {
  const phase = coverage?.get(normalizeUrl(relay))?.phase;
  return phase === undefined || phase === "initial" || phase === "catching-up";
}

/** Two-thirds threshold capped at three relays and floored at one. */
export function meetsBoundedTwoThirdsThreshold(
  covered: number,
  total: number,
): boolean {
  if (total === 0) return false;
  return covered >= Math.max(1, Math.min(3, Math.ceil((total * 2) / 3)));
}

/**
 * Decide whether absence of kind 10002 is established by the identity owner.
 * The caller still decides what an empty mailbox frontier means to its category.
 */
export function assessMailboxDiscovery(
  coverage: RelaySubscriptionCoverage | undefined,
  configuredLookups: readonly string[],
  hasMailboxEvent: boolean,
): MailboxDiscovery {
  if (hasMailboxEvent) return "known";
  if (!coverage) return "checking";

  const lookups = [...new Set(configuredLookups.map(normalizeUrl))];
  const covered = lookups.filter((relay) => coverage.isCovered(relay)).length;
  if (meetsBoundedTwoThirdsThreshold(covered, lookups.length)) return "known";

  const possible =
    covered +
    lookups.filter((relay) => isRelayCoverageInFlight(coverage, relay)).length;
  return meetsBoundedTwoThirdsThreshold(possible, lookups.length)
    ? "checking"
    : "unavailable";
}

/** Read normalized NIP-65 outboxes without invoking an EventStore loader. */
export function readMailboxOutboxes(
  store: IEventStore,
  pubkey: string,
): string[] | undefined {
  const event = store.getReplaceable(10_002, pubkey);
  return event
    ? [...new Set(getOutboxes(event).map(normalizeUrl))].sort()
    : undefined;
}

/**
 * Observe the in-memory mailbox winner without opening an Applesauce model.
 * EventStore models may invoke the configured fallback loader when absent.
 */
export function mailboxOutboxesObservable(
  store: IEventStore,
  pubkey: string,
): Observable<string[] | undefined> {
  const read = () => readMailboxOutboxes(store, pubkey);
  return store
    .timeline([{ kinds: [10_002], authors: [pubkey] } as Filter])
    .pipe(map(read), startWith(read()));
}

/** Compact raw lifecycle summary for diagnostics owned by category policy. */
export function summarizeRelayCoveragePhases(
  coverage: RelaySubscriptionCoverage,
  relays: readonly string[],
): string {
  const counts = new Map<string, number>();
  for (const relay of relays) {
    const phase = coverage.get(normalizeUrl(relay))?.phase ?? "not-checked";
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return [...counts].map(([phase, count]) => `${count} ${phase}`).join(", ");
}

/**
 * Wait until category policy is met, becomes impossible, or reaches a bounded
 * deadline. Scope replacement is supported by re-reading after every change.
 */
export async function waitForCoverageDecision<T>(
  options: WaitForCoverageDecisionOptions<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const snapshot = await options.getSnapshot();
    const assessment = options.assess(snapshot);
    if (assessment.met) return snapshot;

    const remaining = deadline - Date.now();
    if (!assessment.possible || remaining <= 0) {
      throw options.error(assessment);
    }

    await firstValueFrom(
      race(options.changes(snapshot).pipe(take(1)), timer(remaining)),
    );
  }
}
