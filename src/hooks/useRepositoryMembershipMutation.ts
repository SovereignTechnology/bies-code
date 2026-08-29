import { useCallback, useState } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import { firstValueFrom } from "rxjs";
import { endWith, filter, ignoreElements, take, timeout } from "rxjs/operators";
import type { NostrEvent } from "nostr-tools";

import type { RepositoryState } from "@/casts/RepositoryState";
import { graspServiceAddressToRelayUrl, type GraspServer } from "@/lib/grasp";
import {
  getRepoCloneUrls,
  getRepoRelays,
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
import {
  maintainerAcceptanceKey,
  runMaintainerAcceptanceDelivery,
  saveMaintainerAcceptanceJob,
} from "@/services/maintainerAcceptance";
import {
  addressLoader,
  eventStore,
  pool as relayPool,
  publish,
} from "@/services/nostr";
import {
  fallbackRelays,
  gitIndexRelays,
  lookupRelays,
} from "@/services/settings";

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
}

const OBSERVATION_TIMEOUT_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const GIT_OBJECT_TIMEOUT_MS = 15_000;

function mapsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([key, value]) => right.get(key) === value)
  );
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

async function settleMutationSnapshot(
  repo: ResolvedRepo,
  actorPubkey: string,
  intent: RepositoryMembershipMutationIntent,
  relayUrls: string[],
): Promise<MutationSnapshot> {
  const authors = mutationAuthors(repo, actorPubkey, intent);
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
            timeout({ first: SNAPSHOT_TIMEOUT_MS }),
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
  const mailboxRelays = eventStore
    .getByFilters([{ kinds: [10002], authors }])
    .flatMap((event) =>
      event.tags.flatMap(([name, url]) =>
        name === "r" && /^wss?:\/\//.test(url ?? "") ? [url] : [],
      ),
    );
  const relays = [
    ...new Set([
      ...relayUrls,
      ...repo.relays,
      ...mailboxRelays,
      ...gitIndexRelays.getValue(),
      ...fallbackRelays.getValue(),
      ...lookupRelays.getValue(),
    ]),
  ];
  if (relays.length === 0) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      "No repository, mailbox, index, lookup, or fallback relay is available. GitWorkshop does not yet support making this transition.",
    );
  }

  const filters: Filter[] = [
    { kinds: [REPO_KIND], authors, "#d": [repo.dTag] } as Filter,
    { kinds: [REPO_STATE_KIND], authors, "#d": [repo.dTag] } as Filter,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      resilientRequest(relayPool, relays, filters).subscribe({
        next: (response) => {
          if (response !== "EOSE") eventStore.add(response);
        },
        error: reject,
        complete: resolve,
      });
    });
  } catch (error) {
    throw new RepositoryMembershipMutationRefusal(
      "incomplete_relay_view",
      `The affected announcement and state snapshot did not settle (${error instanceof Error ? error.message : String(error)}). GitWorkshop does not yet support making this transition.`,
    );
  }

  const announcementFilter: Filter = {
    kinds: [REPO_KIND],
    authors,
    "#d": [repo.dTag],
  } as Filter;
  const stateFilter: Filter = {
    kinds: [REPO_STATE_KIND],
    authors,
    "#d": [repo.dTag],
  } as Filter;
  const announcements = eventStore.getByFilters([announcementFilter]);
  const stateEvents = eventStore.getByFilters([stateFilter]);
  const refreshedRepo = resolveChain(
    announcements,
    repo.selectedMaintainer,
    repo.dTag,
  );
  if (!refreshedRepo) {
    throw new RepositoryMembershipMutationRefusal(
      "concurrent_change",
      `The selected component ${repo.selectedCoordinate} no longer resolves. GitWorkshop does not yet support making this transition.`,
    );
  }
  return { repo: refreshedRepo, announcements, stateEvents };
}

