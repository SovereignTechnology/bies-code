import { getReplaceableIdentifier } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";

export const REPOSITORY_ANNOUNCEMENT_KIND = 30617;

export type RepositoryRole = "M" | "m" | "o";
export type RoleAssignmentSource = "indexed" | "legacy";

export interface RepositoryRoleRecord {
  author: string;
  role: RepositoryRole;
  subject: string;
  boundaries: (number | "defer")[];
  active: boolean;
}

export interface MaintainerEdge {
  from: string;
  to: string;
  role: "M" | "m";
  source: RoleAssignmentSource;
}

export interface ModeratorEdge {
  from: string;
  to: string;
  source: "indexed";
}

export type RepositoryHealthCode =
  | "invalid-role-record"
  | "duplicate-role-record"
  | "inconsistent-maintainers-projection";

export interface RepositoryHealthWarning {
  code: RepositoryHealthCode;
  message: string;
  author: string;
  role?: RepositoryRole;
  subject?: string;
}

export type LeadResolutionSource =
  | "implicit_sole"
  | "explicit"
  | "legacy_inferred"
  | "explicit_none"
  | "none"
  | "pending"
  | "conflict";

export interface LeadResolution {
  /** Terminal lead when resolution completed successfully. */
  leadMaintainer?: string;
  source: LeadResolutionSource;
  /** Selected maintainer followed by each explicit pointer target. */
  path: string[];
}

interface ParsedAnnouncement {
  event: NostrEvent;
  roleRecords: RepositoryRoleRecord[];
  activeMaintainers: {
    pubkey: string;
    role: "M" | "m";
    source: RoleAssignmentSource;
  }[];
  activeModerators: string[];
  activeRoles: { role: RepositoryRole; pubkey: string }[];
  hasIndexedRoles: boolean;
  hasIndexedMaintainerRoles: boolean;
  hasLegacyMaintainersTag: boolean;
  authorDeclinesMaintainership: boolean;
  authorDeclinesModeratorship: boolean;
  health: RepositoryHealthWarning[];
}

export interface RepositoryMembershipResolution {
  selectedMaintainer: string;
  dTag: string;
  confirmedMaintainers: string[];
  confirmedModerators: string[];
  confirmedMembers: string[];
  invitedMaintainers: string[];
  invitedModerators: string[];
  departedMaintainers: string[];
  departedModerators: string[];
  discoveryPubkeys: string[];
  discoveredAnnouncements: NostrEvent[];
  confirmedAnnouncements: NostrEvent[];
  maintainerEdges: MaintainerEdge[];
  moderatorEdges: ModeratorEdge[];
  repositoryHealth: RepositoryHealthWarning[];
  leadResolution: LeadResolution;
}

const ROLE_NAMES = new Set<RepositoryRole>(["M", "m", "o"]);
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function latestEventWins(candidate: NostrEvent, existing: NostrEvent): boolean {
  return (
    candidate.created_at > existing.created_at ||
    (candidate.created_at === existing.created_at && candidate.id < existing.id)
  );
}

/**
 * Reduce repository announcements once, partitioned by identifier and author.
 * This avoids rescanning the complete repository timeline for every `d` tag.
 */
export function latestRepositoryAnnouncementsByIdentifier(
  events: Iterable<NostrEvent>,
): Map<string, Map<string, NostrEvent>> {
  const latestByIdentifier = new Map<string, Map<string, NostrEvent>>();
  for (const event of events) {
    if (event.kind !== REPOSITORY_ANNOUNCEMENT_KIND) continue;
    const dTag = getReplaceableIdentifier(event);
    if (!dTag) continue;
    const latest =
      latestByIdentifier.get(dTag) ?? new Map<string, NostrEvent>();
    const existing = latest.get(event.pubkey);
    if (!existing || latestEventWins(event, existing)) {
      latest.set(event.pubkey, event);
    }
    latestByIdentifier.set(dTag, latest);
  }
  return latestByIdentifier;
}

/** Select the latest addressable announcement for each author using NIP-01 ordering. */
export function latestRepositoryAnnouncements(
  events: Iterable<NostrEvent>,
  dTag: string,
): Map<string, NostrEvent> {
  return (
    latestRepositoryAnnouncementsByIdentifier(events).get(dTag) ?? new Map()
  );
}

