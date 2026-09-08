import type { EventTemplate, NostrEvent } from "nostr-tools";

import type { GraspServer } from "@/lib/grasp";
import {
  getRepoMaintainers,
  REPO_KIND,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  parseInvalidSelfDeferRoleRecord,
  parseRepositoryRoleRecord,
  type RepositoryHealthWarning,
  type RepositoryRole,
  type RepositoryRoleRecord,
} from "@/lib/nip34-maintainer-model";
import { buildMaintainerAcceptanceTemplate } from "@/lib/repositoryInvitation";

export type RepositoryMembershipMutationRefusalCode =
  | "membership_mutations_disabled"
  | "unsupported_component_join"
  | "unsupported_lead_transition"
  | "unsupported_existing_announcement"
  | "unsupported_immediate_confirmation"
  | "unsupported_role_effect_import"
  | "unsupported_existing_state"
  | "membership_side_effect"
  | "invitation_withdrawal"
  | "state_conflict"
  | "identity_conflict"
  | "history_conflict"
  | "missing_private_relay_hint"
  | "incomplete_relay_view"
  | "concurrent_change"
  | "unavailable_git_object"
  | "publication_pending"
  | "publication_verification_failed";

/** Every browser-supported membership intent is covered by the safety gate. */
export const REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED = true;

export type RepositoryMembershipMutationIntent =
  | { type: "add"; targetPubkey: string }
  | { type: "accept" }
  | { type: "remove"; targetPubkey: string }
  | { type: "leave" }
  | {
      type: "repair-self-defer";
      role: RepositoryRole;
      repair: { action: "continue" } | { action: "end"; boundary: number };
    };

export class RepositoryMembershipMutationRefusal extends Error {
  constructor(
    readonly code: RepositoryMembershipMutationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryMembershipMutationRefusal";
  }
}

export interface RepositoryMembershipMutationProposal {
  actorPubkey: string;
  intent: RepositoryMembershipMutationIntent;
  template: EventTemplate;
  beforeAnnouncementIds: ReadonlyMap<string, string>;
  beforeStateIds: ReadonlyMap<string, string>;
  expectedMaintainers: string[];
  expectedModerators: string[];
  expectedInvitations: string[];
  expectedModeratorInvitations: string[];
  expectedActorActiveRoles: string[];
  expectedCloneUrls: string[];
  expectedRelayUrls: string[];
  expectedLead?: string;
}

interface PrepareRepositoryMembershipMutationOptions {
  repo: ResolvedRepo;
  actorPubkey: string;
  intent: RepositoryMembershipMutationIntent;
  announcements: NostrEvent[];
  stateEvents: NostrEvent[];
  graspServers?: GraspServer[];
  createdAt?: number;
}

const MEMBERSHIP_TAGS = new Set(["M", "m", "o", "maintainers"]);
const MAINTAINER_ROLES = new Set<RepositoryRole>(["M", "m"]);

function refuse(
  code: RepositoryMembershipMutationRefusalCode,
  message: string,
): never {
  throw new RepositoryMembershipMutationRefusal(
    code,
    `${message} GitWorkshop does not yet support making this transition.`,
  );
}

function setEqual(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function activeRoleKeys(
  event: NostrEvent,
  currentLead: string | undefined,
): string[] {
  return sorted(
    materializedRoleRecords(event, currentLead, true)
      .filter(({ active }) => active)
      .map(({ role, subject }) => roleKey(role, subject)),
  );
}

function assertExpectedAuthoredRoleDelta(
  beforeAnnouncement: NostrEvent | undefined,
  proposedAnnouncement: NostrEvent,
  intent: RepositoryMembershipMutationIntent,
  actorPubkey: string,
  lead: string | undefined,
  actorWasMaintainer: boolean,
): void {
  const expected = new Set(
    beforeAnnouncement ? activeRoleKeys(beforeAnnouncement, lead) : [],
  );
  if (intent.type === "add") {
    expected.delete(roleKey("m", actorPubkey));
    expected.delete(roleKey("M", actorPubkey));
    expected.add(roleKey("M", actorPubkey));
    expected.add(roleKey("m", intent.targetPubkey));
  } else if (intent.type === "accept") {
    if (!lead) {
      refuse(
        "unsupported_lead_transition",
        "The invitation has no resolved lead relationship.",
      );
    }
    expected.add(roleKey("M", lead));
    expected.add(roleKey("m", actorPubkey));
  } else if (intent.type === "remove") {
    expected.delete(roleKey("M", intent.targetPubkey));
    expected.delete(roleKey("m", intent.targetPubkey));
  } else if (intent.type === "repair-self-defer") {
    if (intent.repair.action === "continue") {
      expected.add(roleKey(intent.role, actorPubkey));
    }
  } else if (actorWasMaintainer) {
    expected.delete(roleKey("M", actorPubkey));
    expected.delete(roleKey("m", actorPubkey));
  } else {
    expected.delete(roleKey("o", actorPubkey));
  }

  const actual = activeRoleKeys(proposedAnnouncement, lead);
  if (!setEqual(actual, expected)) {
    refuse(
      "membership_side_effect",
      `The proposed announcement changes authored active roles beyond the named intent (expected ${sorted(expected).join(",") || "none"}; got ${actual.join(",") || "none"}).`,
    );
  }
}

function latestByAuthor(events: NostrEvent[]): Map<string, NostrEvent> {
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    const existing = latest.get(event.pubkey);
    if (
      !existing ||
      event.created_at > existing.created_at ||
      (event.created_at === existing.created_at && event.id < existing.id)
    ) {
      latest.set(event.pubkey, event);
    }
  }
  return latest;
}

