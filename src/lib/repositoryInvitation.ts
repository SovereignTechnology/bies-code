import { nip19, type EventTemplate, type NostrEvent } from "nostr-tools";

import type { RepositoryState } from "@/casts/RepositoryState";
import { graspRepositoryCloneUrl, type GraspServer } from "@/lib/grasp";
import {
  computeMaintainerLeadership,
  getRepoCloneUrls,
  getRepoMaintainers,
  getRepoRelays,
  isGraspCloneUrl,
  REPO_KIND,
  type ResolvedRepo,
} from "@/lib/nip34";

export interface InvitationStateDecision {
  blocked: boolean;
  destructiveRefs: string[];
}

/**
 * Decide whether accepting an invitation would let a newer, non-invitee state
 * replace refs that still exist in the invitee's own state.
 *
 * The canonical state has already been selected using NIP-01's created_at and
 * event-id ordering by useRepositoryState. Acceptance is blocked only for the
 * narrower destructive case: the canonical state belongs to another
 * maintainer, is strictly newer by timestamp, and omits or changes at least one
 * invitee ref. Equal timestamps remain safe even when the canonical event won
 * the NIP-01 event-id tiebreak.
 */
export function classifyInvitationState(
  canonicalState: RepositoryState | null | undefined,
  inviteeState: RepositoryState | undefined,
  inviteePubkey: string,
): InvitationStateDecision {
  if (
    !canonicalState ||
    !inviteeState ||
    canonicalState.publisherPubkey === inviteePubkey ||
    canonicalState.event.created_at <= inviteeState.event.created_at
  ) {
    return { blocked: false, destructiveRefs: [] };
  }

  const canonicalRefs = new Map(
    canonicalState.refs.map(({ name, commitId }) => [name, commitId]),
  );
  const destructiveRefs = inviteeState.refs
    .filter(({ name, commitId }) => canonicalRefs.get(name) !== commitId)
    .map(({ name }) => name);

  return {
    blocked: destructiveRefs.length > 0,
    destructiveRefs,
  };
}

export function getAcceptanceMaintainerSelection(
  repo: ResolvedRepo,
  accountPubkey: string,
): {
  options: string[];
  defaults: string[];
  leadMaintainer?: string;
} {
  const options = repo.confirmedMaintainers.filter(
    (pubkey) => pubkey !== accountPubkey,
  );
  const leadMaintainer = computeMaintainerLeadership(
    repo.confirmedMaintainers,
    repo.maintainerEdges,
  ).leadMaintainer;
  const defaults =
    options.length === 1
      ? options
      : leadMaintainer && options.includes(leadMaintainer)
        ? [leadMaintainer]
        : [];

  return { options, defaults, leadMaintainer };
}

const PERSONAL_ANNOUNCEMENT_TAGS = new Set([
  "clone",
  "relays",
  "blossoms",
  "r",
]);

export function buildMaintainerAcceptanceTemplate(
  repo: ResolvedRepo,
  ownAnnouncement: NostrEvent | undefined,
  accountPubkey: string,
  selectedMaintainers: string[],
  graspServers: GraspServer[],
  createdAt = Math.floor(Date.now() / 1000),
): EventTemplate {
  const latestAnnouncement = repo.discoveredAnnouncements.reduce(
    (latest, event) => (event.created_at > latest.created_at ? event : latest),
  );
  const existingMaintainers = ownAnnouncement
    ? getRepoMaintainers(ownAnnouncement)
    : [];
  const maintainers = Array.from(
    new Set([accountPubkey, ...existingMaintainers, ...selectedMaintainers]),
  );

  const sharedTags = latestAnnouncement.tags.filter(
    ([name]) =>
      name !== "d" &&
      name !== "maintainers" &&
      name !== "p" &&
      !PERSONAL_ANNOUNCEMENT_TAGS.has(name),
  );
  const personalTags = buildPersonalTags(
    ownAnnouncement ?? latestAnnouncement,
    ownAnnouncement,
    accountPubkey,
    repo.dTag,
    graspServers,
    ownAnnouncement
      ? Array.from(new Set([...repo.relays, ...getRepoRelays(ownAnnouncement)]))
      : repo.relays,
  );

  return {
    kind: REPO_KIND,
    content: latestAnnouncement.content,
    created_at: Math.max(createdAt, (ownAnnouncement?.created_at ?? 0) + 1),
    tags: [
      ["d", repo.dTag],
      ...sharedTags,
      ...personalTags,
      ["maintainers", ...maintainers],
    ],
  };
}

function buildPersonalTags(
  sourceAnnouncement: NostrEvent,
  ownAnnouncement: NostrEvent | undefined,
  accountPubkey: string,
  dTag: string,
  graspServers: GraspServer[],
  sourceRelayUrls: string[],
): string[][] {
  const npub = nip19.npubEncode(accountPubkey);
  const encodedDTag = encodeURIComponent(dTag);
  const graspCloneUrls = graspServers.map(({ serviceAddress }) =>
    graspRepositoryCloneUrl(serviceAddress, npub, encodedDTag),
  );
  const existingNonGraspCloneUrls = ownAnnouncement
    ? getRepoCloneUrls(ownAnnouncement).filter((url) => !isGraspCloneUrl(url))
    : [];
  const cloneUrls = Array.from(
    new Set([...graspCloneUrls, ...existingNonGraspCloneUrls]),
  );
  const relayUrls = graspServers.map(({ wsUrl }) => wsUrl);
  const inheritedTags = sourceAnnouncement.tags.filter(
    ([name]) => name === "r" || name === "blossoms",
  );
  const syncRelayUrls = Array.from(new Set([...relayUrls, ...sourceRelayUrls]));

  return [
    ...inheritedTags,
    ...(cloneUrls.length > 0 ? [["clone", ...cloneUrls]] : []),
    ...(syncRelayUrls.length > 0 ? [["relays", ...syncRelayUrls]] : []),
  ];
}
