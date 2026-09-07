/**
 * useRobustReplaceableAction — generic safety wrapper for modifying any
 * user replaceable event (kind:3, kind:10002, kind:10317, etc.).
 *
 * WHY THIS EXISTS
 * ---------------
 * Replaceable events (kinds 0, 3, 10000-19999) have a critical property:
 * only the latest event per pubkey+kind is kept. If the EventStore holds a
 * stale copy and an action modifies it, the published event will silently
 * overwrite changes made on another client.
 *
 * This hook combines three layers of protection:
 *
 * 1. PERSISTENT BACKGROUND SUBSCRIPTION (handled in accounts.ts)
 *    A continuous resilientSubscription() for all user replaceable kinds is
 *    kept open on the union of the user's outbox and lookup/index relays for
 *    the lifetime of the session (see userIdentitySubscription.ts). It writes
 *    the initial snapshot and subsequent live updates into the EventStore.
 *
 * 2. WARM COVERAGE THRESHOLD CHECK
 *    Before attempting any write, we intersect the user's outbox and lookup
 *    groups with healthy relays whose current identity-subscription cycle has
 *    returned a real EOSE. The existing one-outbox and larger-set threshold
 *    rules are then applied. Once they pass, the covered subscription is the
 *    freshness evidence: repeating its query at action time would add relay
 *    load and latency without increasing assurance. navigator.onLine remains
 *    a fast offline check.
 *
 * 3. LOCAL ABSENCE EVIDENCE
 *    If the warm relay snapshot contains no target event, perform one bounded
 *    exact IndexedDB lookup before the action. This preserves retained state
 *    without repeating the already-covered relay query.
 *
 * Evidence outside this stable account/filter scope must be warmed by its own
 * subscription or a bounded focused read before invoking the writer. See
 * docs/replaceable-preflight.md.
 *
 * USAGE
 * -----
 * ```ts
 * const execute = useRobustReplaceableAction();
 *
 * // Wrap any action that modifies a replaceable event:
 * await execute(3, async ({ event, outboxes }) => {
 *   await runAction(FollowUserFromPreflight(event, outboxes, pubkey));
 * });
 * ```
 */

import { useCallback, useState } from "react";
import { firstValueFrom, race, timer } from "rxjs";
import { filter, startWith, take } from "rxjs/operators";
import type { NostrEvent } from "nostr-tools";
import { useActiveAccount } from "applesauce-react/hooks";
import { useEventStore } from "@/hooks/useEventStore";
import { use$ } from "@/hooks/use$";
import { normalizeURL } from "applesauce-core/helpers";
import { MailboxesModel } from "applesauce-core/models";
import { liveness, pool } from "@/services/nostr";
import { lookupRelays } from "@/services/settings";
import { cacheRequest } from "@/services/cache";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";
import { normalizeUrl } from "@/lib/url";
import { getRateLimitCooldownRemaining } from "@/lib/resilientSubscription";
import { USER_REPLACEABLE_KINDS } from "@/services/userIdentitySubscription";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * When only 1 outbox relay is connected, we require this many lookup/index
 * relays to also be connected before allowing a replaceable event write.
 * A single outbox relay is not enough confidence on its own.
 */
const MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX = 2;

/**
 * When >1 outbox relays are connected, we pass if either:
 *   - at least this fraction of the user's outbox relays are connected, OR
 *   - at least MIN_OUTBOX_ABSOLUTE are connected (caps the requirement for
 *     large relay sets — e.g. 30 outboxes should not need 15 connected).
 */
const MIN_OUTBOX_FRACTION = 0.5;
const MIN_OUTBOX_ABSOLUTE = 3;

/** Maximum local IndexedDB wait when the EventStore has no target event. */
const CACHE_HYDRATION_TIMEOUT_MS = 1_000;

type RelayPreflightStatus =
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

const USER_REPLACEABLE_KIND_SET = new Set<number>(USER_REPLACEABLE_KINDS);

function meetsWarmCoverageThreshold(
  coveredOutboxes: number,
  totalOutboxes: number,
  coveredLookup: number,
): boolean {
  if (coveredOutboxes === 0) return false;
  if (coveredOutboxes === 1) {
    return coveredLookup >= MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX;
  }
  return (
    coveredOutboxes >= MIN_OUTBOX_ABSOLUTE ||
    coveredOutboxes / totalOutboxes >= MIN_OUTBOX_FRACTION
  );
}