export function repositoryMembershipSnapshotIds(
  events: NostrEvent[],
): ReadonlyMap<string, string> {
  return new Map(
    [...latestByAuthor(events)].map(([pubkey, event]) => [pubkey, event.id]),
  );
}

/** Historical self-role effects that ordinary invitation acceptance may not import. */
export function hasUnsupportedAcceptanceRoleHistory(
  repo: ResolvedRepo,
  actorPubkey: string,
  acceptanceAt: number,
): boolean {
  const selfDeferWarnings = repo.repositoryHealth.filter(
    ({ author, code }) =>
      author === actorPubkey && code === "invalid-self-defer",
  );
  const maintainerSelfDeferWarnings = selfDeferWarnings.filter(
    ({ role }) => role === "M" || role === "m",
  );
  const repairedWarning =
    maintainerSelfDeferWarnings.length === 1
      ? maintainerSelfDeferWarnings[0]
      : undefined;
  const hasUnsafeAdditionalSelfDefer = selfDeferWarnings.some((warning) => {
    if (warning === repairedWarning || warning.selfDefer?.superseded) {
      return false;
    }
    return !(
      typeof warning.selfDefer?.lastValidStart === "number" &&
      warning.selfDefer.lastValidStart < acceptanceAt
    );
  });
  return (
    hasUnsafeAdditionalSelfDefer ||
    repo.departedMaintainers.includes(actorPubkey) ||
    repo.roleHistory.resolvedRecords.some(
      (record) =>
        record.subject === actorPubkey && record.boundaries.length >= 2,
    )
  );
}

function roleKey(role: RepositoryRole, subject: string): string {
  return `${role}:${subject}`;
}

function validateRoleHistory(
  event: NostrEvent,
  allowInvalidSelfDefer = false,
): RepositoryRoleRecord[] {
  const records: RepositoryRoleRecord[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags.filter(
    ([name]) => name === "M" || name === "m" || name === "o",
  )) {
    const record = parseRepositoryRoleRecord(event.pubkey, tag);
    if (!record) {
      if (
        allowInvalidSelfDefer &&
        parseInvalidSelfDeferRoleRecord(event.pubkey, tag)
      ) {
        continue;
      }
      refuse(
        "history_conflict",
        `Announcement ${event.id} has a malformed ${tag[0] ?? "role"} record.`,
      );
    }
    const key = roleKey(record.role, record.subject);
    if (seen.has(key)) {
      refuse(
        "history_conflict",
        `Announcement ${event.id} has duplicate ${record.role}:${record.subject} history.`,
      );
    }
    seen.add(key);
    records.push(record);
  }
  return records;
}

function closeRecord(
  record: RepositoryRoleRecord,
  createdAt: number,
): string[] {
  const tag = [record.role, record.subject, ...record.boundaries.map(String)];
  if (!record.active) return tag;
  if (record.boundaries.length === 0) tag.push("0");
  tag.push(String(createdAt));
  return tag;
}

function restartRecord(
  record: RepositoryRoleRecord,
  createdAt: number,
): string[] {
  if (record.active) {
    return [record.role, record.subject, ...record.boundaries.map(String)];
  }
  if (record.boundaries.at(-1) === "defer") {
    refuse(
      "history_conflict",
      `The deferred ${record.role}:${record.subject} interval has no signed numeric end.`,
    );
  }
  return [
    record.role,
    record.subject,
    ...record.boundaries.map(String),
    String(createdAt),
  ];
}

/**
 * Classify role-free legacy relationships against the destination lead before
 * transition history is generated. An existing legacy listing that becomes
 * `M` is a wire-format migration with an unknown start, not an `m` to `M`
 * promotion at the replacement timestamp.
 */
function materializedRoleRecords(
  event: NostrEvent,
  destinationLead: string | undefined,
  allowInvalidSelfDefer = false,
): RepositoryRoleRecord[] {
  const parsed = validateRoleHistory(event, allowInvalidSelfDefer);
  if (parsed.length > 0) return parsed;
  return getRepoMaintainers(event).map((subject) => ({
    author: event.pubkey,
    role: subject === destinationLead ? "M" : "m",
    subject,
    boundaries: [],
    active: true,
  }));
}

