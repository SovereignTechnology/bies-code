import { useCallback, useEffect, useMemo, useRef } from "react";
import { getOutboxes } from "applesauce-core/helpers";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import { BehaviorSubject, merge, Subscription } from "rxjs";
import { skip } from "rxjs/operators";

import { useEventStore } from "@/hooks/useEventStore";
import { useToast } from "@/hooks/useToast";
import type { ResolvedRepository } from "@/hooks/useResolvedRepository";
import { REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS } from "@/hooks/useResolvedRepository";
import { isValidRepositoryState } from "@/casts/RepositoryState";
import { isValidRepository } from "@/casts/Repository";
import {
  getRepoCloneUrls,
  getRepoRelays,
  repoCoordinate,
  REPO_KIND,
  REPO_STATE_KIND,
} from "@/lib/nip34";
import { normalizeUrl } from "@/lib/url";
import { cacheRequest } from "@/services/cache";
import { eventStore, pool } from "@/services/nostr";
import { resilientRequest } from "@/lib/resilientSubscription";
import {
  summarizeRelayCoveragePhases,
  waitForCoverageDecision,
  type PreflightCoverageAssessment,
} from "@/lib/replaceablePreflightCoverage";
import type { RelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";

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
  /** Hold dynamic deletion additions until a GRASP state/Git transition ends. */
  holdWriteWindow?: boolean;
}

interface RepositoryCoverageSnapshot {
  resolved: ResolvedRepository;
  repositoryRelays: string[];
  coverage: RelaySubscriptionCoverage;
  candidateIncluded: boolean;
}