async function ensureAcceptanceObjectsAvailable(
  repo: ResolvedRepo,
  repoState: RepositoryState | null | undefined,
): Promise<void> {
  if (!repoState || repoState.refs.length === 0) return;
  if (repo.cloneUrls.length === 0) {
    throw new RepositoryMembershipMutationRefusal(
      "unavailable_git_object",
      `Repository state ${repoState.event.id} has refs but no clone URL can supply them. GitWorkshop does not yet support making this transition.`,
    );
  }
  const gitPool = getOrCreatePool({ cloneUrls: repo.cloneUrls });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), GIT_OBJECT_TIMEOUT_MS);
  try {
    for (const commitId of new Set(
      repoState.refs.map(({ commitId }) => commitId),
    )) {
      const commit = await gitPool.getSingleCommit(commitId, controller.signal);
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
        if (!announcementsSettled || !stateSettled) {
          throw new RepositoryMembershipMutationRefusal(
            "incomplete_relay_view",
            "The current announcement and state snapshots have not settled. GitWorkshop does not yet support making this transition.",
          );
        }

        const createdAt = Math.floor(Date.now() / 1000);
        const first = await settleMutationSnapshot(
          repo,
          account.pubkey,
          intent,
          relayUrls,
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
        if (intent.type === "accept") {
          await ensureAcceptanceObjectsAvailable(first.repo, repoState);
        }
        prepareRepositoryMembershipMutation({
          repo: first.repo,
          actorPubkey: account.pubkey,
          intent,
          announcements: first.announcements,
          stateEvents: first.stateEvents,
          graspServers: graspServersForRepo(first.repo),
          createdAt,
        });

        // Re-fetch every predecessor immediately before signing. A changed
        // announcement or state aborts without asking the signer for an event.
        const second = await settleMutationSnapshot(
          first.repo,
          account.pubkey,
          intent,
          relayUrls,
        );
        if (
          !mapsEqual(
            repositoryMembershipSnapshotIds(first.announcements),
            repositoryMembershipSnapshotIds(second.announcements),
          ) ||
          !mapsEqual(
            repositoryMembershipSnapshotIds(first.stateEvents),
            repositoryMembershipSnapshotIds(second.stateEvents),
          )
        ) {
          throw new RepositoryMembershipMutationRefusal(
            "concurrent_change",
            "An affected announcement or state event changed during preflight. GitWorkshop does not yet support making this transition.",
          );
        }

        const proposal = prepareRepositoryMembershipMutation({
          repo: second.repo,
          actorPubkey: account.pubkey,
          intent,
          announcements: second.announcements,
          stateEvents: second.stateEvents,
          graspServers: graspServersForRepo(second.repo),
          createdAt,
        });
        const signedEvent = await account.signer.signEvent(proposal.template);
        await publish(signedEvent, [
          repoCoordinate(account.pubkey, second.repo.dTag),
        ]);

        await firstValueFrom(
          eventStore
            .addressable({
              kind: REPO_KIND,
              pubkey: account.pubkey,
              identifier: second.repo.dTag,
            })
            .pipe(
              filter(
                (event): event is NostrEvent => event?.id === signedEvent.id,
              ),
              take(1),
              timeout({ first: OBSERVATION_TIMEOUT_MS }),
            ),
        );
        const verifiedRepo = resolveChain(
          [
            ...second.announcements.filter(
              ({ pubkey }) => pubkey !== account.pubkey,
            ),
            signedEvent,
          ],
          second.repo.selectedMaintainer,
          second.repo.dTag,
        );
        if (!verifyRepositoryMembershipMutationResult(proposal, verifiedRepo)) {
          throw new RepositoryMembershipMutationRefusal(
            "membership_side_effect",
            "The observed signed replacement did not resolve to the preflighted membership effect. GitWorkshop does not yet support making this transition.",
          );
        }

        if (intent.type === "accept") {
          const now = Date.now();
          const acceptanceRelayUrls = [
            ...new Set([...relayUrls, ...getRepoRelays(signedEvent)]),
          ];
          const key = maintainerAcceptanceKey(
            account.pubkey,
            second.repo.selectedMaintainer,
            second.repo.dTag,
          );
          saveMaintainerAcceptanceJob({
            key,
            accountPubkey: account.pubkey,
            invitationAnchor: second.repo.selectedMaintainer,
            dTag: second.repo.dTag,
            announcement: signedEvent,
            cloneUrls: getRepoCloneUrls(signedEvent),
            relayUrls: acceptanceRelayUrls,
            deliveredRelayUrls: [],
            syncedCloneUrls: [],
            relayErrors: {},
            deliveryAttempt: 0,
            broadcastReceived: false,
            phase: "publishing",
            stateRefs: repoState?.refs ?? [],
            knownHeadCommit: repoState?.headCommitId,
            stateCreatedAt: repoState?.event.created_at,
            createdAt: now,
            updatedAt: now,
          });
          void runMaintainerAcceptanceDelivery(key);
        }
        return signedEvent;
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

  return {
    enabled: REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED,
    mutate,
    pendingIntent,
    failure,
    clearFailure: () => setFailure(undefined),
  };
}