/** Port of ngit's role-history-preserving one-author roster replacement. */
function generateRoleTags(
  event: NostrEvent,
  desiredMaintainers: string[],
  lead: string | undefined,
  createdAt: number,
): string[][] {
  const prior = materializedRoleRecords(event, lead, true);
  const preservedInvalidSelfDeferTags = event.tags
    .filter((tag) => parseInvalidSelfDeferRoleRecord(event.pubkey, tag))
    .map((tag) => [...tag]);
  const priorByKey = new Map(
    prior.map((record) => [roleKey(record.role, record.subject), record]),
  );
  const subjects = new Set(prior.map(({ subject }) => subject));
  const result: string[][] = [];
  const emitted = new Set<string>();

  for (const subject of desiredMaintainers) {
    if (emitted.has(subject)) continue;
    emitted.add(subject);
    const role: "M" | "m" = subject === lead ? "M" : "m";
    const otherRole: "M" | "m" = role === "M" ? "m" : "M";
    const current = priorByKey.get(roleKey(role, subject));
    const other = priorByKey.get(roleKey(otherRole, subject));
    if (current) result.push(restartRecord(current, createdAt));
    else if (other || (prior.length > 0 && subject !== event.pubkey)) {
      result.push([role, subject, String(createdAt)]);
    } else {
      result.push([role, subject]);
    }
    if (other) result.push(closeRecord(other, createdAt));
  }

  for (const subject of subjects) {
    if (emitted.has(subject)) continue;
    for (const role of ["M", "m"] as const) {
      const record = priorByKey.get(roleKey(role, subject));
      if (record) result.push(closeRecord(record, createdAt));
    }
  }
  result.push(
    ...prior
      .filter(({ role }) => role === "o")
      .map((record) => [
        record.role,
        record.subject,
        ...record.boundaries.map(String),
      ]),
  );
  result.push(...preservedInvalidSelfDeferTags);
  return result;
}

function activeProjection(roleTags: string[][]): string[] {
  return [
    ...new Set(
      roleTags.flatMap((tag) => {
        const record = parseRepositoryRoleRecord("", tag);
        return record?.active && MAINTAINER_ROLES.has(record.role)
          ? [record.subject]
          : [];
      }),
    ),
  ];
}

function replaceMembershipTags(
  source: NostrEvent | EventTemplate,
  roleTags: string[][],
  createdAt: number,
): EventTemplate {
  const tags = source.tags.filter(([name]) => !MEMBERSHIP_TAGS.has(name));
  return {
    kind: REPO_KIND,
    content: source.content,
    created_at: createdAt,
    tags: [
      ...tags,
      ...roleTags,
      ["maintainers", ...activeProjection(roleTags)],
    ],
  };
}

function withMembershipTags(
  source: NostrEvent | EventTemplate,
  roleTags: string[][],
  createdAt: number,
): EventTemplate {
  return replaceMembershipTags(
    source,
    roleTags,
    Math.max(createdAt, source.created_at + 1),
  );
}

function selfDeferRecords(event: NostrEvent): RepositoryRoleRecord[] {
  return event.tags.flatMap((tag) => {
    const record = parseInvalidSelfDeferRoleRecord(event.pubkey, tag);
    return record ? [record] : [];
  });
}

function repairSelfDeferTemplate(
  event: NostrEvent,
  intent: Extract<
    RepositoryMembershipMutationIntent,
    { type: "repair-self-defer" }
  >,
  createdAt: number,
): EventTemplate {
  const matching = event.tags.filter((tag) => {
    const record = parseInvalidSelfDeferRoleRecord(event.pubkey, tag);
    return record?.role === intent.role;
  });
  if (matching.length !== 1) {
    refuse(
      "history_conflict",
      `Expected exactly one invalid self-${intent.role} defer record authored by ${event.pubkey}.`,
    );
  }

  const invalidRecord = parseInvalidSelfDeferRoleRecord(
    event.pubkey,
    matching[0],
  )!;
  const lastValidStart = invalidRecord.boundaries.at(-2);
  if (typeof lastValidStart !== "number") {
    refuse(
      "history_conflict",
      `The invalid self-${intent.role} defer has no signed interval start.`,
    );
  }
  const replacementCreatedAt = Math.max(createdAt, event.created_at + 1);
  if (lastValidStart > replacementCreatedAt) {
    refuse(
      "history_conflict",
      `The invalid self-${intent.role} defer starts after the replacement timestamp.`,
    );
  }
  if (
    intent.repair.action === "end" &&
    (!Number.isSafeInteger(intent.repair.boundary) ||
      intent.repair.boundary < lastValidStart ||
      intent.repair.boundary > replacementCreatedAt)
  ) {
    refuse(
      "history_conflict",
      `The self-${intent.role} repair boundary must be between its signed start and the replacement timestamp.`,
    );
  }

  // NIP-34 records one tag per role and subject. A valid same-role successor
  // must merge with the repaired interval or the replacement would parse as a
  // duplicate again; anything beyond a single successor interval closed at
  // its own signed start needs history the signer has not reviewed.
  const validSameRoleTags = event.tags.filter((tag) => {
    const record = parseRepositoryRoleRecord(event.pubkey, tag);
    return record?.role === intent.role && record.subject === event.pubkey;
  });
  if (validSameRoleTags.length > 1) {
    refuse(
      "history_conflict",
      `Announcement ${event.id} has duplicate valid self-${intent.role} records.`,
    );
  }
  const successorTag = validSameRoleTags[0];
  if (successorTag) {
    const successor = parseRepositoryRoleRecord(event.pubkey, successorTag)!;
    if (
      intent.repair.action !== "end" ||
      successor.boundaries.length !== 1 ||
      successor.boundaries[0] !== intent.repair.boundary
    ) {
      refuse(
        "history_conflict",
        `The valid self-${intent.role} record cannot merge with this repair boundary.`,
      );
    }
  }

  const repairedRoleTags = event.tags
    .filter(([name]) => name === "M" || name === "m" || name === "o")
    .filter((tag) => tag !== successorTag)
    .map((tag) => {
      if (tag !== matching[0]) return [...tag];
      if (intent.repair.action === "continue") return tag.slice(0, -1);
      const repaired = [...tag.slice(0, -1), String(intent.repair.boundary)];
      return successorTag ? [...repaired, ...successorTag.slice(2)] : repaired;
    });
  return withMembershipTags(event, repairedRoleTags, createdAt);
}