function repositoryRelayVoters(resolved: ResolvedRepository): string[] {
  const declaredRelays = [...new Set(resolved.repo.relays.map(normalizeUrl))];
  return resolved.repo.isPrivate || declaredRelays.length === 0
    ? [
        ...new Set(
          resolved.repoRelayGroup.relays.map(({ url }) => normalizeUrl(url)),
        ),
      ]
    : declaredRelays;
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
    const event = eventStore.getReplaceable(REPO_KIND, actorPubkey, dTag);
    return event && isValidRepository(event) ? event : undefined;
  }
  return pickWinner(
    eventStore
      .getByFilters([
        {
          kinds: [REPO_STATE_KIND],
          authors: authorityPubkeys,
          "#d": [dTag],
        } as Filter,
      ])
      .filter(isValidRepositoryState),
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

function sameStringSet(first: string[], second: string[]): boolean {
  const a = [...new Set(first)].sort();
  const b = [...new Set(second)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resumablePublicAnnouncement(
  pubkey: string,
  dTag: string,
  proposedCloneUrls: string[],
  proposedRepositoryRelays: string[],
): NostrEvent | undefined {
  const announcement = eventStore.getReplaceable(REPO_KIND, pubkey, dTag);
  if (!announcement) return undefined;
  const cloneUrlsMatch = sameStringSet(
    getRepoCloneUrls(announcement),
    proposedCloneUrls,
  );
  const relaysMatch = sameStringSet(
    getRepoRelays(announcement).map(normalizeUrl),
    proposedRepositoryRelays.map(normalizeUrl),
  );
  return cloneUrlsMatch && relaysMatch ? announcement : undefined;
}

function assertPublicCreationCanProceed(
  pubkey: string,
  dTag: string,
  proposedCloneUrls: string[],
  proposedRepositoryRelays: string[],
  resumable?: { announcementId: string; stateId: string },
): void {
  const state = eventStore.getReplaceable(REPO_STATE_KIND, pubkey, dTag);
  const announcement = eventStore.getReplaceable(REPO_KIND, pubkey, dTag);
  if (
    state &&
    (state.id !== resumable?.stateId ||
      (announcement !== undefined &&
        announcement.id !== resumable.announcementId))
  ) {
    throw new Error(
      "This repository identifier already has published state. Choose another identifier.",
    );
  }
  if (
    announcement &&
    announcement.id !== resumable?.announcementId &&
    !resumablePublicAnnouncement(
      pubkey,
      dTag,
      proposedCloneUrls,
      proposedRepositoryRelays,
    )
  ) {
    throw new Error(
      "This repository identifier already belongs to a different repository frontier. Choose another identifier.",
    );
  }
}

/** Focused preflight for a new or resumable public repository creation. */
export async function assertNewPublicRepositoryCoordinatesAvailable(
  pubkey: string,
  dTag: string,
  proposedCloneUrls: string[],
  proposedRepositoryRelays: string[],
  resumable?: { announcementId: string; stateId: string },
): Promise<void> {
  await Promise.all([
    hydrateCachedCoordinate(REPO_KIND, pubkey, dTag),
    hydrateCachedCoordinate(REPO_STATE_KIND, pubkey, dTag),
  ]);
  assertPublicCreationCanProceed(
    pubkey,
    dTag,
    proposedCloneUrls,
    proposedRepositoryRelays,
    resumable,
  );

  const outboxes = mailboxOutboxes(pubkey);
  await confirmFocusedAbsence(
    [
      {
        kinds: [REPO_KIND, REPO_STATE_KIND],
        authors: [pubkey],
        "#d": [dTag],
      } as Filter,
      {
        kinds: [5],
        authors: [pubkey],
        "#a": [
          repoCoordinate(pubkey, dTag),
          `${REPO_STATE_KIND}:${pubkey}:${dTag}`,
        ],
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

  assertPublicCreationCanProceed(
    pubkey,
    dTag,
    proposedCloneUrls,
    proposedRepositoryRelays,
    resumable,
  );
}

export function useRepositoryReplaceablePreflight(
  resolved: ResolvedRepository | undefined,
) {
  const store = useEventStore();
  const { toast } = useToast();
  const resolvedRef = useRef(resolved);
  const noDeclaredRelayNoticeShown = useRef(false);
  resolvedRef.current = resolved;
  const resolvedRevision$ = useMemo(() => new BehaviorSubject(0), []);
  const deletionCandidateRevision =
    resolved?.replaceableDeletionCandidateIds?.join(",") ?? "";
  useEffect(() => {
    resolvedRevision$.next(resolvedRevision$.value + 1);
  }, [
    resolved?.replaceableCoverage,
    resolved?.replaceableDeletionCoverage,
    deletionCandidateRevision,
    resolvedRevision$,
  ]);
  useEffect(() => () => resolvedRevision$.complete(), [resolvedRevision$]);

  const waitForRepositoryCoverage = useCallback(
    async (
      deadline: number,
      candidateId?: string,
    ): Promise<{
      resolved: ResolvedRepository;
      repositoryRelays: string[];
    }> => {
      const snapshot = await waitForCoverageDecision({
        timeoutMs: Math.max(0, deadline - Date.now()),
        getSnapshot: (): RepositoryCoverageSnapshot => {
          const current = resolvedRef.current;
          if (!current) throw new Error("Repository preflight is not ready.");
          const repositoryRelays = repositoryRelayVoters(current);
          if (repositoryRelays.length === 0) {
            throw new Error(
              "No admitted repository relay or route hint can confirm the current repository state.",
            );
          }
          return {
            resolved: current,
            repositoryRelays,
            coverage: candidateId
              ? current.replaceableDeletionCoverage
              : current.replaceableCoverage,
            candidateIncluded:
              candidateId === undefined ||
              current.replaceableDeletionCandidateIds.includes(candidateId),
          };
        },
        assess: (current): PreflightCoverageAssessment => ({
          met:
            current.candidateIncluded &&
            current.repositoryRelays.some((relay) =>
              current.coverage.isCovered(relay),
            ),
          possible:
            !current.candidateIncluded ||
            current.repositoryRelays.some((relay) => {
              const phase = current.coverage.get(relay)?.phase;
              return (
                phase === undefined ||
                phase === "initial" ||
                phase === "catching-up" ||
                phase === "stopped"
              );
            }),
          summary: summarizeRelayCoveragePhases(
            current.coverage,
            current.repositoryRelays,
          ),
        }),
        changes: (current) =>
          merge(current.coverage.changes$, resolvedRevision$.pipe(skip(1))),
        error: (assessment) =>
          new Error(
            `No repository relay has current ${candidateId ? "exact-deletion" : "announcement and state"} coverage (${assessment.summary}). Please check the repository relays and try again.`,
          ),
      });
      return {
        resolved: snapshot.resolved,
        repositoryRelays: snapshot.repositoryRelays,
      };
    },
    [resolvedRevision$],
  );

  const execute = useCallback(
    async <T>(
      options: RepositoryReplaceablePreflightOptions,
      action: (snapshot: RepositoryReplaceableSnapshot) => Promise<T>,
    ): Promise<T> => {
      const initial = resolvedRef.current;
      if (!initial) throw new Error("Repository preflight is not ready.");
      if (initial.replaceableWriteWindow.isHeld()) {
        throw new Error(
          "Another repository state transition is still in progress. Please wait for it to finish.",
        );
      }
      let deadline = Date.now() + REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS;
      let scope = await waitForRepositoryCoverage(deadline);
      if (
        !scope.resolved.repo.isPrivate &&
        scope.resolved.repo.relays.length === 0 &&
        !noDeclaredRelayNoticeShown.current
      ) {
        noDeclaredRelayNoticeShown.current = true;
        toast({
          title: "Repository has no declared relay",
          description:
            "This safety check is using an admitted route relay hint. Add a repository relay in settings so future writes have an explicit evidence frontier.",
        });
      }
      await hydrateCachedCoordinate(
        options.kind,
        options.actorPubkey,
        scope.resolved.repo.dTag,
      );

      let actorEvent = store.getReplaceable(
        options.kind,
        options.actorPubkey,
        scope.resolved.repo.dTag,
      );
      let winner = repositoryWinner(
        options.kind,
        options.actorPubkey,
        scope.resolved.repo.dTag,
        scope.resolved.repo.confirmedMaintainers,
      );
      let focusedOutboxRelays: string[] = [];
      const needsFocusedActorAbsence =
        !actorEvent &&
        !scope.resolved.repo.isPrivate &&
        !(options.kind === REPO_STATE_KIND && winner);
      if (needsFocusedActorAbsence) {
        focusedOutboxRelays = mailboxOutboxes(options.actorPubkey);
        await confirmFocusedAbsence(
          [
            {
              kinds: [options.kind],
              authors: [options.actorPubkey],
              "#d": [scope.resolved.repo.dTag],
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
          scope.resolved.repo.dTag,
        );
        winner = repositoryWinner(
          options.kind,
          options.actorPubkey,
          scope.resolved.repo.dTag,
          scope.resolved.repo.confirmedMaintainers,
        );
        deadline = Date.now() + REPOSITORY_COVERAGE_SETTLEMENT_TIMEOUT_MS;
      }

      for (;;) {
        scope = await waitForRepositoryCoverage(deadline);
        actorEvent = store.getReplaceable(
          options.kind,
          options.actorPubkey,
          scope.resolved.repo.dTag,
        );
        winner = repositoryWinner(
          options.kind,
          options.actorPubkey,
          scope.resolved.repo.dTag,
          scope.resolved.repo.confirmedMaintainers,
        );
        if (!winner) break;
        const candidateId = winner.id;
        scope = await waitForRepositoryCoverage(deadline, candidateId);
        const checkedWinner = repositoryWinner(
          options.kind,
          options.actorPubkey,
          scope.resolved.repo.dTag,
          scope.resolved.repo.confirmedMaintainers,
        );
        if (checkedWinner?.id === candidateId) {
          winner = checkedWinner;
          break;
        }
      }

      if ((winner?.id ?? null) !== options.expectedEventId) {
        throw new Error(
          "The repository announcement or state changed after this operation began. Review the latest value and try again.",
        );
      }

      const releaseWriteWindow = options.holdWriteWindow
        ? scope.resolved.replaceableWriteWindow.hold()
        : undefined;
      try {
        return await action({
          actorEvent,
          winner,
          repositoryRelays: scope.repositoryRelays,
          focusedOutboxRelays,
        });
      } finally {
        releaseWriteWindow?.();
      }
    },
    [store, toast, waitForRepositoryCoverage],
  );

  return { execute };
}