function parseRoleRecord(
  author: string,
  tag: string[],
): RepositoryRoleRecord | undefined {
  const [rawRole, subject, ...rawBoundaries] = tag;
  if (
    !ROLE_NAMES.has(rawRole as RepositoryRole) ||
    !HEX_PUBKEY.test(subject ?? "")
  ) {
    return undefined;
  }

  const boundaries: (number | "defer")[] = [];
  for (let index = 0; index < rawBoundaries.length; index += 1) {
    const value = rawBoundaries[index];
    if (value === "defer") {
      const isFinalEnd = index % 2 === 1 && index === rawBoundaries.length - 1;
      if (!isFinalEnd) return undefined;
      boundaries.push(value);
      continue;
    }
    if (!/^\d+$/.test(value)) return undefined;
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp)) return undefined;
    boundaries.push(timestamp);
  }

  return {
    author,
    role: rawRole as RepositoryRole,
    subject,
    boundaries,
    active: boundaries.length === 0 || boundaries.length % 2 === 1,
  };
}

const parsedAnnouncementCache = new WeakMap<NostrEvent, ParsedAnnouncement>();

function parseAnnouncement(event: NostrEvent): ParsedAnnouncement {
  const cached = parsedAnnouncementCache.get(event);
  if (cached) return cached;
  const roleTags = event.tags.filter(([name]) =>
    ROLE_NAMES.has(name as RepositoryRole),
  );
  const hasIndexedRoles = roleTags.length > 0;
  const hasIndexedMaintainerRoles = roleTags.some(
    ([name]) => name === "M" || name === "m",
  );
  const hasLegacyMaintainersTag = event.tags.some(
    ([name]) => name === "maintainers",
  );
  const health: RepositoryHealthWarning[] = [];
  const duplicateCounts = new Map<string, number>();
  const roleRecords: RepositoryRoleRecord[] = [];

  for (const tag of roleTags) {
    const role = tag[0] as RepositoryRole;
    const subject = tag[1] ?? "";
    const record = parseRoleRecord(event.pubkey, tag);
    if (!record) {
      health.push({
        code: "invalid-role-record",
        message: `Invalid ${role} role record cannot grant authority`,
        author: event.pubkey,
        role,
        subject: HEX_PUBKEY.test(subject) ? subject : undefined,
      });
    } else {
      roleRecords.push(record);
    }
    const key = `${role}:${subject}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of duplicateCounts) {
    if (count > 1) {
      const [role, subject] = key.split(":");
      health.push({
        code: "duplicate-role-record",
        message: `Duplicate ${role} role records are resolved independently`,
        author: event.pubkey,
        role: role as RepositoryRole,
        subject: HEX_PUBKEY.test(subject) ? subject : undefined,
      });
    }
  }

  const activeRoles = roleRecords
    .filter((record) => record.active)
    .map((record) => ({ role: record.role, pubkey: record.subject }));
  const activeMaintainers: ParsedAnnouncement["activeMaintainers"] = [];
  const activeModerators: string[] = [];
  const authorHasRoleEntry = roleTags.some((tag) => tag[1] === event.pubkey);

  if (hasIndexedRoles) {
    if (!authorHasRoleEntry) {
      activeMaintainers.push({
        pubkey: event.pubkey,
        role: "m",
        source: "indexed",
      });
    }
    for (const record of roleRecords) {
      if (!record.active) continue;
      if (record.role === "o") {
        pushUnique(activeModerators, record.subject);
      } else if (
        !activeMaintainers.some(({ pubkey }) => pubkey === record.subject)
      ) {
        activeMaintainers.push({
          pubkey: record.subject,
          role: record.role,
          source: "indexed",
        });
      }
    }

    const compatibilityTags = event.tags.filter(
      ([name]) => name === "maintainers",
    );
    const projected = new Set(
      roleRecords
        .filter(
          (record) =>
            record.active && (record.role === "M" || record.role === "m"),
        )
        .map((record) => record.subject),
    );
    const compatibility = new Set(
      compatibilityTags.flatMap((tag) => tag.slice(1)),
    );
    if (
      compatibilityTags.length !== 1 ||
      projected.size !== compatibility.size ||
      [...projected].some((pubkey) => !compatibility.has(pubkey))
    ) {
      health.push({
        code: "inconsistent-maintainers-projection",
        message:
          "The deprecated maintainers tag does not match active M/m roles",
        author: event.pubkey,
      });
    }
  } else {
    activeMaintainers.push({
      pubkey: event.pubkey,
      role: "m",
      source: "legacy",
    });
    for (const tag of event.tags) {
      if (tag[0] !== "maintainers") continue;
      for (const pubkey of tag.slice(1)) {
        if (
          HEX_PUBKEY.test(pubkey) &&
          !activeMaintainers.some((entry) => entry.pubkey === pubkey)
        ) {
          activeMaintainers.push({ pubkey, role: "m", source: "legacy" });
        }
      }
    }
  }

  const selfRoleRecords = roleRecords.filter(
    (record) => record.subject === event.pubkey,
  );
  const authorDeclinesMaintainership =
    authorHasRoleEntry &&
    !selfRoleRecords.some(
      (record) => record.active && (record.role === "M" || record.role === "m"),
    );
  const selfModeratorRecords = selfRoleRecords.filter(
    (record) => record.role === "o",
  );
  const authorHasModeratorEntry = roleTags.some(
    ([role, subject]) => role === "o" && subject === event.pubkey,
  );
  const authorDeclinesModeratorship =
    authorHasModeratorEntry &&
    !selfModeratorRecords.some((record) => record.active);

  const parsed: ParsedAnnouncement = {
    event,
    roleRecords,
    activeMaintainers,
    activeModerators,
    activeRoles,
    hasIndexedRoles,
    hasIndexedMaintainerRoles,
    hasLegacyMaintainersTag,
    authorDeclinesMaintainership,
    authorDeclinesModeratorship,
    health,
  };
  parsedAnnouncementCache.set(event, parsed);
  return parsed;
}

/** Active role subjects used for announcement discovery, never authorization. */
export function getRepositoryAnnouncementDiscoveryPubkeys(
  event: NostrEvent,
): string[] {
  const parsed = parseAnnouncement(event);
  return [
    ...new Set([
      ...parsed.activeMaintainers.map(({ pubkey }) => pubkey),
      ...parsed.activeModerators,
    ]),
  ];
}

/** Active current maintainer assignments, respecting indexed-role precedence. */
export function getRepositoryMaintainerAssignments(
  event: NostrEvent,
): string[] {
  return parseAnnouncement(event).activeMaintainers.map(({ pubkey }) => pubkey);
}

function resolveConfirmationSeed(
  selectedMaintainer: string,
  parsedByPubkey: ReadonlyMap<string, ParsedAnnouncement>,
  declined: ReadonlySet<string>,
): string | undefined {
  let current = selectedMaintainer;
  let followedExplicitLead = false;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const announcement = parsedByPubkey.get(current);
    if (!announcement) {
      return !followedExplicitLead && !declined.has(current)
        ? current
        : undefined;
    }
    const leads = [
      ...new Set(
        announcement.activeRoles
          .filter(({ role }) => role === "M")
          .map(({ pubkey }) => pubkey),
      ),
    ];
    if (leads.length === 0) {
      return !followedExplicitLead && !declined.has(current)
        ? current
        : undefined;
    }
    if (leads.length !== 1) return undefined;
    const target = leads[0];
    followedExplicitLead = true;
    if (target === current) return declined.has(target) ? undefined : target;
    current = target;
  }
}

function resolveLead(
  selectedMaintainer: string,
  parsedByPubkey: ReadonlyMap<string, ParsedAnnouncement>,
  confirmedMaintainers: ReadonlySet<string>,
): LeadResolution {
  const selected = parsedByPubkey.get(selectedMaintainer);
  if (!selected) {
    return { source: "pending", path: [selectedMaintainer] };
  }

  const activeLeads = (announcement: ParsedAnnouncement): string[] => [
    ...new Set(
      announcement.activeRoles
        .filter(({ role }) => role === "M")
        .map(({ pubkey }) => pubkey),
    ),
  ];
  const selectedLeads = activeLeads(selected);
  if (selectedLeads.length === 0) {
    if (selected.hasIndexedMaintainerRoles) {
      return { source: "explicit_none", path: [selectedMaintainer] };
    }
    if (selected.hasIndexedRoles) {
      return { source: "none", path: [selectedMaintainer] };
    }
    if (
      !selected.hasLegacyMaintainersTag &&
      confirmedMaintainers.size === 1 &&
      confirmedMaintainers.has(selectedMaintainer)
    ) {
      return {
        leadMaintainer: selectedMaintainer,
        source: "implicit_sole",
        path: [selectedMaintainer],
      };
    }

    const votes = new Map<string, number>();
    for (const announcement of parsedByPubkey.values()) {
      if (!confirmedMaintainers.has(announcement.event.pubkey)) continue;
      if (announcement.hasIndexedRoles) {
        for (const target of activeLeads(announcement)) {
          if (
            target !== announcement.event.pubkey &&
            confirmedMaintainers.has(target)
          ) {
            votes.set(target, (votes.get(target) ?? 0) + 1);
          }
        }
      } else {
        for (const { pubkey: target } of announcement.activeMaintainers) {
          if (
            target !== announcement.event.pubkey &&
            confirmedMaintainers.has(target)
          ) {
            votes.set(target, (votes.get(target) ?? 0) + 1);
          }
        }
      }
    }
    const highest = Math.max(0, ...votes.values());
    const winners = [...votes]
      .filter(([, count]) => count === highest && count > 0)
      .map(([pubkey]) => pubkey);
    if (winners.length !== 1) {
      return { source: "none", path: [selectedMaintainer] };
    }
    const leadMaintainer = winners[0];
    return {
      leadMaintainer,
      source: "legacy_inferred",
      path:
        leadMaintainer === selectedMaintainer
          ? [selectedMaintainer]
          : [selectedMaintainer, leadMaintainer],
    };
  }

  const path = [selectedMaintainer];
  const visited = new Set(path);
  let current = selectedMaintainer;
  while (true) {
    const announcement = parsedByPubkey.get(current);
    if (!announcement) return { source: "pending", path };
    const leads = activeLeads(announcement);
    if (leads.length !== 1) {
      return { source: leads.length === 0 ? "pending" : "conflict", path };
    }
    const target = leads[0];
    if (target === current) {
      return confirmedMaintainers.has(target)
        ? { leadMaintainer: target, source: "explicit", path }
        : { source: "pending", path };
    }
    path.push(target);
    if (visited.has(target)) return { source: "conflict", path };
    visited.add(target);
    if (parsedByPubkey.get(target)?.authorDeclinesMaintainership) {
      return { source: "conflict", path };
    }
    current = target;
  }
}

export function resolveRepositoryMembership(
  events: Iterable<NostrEvent>,
  selectedMaintainer: string,
  dTag: string,
): RepositoryMembershipResolution | undefined {
  const latestByPubkey = latestRepositoryAnnouncements(events, dTag);
  return resolveRepositoryMembershipFromLatest(
    latestByPubkey,
    selectedMaintainer,
    dTag,
  );
}

/** Resolve one rooted view from an already reduced identifier partition. */
export function resolveRepositoryMembershipFromLatest(
  latestByPubkey: ReadonlyMap<string, NostrEvent>,
  selectedMaintainer: string,
  dTag: string,
): RepositoryMembershipResolution | undefined {
  if (!latestByPubkey.has(selectedMaintainer)) return undefined;

  const parsedByPubkey = new Map<string, ParsedAnnouncement>();
  const discoveryPubkeys: string[] = [];
  const queue = [selectedMaintainer];
  const maintainerCandidates: string[] = [];
  const moderatorCandidates: string[] = [];
  const maintainerEdges: MaintainerEdge[] = [];
  const moderatorEdges: ModeratorEdge[] = [];
  const repositoryHealth: RepositoryHealthWarning[] = [];
  const edgeKeys = new Set<string>();
  const moderatorEdgeKeys = new Set<string>();

  while (queue.length > 0) {
    const pubkey = queue.shift()!;
    if (discoveryPubkeys.includes(pubkey)) continue;
    discoveryPubkeys.push(pubkey);
    const event = latestByPubkey.get(pubkey);
    if (!event) continue;
    const parsed = parseAnnouncement(event);
    parsedByPubkey.set(pubkey, parsed);
    repositoryHealth.push(...parsed.health);

    for (const assignment of parsed.activeMaintainers) {
      pushUnique(maintainerCandidates, assignment.pubkey);
      if (!discoveryPubkeys.includes(assignment.pubkey))
        queue.push(assignment.pubkey);
      if (assignment.pubkey === pubkey) continue;
      const key = `${pubkey}:${assignment.pubkey}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        maintainerEdges.push({
          from: pubkey,
          to: assignment.pubkey,
          role: assignment.role,
          source: assignment.source,
        });
      }
    }
    for (const moderator of parsed.activeModerators) {
      pushUnique(moderatorCandidates, moderator);
      if (!discoveryPubkeys.includes(moderator)) queue.push(moderator);
      const key = `${pubkey}:${moderator}`;
      if (!moderatorEdgeKeys.has(key)) {
        moderatorEdgeKeys.add(key);
        moderatorEdges.push({ from: pubkey, to: moderator, source: "indexed" });
      }
    }
  }

  const declinedMaintainers = new Set(
    [...parsedByPubkey.values()]
      .filter(
        ({ authorDeclinesMaintainership }) => authorDeclinesMaintainership,
      )
      .map(({ event }) => event.pubkey),
  );
  const confirmedMaintainerSet = new Set<string>();
  const seed = resolveConfirmationSeed(
    selectedMaintainer,
    parsedByPubkey,
    declinedMaintainers,
  );
  if (seed) confirmedMaintainerSet.add(seed);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of maintainerCandidates) {
      if (
        confirmedMaintainerSet.has(candidate) ||
        declinedMaintainers.has(candidate)
      ) {
        continue;
      }
      const listedByMember = maintainerEdges.some(
        ({ from, to }) => to === candidate && confirmedMaintainerSet.has(from),
      );
      const acknowledgesMember = maintainerEdges.some(
        ({ from, to }) => from === candidate && confirmedMaintainerSet.has(to),
      );
      if (listedByMember && acknowledgesMember) {
        confirmedMaintainerSet.add(candidate);
        changed = true;
      }
    }
  }

  const confirmedMaintainers = maintainerCandidates.filter((pubkey) =>
    confirmedMaintainerSet.has(pubkey),
  );
  if (seed && !confirmedMaintainers.includes(seed)) {
    confirmedMaintainers.unshift(seed);
  }

  const assignedModerators: string[] = [];
  for (const maintainer of confirmedMaintainers) {
    const parsed = parsedByPubkey.get(maintainer);
    for (const moderator of parsed?.activeModerators ?? []) {
      pushUnique(assignedModerators, moderator);
    }
  }
  const declinedModerators = new Set(
    [...parsedByPubkey.values()]
      .filter(({ authorDeclinesModeratorship }) => authorDeclinesModeratorship)
      .map(({ event }) => event.pubkey),
  );
  const confirmedModerators: string[] = [];
  const confirmedMemberSet = new Set(confirmedMaintainers);
  changed = true;
  while (changed) {
    changed = false;
    for (const candidate of assignedModerators) {
      if (
        confirmedModerators.includes(candidate) ||
        declinedModerators.has(candidate)
      ) {
        continue;
      }
      const parsed = parsedByPubkey.get(candidate);
      if (!parsed) continue;
      const acknowledgesRole = parsed.activeRoles.some(
        ({ role, pubkey }) => role === "o" && pubkey === candidate,
      );
      const acknowledgesMember = parsed.activeRoles.some(
        ({ pubkey }) => pubkey !== candidate && confirmedMemberSet.has(pubkey),
      );
      if (acknowledgesRole && acknowledgesMember) {
        confirmedModerators.push(candidate);
        confirmedMemberSet.add(candidate);
        changed = true;
      }
    }
  }

  const confirmedMembers = [...confirmedMaintainers, ...confirmedModerators];
  const confirmedAnnouncements = confirmedMembers.flatMap((pubkey) => {
    const event = latestByPubkey.get(pubkey);
    return event ? [event] : [];
  });
  const discoveredAnnouncements = discoveryPubkeys.flatMap((pubkey) => {
    const event = latestByPubkey.get(pubkey);
    return event ? [event] : [];
  });

  return {
    selectedMaintainer,
    dTag,
    confirmedMaintainers,
    confirmedModerators,
    confirmedMembers,
    invitedMaintainers: maintainerCandidates.filter(
      (pubkey) =>
        !confirmedMaintainerSet.has(pubkey) && !declinedMaintainers.has(pubkey),
    ),
    invitedModerators: assignedModerators.filter(
      (pubkey) =>
        !confirmedModerators.includes(pubkey) &&
        !declinedModerators.has(pubkey),
    ),
    departedMaintainers: [...declinedMaintainers],
    departedModerators: [...declinedModerators],
    discoveryPubkeys,
    discoveredAnnouncements,
    confirmedAnnouncements,
    maintainerEdges,
    moderatorEdges,
    repositoryHealth,
    leadResolution: resolveLead(
      selectedMaintainer,
      parsedByPubkey,
      confirmedMaintainerSet,
    ),
  };
}
