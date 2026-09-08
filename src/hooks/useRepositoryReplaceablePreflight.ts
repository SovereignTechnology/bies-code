import { useCallback, useState } from "react";
import { getOutboxes } from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { firstValueFrom, race, Subscription, timer } from "rxjs";
import { filter, startWith, take } from "rxjs/operators";

import { useEventStore } from "@/hooks/useEventStore";
import type { ResolvedRepository } from "@/hooks/useResolvedRepository";
import { REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS } from "@/hooks/useResolvedRepository";
import { REPO_KIND, REPO_STATE_KIND } from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { cacheRequest } from "@/services/cache";
import { eventStore, pool } from "@/services/nostr";
import { resilientRequest } from "@/lib/resilientSubscription";

const CACHE_HYDRATION_TIMEOUT_MS = 1_000;
const FOCUSED_ABSENCE_TIMEOUT_MS = 10_000;

export interface RepositoryReplaceableSnapshot {
  /** Current event at the signer-owned coordinate, if one exists. */
  actorEvent: NostrEvent | undefined;
  /** Current winner across the category's authority set. */
  winner: NostrEvent | undefined;
  /** Repository relay voters frozen before signing. */
  repositoryRelays: string[];
  /** Newly queried author outboxes, empty when warm repository evidence sufficed. */
  focusedOutboxRelays: string[];
}

export interface RepositoryReplaceablePreflightOptions {
  kind: typeof REPO_KIND | typeof REPO_STATE_KIND;
  actorPubkey: string;
  /** Event the editor/operation was based on; null records known absence. */
  expectedEventId: string | null;
}

function pickWinner(events: NostrEvent[]): NostrEvent | undefined {
  return events.reduce<NostrEvent | undefined>((winner, event) => {
    if (
      !winner ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
    ) {
      return event;
    }
    return winner;
  }, undefined);
}

function repositoryWinner(
  kind: typeof REPO_KIND | typeof REPO_STATE_KIND,
  actorPubkey: string,
  dTag: string,
  authorityPubkeys: string[],
): NostrEvent | undefined {
  if (kind === REPO_KIND) {
    return eventStore.getReplaceable(REPO_KIND, actorPubkey, dTag);
  }
  return pickWinner(
    eventStore.getByFilters([
      {
        kinds: [REPO_STATE_KIND],
        authors: authorityPubkeys,
        "#d": [dTag],
      } as Filter,
    ]),
  );
}

