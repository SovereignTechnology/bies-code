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
import type { NostrEvent } from "nostr-tools";
import { useActiveAccount } from "applesauce-react/hooks";
import { useEventStore } from "@/hooks/useEventStore";
import { use$ } from "@/hooks/use$";
import { normalizeURL } from "applesauce-core/helpers";
import { liveness, pool } from "@/services/nostr";
import { lookupRelays } from "@/services/settings";
import { cacheRequest } from "@/services/cache";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";
import { normalizeUrl } from "@/lib/url";
import { getRateLimitCooldownRemaining } from "@/lib/resilientSubscription";
import {
  isPersonalSingletonKind,
  PERSONAL_DELETION_BATCH_WINDOW_MS,
  personalSingletonNeedsDeletionEvidence,
} from "@/lib/personalSingletons";
import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import {
  classifyRelayPreflightStatus,
  formatRelayPreflightGroup,
  mailboxOutboxesObservable,
  waitForCoverageDecision,
  type PreflightCoverageAssessment,
  type RelayPreflightStatus,
} from "@/lib/replaceablePreflightCoverage";
import { userPersonalDeletionCoverage } from "@/services/userPersonalDeletionCoverage";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * When only 1 outbox relay is connected, we require this many lookup/index
 * relays to also be connected before allowing a replaceable event write.
 * A single outbox relay is not enough confidence on its own.
 */
const MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX = 2;

/** Preserve a full relay-settlement window after a candidate batch rebinds. */
const PERSONAL_DELETION_COVERAGE_WAIT_TIMEOUT_MS =
  PERSONAL_DELETION_BATCH_WINDOW_MS +
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS;

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
  10063: "Blossom server list",
  10317: "grasp server list",
  10318: "private Git relay list",
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
    options?: ReplaceablePreflightOptions,
  ) => Promise<void>;
  /** True while an action is in progress. */
  pending: boolean;
}

/** Exact state frozen after warm coverage and local-cache hydration. */
export interface ReplaceablePreflightSnapshot {
  event: NostrEvent | undefined;
  outboxes: string[];
}

/** Optional safeguards required by a writer's declared modifiers. */
export interface ReplaceablePreflightOptions {
  /** Event shown when a full-replacement draft began; null means absent. */
  expectedEventId: string | null;
}

