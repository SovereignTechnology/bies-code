import { useCallback, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import { firstValueFrom, type Subscription } from "rxjs";
import { endWith, ignoreElements, timeout } from "rxjs/operators";
import type { NostrEvent } from "nostr-tools";

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
  repositoryMembershipSnapshotIds,
  RepositoryMembershipMutationRefusal,
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

export interface RepositoryMembershipMutationFailure {
  code: RepositoryMembershipMutationRefusalCode;
  message: string;
}

interface UseRepositoryMembershipMutationOptions {
  repo: ResolvedRepo;
  announcementsSettled: boolean;
  stateSettled: boolean;
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

function mapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
}

function arraysEqualAsSets(left: string[], right: string[]): boolean {
  return setEqual(left, right);
}

function setEqual(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

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
): Promise<CompleteRelayRead> {
  return new Promise((resolve, reject) => {
    const required = new Set(relays.map(normalizeUrl));
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
          `${message} GitWorkshop does not yet support making this transition.`,
        ),
      );
    resources.timerId = setTimeout(
      () =>
        fail(
          `${label} did not receive EOSE from ${
            [...required].filter((relay) => !eose.has(relay)).join(", ") ||
            "every required relay"
          } before the bounded deadline.`,
        ),
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
        if (eose.size === required.size) {
          finish({ events: [...events.values()], eoseRelays: [...eose] });
        }
      },
      onRelayError: (relay) => {
        fail(`${label} failed on required relay ${normalizeUrl(relay)}.`);
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
        if (eose.size !== required.size) {
          fail(
            `${label} completed without EOSE from ${[...required]
              .filter((relay) => !eose.has(relay))
              .join(", ")}.`,
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
  const target =
    intent.type === "add" || intent.type === "remove"
      ? intent.targetPubkey
      : actorPubkey;
  return [
    ...new Set([
      ...repo.discoveryPubkeys,
      ...repo.historyPubkeys,
      ...repo.confirmedMaintainers,
      actorPubkey,
      target,
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
      "Mailbox lookup exhausted its bounded deadline. GitWorkshop does not yet support making this transition.",
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
      `The affected mailbox relay lists did not settle (${error instanceof Error ? error.message : String(error)}). GitWorkshop does not yet support making this transition.`,
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
  knownTargetIds: string[] = [],
): Promise<MutationSnapshot> {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  const authors = new Set(mutationAuthors(repo, actorPubkey, intent));
  const indexRelayUrls = gitIndexRelays.getValue().map(normalizeUrl);
  const baseRelays = new Set(
    [
      ...relayUrls,
      ...repo.relays,
      ...indexRelayUrls,
      ...fallbackRelays.getValue(),
    ].map(normalizeUrl),
  );
  if (baseRelays.size === 0) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      "No repository, mailbox, Git index, or fallback relay is available. GitWorkshop does not yet support making this transition.",
    );
  }
  const safetyRelays = new Set(baseRelays);
  const mailboxAuthors = new Set<string>();

  while (true) {
    if (authors.size > MAX_SNAPSHOT_AUTHORS) {
      throw new RepositoryMembershipMutationRefusal(
        "incomplete_relay_view",
        `The affected closure exceeds ${MAX_SNAPSHOT_AUTHORS} authors. GitWorkshop does not yet support making this transition.`,
      );
    }
    if (safetyRelays.size > MAX_SNAPSHOT_RELAYS) {
      throw new RepositoryMembershipMutationRefusal(
        "incomplete_relay_view",
        `The safety set exceeds ${MAX_SNAPSHOT_RELAYS} relays. GitWorkshop does not yet support making this transition.`,
      );
    }

    const authorList = [...authors].sort();
    const undiscoveredMailboxAuthors = authorList.filter(
      (author) => !mailboxAuthors.has(author),
    );
    if (undiscoveredMailboxAuthors.length > 0) {
      const mailboxEvents = await discoverMutationMailboxes(
        undiscoveredMailboxAuthors,
        deadline,
      );
      for (const event of mailboxEvents) {
        for (const [name, url] of event.tags) {
          if (name === "r" && /^wss?:\/\//.test(url ?? "")) {
            safetyRelays.add(normalizeUrl(url));
          }
        }
      }
      for (const author of undiscoveredMailboxAuthors) {
        mailboxAuthors.add(author);
      }
      continue;
    }

    const relayList = [...safetyRelays].sort();
    const mailboxRead = await requiredRelayRead(
      relayList,
      [{ kinds: [10002], authors: authorList } as Filter],
      deadline,
      "Mailbox discovery",
    );
    const mailboxEvents = latestEventsByAuthor(
      mailboxRead.events.filter(({ kind }) => kind === 10002),
    );
    const discoveredMailboxRelays = mailboxEvents.flatMap((event) =>
      event.tags.flatMap(([name, url]) =>
        name === "r" && /^wss?:\/\//.test(url ?? "") ? [normalizeUrl(url)] : [],
      ),
    );
    const relayCount = safetyRelays.size;
    for (const relay of discoveredMailboxRelays) safetyRelays.add(relay);
    if (safetyRelays.size !== relayCount) continue;

    const addressCoordinates = authorList.flatMap((author) => [
      `${REPO_KIND}:${author}:${repo.dTag}`,
      `${REPO_STATE_KIND}:${author}:${repo.dTag}`,
      `10002:${author}:`,
    ]);
    const candidateRead = await requiredRelayRead(
      relayList,
      [
        { kinds: [10002], authors: authorList } as Filter,
        {
          kinds: [REPO_KIND],
          authors: authorList,
          "#d": [repo.dTag],
        } as Filter,
        {
          kinds: [REPO_STATE_KIND],
          authors: authorList,
          "#d": [repo.dTag],
        } as Filter,
        {
          kinds: [5],
          authors: authorList,
          "#a": addressCoordinates,
        } as Filter,
      ],
      deadline,
      "Announcement, state, and mailbox snapshot",
    );
    const rawCandidates = candidateRead.events;
    const knownEventIds = [
      ...new Set([
        ...rawCandidates.map(({ id }) => id),
        ...repo.discoveredAnnouncements.map(({ id }) => id),
        ...repo.historicalAnnouncements.map(({ id }) => id),
        ...knownTargetIds,
      ]),
    ];
    const exactDeletionRead =
      knownEventIds.length > 0
        ? await requiredRelayRead(
            relayList,
            [
              {
                kinds: [5],
                authors: authorList,
                "#e": knownEventIds,
              } as Filter,
            ],
            deadline,
            "Exact deletion snapshot",
          )
        : { events: [], eoseRelays: relayList };
    const deletionEvents = [
      ...new Map(
        [...rawCandidates, ...exactDeletionRead.events]
          .filter(({ kind }) => kind === 5)
          .map((event) => [event.id, event]),
      ).values(),
    ];
    const announcements = withoutDeleted(
      rawCandidates.filter(({ kind }) => kind === REPO_KIND),
      deletionEvents,
    );
    const stateEvents = withoutDeleted(
      rawCandidates.filter(({ kind }) => kind === REPO_STATE_KIND),
      deletionEvents,
    );
    const refreshedMailboxEvents = latestEventsByAuthor(
      withoutDeleted(
        rawCandidates.filter(({ kind }) => kind === 10002),
        deletionEvents,
      ),
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
        `The selected component ${repo.selectedCoordinate} no longer resolves. GitWorkshop does not yet support making this transition.`,
      );
    }
    const finalRelays = new Set(baseRelays);
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
    const missingFinalRelays = [...finalRelays].filter(
      (relay) => !safetyRelays.has(relay),
    );
    if (missingFinalRelays.length > 0) {
      for (const relay of missingFinalRelays) safetyRelays.add(relay);
      continue;
    }

    for (const event of [...rawCandidates, ...exactDeletionRead.events]) {
      eventStore.add(event);
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
      `Repository state ${repoState.event.id} has refs but no clone URL can supply them. GitWorkshop does not yet support making this transition.`,
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
      `Repository state objects could not be fetched (${error instanceof Error ? error.message : String(error)}). GitWorkshop does not yet support making this transition.`,
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
  repo,
  announcementsSettled,
  stateSettled,
  relayUrls,
  repoState,
}: UseRepositoryMembershipMutationOptions) {
  const account = useActiveAccount();
  const persistedDelivery = useMaintainerAcceptanceJob(
    account?.pubkey ?? "",
    repo.selectedMaintainer,
    repo.dTag,
  );
  const [pendingIntent, setPendingIntent] =
    useState<RepositoryMembershipMutationIntent>();
  const [failure, setFailure] = useState<RepositoryMembershipMutationFailure>();

  const mutate = useCallback(
    async (intent: RepositoryMembershipMutationIntent): Promise<NostrEvent> => {
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
          "Sign in before changing repository membership. GitWorkshop does not yet support making this transition.",
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
        if (!announcementsSettled || !stateSettled) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            "The current announcement and state snapshots have not settled. GitWorkshop does not yet support making this transition.",
          );
        }

        const first = await settleMutationSnapshot(
          repo,
          account.pubkey,
          intent,
          relayUrls,
          repoState ? [repoState.event.id] : [],
        );
        if (
          winningCurrentState(first.repo, first.stateEvents)?.id !==
          repoState?.event.id
        ) {
          throw new RepositoryMembershipMutationRefusal(
            "concurrent_change",
            "The authoritative repository state changed after the page settled. GitWorkshop does not yet support making this transition.",
          );
        }
        const firstProposal = prepareRepositoryMembershipMutation({
          repo: first.repo,
          actorPubkey: account.pubkey,
          intent,
          announcements: first.announcements,
          stateEvents: first.stateEvents,
          graspServers: graspServersForRepo(first.repo),
          createdAt: Math.floor(Date.now() / 1000),
        });
        await ensureStateObjectsAvailable(
          firstProposal.expectedCloneUrls,
          repoState,
        );

        // Re-fetch every predecessor immediately before signing. A changed
        // announcement or state aborts without asking the signer for an event.
        const second = await settleMutationSnapshot(
          first.repo,
          account.pubkey,
          intent,
          relayUrls,
          [
            ...(repoState ? [repoState.event.id] : []),
            ...first.announcements.map(({ id }) => id),
            ...first.stateEvents.map(({ id }) => id),
            ...first.deletionEvents.flatMap((event) =>
              event.tags.flatMap(([name, value]) =>
                name === "e" && value ? [value] : [],
              ),
            ),
          ],
        );
        if (
          !mapsEqual(
            repositoryMembershipSnapshotIds(first.announcements),
            repositoryMembershipSnapshotIds(second.announcements),
          ) ||
          !mapsEqual(
            repositoryMembershipSnapshotIds(first.stateEvents),
            repositoryMembershipSnapshotIds(second.stateEvents),
          ) ||
          !mapsEqual(
            repositoryMembershipSnapshotIds(first.mailboxEvents),
            repositoryMembershipSnapshotIds(second.mailboxEvents),
          ) ||
          !arraysEqualAsSets(
            first.deletionEvents.map(({ id }) => id),
            second.deletionEvents.map(({ id }) => id),
          ) ||
          !arraysEqualAsSets(first.relayUrls, second.relayUrls) ||
          !arraysEqualAsSets(first.indexRelayUrls, second.indexRelayUrls)
        ) {
          throw new RepositoryMembershipMutationRefusal(
            "concurrent_change",
            "An affected announcement or state event changed during preflight. GitWorkshop does not yet support making this transition.",
          );
        }

        const finalCreatedAt = Math.floor(Date.now() / 1000);
        const proposal = prepareRepositoryMembershipMutation({
          repo: second.repo,
          actorPubkey: account.pubkey,
          intent,
          announcements: second.announcements,
          stateEvents: second.stateEvents,
          graspServers: graspServersForRepo(second.repo),
          createdAt: finalCreatedAt,
        });
        const confirmationRelayUrls = [
          ...new Set(
            [...proposal.expectedRelayUrls, ...second.indexRelayUrls].map(
              normalizeUrl,
            ),
          ),
        ];
        if (confirmationRelayUrls.length === 0) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            "No post-change repository or configured Git index relay is available to acknowledge the replacement. GitWorkshop does not yet support making this transition.",
          );
        }
        const unsnapshottedConfirmationRelays = confirmationRelayUrls.filter(
          (relayUrl) => !second.relayUrls.includes(relayUrl),
        );
        if (unsnapshottedConfirmationRelays.length > 0) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            `The post-change acknowledgement set introduced relays outside the settled safety snapshot (${unsnapshottedConfirmationRelays.join(", ")}). GitWorkshop does not yet support making this transition.`,
          );
        }
        const deliveryRelayUrls = [
          ...new Set(
            [
              ...second.relayUrls,
              ...proposal.expectedRelayUrls,
              ...second.indexRelayUrls,
            ].map(normalizeUrl),
          ),
        ];
        const signedEvent = await account.signer.signEvent(proposal.template);
        const now = Date.now();
        saveMaintainerAcceptanceJob({
          key: operationKey,
          accountPubkey: account.pubkey,
          invitationAnchor: second.repo.selectedMaintainer,
          dTag: second.repo.dTag,
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

        try {
          await publish(
            signedEvent,
            [repoCoordinate(account.pubkey, second.repo.dTag)],
            { optimistic: false },
          );
        } catch (error) {
          updateMaintainerAcceptanceJob(operationKey, {
            relayErrors: {
              outbox: error instanceof Error ? error.message : String(error),
            },
          });
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
            ...second.repo.historicalAnnouncements,
            ...second.announcements.filter(
              ({ pubkey }) => pubkey !== account.pubkey,
            ),
            ...second.deletionEvents,
            refetchedEvent,
          ],
          second.repo.selectedMaintainer,
          second.repo.dTag,
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
        const refusal =
          error instanceof RepositoryMembershipMutationRefusal
            ? error
            : new RepositoryMembershipMutationRefusal(
                "incomplete_relay_view",
                `${error instanceof Error ? error.message : String(error)} GitWorkshop does not yet support making this transition.`,
              );
        setFailure({ code: refusal.code, message: refusal.message });
        throw refusal;
      } finally {
        setPendingIntent(undefined);
      }
    },
    [account, announcementsSettled, relayUrls, repo, repoState, stateSettled],
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
