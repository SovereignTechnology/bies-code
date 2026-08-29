import type { EventTemplate, NostrEvent } from "nostr-tools";

import type { GraspServer } from "@/lib/grasp";
import {
  getRepoMaintainers,
  REPO_KIND,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  parseRepositoryRoleRecord,
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
  | "incomplete_relay_view"
  | "concurrent_change"
  | "unavailable_git_object";

/**
 * Membership writers stay behind this safety rail until the complete relay,
 * history, Git-object, and publication gates have landed together.
 */
export const REPOSITORY_MEMBERSHIP_MUTATIONS_ENABLED = false;

export type RepositoryMembershipMutationIntent =
  | { type: "add"; targetPubkey: string }
  | { type: "accept" }
  | { type: "remove"; targetPubkey: string }
  | { type: "leave" };

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
    materializedRoleRecords(event, currentLead)
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

function roleKey(role: RepositoryRole, subject: string): string {
  return `${role}:${subject}`;
}

function validateRoleHistory(event: NostrEvent): RepositoryRoleRecord[] {
  const records: RepositoryRoleRecord[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags.filter(
    ([name]) => name === "M" || name === "m" || name === "o",
  )) {
    const record = parseRepositoryRoleRecord(event.pubkey, tag);
    if (!record) {
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

function materializedRoleRecords(
  event: NostrEvent,
  currentLead: string | undefined,
): RepositoryRoleRecord[] {
  const parsed = validateRoleHistory(event);
  if (parsed.length > 0) return parsed;
  return getRepoMaintainers(event).map((subject) => ({
    author: event.pubkey,
    role: subject === currentLead ? "M" : "m",
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
  const prior = materializedRoleRecords(event, undefined);
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

function withMembershipTags(
  source: NostrEvent | EventTemplate,
  roleTags: string[][],
  createdAt: number,
): EventTemplate {
  const tags = source.tags.filter(([name]) => !MEMBERSHIP_TAGS.has(name));
  return {
    kind: REPO_KIND,
    content: source.content,
    created_at: Math.max(createdAt, source.created_at + 1),
    tags: [
      ...tags,
      ...roleTags,
      ["maintainers", ...activeProjection(roleTags)],
    ],
  };
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
): string[][] {
  const conflicts = repo.roleHistory.resolvedRecords.filter(
    ({ conflicts: recordConflicts }) => recordConflicts.length > 0,
  );
  if (conflicts.length > 0) {
    refuse(
      "history_conflict",
      `Resolved role history disagrees for ${conflicts.map(({ role, subject }) => `${role}:${subject}`).join(", ")}.`,
    );
  }
  const ownRecords = ownAnnouncement
    ? validateRoleHistory(ownAnnouncement)
    : [];
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
          MAINTAINER_ROLES.has(record.role) &&
          (record.subject === actorPubkey ||
            (record.role === "M" && record.subject === lead))
        ),
    )
    .map(deferredHistoryTag);

  result.push(
    leadRecord
      ? [
          leadRecord.role,
          leadRecord.subject,
          ...leadRecord.boundaries.map(String),
        ]
      : ["M", lead, String(createdAt)],
  );
  result.push(
    selfRecord
      ? restartRecord({ ...selfRecord, role: "m" }, createdAt)
      : ["m", actorPubkey, String(createdAt)],
  );
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
    after.leadResolution.leadMaintainer !== before.leadResolution.leadMaintainer
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
  if (repo.repositoryHealth.length > 0) {
    refuse(
      "history_conflict",
      `Repository health warnings must be reconciled first: ${repo.repositoryHealth.map(({ code }) => code).join(", ")}.`,
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

  if (intent.type === "accept" && actorAnnouncement) {
    refuse(
      "unsupported_existing_announcement",
      `Invitee ${actorPubkey} already has a same-identifier announcement that requires full reconciliation.`,
    );
  }

  if (
    (intent.type === "add" || intent.type === "accept") &&
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
    if (
      repo.departedMaintainers.includes(actorPubkey) ||
      repo.roleHistory.resolvedRecords.some(
        (record) =>
          record.subject === actorPubkey && record.boundaries.length >= 2,
      )
    ) {
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
    template = withMembershipTags(
      base,
      acceptanceRoleTags(repo, actorAnnouncement, actorPubkey, lead, createdAt),
      createdAt,
    );
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
  assertExpectedEffect(repo, after, intent, actorPubkey);

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
    expectedLead: after?.leadResolution.leadMaintainer,
  };
}
