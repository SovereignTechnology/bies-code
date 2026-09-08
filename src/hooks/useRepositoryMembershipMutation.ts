import { useCallback, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import { firstValueFrom, type Subscription } from "rxjs";
import { endWith, ignoreElements, timeout } from "rxjs/operators";
import type { EventTemplate, NostrEvent } from "nostr-tools";

import type { RepositoryState } from "@/casts/RepositoryState";
import { useMaintainerAcceptanceJob } from "@/hooks/useMaintainerAcceptanceJob";
import { graspServiceAddressToRelayUrl, type GraspServer } from "@/lib/grasp";
import {
  getRepoCloneUrls,
  getRepoHistorySubjects,
  getRepoRoleSubjects,
  REPO_KIND,
  REPO_STATE_KIND,
  repoCoordinate,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import { getOrCreatePool } from "@/lib/git-grasp-pool";
import {
  prepareRepositoryMembershipMutation,
  REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED,
  RepositoryMembershipMutationRefusal,
  normalizeRepositoryMembershipMutationFailure,
  signRepositoryMembershipMutation,
  verifyRepositoryMembershipMutationResult,
  type RepositoryMembershipMutationIntent,
  type RepositoryMembershipMutationRefusalCode,
} from "@/lib/repositoryMembershipMutation";
import { resilientRequest } from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import {
  getMaintainerAcceptanceJob,
  isMaintainerAcceptanceJobExpired,
  maintainerAcceptanceKey,
  publishAcceptanceToRelay,
  recordMaintainerAcceptanceBroadcast,
  recordMaintainerAcceptanceDeliveries,
  runMaintainerAcceptanceDelivery,
  saveMaintainerAcceptanceJob,
  updateMaintainerAcceptanceJob,
  type RelayDelivery,
} from "@/services/maintainerAcceptance";
import {
  addressLoader,
  eventStore,
  pool as relayPool,
  publish,
} from "@/services/nostr";
import { fallbackRelays, gitIndexRelays } from "@/services/settings";
import { getOutboxes } from "applesauce-core/helpers";
import type { ResolvedRepository } from "@/hooks/useResolvedRepository";
import { useRepositoryReplaceablePreflight } from "@/hooks/useRepositoryReplaceablePreflight";

export interface RepositoryMembershipMutationFailure {
  code: RepositoryMembershipMutationRefusalCode;
  message: string;
}

export interface RepositoryMembershipMutationOptions {
  /** Announcement revision the settings form was opened against. */
  expectedAnnouncementId?: string;
  /** Non-membership fields to publish in the same roster replacement. */
  announcementFields?: Pick<EventTemplate, "content" | "tags">;
}

interface UseRepositoryMembershipMutationOptions {
  resolved: ResolvedRepository;
  repo: ResolvedRepo;
  relayUrls: string[];
  repoState?: RepositoryState | null;
}

interface MutationSnapshot {
  repo: ResolvedRepo;
  announcements: NostrEvent[];
  stateEvents: NostrEvent[];
  deletionEvents: NostrEvent[];
  mailboxEvents: NostrEvent[];
  relayUrls: string[];
  indexRelayUrls: string[];
}

interface CompleteRelayRead {
  events: NostrEvent[];
  eoseRelays: string[];
}

const SNAPSHOT_TIMEOUT_MS = 20_000;
const GIT_OBJECT_TIMEOUT_MS = 15_000;
const PUBLICATION_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_AUTHORS = 64;
const MAX_SNAPSHOT_RELAYS = 64;

function latestEventsByAuthor(events: NostrEvent[]): NostrEvent[] {
  return [
    ...events
      .reduce((latest, event) => {
        const existing = latest.get(event.pubkey);
        if (
          !existing ||
          event.created_at > existing.created_at ||
          (event.created_at === existing.created_at && event.id < existing.id)
        ) {
          latest.set(event.pubkey, event);
        }
        return latest;
      }, new Map<string, NostrEvent>())
      .values(),
  ];
}

function isDeletedBy(event: NostrEvent, deletions: NostrEvent[]): boolean {
  const coordinate = `${event.kind}:${event.pubkey}:${
    event.tags.find(([name]) => name === "d")?.[1] ?? ""
  }`;
  return deletions.some(
    (deletion) =>
      deletion.kind === 5 &&
      deletion.pubkey === event.pubkey &&
      deletion.created_at >= event.created_at &&
      deletion.tags.some(
        ([name, value]) =>
          (name === "e" && value === event.id) ||
          (name === "a" && value === coordinate),
      ),
  );
}

function withoutDeleted(
  events: NostrEvent[],
  deletions: NostrEvent[],
): NostrEvent[] {
  return events.filter((event) => !isDeletedBy(event, deletions));
}

function requiredRelayRead(
  relays: string[],
  filters: Filter[],
  deadline: number,
  label: string,
  requiredEoseCount = relays.length,
): Promise<CompleteRelayRead> {
  return new Promise((resolve, reject) => {
    const eose = new Set<string>();
    const events = new Map<string, NostrEvent>();
    const resources: {
      subscription?: Subscription;
      timerId?: ReturnType<typeof setTimeout>;
    } = {};
    let finished = false;
    const remaining = deadline - Date.now();

    const finish = (
      result: CompleteRelayRead | undefined,
      error?: RepositoryMembershipMutationRefusal,
    ) => {
      if (finished) return;
      finished = true;
      if (resources.timerId) clearTimeout(resources.timerId);
      resources.subscription?.unsubscribe();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const fail = (message: string) =>
      finish(
        undefined,
        new RepositoryMembershipMutationRefusal(
          "incomplete_relay_view",
          `${message} Check the affected relay connections and try again. No repository update was published.`,
        ),
      );
    resources.timerId = setTimeout(
      () =>
        fail(`${label} did not reach its relay threshold before the deadline.`),
      Math.max(0, remaining),
    );

    if (remaining <= 0) {
      fail(`${label} exhausted its bounded deadline.`);
      return;
    }

    resources.subscription = resilientRequest(relayPool, relays, filters, {
      settle: false,
      retryCount: 0,
      onRelayEose: (relay) => {
        eose.add(normalizeUrl(relay));
        if (eose.size >= requiredEoseCount) {
          finish({ events: [...events.values()], eoseRelays: [...eose] });
        }
      },
    }).subscribe({
      next: (response) => {
        if (response !== "EOSE") events.set(response.id, response);
      },
      error: (error) => {
        fail(
          `${label} failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      },
      complete: () => {
        if (eose.size < requiredEoseCount) {
          fail(
            `${label} completed with ${eose.size} of ${requiredEoseCount} required relay responses.`,
          );
        }
      },
    });
  });
}

function winningCurrentState(
  repo: ResolvedRepo,
  stateEvents: NostrEvent[],
): NostrEvent | undefined {
  return stateEvents
    .filter(({ pubkey }) => repo.confirmedMaintainers.includes(pubkey))
    .reduce<NostrEvent | undefined>((winner, event) => {
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

function mutationAuthors(
  repo: ResolvedRepo,
  actorPubkey: string,
  intent: RepositoryMembershipMutationIntent,
): string[] {
  const targets =
    intent.type === "update-roster"
      ? [...intent.addPubkeys, ...intent.removePubkeys]
      : intent.type === "add" || intent.type === "remove"
        ? [intent.targetPubkey]
        : [actorPubkey];
  return [
    ...new Set([
      ...repo.discoveryPubkeys,
      ...repo.historyPubkeys,
      ...repo.confirmedMaintainers,
      actorPubkey,
      ...targets,
    ]),
  ];
}

async function discoverMutationMailboxes(
  authors: string[],
  deadline: number,
): Promise<NostrEvent[]> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      "Mailbox lookup exhausted its bounded deadline. Check the affected users' relay connections and try again. No repository update was published.",
    );
  }

  try {
    await Promise.all(
      authors.map((author) =>
        firstValueFrom(
          addressLoader({
            kind: 10002,
            pubkey: author,
            cache: false,
          }).pipe(
            ignoreElements(),
            endWith(null),
            timeout({ first: remaining }),
          ),
        ),
      ),
    );
  } catch (error) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      `The affected mailbox relay lists did not settle (${error instanceof Error ? error.message : String(error)}). Check the affected users' relay connections and try again. No repository update was published.`,
    );
  }

  return latestEventsByAuthor(
    eventStore.getByFilters([{ kinds: [10002], authors }]),
  );
}

async function settleMutationSnapshot(
  repo: ResolvedRepo,
  actorPubkey: string,
  intent: RepositoryMembershipMutationIntent,
  relayUrls: string[],
  preflight: {
    absentAuthors: string[];
    focusedOutboxRelays: string[];
    repositoryRelays: string[];
  },
): Promise<MutationSnapshot> {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  const authors = new Set(mutationAuthors(repo, actorPubkey, intent));
  const indexRelayUrls = repo.isPrivate
    ? []
    : gitIndexRelays.getValue().map(normalizeUrl);
  const baseRelays = new Set(
    (repo.isPrivate
      ? preflight.repositoryRelays
      : [
          ...relayUrls,
          ...repo.relays,
          ...preflight.focusedOutboxRelays,
          ...indexRelayUrls,
          ...fallbackRelays.getValue(),
        ]
    ).map(normalizeUrl),
  );
  if (baseRelays.size === 0) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      "No repository, mailbox, Git index, or fallback relay is available. Configure an applicable relay before retrying. No repository update was published.",
    );
  }
  // The shared repository gate already settled a focused outbox query when it
  // proved the actor's coordinate absent. Carry that evidence and frontier
  // into the authority snapshot instead of opening the same REQ again.
  const checkedAbsentAuthors = new Set(preflight.absentAuthors);

  while (true) {
    if (authors.size > MAX_SNAPSHOT_AUTHORS) {
      throw new RepositoryMembershipMutationRefusal(
        "incomplete_relay_view",
        `The affected membership graph exceeds the browser safety limit of ${MAX_SNAPSHOT_AUTHORS} authors. No repository update was published.`,
      );
    }
    if (baseRelays.size > MAX_SNAPSHOT_RELAYS) {
      throw new RepositoryMembershipMutationRefusal(
        "incomplete_relay_view",
        `The delivery set exceeds the browser safety limit of ${MAX_SNAPSHOT_RELAYS} relays. Reduce the announced relay set before retrying. No repository update was published.`,
      );
    }

    const authorList = [...authors].sort();
    const currentAnnouncements = eventStore.getByFilters([
      {
        kinds: [REPO_KIND],
        authors: authorList,
        "#d": [repo.dTag],
      } as Filter,
    ]);
    const authorsWithAnnouncements = new Set(
      currentAnnouncements.map(({ pubkey }) => pubkey),
    );
    const absentAuthors = authorList.filter(
      (author) =>
        !authorsWithAnnouncements.has(author) &&
        !checkedAbsentAuthors.has(author),
    );

    // An existing announcement is already covered by the page owner. Public
    // absent authors introduce an outbox scope; private absent authors are
    // checked only on the already-admitted private repository frontier.
    if (absentAuthors.length > 0) {
      if (repo.isPrivate) {
        const focused = await requiredRelayRead(
          preflight.repositoryRelays,
          [
            {
              kinds: [REPO_KIND, REPO_STATE_KIND],
              authors: absentAuthors,
              "#d": [repo.dTag],
            } as Filter,
            {
              kinds: [5],
              authors: absentAuthors,
              "#a": absentAuthors.flatMap((author) => [
                `${REPO_KIND}:${author}:${repo.dTag}`,
                `${REPO_STATE_KIND}:${author}:${repo.dTag}`,
              ]),
            } as Filter,
          ],
          deadline,
          "Private repository coordinate lookup",
          1,
        );
        focused.events.forEach((event) => eventStore.add(event));
        absentAuthors.forEach((author) => checkedAbsentAuthors.add(author));
        continue;
      }
      const mailboxEvents = await discoverMutationMailboxes(
        absentAuthors,
        deadline,
      );
      const mailboxByAuthor = new Map(
        mailboxEvents.map((event) => [event.pubkey, event]),
      );
      for (const author of absentAuthors) {
        const mailbox = mailboxByAuthor.get(author);
        const outboxes = mailbox
          ? [...new Set(getOutboxes(mailbox).map(normalizeUrl))]
          : [];
        if (outboxes.length === 0) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            `No NIP-65 outbox relay is available to confirm the absent repository announcement for ${author}. Ask that user to publish a mailbox relay list, then retry. No repository update was published.`,
          );
        }
        const focused = await requiredRelayRead(
          outboxes,
          [
            {
              kinds: [REPO_KIND, REPO_STATE_KIND],
              authors: [author],
              "#d": [repo.dTag],
            } as Filter,
            {
              kinds: [5],
              authors: [author],
              "#a": [
                `${REPO_KIND}:${author}:${repo.dTag}`,
                `${REPO_STATE_KIND}:${author}:${repo.dTag}`,
              ],
            } as Filter,
          ],
          deadline,
          `Repository coordinate lookup for ${author}`,
          1,
        );
        focused.events.forEach((event) => eventStore.add(event));
        for (const relay of outboxes) baseRelays.add(relay);
        checkedAbsentAuthors.add(author);
      }
      continue;
    }

    const rawCandidates = eventStore.getByFilters([
      {
        kinds: [REPO_KIND, REPO_STATE_KIND],
        authors: authorList,
        "#d": [repo.dTag],
      } as Filter,
    ]);
    const knownEventIds = rawCandidates.map(({ id }) => id);
    const addressCoordinates = authorList.flatMap((author) => [
      `${REPO_KIND}:${author}:${repo.dTag}`,
      `${REPO_STATE_KIND}:${author}:${repo.dTag}`,
      `10002:${author}:`,
    ]);
    const deletionEvents = eventStore.getByFilters([
      {
        kinds: [5],
        authors: authorList,
        "#a": addressCoordinates,
      } as Filter,
      ...(knownEventIds.length > 0
        ? [
            {
              kinds: [5],
              authors: authorList,
              "#e": knownEventIds,
            } as Filter,
          ]
        : []),
    ]);
    const announcements = withoutDeleted(
      rawCandidates.filter(({ kind }) => kind === REPO_KIND),
      deletionEvents,
    );
    const stateEvents = withoutDeleted(
      rawCandidates.filter(({ kind }) => kind === REPO_STATE_KIND),
      deletionEvents,
    );
    const refreshedMailboxEvents = latestEventsByAuthor(
      eventStore.getByFilters([
        { kinds: [10002], authors: authorList } as Filter,
      ]),
    );

    const nextAuthors = new Set(authors);
    for (const announcement of announcements) {
      for (const subject of [
        ...getRepoRoleSubjects(announcement),
        ...getRepoHistorySubjects(announcement),
      ]) {
        nextAuthors.add(subject);
      }
    }
    if (nextAuthors.size !== authors.size) {
      for (const author of nextAuthors) authors.add(author);
      continue;
    }

    const retainedDeletedAnnouncements = [
      ...new Map(
        [...repo.discoveredAnnouncements, ...repo.historicalAnnouncements]
          .filter((event) => isDeletedBy(event, deletionEvents))
          .map((event) => [event.id, event]),
      ).values(),
    ];
    const refreshedRepo = resolveChain(
      [...announcements, ...retainedDeletedAnnouncements, ...deletionEvents],
      repo.selectedMaintainer,
      repo.dTag,
    );
    if (!refreshedRepo) {
      throw new RepositoryMembershipMutationRefusal(
        "concurrent_change",
        `The selected component ${repo.selectedCoordinate} changed and no longer resolves. Reload repository settings and review the latest membership before retrying. No repository update was published.`,
      );
    }
    const finalRelays = new Set(baseRelays);
    if (!repo.isPrivate) {
      for (const relay of [
        ...refreshedRepo.relays,
        ...refreshedMailboxEvents.flatMap((event) =>
          event.tags.flatMap(([name, url]) =>
            name === "r" && /^wss?:\/\//.test(url ?? "")
              ? [normalizeUrl(url)]
              : [],
          ),
        ),
      ]) {
        finalRelays.add(normalizeUrl(relay));
      }
    }
    return {
      repo: refreshedRepo,
      announcements,
      stateEvents,
      deletionEvents,
      mailboxEvents: refreshedMailboxEvents,
      relayUrls: [...finalRelays].sort(),
      indexRelayUrls: [...new Set(indexRelayUrls)].sort(),
    };
  }
}

async function ensureStateObjectsAvailable(
  cloneUrls: string[],
  repoState: RepositoryState | null | undefined,
): Promise<void> {
  if (!repoState || repoState.refs.length === 0) return;
  if (cloneUrls.length === 0) {
    throw new RepositoryMembershipMutationRefusal(
      "unavailable_git_object",
      `Repository state ${repoState.event.id} has refs but no announced clone URL can supply them. Add or repair a clone URL before retrying. No repository update was published.`,
    );
  }
  const gitPool = getOrCreatePool({ cloneUrls });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), GIT_OBJECT_TIMEOUT_MS);
  try {
    for (const commitId of new Set(
      repoState.refs.map(({ commitId }) => commitId),
    )) {
      const commit = await gitPool.probeCommitOnNetwork(
        commitId,
        controller.signal,
      );
      if (!commit) {
        throw new Error(`commit ${commitId} is unavailable`);
      }
    }
  } catch (error) {
    throw new RepositoryMembershipMutationRefusal(
      "unavailable_git_object",
      `Repository state objects could not be fetched (${error instanceof Error ? error.message : String(error)}). Ensure an announced Git server has every signed state commit, then retry. No repository update was published.`,
    );
  } finally {
    clearTimeout(deadline);
  }
}

function publicationPending(
  message: string,
): RepositoryMembershipMutationRefusal {
  return new RepositoryMembershipMutationRefusal(
    "publication_pending",
    `${message} The signed replacement remains queued for delivery. Do not retry this membership change; wait for delivery or use the recovery workflow.`,
  );
}

function publishReplacementWithinDeadline(
  event: NostrEvent,
  relayUrl: string,
  deadline: number,
): Promise<RelayDelivery> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (delivery: RelayDelivery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(delivery);
    };
    const timer = setTimeout(
      () =>
        finish({
          relayUrl,
          ok: false,
          message: "Relay acknowledgement deadline expired.",
        }),
      Math.max(0, deadline - Date.now()),
    );
    void publishAcceptanceToRelay(event, relayUrl).then(finish, (error) =>
      finish({
        relayUrl,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

async function refetchAcknowledgedReplacement(
  event: NostrEvent,
  acknowledgedRelayUrls: string[],
  deadline: number,
): Promise<{ event: NostrEvent; relayUrl: string }> {
  for (const relayUrl of acknowledgedRelayUrls) {
    if (Date.now() >= deadline) break;
    try {
      const read = await requiredRelayRead(
        [relayUrl],
        [{ ids: [event.id], authors: [event.pubkey], kinds: [REPO_KIND] }],
        Math.min(deadline, Date.now() + 5_000),
        "Published replacement verification",
      );
      const refetched = read.events.find(({ id }) => id === event.id);
      if (refetched) return { event: refetched, relayUrl };
    } catch {
      // A second acknowledged relay may still be able to return the event.
    }
  }
  throw publicationPending(
    "No acknowledged repository or index relay returned the exact replacement before the verification deadline.",
  );
}

function graspServersForRepo(repo: ResolvedRepo): GraspServer[] {
  return repo.graspServerAddresses.map((serviceAddress) => ({
    serviceAddress,
    wsUrl: graspServiceAddressToRelayUrl(serviceAddress),
  }));
}

export function useRepositoryMembershipMutation({
  resolved,
  repo,
  relayUrls,
  repoState,
}: UseRepositoryMembershipMutationOptions) {
  const account = useActiveAccount();
  const replaceablePreflight = useRepositoryReplaceablePreflight(resolved);
  const persistedDelivery = useMaintainerAcceptanceJob(
    account?.pubkey ?? "",
    repo.selectedMaintainer,
    repo.dTag,
  );
  const [pendingIntent, setPendingIntent] =
    useState<RepositoryMembershipMutationIntent>();
  const [failure, setFailure] = useState<RepositoryMembershipMutationFailure>();

  const mutate = useCallback(
    async (
      intent: RepositoryMembershipMutationIntent,
      options?: RepositoryMembershipMutationOptions,
    ): Promise<NostrEvent> => {
      if (!REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED) {
        const refusal = new RepositoryMembershipMutationRefusal(
          "membership_mutations_disabled",
          "Repository membership changes are temporarily disabled while their safety checks are upgraded.",
        );
        setFailure({ code: refusal.code, message: refusal.message });
        throw refusal;
      }
      if (!account) {
        throw new RepositoryMembershipMutationRefusal(
          "membership_side_effect",
          "Sign in before changing repository membership.",
        );
      }
      setPendingIntent(intent);
      setFailure(undefined);
      try {
        const operationKey = maintainerAcceptanceKey(
          account.pubkey,
          repo.selectedMaintainer,
          repo.dTag,
        );
        const existingDelivery = getMaintainerAcceptanceJob(operationKey);
        if (
          existingDelivery &&
          !existingDelivery.completedAt &&
          !isMaintainerAcceptanceJobExpired(existingDelivery)
        ) {
          throw publicationPending(
            `A signed membership replacement for ${repo.selectedCoordinate} is already pending or quarantined.`,
          );
        }
        const actorAnnouncement = eventStore.getReplaceable(
          REPO_KIND,
          account.pubkey,
          repo.dTag,
        );
        const repositoryPreflight = await replaceablePreflight.execute(
          {
            kind: REPO_KIND,
            actorPubkey: account.pubkey,
            expectedEventId:
              options?.expectedAnnouncementId ?? actorAnnouncement?.id ?? null,
          },
          async (snapshot) => snapshot,
        );

        const snapshot = await settleMutationSnapshot(
          repo,
          account.pubkey,
          intent,
          relayUrls,
          {
            absentAuthors: repositoryPreflight.actorEvent
              ? []
              : [account.pubkey],
            focusedOutboxRelays: repositoryPreflight.focusedOutboxRelays,
            repositoryRelays: repositoryPreflight.repositoryRelays,
          },
        );
        if (
          winningCurrentState(snapshot.repo, snapshot.stateEvents)?.id !==
          repoState?.event.id
        ) {
          throw new RepositoryMembershipMutationRefusal(
            "concurrent_change",
            "The authoritative repository state changed after the page settled. Reload repository settings and review the current state before retrying. No repository update was published.",
          );
        }
        const proposal = prepareRepositoryMembershipMutation({
          repo: snapshot.repo,
          actorPubkey: account.pubkey,
          intent,
          announcements: snapshot.announcements,
          stateEvents: snapshot.stateEvents,
          announcementFields: options?.announcementFields,
          graspServers: graspServersForRepo(snapshot.repo),
          createdAt: Math.floor(Date.now() / 1000),
        });
        await ensureStateObjectsAvailable(
          proposal.expectedCloneUrls,
          repoState,
        );

        // Extension point: a future compare-and-rebase protocol would re-read
        // the warm winner here. This phase deliberately freezes one coherent
        // snapshot rather than issuing a second full relay request.
        const confirmationRelayUrls = snapshot.repo.isPrivate
          ? snapshot.relayUrls
          : [
              ...new Set(
                [
                  ...snapshot.repo.relays,
                  ...proposal.expectedRelayUrls,
                  ...snapshot.indexRelayUrls,
                ]
                  .map(normalizeUrl)
                  .filter((relayUrl) => snapshot.relayUrls.includes(relayUrl)),
              ),
            ];
        if (confirmationRelayUrls.length === 0) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            "No repository or configured Git index relay is available to acknowledge the replacement. Configure an acknowledgement relay before retrying. No repository update was published.",
          );
        }
        const deliveryRelayUrls = snapshot.repo.isPrivate
          ? snapshot.relayUrls
          : [
              ...new Set(
                [
                  ...snapshot.relayUrls,
                  ...proposal.expectedRelayUrls,
                  ...snapshot.indexRelayUrls,
                ].map(normalizeUrl),
              ),
            ];
        const signedEvent = await signRepositoryMembershipMutation(
          account.signer,
          proposal.template,
        );
        const now = Date.now();
        saveMaintainerAcceptanceJob({
          key: operationKey,
          accountPubkey: account.pubkey,
          invitationAnchor: snapshot.repo.selectedMaintainer,
          dTag: snapshot.repo.dTag,
          announcement: signedEvent,
          cloneUrls:
            intent.type === "accept" ? getRepoCloneUrls(signedEvent) : [],
          relayUrls: deliveryRelayUrls,
          confirmationRelayUrls,
          deliveredRelayUrls: [],
          syncedCloneUrls: [],
          relayErrors: {},
          deliveryAttempt: 0,
          broadcastReceived: false,
          phase: "publishing",
          stateRefs: intent.type === "accept" ? (repoState?.refs ?? []) : [],
          knownHeadCommit:
            intent.type === "accept" ? repoState?.headCommitId : undefined,
          stateCreatedAt:
            intent.type === "accept" ? repoState?.event.created_at : undefined,
          createdAt: now,
          updatedAt: now,
        });

        if (!snapshot.repo.isPrivate) {
          try {
            await publish(
              signedEvent,
              [repoCoordinate(account.pubkey, snapshot.repo.dTag)],
              { optimistic: false },
            );
          } catch (error) {
            updateMaintainerAcceptanceJob(operationKey, {
              relayErrors: {
                outbox: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }

        const publicationDeadline = Date.now() + PUBLICATION_TIMEOUT_MS;
        const initialDeliveries = await Promise.all(
          confirmationRelayUrls.map((relayUrl) =>
            publishReplacementWithinDeadline(
              signedEvent,
              relayUrl,
              publicationDeadline,
            ),
          ),
        );
        recordMaintainerAcceptanceDeliveries(
          operationKey,
          signedEvent.id,
          initialDeliveries,
        );
        void runMaintainerAcceptanceDelivery(operationKey);

        const acknowledgedRelayUrls = initialDeliveries
          .filter(({ ok }) => ok)
          .map(({ relayUrl }) => relayUrl);
        if (acknowledgedRelayUrls.length === 0) {
          throw publicationPending(
            "No designated repository or index relay acknowledged the signed replacement before the publication deadline.",
          );
        }
        const refetched = await refetchAcknowledgedReplacement(
          signedEvent,
          acknowledgedRelayUrls,
          publicationDeadline,
        );
        const refetchedEvent = refetched.event;
        eventStore.add(refetchedEvent);
        recordMaintainerAcceptanceBroadcast(operationKey, refetchedEvent);

        const verifiedRepo = resolveChain(
          [
            ...snapshot.repo.historicalAnnouncements,
            ...snapshot.announcements.filter(
              ({ pubkey }) => pubkey !== account.pubkey,
            ),
            ...snapshot.deletionEvents,
            refetchedEvent,
          ],
          snapshot.repo.selectedMaintainer,
          snapshot.repo.dTag,
        );
        if (!verifyRepositoryMembershipMutationResult(proposal, verifiedRepo)) {
          const currentDelivery = getMaintainerAcceptanceJob(operationKey);
          updateMaintainerAcceptanceJob(operationKey, {
            phase: "quarantined",
            relayErrors: {
              ...currentDelivery?.relayErrors,
              verification:
                "The relay-confirmed replacement did not resolve to its preflighted membership effect.",
            },
            nextDeliveryRetryAt: undefined,
          });
          throw new RepositoryMembershipMutationRefusal(
            "publication_verification_failed",
            "The relay-confirmed replacement did not resolve to the preflighted membership effect. Do not retry this membership change; use the recovery workflow.",
          );
        }
        updateMaintainerAcceptanceJob(operationKey, {
          initialVerificationAt: Date.now(),
          initialVerificationRelayUrl: refetched.relayUrl,
        });
        return refetchedEvent;
      } catch (error) {
        const refusal = normalizeRepositoryMembershipMutationFailure(error);
        setFailure({ code: refusal.code, message: refusal.message });
        throw refusal;
      } finally {
        setPendingIntent(undefined);
      }
    },
    [account, relayUrls, repo, repoState, replaceablePreflight],
  );

  const deliveryBlocked =
    !!persistedDelivery &&
    !persistedDelivery.completedAt &&
    !isMaintainerAcceptanceJobExpired(persistedDelivery);
  const persistedFailure: RepositoryMembershipMutationFailure | undefined =
    deliveryBlocked &&
    !persistedDelivery?.initialVerificationAt &&
    !pendingIntent
      ? persistedDelivery.relayErrors.verification
        ? {
            code: "publication_verification_failed",
            message:
              "A relay-confirmed membership replacement did not resolve to its preflighted effect. Do not retry this membership change; use the recovery workflow.",
          }
        : {
            code: "publication_pending",
            message:
              "A signed membership replacement is queued, pending, or quarantined. Do not retry it; wait for delivery or use the recovery workflow.",
          }
      : undefined;

  return {
    enabled:
      REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED &&
      (!deliveryBlocked || !!pendingIntent),
    deliveryBlocked,
    mutate,
    pendingIntent,
    failure: failure ?? persistedFailure,
    clearFailure: () => setFailure(undefined),
  };
}