async function hydrateCachedCoordinate(
  kind: typeof REPO_KIND | typeof REPO_STATE_KIND,
  pubkey: string,
  dTag: string,
): Promise<void> {
  if (eventStore.getReplaceable(kind, pubkey, dTag)) return;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never[]>((resolve) => {
    timeoutId = setTimeout(() => resolve([]), CACHE_HYDRATION_TIMEOUT_MS);
  });
  const cached = await Promise.race([
    cacheRequest([
      { kinds: [kind], authors: [pubkey], "#d": [dTag] } as Filter,
    ]).catch(() => []),
    timeoutResult,
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
  cached.forEach((event) => eventStore.add(event));
}

function mailboxOutboxes(pubkey: string): string[] {
  const mailboxEvent = eventStore.getReplaceable(10_002, pubkey);
  return mailboxEvent
    ? [...new Set(getOutboxes(mailboxEvent).map(normalizeUrl))]
    : [];
}

/**
 * Query genuinely new author-coordinate evidence and require one EOSE from
 * every named frontier. The caller supplies no frontier already covered by a
 * warm lease.
 */
async function confirmFocusedAbsence(
  filters: Filter[],
  frontiers: { name: string; relays: string[] }[],
): Promise<void> {
  const normalizedFrontiers = frontiers.map(({ name, relays }) => ({
    name,
    relays: [...new Set(relays.map(normalizeUrl))],
  }));
  const empty = normalizedFrontiers.find(({ relays }) => relays.length === 0);
  if (empty) {
    throw new Error(
      `No ${empty.name} are available to check this new repository coordinate.`,
    );
  }

  const allRelays = [
    ...new Set(normalizedFrontiers.flatMap(({ relays }) => relays)),
  ];
  await new Promise<void>((resolve, reject) => {
    const eose = new Set<string>();
    const subscription = new Subscription();
    const resources: {
      timeoutId?: ReturnType<typeof setTimeout>;
    } = {};
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (resources.timeoutId !== undefined) clearTimeout(resources.timeoutId);
      subscription.unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const hasEveryFrontier = () =>
      normalizedFrontiers.every(({ relays }) =>
        relays.some((relay) => eose.has(relay)),
      );

    resources.timeoutId = setTimeout(() => {
      const missing = normalizedFrontiers
        .filter(({ relays }) => !relays.some((relay) => eose.has(relay)))
        .map(({ name }) => name);
      finish(
        new Error(
          `Repository collision checks did not settle on ${missing.join(" and ")}. Please check those relays and try again.`,
        ),
      );
    }, FOCUSED_ABSENCE_TIMEOUT_MS);

    subscription.add(
      resilientRequest(pool, allRelays, filters, {
        settle: false,
        retryCount: 1,
        onRelayEose: (relay) => {
          eose.add(normalizeUrl(relay));
          if (hasEveryFrontier()) finish();
        },
      })
        .pipe(onlyEvents())
        .subscribe({
          next: (event) => eventStore.add(event),
          error: () => {
            finish(
              new Error(
                "Repository collision checks failed before the required relay frontiers settled.",
              ),
            );
          },
          complete: () => {
            if (!hasEveryFrontier()) {
              finish(
                new Error(
                  "Repository collision checks ended before the required relay frontiers settled.",
                ),
              );
            }
          },
        }),
    );
  });
}

/** Focused preflight for a completely new public repository. */
export async function assertNewPublicRepositoryCoordinatesAbsent(
  pubkey: string,
  dTag: string,
  proposedRepositoryRelays: string[],
): Promise<void> {
  await Promise.all([
    hydrateCachedCoordinate(REPO_KIND, pubkey, dTag),
    hydrateCachedCoordinate(REPO_STATE_KIND, pubkey, dTag),
  ]);
  if (
    eventStore.getReplaceable(REPO_KIND, pubkey, dTag) ||
    eventStore.getReplaceable(REPO_STATE_KIND, pubkey, dTag)
  ) {
    throw new Error(
      "This repository identifier already exists for your account. Choose another identifier.",
    );
  }

  const outboxes = mailboxOutboxes(pubkey);
  await confirmFocusedAbsence(
    [
      {
        kinds: [REPO_KIND, REPO_STATE_KIND],
        authors: [pubkey],
        "#d": [dTag],
      } as Filter,
    ],
    [
      { name: "current NIP-65 outbox relays", relays: outboxes },
      {
        name: "proposed repository relays",
        relays: proposedRepositoryRelays,
      },
    ],
  );

  if (
    eventStore.getReplaceable(REPO_KIND, pubkey, dTag) ||
    eventStore.getReplaceable(REPO_STATE_KIND, pubkey, dTag)
  ) {
    throw new Error(
      "This repository identifier already exists for your account. Choose another identifier.",
    );
  }
}

export function useRepositoryReplaceablePreflight(
  resolved: ResolvedRepository | undefined,
) {
  const store = useEventStore();
  const [pending, setPending] = useState(false);

  const waitForRepositoryCoverage = useCallback(async () => {
    if (!resolved) throw new Error("Repository preflight is not ready.");
    const repositoryRelays = [
      ...new Set(resolved.repo.relays.map(normalizeUrl)),
    ];
    if (repositoryRelays.length === 0) {
      throw new Error(
        "This repository does not declare a relay that can confirm its current state.",
      );
    }
    const coverage = resolved.replaceableCoverage;
    const covered = () =>
      repositoryRelays.some((relay) => coverage.isCovered(relay));
    const canStillSettle = () =>
      repositoryRelays.some((relay) => {
        const phase = coverage.get(relay)?.phase;
        return phase === "initial" || phase === "catching-up";
      });

    if (!covered() && canStillSettle()) {
      await firstValueFrom(
        race(
          coverage.changes$.pipe(
            startWith(undefined),
            filter(() => covered() || !canStillSettle()),
            take(1),
          ),
          timer(REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS),
        ),
      );
    }
    if (!covered()) {
      const counts = new Map<string, number>();
      for (const relay of repositoryRelays) {
        const phase = coverage.get(relay)?.phase ?? "not-checked";
        counts.set(phase, (counts.get(phase) ?? 0) + 1);
      }
      const summary = [...counts]
        .map(([phase, count]) => `${count} ${phase}`)
        .join(", ");
      throw new Error(
        `No repository relay has current announcement and state coverage (${summary}). Please check the repository relays and try again.`,
      );
    }
    return repositoryRelays;
  }, [resolved]);

  const execute = useCallback(
    async <T>(
      options: RepositoryReplaceablePreflightOptions,
      action: (snapshot: RepositoryReplaceableSnapshot) => Promise<T>,
    ): Promise<T> => {
      setPending(true);
      try {
        if (!resolved) throw new Error("Repository preflight is not ready.");
        const repositoryRelays = await waitForRepositoryCoverage();
        await hydrateCachedCoordinate(
          options.kind,
          options.actorPubkey,
          resolved.repo.dTag,
        );

        let actorEvent = store.getReplaceable(
          options.kind,
          options.actorPubkey,
          resolved.repo.dTag,
        );
        let focusedOutboxRelays: string[] = [];
        if (!actorEvent) {
          focusedOutboxRelays = mailboxOutboxes(options.actorPubkey);
          await confirmFocusedAbsence(
            [
              {
                kinds: [options.kind],
                authors: [options.actorPubkey],
                "#d": [resolved.repo.dTag],
              } as Filter,
            ],
            [
              {
                name: "current NIP-65 outbox relays",
                relays: focusedOutboxRelays,
              },
            ],
          );
          actorEvent = store.getReplaceable(
            options.kind,
            options.actorPubkey,
            resolved.repo.dTag,
          );
        }

        const winner = repositoryWinner(
          options.kind,
          options.actorPubkey,
          resolved.repo.dTag,
          resolved.repo.confirmedMaintainers,
        );
        if ((winner?.id ?? null) !== options.expectedEventId) {
          throw new Error(
            "The repository announcement or state changed after this operation began. Review the latest value and try again.",
          );
        }

        return await action({
          actorEvent,
          winner,
          repositoryRelays,
          focusedOutboxRelays,
        });
      } finally {
        setPending(false);
      }
    },
    [resolved, store, waitForRepositoryCoverage],
  );

  return { execute, pending };
}
