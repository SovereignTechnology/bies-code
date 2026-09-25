/**
 * Account-owned NIP-09 evidence for personal singleton candidates.
 *
 * The stable singleton query remains separate and continuously warm. This
 * owner watches its EventStore winners, coalesces changes for one second, and
 * keeps exactly one deletion REQ per relay open for all protected coordinates
 * and current exact event IDs. Rebuilding replaces that REQ rather than
 * accumulating one subscription per kind or writer.
 *
 * See docs/replaceable-preflight.md, "Personal-singleton adoption decision".
 */

import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import {
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  merge,
  startWith,
  type Observable,
  type Subscription,
} from "rxjs";

import { createRelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import {
  PERSONAL_DELETION_BATCH_WINDOW_MS,
  PERSONAL_SINGLETON_DELETION_KINDS,
} from "@/lib/personalSingletons";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { eventStore, pool } from "@/services/nostr";
import { USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS } from "@/services/userIdentityCoverage";
import { userPersonalDeletionCoverage } from "@/services/userPersonalDeletionCoverage";

function candidateKey(candidateIds: ReadonlyMap<number, string>): string {
  return [...candidateIds]
    .sort(([left], [right]) => left - right)
    .map(([kind, id]) => `${kind}:${id}`)
    .join("|");
}

function deletionFilters(
  pubkey: string,
  candidateIds: ReadonlyMap<number, string>,
): Filter[] {
  const filters: Filter[] = [
    {
      kinds: [5],
      authors: [pubkey],
      "#a": PERSONAL_SINGLETON_DELETION_KINDS.map(
        (kind) => `${kind}:${pubkey}:`,
      ),
    },
  ];
  const ids = [...candidateIds.values()];
  if (ids.length > 0) {
    filters.push({ kinds: [5], authors: [pubkey], "#e": ids });
  }
  return filters;
}

/** Start the one active-account deletion-evidence owner. */
export function startUserPersonalDeletionSubscription(
  pubkey: string,
  relays$: Observable<string[]>,
): () => void {
  let stopped = false;
  let activeSubscription: Subscription | undefined;
  let releaseCoverage: (() => void) | undefined;

  const protectedKinds = new Set<number>(PERSONAL_SINGLETON_DELETION_KINDS);
  const candidates$ = merge(
    eventStore.filters(
      {
        kinds: [...PERSONAL_SINGLETON_DELETION_KINDS],
        authors: [pubkey],
      },
      true,
    ),
    eventStore.remove$.pipe(
      filter(
        (event) => event.pubkey === pubkey && protectedKinds.has(event.kind),
      ),
    ),
  ).pipe(
    startWith(undefined),
    map(() => {
      const ids = new Map<number, string>();
      PERSONAL_SINGLETON_DELETION_KINDS.forEach((kind) => {
        const event = eventStore.getReplaceable(kind, pubkey);
        if (event) ids.set(kind, event.id);
      });
      return ids;
    }),
    distinctUntilChanged(
      (left, right) => candidateKey(left) === candidateKey(right),
    ),
    debounceTime(PERSONAL_DELETION_BATCH_WINDOW_MS),
  );

  const candidateSubscription = candidates$.subscribe({
    next: (candidateIds) => {
      if (stopped) return;
      const coverage = createRelaySubscriptionCoverage({
        settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
      });
      let failedSynchronously = false;
      const nextSubscription = resilientSubscription(
        pool,
        relays$,
        deletionFilters(pubkey, candidateIds),
        {
          reconnect: true,
          gapFill: true,
          settle: false,
          paginate: false,
          retryCount: Infinity,
          onRelayLifecycle: (event) => coverage.onLifecycle(event),
        },
      )
        .pipe(onlyEvents(), mapEventsToStore(eventStore))
        .subscribe({
          error: (error) => {
            failedSynchronously = true;
            coverage.stop();
            console.warn(
              "[userPersonalDeletionSubscription] subscription error:",
              error,
            );
          },
        });

      if (failedSynchronously || nextSubscription.closed) return;

      const previousSubscription = activeSubscription;
      const previousRelease = releaseCoverage;
      activeSubscription = nextSubscription;
      releaseCoverage = userPersonalDeletionCoverage.activate(
        pubkey,
        candidateIds,
        coverage,
      );
      previousRelease?.();
      previousSubscription?.unsubscribe();
    },
    error: (error) => {
      console.warn(
        "[userPersonalDeletionSubscription] candidate stream error:",
        error,
      );
    },
  });

  return () => {
    if (stopped) return;
    stopped = true;
    candidateSubscription.unsubscribe();
    releaseCoverage?.();
    activeSubscription?.unsubscribe();
  };
}