// ---------------------------------------------------------------------------
// Human-readable kind labels for error messages
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<number, string> = {
  0: "profile",
  3: "follow list",
  10002: "relay list",
  10017: "git authors list",
  10018: "git repositories list",
  10317: "grasp server list",
  10617: "pinned repositories list",
};

function kindLabel(kind: number): string {
  return KIND_LABELS[kind] ?? `kind:${kind} list`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface RobustReplaceableActionResult {
  /**
   * Execute an action that modifies a replaceable event, with connectivity
   * and freshness safeguards.
   *
   * @param kind    - The replaceable event kind being modified
   * @param action  - The async action to execute with the resolved snapshot
   */
  execute: (
    kind: number,
    action: (snapshot: ReplaceablePreflightSnapshot) => Promise<void>,
  ) => Promise<void>;
  /** True while an action is in progress. */
  pending: boolean;
}

/** Exact state frozen after warm coverage and local-cache hydration. */
export interface ReplaceablePreflightSnapshot {
  event: NostrEvent | undefined;
  outboxes: string[];
}

export function useRobustReplaceableAction(): RobustReplaceableActionResult {
  const account = useActiveAccount();
  const store = useEventStore();
  const [pending, setPending] = useState(false);

  // Reactively subscribe to the user's outbox relays so we always have the
  // latest list when the action fires.
  const mailboxes = use$(
    () =>
      account?.pubkey ? store.model(MailboxesModel, account.pubkey) : undefined,
    [account?.pubkey, store],
  );

  const getRelaySets = useCallback((): {
    outboxes: string[];
    lookup: string[];
  } => {
    const outboxes = [
      ...new Set((mailboxes?.outboxes ?? []).map(normalizeUrl)),
    ];
    const outboxSet = new Set(outboxes);
    // Lookup relays that are not already in the outbox set
    const lookup = [
      ...new Set(lookupRelays.getValue().map(normalizeUrl)),
    ].filter((relay) => !outboxSet.has(relay));
    return { outboxes, lookup };
  }, [mailboxes]);

  /** Project lifecycle and transport facts into one user-facing relay state. */
  const classifyRelay = useCallback(
    (url: string): RelayPreflightStatus => {
      if (!account?.pubkey) return "not-checked";
      const normalized = normalizeUrl(url);
      const state = userIdentityCoverage.get(account.pubkey)?.get(normalized);
      let transportUrl: string;
      try {
        // Coverage and settings use the app's slash-stripped form, while the
        // Applesauce transport registries retain the root slash.
        transportUrl = normalizeURL(normalized);
      } catch {
        return "unavailable";
      }

      if (pool.relays.get(transportUrl)?.connected !== true) {
        return "disconnected";
      }
      const transportHealthy = liveness.filter([transportUrl]).length > 0;
      if (state?.phase === "covered") {
        return transportHealthy ? "ready" : "unavailable";
      }
      if (
        state?.reason === "rate-limited" ||
        getRateLimitCooldownRemaining(normalized) > 0
      ) {
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
      if (!transportHealthy) return "unavailable";
      if (state?.phase === "initial" || state?.phase === "catching-up") {
        return "checking";
      }
      if (state?.phase === "not-responding") return "not-responding";
      return "not-checked";
    },
    [account?.pubkey],
  );

  const getRelayStatuses = useCallback(
    (relays: string[]) => relays.map(classifyRelay),
    [classifyRelay],
  );

  const formatRelayGroup = useCallback(
    (name: string, statuses: RelayPreflightStatus[]): string => {
      if (statuses.length === 0) return `${name}: none configured.`;
      const counts = new Map<RelayPreflightStatus, number>();
      statuses.forEach((status) =>
        counts.set(status, (counts.get(status) ?? 0) + 1),
      );
      const details = RELAY_STATUS_ORDER.flatMap((status) => {
        const count = counts.get(status) ?? 0;
        return count > 0 ? [`${count} ${RELAY_STATUS_LABELS[status]}`] : [];
      });
      return `${name}: ${details.join(", ")}.`;
    },
    [],
  );

  const getCoverageCounts = useCallback(
    (outboxes: string[], lookup: string[]) => {
      const outboxStatuses = getRelayStatuses(outboxes);
      const lookupStatuses = getRelayStatuses(lookup);
      return {
        coveredOutboxes: outboxStatuses.filter((status) => status === "ready")
          .length,
        coveredLookup: lookupStatuses.filter((status) => status === "ready")
          .length,
        inFlightOutboxes: outboxStatuses.filter(
          (status) => status === "checking",
        ).length,
        inFlightLookup: lookupStatuses.filter((status) => status === "checking")
          .length,
        summary: `${formatRelayGroup("Outbox relays", outboxStatuses)} ${formatRelayGroup("Lookup relays", lookupStatuses)}`,
      };
    },
    [formatRelayGroup, getRelayStatuses],
  );

  /**
   * True when connected identity queries are still capable of satisfying the
   * threshold. Unavailable relays fail immediately instead of adding latency.
   */
  const canWarmCoverageStillSucceed = useCallback(
    (outboxes: string[], lookup: string[]) => {
      if (!navigator.onLine) return false;
      const {
        coveredOutboxes,
        coveredLookup,
        inFlightOutboxes,
        inFlightLookup,
      } = getCoverageCounts(outboxes, lookup);

      if (inFlightOutboxes + inFlightLookup === 0) return false;
      return meetsWarmCoverageThreshold(
        coveredOutboxes + inFlightOutboxes,
        outboxes.length,
        coveredLookup + inFlightLookup,
      );
    },
    [getCoverageCounts],
  );

  /**
   * Check that enough relays have current warm coverage to safely write.
   *
   * Coverage rules (applied after navigator.onLine fast-fail):
   *
   *   - No outbox relays found -> error: we can't be confident we have the
   *     user's latest event without knowing where they publish.
   *
   *   - Exactly 1 covered outbox -> also require >=2 covered lookup relays.
   *     A single outbox relay is not enough confidence on its own.
   *
   *   - >1 covered outbox -> pass if (>=50% of outboxes OR >=3 outboxes).
   *     The absolute floor prevents requiring 15/30 on large relay sets.
   *
   * Throws a user-facing error if the threshold is not met.
   */
  const assertWarmCoverage = useCallback(
    (outboxes: string[], lookup: string[], kind: number) => {
      const label = kindLabel(kind);

      // Layer 1: fast-fail on navigator.onLine (catches DevTools offline mode
      // immediately, before WebSocket close events have had time to propagate)
      if (!navigator.onLine) {
        throw new Error(
          "You appear to be offline. Please check your internet connection and try again.",
        );
      }

      // No outbox relay list found
      if (outboxes.length === 0) {
        throw new Error(
          "Could not find your relay list (NIP-65). Without knowing where you publish, " +
            `we can't be confident we have your latest ${label}. ` +
            "Please add outbox relays in your relay settings and try again.",
        );
      }

      // Personal-singleton policy consumes only the exact account session's
      // warm lease. See docs/replaceable-preflight.md, "Phase 1".
      const {
        coveredOutboxes: healthyOutboxes,
        coveredLookup: healthyLookup,
        summary,
      } = getCoverageCounts(outboxes, lookup);
      const advice = canWarmCoverageStillSucceed(outboxes, lookup)
        ? "Relay checks are still in progress."
        : "Try again shortly; if this persists, review the relay status.";

      if (healthyOutboxes === 0) {
        throw new Error(
          `None of your ${outboxes.length} outbox relay(s) have current query coverage. ` +
            `${summary} ${advice}`,
        );
      }

      if (healthyOutboxes === 1) {
        // Single covered outbox — require backup coverage from index relays
        if (healthyLookup < MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX) {
          throw new Error(
            `Only 1 of your ${outboxes.length} outbox relay(s) has current query coverage and ` +
              `only ${healthyLookup} of ${lookup.length} lookup relay(s) have current query coverage ` +
              `(need at least ${MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX} lookup relays as backup). ` +
              `${summary} ${advice}`,
          );
        }
        return; // 1 outbox + >=2 lookup is sufficient
      }

      // >1 covered outbox — pass if >=50% OR >=3 absolute
      const fraction = healthyOutboxes / outboxes.length;
      if (
        healthyOutboxes < MIN_OUTBOX_ABSOLUTE &&
        fraction < MIN_OUTBOX_FRACTION
      ) {
        throw new Error(
          `Connection is not stable enough to safely update your ${label}. ` +
            `Only ${healthyOutboxes} of ${outboxes.length} outbox relay(s) have current query coverage ` +
            `(need at least ${MIN_OUTBOX_ABSOLUTE} or ${Math.round(MIN_OUTBOX_FRACTION * 100)}%). ` +
            `${summary} ${advice}`,
        );
      }
    },
    [canWarmCoverageStillSucceed, getCoverageCounts],
  );

  /** Wait for an in-flight identity query to decide the coverage threshold. */
  const waitForWarmCoverage = useCallback(
    async (outboxes: string[], lookup: string[], kind: number) => {
      const startedWithCoverageLease = account?.pubkey
        ? userIdentityCoverage.get(account.pubkey) !== undefined
        : false;
      try {
        assertWarmCoverage(outboxes, lookup, kind);
        return;
      } catch (initialError) {
        if (!canWarmCoverageStillSucceed(outboxes, lookup)) {
          throw initialError;
        }
      }

      const decisionReady = () => {
        // accounts.ts releases the old same-account owner immediately before
        // activating its successor. Preserve the pending decision across that
        // synchronous hand-off instead of treating the empty instant as final.
        if (
          startedWithCoverageLease &&
          account?.pubkey &&
          userIdentityCoverage.get(account.pubkey) === undefined
        ) {
          return false;
        }
        try {
          assertWarmCoverage(outboxes, lookup, kind);
          return true;
        } catch {
          return !canWarmCoverageStillSucceed(outboxes, lookup);
        }
      };

      await firstValueFrom(
        race(
          userIdentityCoverage.changes$.pipe(
            startWith(undefined),
            filter(decisionReady),
            take(1),
          ),
          timer(USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS),
        ),
      );

      assertWarmCoverage(outboxes, lookup, kind);
    },
    [account?.pubkey, assertWarmCoverage, canWarmCoverageStillSucceed],
  );

  /**
   * Preserve an existing local copy when the warm relay snapshot found no
   * target event. This is deliberately cache-only: covered relay requests are
   * never repeated, and fallback-relay discovery remains a separate policy.
   */
  const hydrateCachedReplaceable = useCallback(
    async (pubkey: string, kind: number): Promise<NostrEvent | undefined> => {
      const current = store.getReplaceable(kind, pubkey);
      if (current !== undefined) return current;

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never[]>((resolve) => {
        timeoutId = setTimeout(() => resolve([]), CACHE_HYDRATION_TIMEOUT_MS);
      });
      const cachedEvents = await Promise.race([
        cacheRequest([{ kinds: [kind], authors: [pubkey] }]).catch(() => []),
        timeout,
      ]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
      cachedEvents.forEach((event) => store.add(event));
      return store.getReplaceable(kind, pubkey);
    },
    [store],
  );

  const execute = useCallback(
    async (
      kind: number,
      action: (snapshot: ReplaceablePreflightSnapshot) => Promise<void>,
    ) => {
      if (!account?.pubkey) {
        throw new Error("Not logged in.");
      }
      if (!USER_REPLACEABLE_KIND_SET.has(kind)) {
        throw new Error(
          `Cannot use personal replaceable preflight for uncovered kind:${kind}.`,
        );
      }

      setPending(true);
      try {
        const { outboxes, lookup } = getRelaySets();

        // Reuse the exact identity query's evidence. A covered EOSE means its
        // snapshot (including absence) and subsequent live updates are already
        // represented in the EventStore, so do not issue a duplicate REQ.
        await waitForWarmCoverage(outboxes, lookup, kind);

        // The persistent relay subscription does not hydrate IndexedDB. On an
        // absent target only, preserve any retained local copy before writing.
        const event = await hydrateCachedReplaceable(account.pubkey, kind);

        // Supply the resolved state directly. Writers must not reopen a model
        // whose fallback loader could issue an action-time relay request.
        await action({ event, outboxes });
      } finally {
        setPending(false);
      }
    },
    [
      account?.pubkey,
      getRelaySets,
      waitForWarmCoverage,
      hydrateCachedReplaceable,
    ],
  );

  return { execute, pending };
}