export function useRobustReplaceableAction(): RobustReplaceableActionResult {
  const account = useActiveAccount();
  const store = useEventStore();
  const [pending, setPending] = useState(false);

  // Reactively subscribe to the user's outbox relays so we always have the
  // latest list when the action fires.
  const mailboxOutboxes = use$(
    () =>
      account?.pubkey
        ? mailboxOutboxesObservable(store, account.pubkey)
        : undefined,
    [account?.pubkey, store],
  );

  const getRelaySets = useCallback((): {
    outboxes: string[];
    lookup: string[];
  } => {
    const outboxes = mailboxOutboxes ?? [];
    const outboxSet = new Set(outboxes);
    // Lookup relays that are not already in the outbox set
    const lookup = [
      ...new Set(lookupRelays.getValue().map(normalizeUrl)),
    ].filter((relay) => !outboxSet.has(relay));
    return { outboxes, lookup };
  }, [mailboxOutboxes]);

  /** Project lifecycle and transport facts into one user-facing relay state. */
  const classifyRelay = useCallback(
    (
      url: string,
      coverage: RelaySubscriptionCoverage | undefined,
    ): RelayPreflightStatus => {
      const normalized = normalizeUrl(url);
      const state = coverage?.get(normalized);
      let transportUrl: string;
      try {
        // Coverage and settings use the app's slash-stripped form, while the
        // Applesauce transport registries retain the root slash.
        transportUrl = normalizeURL(normalized);
      } catch {
        return "unavailable";
      }

      const connected = pool.relays.get(transportUrl)?.connected === true;
      const transportHealthy = liveness.filter([transportUrl]).length > 0;
      return classifyRelayPreflightStatus(state, {
        connected,
        healthy: transportHealthy,
        rateLimitCooldownMs: getRateLimitCooldownRemaining(normalized),
      });
    },
    [],
  );

  const getRelayStatuses = useCallback(
    (relays: string[], coverage: RelaySubscriptionCoverage | undefined) =>
      relays.map((relay) => classifyRelay(relay, coverage)),
    [classifyRelay],
  );

  const getCoverageCounts = useCallback(
    (
      outboxes: string[],
      lookup: string[],
      coverage: RelaySubscriptionCoverage | undefined,
    ) => {
      const outboxStatuses = getRelayStatuses(outboxes, coverage);
      const lookupStatuses = getRelayStatuses(lookup, coverage);
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
        summary: `${formatRelayPreflightGroup("Outbox relays", outboxStatuses)} ${formatRelayPreflightGroup("Lookup relays", lookupStatuses)}`,
      };
    },
    [getRelayStatuses],
  );

  /**
   * True when connected identity queries are still capable of satisfying the
   * threshold. Unavailable relays fail immediately instead of adding latency.
   */
  const canWarmCoverageStillSucceed = useCallback(
    (
      outboxes: string[],
      lookup: string[],
      coverage: RelaySubscriptionCoverage | undefined,
    ) => {
      if (!navigator.onLine) return false;
      const {
        coveredOutboxes,
        coveredLookup,
        inFlightOutboxes,
        inFlightLookup,
      } = getCoverageCounts(outboxes, lookup, coverage);

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
    (
      outboxes: string[],
      lookup: string[],
      kind: number,
      coverage: RelaySubscriptionCoverage | undefined,
      evidence: "identity" | "deletion" = "identity",
    ) => {
      const label = kindLabel(kind);
      const coverageLabel =
        evidence === "deletion" ? "deletion-query coverage" : "query coverage";

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
      } = getCoverageCounts(outboxes, lookup, coverage);
      const advice = canWarmCoverageStillSucceed(outboxes, lookup, coverage)
        ? "Relay checks are still in progress."
        : "Try again shortly; if this persists, review the relay status.";

      if (healthyOutboxes === 0) {
        throw new Error(
          `None of your ${outboxes.length} outbox relay(s) have current ${coverageLabel}. ` +
            `${summary} ${advice}`,
        );
      }

      if (healthyOutboxes === 1) {
        // Single covered outbox — require backup coverage from index relays
        if (healthyLookup < MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX) {
          throw new Error(
            `Only 1 of your ${outboxes.length} outbox relay(s) has current ${coverageLabel} and ` +
              `only ${healthyLookup} of ${lookup.length} lookup relay(s) have current ${coverageLabel} ` +
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
            `Only ${healthyOutboxes} of ${outboxes.length} outbox relay(s) have current ${coverageLabel} ` +
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
      const currentCoverage = () =>
        account?.pubkey ? userIdentityCoverage.get(account.pubkey) : undefined;
      const startedWithCoverageLease = account?.pubkey
        ? userIdentityCoverage.get(account.pubkey) !== undefined
        : false;
      await waitForCoverageDecision({
        timeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
        getSnapshot: currentCoverage,
        assess: (coverage): PreflightCoverageAssessment => {
          // accounts.ts releases the old same-account owner immediately before
          // activating its successor. Preserve the pending decision across
          // that synchronous hand-off instead of treating it as final.
          if (
            startedWithCoverageLease &&
            account?.pubkey &&
            userIdentityCoverage.get(account.pubkey) === undefined
          ) {
            return {
              met: false,
              possible: true,
              summary:
                "Relay coverage is moving to the replacement identity owner.",
            };
          }
          try {
            assertWarmCoverage(outboxes, lookup, kind, coverage);
            return { met: true, possible: true, summary: "ready" };
          } catch (error) {
            return {
              met: false,
              possible: canWarmCoverageStillSucceed(outboxes, lookup, coverage),
              summary:
                error instanceof Error
                  ? error.message
                  : "Relay coverage is not ready.",
            };
          }
        },
        changes: () => userIdentityCoverage.changes$,
        error: (assessment) => new Error(assessment.summary),
      });
    },
    [account?.pubkey, assertWarmCoverage, canWarmCoverageStillSucceed],
  );

  /** Wait for the shared, candidate-specific NIP-09 query when required. */
  const waitForDeletionCoverage = useCallback(
    async (
      outboxes: string[],
      lookup: string[],
      kind: number,
      candidateId: string | undefined,
    ) => {
      if (!account?.pubkey) throw new Error("Not logged in.");
      const pubkey = account.pubkey;
      const matchingLease = () => {
        const lease = userPersonalDeletionCoverage.get(pubkey);
        if (!lease) return undefined;
        const leaseCandidateId = lease.candidateIds.get(kind);
        if (leaseCandidateId === candidateId) return lease;

        // An exact deletion can remove the candidate while its batched lease
        // is settling. The replacement lease no longer needs that event ID;
        // accept it only when the EventStore confirms the candidate is gone.
        if (
          candidateId !== undefined &&
          leaseCandidateId === undefined &&
          store.getReplaceable(kind, pubkey) === undefined
        ) {
          return lease;
        }
        return undefined;
      };
      await waitForCoverageDecision({
        timeoutMs: PERSONAL_DELETION_COVERAGE_WAIT_TIMEOUT_MS,
        getSnapshot: matchingLease,
        assess: (lease): PreflightCoverageAssessment => {
          if (!lease) {
            return {
              met: false,
              possible: true,
              summary:
                `Deletion checks for your ${kindLabel(kind)} did not settle in time. ` +
                "Please try again shortly.",
            };
          }
          try {
            assertWarmCoverage(
              outboxes,
              lookup,
              kind,
              lease.coverage,
              "deletion",
            );
            return { met: true, possible: true, summary: "ready" };
          } catch (error) {
            return {
              met: false,
              possible: canWarmCoverageStillSucceed(
                outboxes,
                lookup,
                lease.coverage,
              ),
              summary:
                error instanceof Error
                  ? error.message
                  : "Deletion-query coverage is not ready.",
            };
          }
        },
        changes: () => userPersonalDeletionCoverage.changes$,
        error: (assessment) => new Error(assessment.summary),
      });
    },
    [account?.pubkey, assertWarmCoverage, canWarmCoverageStillSucceed, store],
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
      options?: ReplaceablePreflightOptions,
    ) => {
      if (!account?.pubkey) {
        throw new Error("Not logged in.");
      }
      if (!isPersonalSingletonKind(kind)) {
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
        let event = await hydrateCachedReplaceable(account.pubkey, kind);

        if (personalSingletonNeedsDeletionEvidence(kind)) {
          const candidateId = event?.id;
          await waitForDeletionCoverage(outboxes, lookup, kind, candidateId);
          const afterDeletionEvidence = store.getReplaceable(
            kind,
            account.pubkey,
          );
          if (
            afterDeletionEvidence !== undefined &&
            afterDeletionEvidence.id !== candidateId
          ) {
            throw new Error(
              `Your ${kindLabel(kind)} changed while its deletion evidence was checked. ` +
                "Please review the latest value and try again.",
            );
          }
          event = afterDeletionEvidence;
        }

        if (
          options !== undefined &&
          (event?.id ?? null) !== options.expectedEventId
        ) {
          throw new Error(
            `Your ${kindLabel(kind)} changed after you began editing. ` +
              "Review the latest value before saving.",
          );
        }

        // Supply the resolved state directly. Writers must not reopen a model
        // whose fallback loader could issue an action-time relay request.
        // Extension point: if concurrent cross-client writes prove common, a
        // winner-stability comparison and delta rebase belongs here, before the
        // action signs. Phase 2 deliberately does not add that transaction.
        await action({ event, outboxes });
      } finally {
        setPending(false);
      }
    },
    [
      account?.pubkey,
      getRelaySets,
      waitForWarmCoverage,
      waitForDeletionCoverage,
      hydrateCachedReplaceable,
      store,
    ],
  );

  return { execute, pending };
}