function deferredHistoryTag(record: RepositoryRoleRecord): string[] {
  const tag = [record.role, record.subject, ...record.boundaries.map(String)];
  if (!record.active) return tag;
  if (record.boundaries.length === 0) tag.push("0");
  tag.push("defer");
  return tag;
}

function acceptanceRoleTags(
  repo: ResolvedRepo,
  ownAnnouncement: NostrEvent | undefined,
  actorPubkey: string,
  lead: string,
  createdAt: number,
  repairWarning?: RepositoryHealthWarning,
): string[][] {
  const conflicts = repo.roleHistory.resolvedRecords.filter(
    ({ conflicts: recordConflicts }) =>
      recordConflicts.some(({ author }) => author !== actorPubkey),
  );
  if (conflicts.length > 0) {
    refuse(
      "history_conflict",
      `Resolved role history disagrees for ${conflicts.map(({ role, subject }) => `${role}:${subject}`).join(", ")}.`,
    );
  }
  const ownRecords = ownAnnouncement
    ? validateRoleHistory(ownAnnouncement, true)
    : [];
  const invalidSelfMaintainerRecords = ownAnnouncement
    ? selfDeferRecords(ownAnnouncement).filter(
        ({ role }) => role === "M" || role === "m",
      )
    : [];
  if (invalidSelfMaintainerRecords.length > 1) {
    refuse(
      "history_conflict",
      `Acceptance cannot infer which of ${invalidSelfMaintainerRecords.length} invalid self-defer records represents the prior maintainer role.`,
    );
  }
  const selfRecord = ownRecords.find(
    (record) =>
      record.subject === actorPubkey && MAINTAINER_ROLES.has(record.role),
  );
  const leadRecord = ownRecords.find(
    (record) => record.subject === lead && record.role === "M" && record.active,
  );
  const result = repo.roleHistory.resolvedRecords
    .filter(
      (record) =>
        !(
          record.subject === actorPubkey ||
          (record.role === "M" && record.subject === lead)
        ),
    )
    .map(deferredHistoryTag);
  if (ownAnnouncement) {
    result.push(
      ...ownAnnouncement.tags
        .filter((tag) => {
          const record =
            parseRepositoryRoleRecord(ownAnnouncement.pubkey, tag) ??
            parseInvalidSelfDeferRoleRecord(ownAnnouncement.pubkey, tag);
          return record?.role === "o" && record.subject === actorPubkey;
        })
        .map((tag) => [...tag]),
    );
  }

  result.push(
    leadRecord
      ? [
          leadRecord.role,
          leadRecord.subject,
          ...leadRecord.boundaries.map(String),
        ]
      : ["M", lead, String(createdAt)],
  );
  const invalidSelfRecord = invalidSelfMaintainerRecords[0];
  if (invalidSelfRecord) {
    if (!repairWarning || repairWarning.role !== invalidSelfRecord.role) {
      refuse(
        "history_conflict",
        "Acceptance cannot identify one invalid self-maintainer interval to repair.",
      );
    }
    if (invalidSelfRecord.boundaries.length !== 2) {
      refuse(
        "unsupported_role_effect_import",
        "Acceptance cannot repair a malformed self-maintainer record containing earlier intervals.",
      );
    }
    const lastValidStart = invalidSelfRecord.boundaries.at(-2);
    const repairBoundary = repairWarning.selfDefer?.superseded
      ? repairWarning.selfDefer.proposedEnd
      : createdAt;
    if (typeof lastValidStart !== "number" || lastValidStart > createdAt) {
      refuse(
        "history_conflict",
        "The invalid self-maintainer defer starts after the acceptance timestamp.",
      );
    }
    if (
      repairBoundary === undefined ||
      repairBoundary < lastValidStart ||
      repairBoundary > createdAt
    ) {
      refuse(
        "history_conflict",
        "Acceptance has no unambiguous signed boundary for the invalid self-maintainer interval.",
      );
    }
    const corrected = [
      invalidSelfRecord.role,
      invalidSelfRecord.subject,
      ...invalidSelfRecord.boundaries.slice(0, -1).map(String),
      String(repairBoundary),
    ];
    if (invalidSelfRecord.role === "m") corrected.push(String(createdAt));
    result.push(corrected);
    if (invalidSelfRecord.role !== "m") {
      result.push(["m", actorPubkey, String(createdAt)]);
    }
  } else {
    result.push(
      selfRecord
        ? restartRecord({ ...selfRecord, role: "m" }, createdAt)
        : ["m", actorPubkey, String(createdAt)],
    );
  }
  return result;
}

