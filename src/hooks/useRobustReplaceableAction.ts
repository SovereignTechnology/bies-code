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
 * This hook adds three layers of protection:
 *
 * 1. WARM COVERAGE THRESHOLD CHECK
 *    Before attempting any write, we intersect the user's outbox and lookup
 *    groups with healthy relays whose current identity-subscription cycle has
 *    returned a real EOSE. The existing one-outbox and larger-set threshold
 *    rules are then applied. navigator.onLine remains a fast offline check.
 *
 * 2. FRESH FETCH FROM ALL OUTBOX + LOOKUP RELAYS
 *    We use addressLoader to fetch the latest event of the target kind from
 *    the user's outbox relays AND the configured lookup relays, then wait
 *    for it to land in the EventStore.
 *
 * 3. PERSISTENT BACKGROUND SUBSCRIPTION (handled in accounts.ts)
 *    A continuous pool.subscription() for all user replaceable kinds is kept
 *    open on the union of the user's outbox relays and lookup/index relays
 *    for the lifetime of the session (see userIdentitySubscription.ts). This
 *    means the EventStore is already warm in most cases — the addressLoader
 *    fetch here is a final safety net, not the primary mechanism.
 *
 * USAGE
 * -----
 * ```ts
 * const execute = useRobustReplaceableAction();
 *
 * // Wrap any action that modifies a replaceable event:
 * await execute(3, async () => {
 *   await followUser(pubkey);
 * });
 * ```
 */

import { useCallback, useState } from "react";
import { firstValueFrom, race } from "rxjs";
import { filter, take } from "rxjs/operators";
import { useActiveAccount } from "applesauce-react/hooks";
import { useEventStore } from "@/hooks/useEventStore";
import { use$ } from "@/hooks/use$";
import { normalizeURL } from "applesauce-core/helpers";
import { MailboxesModel } from "applesauce-core/models";
import { addressLoader, liveness, pool } from "@/services/nostr";
import { lookupRelays } from "@/services/settings";
import { userIdentityCoverage } from "@/services/userIdentityCoverage";
import { normalizeUrl } from "@/lib/url";

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

/**
 * How long (ms) to wait for the addressLoader to return the latest event
 * before proceeding with whatever is already in the EventStore.
 */
const FETCH_TIMEOUT_MS = 5_000;

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
   * @param action  - The async action to execute after safety checks pass
   */
  execute: (kind: number, action: () => Promise<void>) => Promise<void>;
  /** True while an action is in progress. */
  pending: boolean;
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

  /**
   * Count relays whose exact active-account identity query is cycle-covered,
   * whose WebSocket remains open, and which are not dead/backing off.
   */
  const countCoveredHealthy = useCallback(
    (relays: string[]): number => {
      if (!account?.pubkey) return 0;
      const covered = userIdentityCoverage.coveredRelays(
        account.pubkey,
        relays,
      );
      // Coverage and settings use the app's slash-stripped canonical form,
      // while Applesauce keys RelayPool and RelayLiveness by normalizeURL(),
      // which retains the root slash. Translate only at that boundary.
      const connected = covered.flatMap((url) => {
        try {
          const transportUrl = normalizeURL(url);
          return pool.relays.get(transportUrl)?.connected === true
            ? [transportUrl]
            : [];
        } catch {
          return [];
        }
      });
      return liveness.filter(connected).length;
    },
    [account?.pubkey],
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
      const healthyOutboxes = countCoveredHealthy(outboxes);
      const healthyLookup = countCoveredHealthy(lookup);

      if (healthyOutboxes === 0) {
        throw new Error(
          `None of your ${outboxes.length} outbox relay(s) have current query coverage. ` +
            "Please wait for relay checks to finish, then try again.",
        );
      }

      if (healthyOutboxes === 1) {
        // Single covered outbox — require backup coverage from index relays
        if (healthyLookup < MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX) {
          throw new Error(
            `Only 1 of your ${outboxes.length} outbox relay(s) has current query coverage and ` +
              `only ${healthyLookup} of ${lookup.length} lookup relay(s) have current query coverage ` +
              `(need at least ${MIN_INDEX_RELAYS_FOR_SINGLE_OUTBOX} lookup relays as backup). ` +
              "Please wait for relay checks to finish, then try again.",
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
            "Please wait for relay checks to finish, then try again.",
        );
      }
    },
    [countCoveredHealthy],
  );

  /**
   * Fetch the latest event of the given kind from the user's relay set and
   * wait for it to land in the EventStore. Times out after FETCH_TIMEOUT_MS
   * and proceeds with whatever is already in the store.
   */
  const prefetchReplaceable = useCallback(
    async (pubkey: string, kind: number, relays: string[]) => {
      if (relays.length === 0) return;

      await Promise.race([
        firstValueFrom(
          race(
            // Wait for the store to emit the replaceable event for this
            // pubkey+kind (may already be there, resolves immediately)
            store.replaceable(kind, pubkey).pipe(
              filter((e) => e !== undefined),
              take(1),
            ),
            // Kick off the actual relay fetch in parallel
            new Promise<void>((resolve) => {
              addressLoader({ kind, pubkey, relays }).subscribe({
                complete: resolve,
                error: resolve, // don't let fetch errors block the action
              });
            }) as never,
          ),
        ),
        // Hard timeout — proceed with whatever is in the store
        new Promise<void>((resolve) => setTimeout(resolve, FETCH_TIMEOUT_MS)),
      ]);
    },
    [store],
  );

  const execute = useCallback(
    async (kind: number, action: () => Promise<void>) => {
      if (!account?.pubkey) {
        throw new Error("Not logged in.");
      }

      setPending(true);
      try {
        const { outboxes, lookup } = getRelaySets();

        // 1. Warm coverage check — fail fast with a clear error
        assertWarmCoverage(outboxes, lookup, kind);

        // 2. Fetch latest event from all outbox + lookup relays
        const allRelays = [...outboxes, ...lookup];
        await prefetchReplaceable(account.pubkey, kind, allRelays);

        // 3. Run the action — now guaranteed to start from the freshest state
        await action();
      } finally {
        setPending(false);
      }
    },
    [account?.pubkey, getRelaySets, assertWarmCoverage, prefetchReplaceable],
  );

  return { execute, pending };
}
