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
  | "unsupported_component_join"
  | "unsupported_lead_transition"
  | "membership_side_effect"
  | "invitation_withdrawal"
  | "state_conflict"
  | "identity_conflict"
  | "history_conflict"
  | "incomplete_relay_view"
  | "concurrent_change"
  | "unavailable_git_object";

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
  intent: RepositoryMembershipMutationIntent;
  template: EventTemplate;
  beforeAnnouncementIds: ReadonlyMap<string, string>;
  beforeStateIds: ReadonlyMap<string, string>;
  expectedMaintainers: string[];
  expectedModerators: string[];
  expectedInvitations: string[];
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
  if (intent.type === "add") expectedInvitations.add(intent.targetPubkey);
  if (intent.type === "accept") {
    expectedMaintainers.add(actorPubkey);
    expectedInvitations.delete(actorPubkey);
  }
  if (intent.type === "remove") {
    expectedMaintainers.delete(intent.targetPubkey);
    expectedInvitations.delete(intent.targetPubkey);
  }
  if (intent.type === "leave") expectedMaintainers.delete(actorPubkey);

  if (
    !setEqual(after.confirmedMaintainers, expectedMaintainers) ||
    !setEqual(after.confirmedModerators, before.confirmedModerators) ||
    !setEqual(after.invitedMaintainers, expectedInvitations) ||
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
    setEqual(resolved.confirmedMaintainers, proposal.expectedMaintainers) &&
    setEqual(resolved.confirmedModerators, proposal.expectedModerators) &&
    setEqual(resolved.invitedMaintainers, proposal.expectedInvitations) &&
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
    if (stateEvents.some((event) => event.pubkey === actorPubkey)) {
      refuse(
        "state_conflict",
        `Invitee ${actorPubkey} already has repository state that could become authoritative.`,
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
    if (!actorIsMaintainer || !actorAnnouncement) {
      refuse(
        "membership_side_effect",
        `Actor ${actorPubkey} is not a current maintainer.`,
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
    if (stateEvents.some((event) => event.pubkey === actorPubkey)) {
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
  assertExpectedEffect(repo, after, intent, actorPubkey);

  return {
    intent,
    template,
    beforeAnnouncementIds: repositoryMembershipSnapshotIds(announcements),
    beforeStateIds: repositoryMembershipSnapshotIds(stateEvents),
    expectedMaintainers: sorted(after?.confirmedMaintainers ?? []),
    expectedModerators: sorted(after?.confirmedModerators ?? []),
    expectedInvitations: sorted(after?.invitedMaintainers ?? []),
    expectedLead: after?.leadResolution.leadMaintainer,
  };
}