function eventEuc(event: NostrEvent | undefined): string | undefined {
  return event?.tags.find(
    ([name, value, marker]) => name === "r" && !!value && marker === "euc",
  )?.[1];
}

function ensureIdentityCompatible(
  repo: ResolvedRepo,
  targetAnnouncement: NostrEvent | undefined,
): void {
  if (!targetAnnouncement) return;
  const repositoryEucs = new Set(
    repo.confirmedAnnouncements.flatMap((event) => {
      const euc = eventEuc(event);
      return euc ? [euc] : [];
    }),
  );
  const targetEuc = eventEuc(targetAnnouncement);
  if (
    repositoryEucs.size > 1 ||
    (targetEuc && repositoryEucs.size === 1 && !repositoryEucs.has(targetEuc))
  ) {
    refuse(
      "identity_conflict",
      `The target coordinate's earliest-unique-commit identity differs from ${repo.selectedCoordinate}.`,
    );
  }
}

function assertExpectedEffect(
  before: ResolvedRepo,
  after: ResolvedRepo | undefined,
  intent: RepositoryMembershipMutationIntent,
  actorPubkey: string,
): void {
  if (!after) {
    refuse(
      "membership_side_effect",
      "The proposed announcement has no resolvable component.",
    );
  }
  const expectedMaintainers = new Set(before.confirmedMaintainers);
  const expectedInvitations = new Set(before.invitedMaintainers);
  const expectedModerators = new Set(before.confirmedModerators);
  const expectedModeratorInvitations = new Set(before.invitedModerators);
  if (intent.type === "add") expectedInvitations.add(intent.targetPubkey);
  if (intent.type === "accept") {
    expectedMaintainers.add(actorPubkey);
    expectedModerators.delete(actorPubkey);
    expectedInvitations.delete(actorPubkey);
  }
  if (intent.type === "remove") {
    expectedMaintainers.delete(intent.targetPubkey);
    expectedInvitations.delete(intent.targetPubkey);
  }
  if (intent.type === "leave") {
    if (before.confirmedMaintainers.includes(actorPubkey)) {
      expectedMaintainers.delete(actorPubkey);
    } else {
      expectedModerators.delete(actorPubkey);
    }
  }

  const actorAnnouncement = before.confirmedAnnouncements.find(
    ({ pubkey }) => pubkey === actorPubkey,
  );
  const materializesSoleLegacyLead =
    intent.type === "add" &&
    before.leadResolution.source === "none" &&
    before.confirmedMaintainers.length === 1 &&
    before.confirmedMaintainers[0] === actorPubkey &&
    before.maintainerEdges.length === 0 &&
    before.invitedMaintainers.length === 0 &&
    !actorAnnouncement?.tags.some(([name]) => ["M", "m", "o"].includes(name)) &&
    after?.leadResolution.leadMaintainer === actorPubkey &&
    after.leadResolution.source === "explicit";

  const maintainerInvitationsMatch = setEqual(
    after.invitedMaintainers,
    expectedInvitations,
  );
  const moderatorInvitationsMatch = setEqual(
    after.invitedModerators,
    expectedModeratorInvitations,
  );
  if (!maintainerInvitationsMatch || !moderatorInvitationsMatch) {
    const withdrawn = [
      ...[...expectedInvitations].filter(
        (pubkey) => !after.invitedMaintainers.includes(pubkey),
      ),
      ...[...expectedModeratorInvitations].filter(
        (pubkey) => !after.invitedModerators.includes(pubkey),
      ),
    ];
    refuse(
      withdrawn.length > 0 ? "invitation_withdrawal" : "membership_side_effect",
      `The proposed announcement changes invitations beyond the named intent (${withdrawn.length > 0 ? `withdrawn ${sorted(withdrawn).join(",")}` : "unexpected invitation added"}).`,
    );
  }

  if (
    !setEqual(after.confirmedMaintainers, expectedMaintainers) ||
    !setEqual(after.confirmedModerators, expectedModerators) ||
    (after.leadResolution.leadMaintainer !==
      before.leadResolution.leadMaintainer &&
      !materializesSoleLegacyLead)
  ) {
    refuse(
      "membership_side_effect",
      `The proposed announcement changes more than the named intent (maintainers ${sorted(after.confirmedMaintainers).join(",") || "none"}; invitations ${sorted(after.invitedMaintainers).join(",") || "none"}; moderators ${sorted(after.confirmedModerators).join(",") || "none"}; lead ${after.leadResolution.leadMaintainer ?? "none"}).`,
    );
  }
}

export function verifyRepositoryMembershipMutationResult(
  proposal: RepositoryMembershipMutationProposal,
  resolved: ResolvedRepo | undefined,
): boolean {
  return (
    !!resolved &&
    resolved.discoveredAnnouncements.some(
      (event) =>
        event.pubkey === proposal.actorPubkey &&
        setEqual(
          activeRoleKeys(event, proposal.expectedLead),
          proposal.expectedActorActiveRoles,
        ),
    ) &&
    setEqual(resolved.confirmedMaintainers, proposal.expectedMaintainers) &&
    setEqual(resolved.confirmedModerators, proposal.expectedModerators) &&
    setEqual(resolved.invitedMaintainers, proposal.expectedInvitations) &&
    setEqual(
      resolved.invitedModerators,
      proposal.expectedModeratorInvitations,
    ) &&
    resolved.leadResolution.leadMaintainer === proposal.expectedLead
  );
}

export function prepareRepositoryMembershipMutation({
  repo,
  actorPubkey,
  intent,
  announcements,
  stateEvents,
  graspServers = [],
  createdAt = Math.floor(Date.now() / 1000),
}: PrepareRepositoryMembershipMutationOptions): RepositoryMembershipMutationProposal {
  const actorSelfDeferWarnings = repo.repositoryHealth.filter(
    ({ author, code }) =>
      author === actorPubkey && code === "invalid-self-defer",
  );
  const actorMaintainerSelfDeferWarnings = actorSelfDeferWarnings.filter(
    ({ role }) => role === "M" || role === "m",
  );
  const acceptanceRepairWarning =
    actorMaintainerSelfDeferWarnings.length === 1
      ? actorMaintainerSelfDeferWarnings[0]
      : undefined;
  const acceptanceHasUnsupportedRoleHistory =
    hasUnsupportedAcceptanceRoleHistory(repo, actorPubkey, createdAt);
  const acceptanceCanRepairSelfDefer =
    !!acceptanceRepairWarning &&
    !acceptanceRepairWarning.selfDefer?.hasPriorIntervals &&
    !acceptanceHasUnsupportedRoleHistory &&
    (!acceptanceRepairWarning.selfDefer?.superseded ||
      acceptanceRepairWarning.selfDefer.proposedEnd !== undefined);
  const explicitlyRepairsSelfDefer =
    intent.type === "repair-self-defer" || intent.type === "accept";
  const blockingHealth = repo.repositoryHealth.filter((warning) => {
    if (
      warning.code !== "invalid-self-defer" &&
      warning.code !== "duplicate-role-record"
    ) {
      return true;
    }
    // Self-defer and duplicate health is author-scoped: another author's
    // history problem never blocks this actor's mutations, while the
    // affected author's own generic mutations stay fail-closed.
    if (warning.author !== actorPubkey) return false;
    if (warning.code === "duplicate-role-record") {
      // A duplicate made of one invalid self-defer beside its single valid
      // same-role successor is exactly what the explicit repair and
      // acceptance flows eliminate; genuine duplicates stay a hard conflict.
      return !(explicitlyRepairsSelfDefer && warning.repairableBySelfDefer);
    }
    return !warning.selfDefer?.superseded && !explicitlyRepairsSelfDefer;
  });
  if (blockingHealth.length > 0) {
    refuse(
      "history_conflict",
      `Repository health warnings must be reconciled first: ${blockingHealth.map(({ code }) => code).join(", ")}.`,
    );
  }
  const announcementsByAuthor = latestByAuthor(announcements);
  const actorAnnouncement = announcementsByAuthor.get(actorPubkey);
  const targetPubkey =
    intent.type === "add" || intent.type === "remove"
      ? intent.targetPubkey
      : actorPubkey;
  const targetAnnouncement = announcementsByAuthor.get(targetPubkey);
  const lead = repo.leadResolution.leadMaintainer;
  const actorIsMaintainer = repo.confirmedMaintainers.includes(actorPubkey);
  const actorIsModerator = repo.confirmedModerators.includes(actorPubkey);

  if (
    intent.type === "accept" &&
    actorAnnouncement &&
    !acceptanceCanRepairSelfDefer
  ) {
    if (acceptanceRepairWarning && acceptanceHasUnsupportedRoleHistory) {
      refuse(
        "unsupported_role_effect_import",
        `Invitee ${actorPubkey} has a prior role interval that could make historical role-scoped effects authoritative.`,
      );
    }
    if (acceptanceRepairWarning?.selfDefer?.hasPriorIntervals) {
      refuse(
        "unsupported_role_effect_import",
        "The invalid self-maintainer record contains earlier intervals that acceptance cannot make authoritative.",
      );
    }
    if (
      acceptanceRepairWarning?.selfDefer?.superseded &&
      acceptanceRepairWarning.selfDefer.proposedEnd === undefined
    ) {
      refuse(
        "history_conflict",
        "The invalid self-maintainer interval has multiple possible signed successor boundaries.",
      );
    }
    refuse(
      "unsupported_existing_announcement",
      `Invitee ${actorPubkey} already has a same-identifier announcement that requires full reconciliation.`,
    );
  }

  if (
    (intent.type === "add" ||
      intent.type === "accept" ||
      (intent.type === "repair-self-defer" &&
        intent.repair.action === "continue")) &&
    stateEvents.some((event) => event.pubkey === targetPubkey)
  ) {
    refuse(
      "unsupported_existing_state",
      `Target ${targetPubkey} already authored repository state that requires full before-and-after reconciliation.`,
    );
  }

  ensureIdentityCompatible(repo, targetAnnouncement);
  if (targetAnnouncement) {
    const targetRepo = resolveChain(announcements, targetPubkey, repo.dTag);
    if (
      targetRepo?.confirmedMaintainers.includes(targetPubkey) &&
      targetRepo.componentId !== repo.componentId
    ) {
      refuse(
        "unsupported_component_join",
        `The target ${targetPubkey} already roots another active ${repo.dTag} component.`,
      );
    }
  }

  let template: EventTemplate;
  if (intent.type === "add") {
    if (!actorIsMaintainer || !actorAnnouncement) {
      refuse(
        "membership_side_effect",
        `Actor ${actorPubkey} is not a current maintainer.`,
      );
    }
    if (lead && lead !== actorPubkey) {
      refuse(
        "unsupported_lead_transition",
        `Only resolved lead ${lead} may add a relationship in this topology.`,
      );
    }
    if (
      repo.confirmedMaintainers.includes(intent.targetPubkey) ||
      repo.invitedMaintainers.includes(intent.targetPubkey)
    ) {
      refuse(
        "membership_side_effect",
        `Target ${intent.targetPubkey} is already confirmed or invited.`,
      );
    }
    const desired = [
      ...getRepoMaintainers(actorAnnouncement),
      intent.targetPubkey,
    ];
    const roleTags = generateRoleTags(
      actorAnnouncement,
      desired,
      actorPubkey,
      createdAt,
    );
    template = withMembershipTags(actorAnnouncement, roleTags, createdAt);
  } else if (intent.type === "accept") {
    if (!repo.invitedMaintainers.includes(actorPubkey)) {
      refuse(
        "membership_side_effect",
        `Actor ${actorPubkey} has no current invitation.`,
      );
    }
    if (!lead || lead === actorPubkey) {
      refuse(
        "unsupported_lead_transition",
        "The invitation has no distinct resolved lead to acknowledge.",
      );
    }
    if (acceptanceHasUnsupportedRoleHistory) {
      refuse(
        "unsupported_role_effect_import",
        `Invitee ${actorPubkey} has a prior role interval that could make historical role-scoped effects authoritative.`,
      );
    }
    const base = buildMaintainerAcceptanceTemplate(
      repo,
      actorAnnouncement,
      actorPubkey,
      [lead],
      graspServers,
      createdAt,
    );
    template = replaceMembershipTags(
      base,
      acceptanceRoleTags(
        repo,
        actorAnnouncement,
        actorPubkey,
        lead,
        base.created_at,
        acceptanceRepairWarning,
      ),
      base.created_at,
    );
  } else if (intent.type === "repair-self-defer") {
    if (!actorAnnouncement) {
      refuse(
        "history_conflict",
        `Actor ${actorPubkey} has no announcement containing the invalid self-defer.`,
      );
    }
    const warning = actorSelfDeferWarnings.find(
      ({ role }) => role === intent.role,
    );
    if (!warning) {
      refuse(
        "history_conflict",
        `Actor ${actorPubkey} has no invalid self-${intent.role} defer to repair.`,
      );
    }
    if (intent.repair.action === "continue" && warning.selfDefer?.superseded) {
      refuse(
        "history_conflict",
        `A later signed self-${warning.selfDefer.successorRole ?? "role"} already supersedes this interval; close it at the successor boundary instead.`,
      );
    }
    if (
      intent.repair.action === "end" &&
      warning.selfDefer?.proposedEnd !== undefined &&
      intent.repair.boundary !== warning.selfDefer.proposedEnd
    ) {
      refuse(
        "history_conflict",
        `The signed successor supplies ${warning.selfDefer.proposedEnd} as the unambiguous repair boundary.`,
      );
    }
    template = repairSelfDeferTemplate(actorAnnouncement, intent, createdAt);
  } else if (intent.type === "remove") {
    if (!actorIsMaintainer || !actorAnnouncement) {
      refuse(
        "membership_side_effect",
        `Actor ${actorPubkey} is not a current maintainer.`,
      );
    }
    if (lead !== actorPubkey) {
      refuse(
        "unsupported_lead_transition",
        `Only resolved lead ${lead ?? "(none)"} may remove a relationship in this topology.`,
      );
    }
    if (
      !repo.maintainerEdges.some(
        ({ from, to }) => from === actorPubkey && to === intent.targetPubkey,
      )
    ) {
      refuse(
        "membership_side_effect",
        `Announcement ${actorPubkey} does not directly assign ${intent.targetPubkey}.`,
      );
    }
    if (stateEvents.some((event) => event.pubkey === intent.targetPubkey)) {
      refuse(
        "state_conflict",
        `Removing ${intent.targetPubkey} would change the authoritative state candidate set.`,
      );
    }
    const desired = getRepoMaintainers(actorAnnouncement).filter(
      (pubkey) => pubkey !== intent.targetPubkey,
    );
    template = withMembershipTags(
      actorAnnouncement,
      generateRoleTags(actorAnnouncement, desired, actorPubkey, createdAt),
      createdAt,
    );
  } else {
    if ((!actorIsMaintainer && !actorIsModerator) || !actorAnnouncement) {
      refuse(
        "membership_side_effect",
        `Actor ${actorPubkey} is not a current maintainer or moderator.`,
      );
    }
    if (!lead || lead === actorPubkey) {
      refuse(
        "unsupported_lead_transition",
        "The resolved lead cannot leave through an ordinary one-person operation.",
      );
    }
    const outgoing = repo.maintainerEdges.filter(
      ({ from }) => from === actorPubkey,
    );
    if (outgoing.some(({ to }) => to !== lead)) {
      refuse(
        "membership_side_effect",
        `Leaving would disconnect relationships authored by ${actorPubkey}.`,
      );
    }
    if (
      actorIsMaintainer &&
      stateEvents.some((event) => event.pubkey === actorPubkey)
    ) {
      refuse(
        "state_conflict",
        `Maintainer ${actorPubkey} has repository state that would leave the authority set.`,
      );
    }
    const roleTags = generateRoleTags(
      actorAnnouncement,
      [lead],
      lead,
      createdAt,
    ).map((tag) => {
      const record = parseRepositoryRoleRecord(actorPubkey, tag);
      return record?.role === "o" &&
        record.subject === actorPubkey &&
        record.active
        ? closeRecord(record, createdAt)
        : tag;
    });
    template = withMembershipTags(actorAnnouncement, roleTags, createdAt);
  }

  const simulated: NostrEvent = {
    id: "0".repeat(64),
    sig: "0".repeat(128),
    pubkey: actorPubkey,
    ...template,
  };
  if (
    repo.isPrivate &&
    !simulated.tags.some(
      ([name, ...relayUrls]) =>
        name === "relays" && relayUrls.some((url) => url.length > 0),
    )
  ) {
    refuse(
      "missing_private_relay_hint",
      "A private repository announcement must include at least one relay hint.",
    );
  }
  const after = resolveChain(
    [
      ...announcements.filter(({ pubkey }) => pubkey !== actorPubkey),
      simulated,
    ],
    repo.selectedMaintainer,
    repo.dTag,
  );
  if (
    intent.type === "add" &&
    !repo.confirmedMaintainers.includes(intent.targetPubkey) &&
    after?.confirmedMaintainers.includes(intent.targetPubkey)
  ) {
    refuse(
      "unsupported_immediate_confirmation",
      `Adding ${intent.targetPubkey} would confirm their standing acknowledgement immediately and requires full confirmation preflight.`,
    );
  }
  assertExpectedAuthoredRoleDelta(
    actorAnnouncement,
    simulated,
    intent,
    actorPubkey,
    lead,
    actorIsMaintainer,
  );
  if (intent.type !== "repair-self-defer") {
    assertExpectedEffect(repo, after, intent, actorPubkey);
  } else if (!after) {
    refuse(
      "membership_side_effect",
      "The repaired announcement has no resolvable repository view.",
    );
  }

  return {
    actorPubkey,
    intent,
    template,
    beforeAnnouncementIds: repositoryMembershipSnapshotIds(announcements),
    beforeStateIds: repositoryMembershipSnapshotIds(stateEvents),
    expectedMaintainers: sorted(after?.confirmedMaintainers ?? []),
    expectedModerators: sorted(after?.confirmedModerators ?? []),
    expectedInvitations: sorted(after?.invitedMaintainers ?? []),
    expectedModeratorInvitations: sorted(after?.invitedModerators ?? []),
    expectedActorActiveRoles: activeRoleKeys(simulated, lead),
    expectedCloneUrls: sorted(after?.cloneUrls ?? []),
    expectedRelayUrls: sorted(after?.relays ?? []),
    expectedLead: after?.leadResolution.leadMaintainer,
  };
}
