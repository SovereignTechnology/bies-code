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
  /** Start of the current assignment interval, when it is signed. */
  activeSince?: number;
  /** A reopened interval cannot reuse an acknowledgement of an older interval. */
  requiresFreshAcceptance: boolean;
}

export interface ModeratorEdge {
  from: string;
  to: string;
  source: "indexed";
  activeSince?: number;
  requiresFreshAcceptance: boolean;
}

export type RepositoryHealthCode =
  | "invalid-role-record"
  | "invalid-self-defer"
  | "duplicate-role-record"
  | "inconsistent-maintainers-projection";

export interface RepositoryHealthWarning {
  code: RepositoryHealthCode;
  message: string;
  author: string;
  role?: RepositoryRole;
  subject?: string;
  /**
   * Present only on a duplicate-role-record warning. True when the duplicate
   * consists of exactly one invalid self-defer beside one valid same-role
   * record holding a single strictly later signed start, so the signer's
   * sanctioned self-defer repair (or invitation acceptance) merges both into
   * one multi-interval record and eliminates the duplicate. Genuinely
   * duplicated valid records stay false.
   */
  repairableBySelfDefer?: boolean;
  /** Repair context present only for a syntactically valid invalid self-defer. */
  selfDefer?: {
    /** Signed start of the unresolved interval. */
    lastValidStart: number;
    /** Earlier closed intervals make implicit acceptance repair unsafe. */
    hasPriorIntervals: boolean;
    /** A strictly later signed active self-role can restore current authority. */
    superseded: boolean;
    /** Unambiguous numeric boundary a signer may approve as a repair. */
    proposedEnd?: number;
    /** Role of the unambiguous active successor, when one exists. */
    successorRole?: RepositoryRole;
  };
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
    activeSince?: number;
    requiresFreshAcceptance: boolean;
  }[];
  activeModerators: string[];
  activeRoles: { role: RepositoryRole; pubkey: string }[];
  hasIndexedRoles: boolean;
  hasIndexedMaintainerRoles: boolean;
  hasLegacyMaintainersTag: boolean;
  authorDeclinesMaintainership: boolean;
  authorDeclinesModeratorship: boolean;
  authorCannotMaintain: boolean;
  authorCannotModerate: boolean;
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
  /** Historical role subjects fetched for event-time authorization only. */
  historyPubkeys: string[];
  /** Latest events for current discovery plus retained history subjects. */
  historicalAnnouncements: NostrEvent[];
  confirmedAnnouncements: NostrEvent[];
  maintainerEdges: MaintainerEdge[];
  moderatorEdges: ModeratorEdge[];
  repositoryHealth: RepositoryHealthWarning[];
  leadResolution: LeadResolution;
  /** Signed kind-5 end boundary for an author's latest announcement. */
  deletedAnnouncementTimestamps: ReadonlyMap<string, number>;
}

export type HistoricalRoleState = "active" | "inactive" | "unknown";

export interface RepositoryAuthorRoleHistory {
  author: string;
  records: RepositoryRoleRecord[];
  /** Raw role keys that were malformed or duplicated in this announcement. */
  disputedKeys: string[];
  /** No self-role at all means implicit maintainership for the full history. */
  implicitMaintainer: boolean;
}

export interface ResolvedRepositoryRoleRecord extends RepositoryRoleRecord {
  sourceDistance: number;
  conflicts: RepositoryRoleRecord[];
}

/** Replicated history view used only for authorization at publication time. */
export interface RepositoryRoleHistory {
  selectedMaintainer: string;
  dTag: string;
  /** Today's maintainers provide conservative roots for older graph views. */
  currentConfirmedMaintainers: string[];
  authorHistories: RepositoryAuthorRoleHistory[];
  resolvedRecords: ResolvedRepositoryRoleRecord[];
}

/**
 * Stable structural key for a role history. The resolver rebuilds the
 * history object on every announcement-graph emission, so identity-based
 * React dependency comparisons would treat content-identical histories as
 * changes. History derivation is deterministic over the announcement set,
 * making this serialization a reliable equality key.
 */
export function roleHistoryCacheKey(history?: RepositoryRoleHistory): string {
  return history ? JSON.stringify(history) : "";
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

/** Resolve applicable signed deletion boundaries for one repository identifier. */
function repositoryAnnouncementDeletionTimes(
  deletionEvents: Iterable<NostrEvent>,
  dTag: string,
  latestByPubkey: ReadonlyMap<string, NostrEvent>,
): Map<string, number> {
  const deletedAt = new Map<string, number>();
  const latestById = new Map(
    [...latestByPubkey.values()].map((event) => [event.id, event]),
  );
  const record = (pubkey: string, createdAt: number) => {
    const announcement = latestByPubkey.get(pubkey);
    if (announcement && createdAt < announcement.created_at) return;
    deletedAt.set(pubkey, Math.max(deletedAt.get(pubkey) ?? 0, createdAt));
  };

  for (const deletion of deletionEvents) {
    if (deletion.kind !== 5) continue;
    for (const [name, value] of deletion.tags) {
      if (name === "a") {
        const prefix = `${REPOSITORY_ANNOUNCEMENT_KIND}:${deletion.pubkey}:`;
        if (value === `${prefix}${dTag}`) {
          record(deletion.pubkey, deletion.created_at);
        }
      } else if (name === "e") {
        const announcement = latestById.get(value ?? "");
        if (announcement?.pubkey === deletion.pubkey) {
          record(deletion.pubkey, deletion.created_at);
        }
      }
    }
  }
  return deletedAt;
}

function parseRepositoryRoleRecordSyntax(
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

/** Parse a valid role record. A self-authored defer is deliberately invalid. */
export function parseRepositoryRoleRecord(
  author: string,
  tag: string[],
): RepositoryRoleRecord | undefined {
  const record = parseRepositoryRoleRecordSyntax(author, tag);
  return record?.subject === author && record.boundaries.at(-1) === "defer"
    ? undefined
    : record;
}

/**
 * Return the otherwise well-formed record behind an invalid self-defer. This is
 * diagnostic and repair input only; callers must never treat it as authority.
 */
export function parseInvalidSelfDeferRoleRecord(
  author: string,
  tag: string[],
): RepositoryRoleRecord | undefined {
  const record = parseRepositoryRoleRecordSyntax(author, tag);
  return record?.subject === author && record.boundaries.at(-1) === "defer"
    ? record
    : undefined;
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
  const roleRecordTags = new Map<RepositoryRoleRecord, string[]>();
  const invalidSelfDeferRecords: {
    record: RepositoryRoleRecord;
    warning: RepositoryHealthWarning;
  }[] = [];

  for (const tag of roleTags) {
    const role = tag[0] as RepositoryRole;
    const subject = tag[1] ?? "";
    const record = parseRepositoryRoleRecord(event.pubkey, tag);
    if (!record) {
      const invalidSelfDefer = parseInvalidSelfDeferRoleRecord(
        event.pubkey,
        tag,
      );
      const warning: RepositoryHealthWarning = {
        code: invalidSelfDefer ? "invalid-self-defer" : "invalid-role-record",
        message: invalidSelfDefer
          ? "A self-authored role cannot end in defer; use a numeric end or an active open interval"
          : `Invalid ${role} role record cannot grant authority`,
        author: event.pubkey,
        role,
        subject: HEX_PUBKEY.test(subject) ? subject : undefined,
      };
      health.push(warning);
      if (invalidSelfDefer) {
        invalidSelfDeferRecords.push({ record: invalidSelfDefer, warning });
      }
    } else {
      roleRecords.push(record);
      roleRecordTags.set(record, tag);
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
        requiresFreshAcceptance: false,
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
          activeSince:
            typeof record.boundaries[record.boundaries.length - 1] === "number"
              ? (record.boundaries[record.boundaries.length - 1] as number)
              : undefined,
          requiresFreshAcceptance: record.boundaries.length >= 3,
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
      requiresFreshAcceptance: false,
    });
    for (const tag of event.tags) {
      if (tag[0] !== "maintainers") continue;
      for (const pubkey of tag.slice(1)) {
        if (
          HEX_PUBKEY.test(pubkey) &&
          !activeMaintainers.some((entry) => entry.pubkey === pubkey)
        ) {
          activeMaintainers.push({
            pubkey,
            role: "m",
            source: "legacy",
            requiresFreshAcceptance: false,
          });
        }
      }
    }
  }

  const selfRoleRecords = roleRecords.filter(
    (record) => record.subject === event.pubkey,
  );
  const activeSelfMaintainerRecords = selfRoleRecords.filter(
    (record) => record.active && (record.role === "M" || record.role === "m"),
  );
  const activeSelfModeratorRecords = selfRoleRecords.filter(
    (record) => record.active && record.role === "o",
  );
  for (const { record: invalidRecord, warning } of invalidSelfDeferRecords) {
    const lastValidStart = invalidRecord.boundaries.at(-2);
    if (typeof lastValidStart !== "number") continue;
    const successorsByTag = new Map<
      string,
      { role: RepositoryRole; start: number }
    >();
    for (const record of selfRoleRecords) {
      const start = record.boundaries.at(-1);
      if (
        !record.active ||
        typeof start !== "number" ||
        start <= lastValidStart
      ) {
        continue;
      }
      const tag = roleRecordTags.get(record);
      if (tag)
        successorsByTag.set(JSON.stringify(tag), { role: record.role, start });
    }
    const successors = [...successorsByTag.values()];
    const sameRoleInvalidRecords = invalidSelfDeferRecords.filter(
      ({ record }) => record.role === invalidRecord.role,
    );
    const unambiguousSuccessor =
      successors.length === 1 && sameRoleInvalidRecords.length === 1
        ? successors[0]
        : undefined;
    warning.selfDefer = {
      lastValidStart,
      hasPriorIntervals: invalidRecord.boundaries.length > 2,
      superseded: successors.length > 0,
      proposedEnd: unambiguousSuccessor?.start,
      successorRole: unambiguousSuccessor?.role,
    };
  }
  for (const warning of health) {
    if (warning.code !== "duplicate-role-record" || !warning.subject) continue;
    const sameKey = (record: RepositoryRoleRecord) =>
      record.role === warning.role && record.subject === warning.subject;
    const validRecords = roleRecords.filter(sameKey);
    const invalidEntries = invalidSelfDeferRecords.filter(({ record }) =>
      sameKey(record),
    );
    const successorStart = validRecords[0]?.boundaries[0];
    const deferStart = invalidEntries[0]?.warning.selfDefer?.lastValidStart;
    warning.repairableBySelfDefer =
      duplicateCounts.get(`${warning.role}:${warning.subject}`) === 2 &&
      validRecords.length === 1 &&
      invalidEntries.length === 1 &&
      validRecords[0].boundaries.length === 1 &&
      typeof successorStart === "number" &&
      typeof deferStart === "number" &&
      successorStart > deferStart;
  }
  const selfDeferWarnings = health.filter(
    (warning) => warning.code === "invalid-self-defer",
  );
  const unresolvedSelfDefer = selfDeferWarnings.some(
    (warning) => !warning.selfDefer?.superseded,
  );
  const hasValidSelfMaintainerRecord = selfRoleRecords.some(
    ({ role }) => role === "M" || role === "m",
  );
  const hasInvalidSelfMaintainerDefer = invalidSelfDeferRecords.some(
    ({ record }) => record.role === "M" || record.role === "m",
  );
  const authorDeclinesMaintainership =
    activeSelfMaintainerRecords.length === 0 &&
    (hasValidSelfMaintainerRecord ||
      (selfRoleRecords.length > 0 && !hasInvalidSelfMaintainerDefer));
  const selfModeratorRecords = selfRoleRecords.filter(
    (record) => record.role === "o",
  );
  const authorHasModeratorEntry = roleTags.some(
    ([role, subject]) => role === "o" && subject === event.pubkey,
  );
  const authorDeclinesModeratorship =
    selfModeratorRecords.length > 0 && activeSelfModeratorRecords.length === 0;
  const authorCannotMaintain =
    authorHasRoleEntry &&
    (activeSelfMaintainerRecords.length === 0 || unresolvedSelfDefer);
  const authorCannotModerate =
    authorHasModeratorEntry &&
    (activeSelfModeratorRecords.length === 0 || unresolvedSelfDefer);

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
    authorCannotMaintain,
    authorCannotModerate,
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

/** Valid indexed role subjects whose announcements may supply retained history. */
export function getRepositoryHistoryPubkeys(event: NostrEvent): string[] {
  return [
    ...new Set(
      parseAnnouncement(event).roleRecords.map(({ subject }) => subject),
    ),
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
    if (parsedByPubkey.get(target)?.authorCannotMaintain) {
      return { source: "conflict", path };
    }
    current = target;
  }
}

function selfAcceptanceCoversAssignment(
  candidate: ParsedAnnouncement | undefined,
  edge: {
    role: RepositoryRole;
  },
): boolean {
  if (!candidate) return false;
  if (
    (edge.role === "o" && candidate.authorCannotModerate) ||
    (edge.role !== "o" && candidate.authorCannotMaintain)
  ) {
    return false;
  }
  const acceptedRoles =
    edge.role === "o"
      ? new Set<RepositoryRole>(["o"])
      : new Set<RepositoryRole>(["M", "m"]);
  const selfRecords = candidate.roleRecords.filter(
    (record) =>
      record.subject === candidate.event.pubkey &&
      acceptedRoles.has(record.role) &&
      record.active,
  );
  return (
    selfRecords.length > 0 ||
    (edge.role !== "o" && !candidate.authorCannotMaintain)
  );
}

export function resolveRepositoryMembership(
  events: Iterable<NostrEvent>,
  selectedMaintainer: string,
  dTag: string,
): RepositoryMembershipResolution | undefined {
  const snapshot = [...events];
  const latestByPubkey = latestRepositoryAnnouncements(snapshot, dTag);
  return resolveRepositoryMembershipFromLatest(
    latestByPubkey,
    selectedMaintainer,
    dTag,
    snapshot,
  );
}

/** Resolve one rooted view from an already reduced identifier partition. */
export function resolveRepositoryMembershipFromLatest(
  latestByPubkey: ReadonlyMap<string, NostrEvent>,
  selectedMaintainer: string,
  dTag: string,
  deletionEvents: Iterable<NostrEvent> = [],
): RepositoryMembershipResolution | undefined {
  if (!latestByPubkey.has(selectedMaintainer)) return undefined;
  const deletedAnnouncementTimestamps = repositoryAnnouncementDeletionTimes(
    deletionEvents,
    dTag,
    latestByPubkey,
  );

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
    if (deletedAnnouncementTimestamps.has(pubkey)) continue;
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
          activeSince: assignment.activeSince,
          requiresFreshAcceptance: assignment.requiresFreshAcceptance,
        });
      }
    }
    for (const moderator of parsed.activeModerators) {
      pushUnique(moderatorCandidates, moderator);
      if (!discoveryPubkeys.includes(moderator)) queue.push(moderator);
      const key = `${pubkey}:${moderator}`;
      if (!moderatorEdgeKeys.has(key)) {
        moderatorEdgeKeys.add(key);
        const record = parsed.roleRecords.find(
          (candidate) =>
            candidate.role === "o" &&
            candidate.subject === moderator &&
            candidate.active,
        );
        moderatorEdges.push({
          from: pubkey,
          to: moderator,
          source: "indexed",
          activeSince:
            record &&
            typeof record.boundaries[record.boundaries.length - 1] === "number"
              ? (record.boundaries[record.boundaries.length - 1] as number)
              : undefined,
          requiresFreshAcceptance: (record?.boundaries.length ?? 0) >= 3,
        });
      }
    }
  }

  const relevantDeletionPubkeys = new Set([
    selectedMaintainer,
    ...discoveryPubkeys,
    ...[...parsedByPubkey.values()].flatMap(({ roleRecords }) =>
      roleRecords.map(({ subject }) => subject),
    ),
  ]);
  const applicableDeletedTimestamps = new Map(
    [...deletedAnnouncementTimestamps].filter(([pubkey]) =>
      relevantDeletionPubkeys.has(pubkey),
    ),
  );

  const departedMaintainers = new Set([
    ...[...parsedByPubkey.values()]
      .filter(
        ({ authorDeclinesMaintainership }) => authorDeclinesMaintainership,
      )
      .map(({ event }) => event.pubkey),
    ...applicableDeletedTimestamps.keys(),
  ]);
  const ineligibleMaintainers = new Set([
    ...[...parsedByPubkey.values()]
      .filter(({ authorCannotMaintain }) => authorCannotMaintain)
      .map(({ event }) => event.pubkey),
    ...applicableDeletedTimestamps.keys(),
  ]);
  const confirmedMaintainerSet = new Set<string>();
  const seed = resolveConfirmationSeed(
    selectedMaintainer,
    parsedByPubkey,
    ineligibleMaintainers,
  );
  if (seed) confirmedMaintainerSet.add(seed);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of maintainerCandidates) {
      if (
        confirmedMaintainerSet.has(candidate) ||
        ineligibleMaintainers.has(candidate)
      ) {
        continue;
      }
      const candidateAnnouncement = parsedByPubkey.get(candidate);
      const listedByMember = maintainerEdges.some(
        (edge) =>
          edge.to === candidate &&
          confirmedMaintainerSet.has(edge.from) &&
          selfAcceptanceCoversAssignment(candidateAnnouncement, edge),
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
  const departedModerators = new Set([
    ...[...parsedByPubkey.values()]
      .filter(({ authorDeclinesModeratorship }) => authorDeclinesModeratorship)
      .map(({ event }) => event.pubkey),
    ...applicableDeletedTimestamps.keys(),
  ]);
  const ineligibleModerators = new Set([
    ...[...parsedByPubkey.values()]
      .filter(({ authorCannotModerate }) => authorCannotModerate)
      .map(({ event }) => event.pubkey),
    ...applicableDeletedTimestamps.keys(),
  ]);
  const confirmedModerators: string[] = [];
  const confirmedMemberSet = new Set(confirmedMaintainers);
  changed = true;
  while (changed) {
    changed = false;
    for (const candidate of assignedModerators) {
      if (
        confirmedModerators.includes(candidate) ||
        ineligibleModerators.has(candidate)
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
      const assignedWithCurrentAcceptance = moderatorEdges.some(
        (edge) =>
          edge.to === candidate &&
          confirmedMaintainerSet.has(edge.from) &&
          selfAcceptanceCoversAssignment(parsed, { ...edge, role: "o" }),
      );
      if (
        assignedWithCurrentAcceptance &&
        acknowledgesRole &&
        acknowledgesMember
      ) {
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
  const historyPubkeys = [
    ...new Set(
      [selectedMaintainer, ...confirmedMembers].flatMap((pubkey) => {
        const parsed = parsedByPubkey.get(pubkey);
        return [
          pubkey,
          ...(parsed?.roleRecords.map(({ subject }) => subject) ?? []),
        ];
      }),
    ),
  ];
  const historicalAnnouncements = historyPubkeys.flatMap((pubkey) => {
    const event = latestByPubkey.get(pubkey);
    return event ? [event] : [];
  });

  return {
    selectedMaintainer,
    dTag,
    confirmedMaintainers,
    confirmedModerators,
    confirmedMembers,
    invitedMaintainers: maintainerCandidates.filter((pubkey) => {
      if (confirmedMaintainerSet.has(pubkey)) return false;
      const incomingAssignments = maintainerEdges.filter(
        (edge) => edge.to === pubkey && confirmedMaintainerSet.has(edge.from),
      );
      if (incomingAssignments.length === 0) return false;
      return (
        !departedMaintainers.has(pubkey) ||
        incomingAssignments.some(({ requiresFreshAcceptance }) =>
          Boolean(requiresFreshAcceptance),
        )
      );
    }),
    invitedModerators: assignedModerators.filter((pubkey) => {
      if (confirmedModerators.includes(pubkey)) return false;
      if (!departedModerators.has(pubkey)) return true;
      return moderatorEdges.some(
        (edge) =>
          edge.to === pubkey &&
          confirmedMaintainerSet.has(edge.from) &&
          edge.requiresFreshAcceptance,
      );
    }),
    departedMaintainers: [...departedMaintainers],
    departedModerators: [...departedModerators],
    discoveryPubkeys,
    discoveredAnnouncements,
    historyPubkeys,
    historicalAnnouncements,
    confirmedAnnouncements,
    maintainerEdges,
    moderatorEdges,
    repositoryHealth,
    leadResolution: resolveLead(
      selectedMaintainer,
      parsedByPubkey,
      confirmedMaintainerSet,
    ),
    deletedAnnouncementTimestamps: applicableDeletedTimestamps,
  };
}

function roleKey(role: RepositoryRole, subject: string): string {
  return `${role}:${subject}`;
}

function authorRoleHistory(
  event: NostrEvent,
  deletedAt?: number,
): RepositoryAuthorRoleHistory {
  const roleTags = event.tags.filter(([name]) =>
    ROLE_NAMES.has(name as RepositoryRole),
  );
  if (roleTags.length === 0) {
    const subjects = new Set<string>([event.pubkey]);
    for (const tag of event.tags) {
      if (tag[0] !== "maintainers") continue;
      for (const subject of tag.slice(1)) {
        if (HEX_PUBKEY.test(subject)) subjects.add(subject);
      }
    }
    const records: RepositoryRoleRecord[] = [...subjects].map((subject) => ({
      author: event.pubkey,
      role: "m",
      subject,
      // Legacy maintainers tags are untimed active role records. Their missing
      // start is represented by an empty history, which covers the role from
      // the beginning until later evidence closes it.
      boundaries: [],
      active: true,
    }));
    return {
      author: event.pubkey,
      records: closeDeletedRoleRecords(records, deletedAt),
      disputedKeys: [],
      implicitMaintainer: true,
    };
  }

  const records: RepositoryRoleRecord[] = [];
  const counts = new Map<string, number>();
  const disputed = new Set<string>();
  for (const tag of roleTags) {
    const role = tag[0] as RepositoryRole;
    const subject = tag[1] ?? "";
    if (HEX_PUBKEY.test(subject)) {
      const key = roleKey(role, subject);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const record = parseRepositoryRoleRecord(event.pubkey, tag);
      if (record) records.push(record);
      else disputed.add(key);
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) disputed.add(key);
  }

  const authorHasSelfRole = roleTags.some(
    ([, subject]) => subject === event.pubkey,
  );
  const implicitMaintainer = !authorHasSelfRole;
  if (implicitMaintainer) {
    records.push({
      author: event.pubkey,
      role: "m",
      subject: event.pubkey,
      boundaries: [],
      active: true,
    });
  }

  return {
    author: event.pubkey,
    records: closeDeletedRoleRecords(records, deletedAt),
    disputedKeys: [...disputed].sort(),
    implicitMaintainer,
  };
}

function closeDeletedRoleRecords(
  records: RepositoryRoleRecord[],
  deletedAt: number | undefined,
): RepositoryRoleRecord[] {
  if (deletedAt === undefined) return records;
  return records.map((record) =>
    record.active
      ? {
          ...record,
          boundaries:
            record.boundaries.length === 0
              ? [0, deletedAt]
              : [...record.boundaries, deletedAt],
          active: false,
        }
      : record,
  );
}

function currentGraphDistances(
  membership: RepositoryMembershipResolution,
): Map<string, number> {
  const distances = new Map<string, number>([
    [membership.selectedMaintainer, 0],
  ]);
  const confirmed = new Set(membership.confirmedMembers);
  const edges = [
    ...membership.maintainerEdges.map(({ from, to }) => [from, to] as const),
    ...membership.moderatorEdges.map(({ from, to }) => [from, to] as const),
  ].filter(([from, to]) => confirmed.has(from) && confirmed.has(to));
  const queue = [membership.selectedMaintainer];
  while (queue.length > 0) {
    const author = queue.shift()!;
    const nextDistance = (distances.get(author) ?? 0) + 1;
    for (const [from, to] of edges) {
      if (from !== author || distances.has(to)) continue;
      distances.set(to, nextDistance);
      queue.push(to);
    }
  }
  return distances;
}

/** Resolve replicated role records using selected/distance/pubkey precedence. */
export function resolveRepositoryRoleHistory(
  membership: RepositoryMembershipResolution,
): RepositoryRoleHistory {
  const histories = new Map(
    membership.historicalAnnouncements.map((event) => [
      event.pubkey,
      authorRoleHistory(
        event,
        membership.deletedAnnouncementTimestamps.get(event.pubkey),
      ),
    ]),
  );
  const sourceAuthors = new Set([
    membership.selectedMaintainer,
    ...membership.confirmedMembers,
  ]);
  const distances = currentGraphDistances(membership);
  const candidateKeys = new Set<string>();
  for (const author of sourceAuthors) {
    const history = histories.get(author);
    for (const record of history?.records ?? []) {
      candidateKeys.add(roleKey(record.role, record.subject));
    }
    for (const key of history?.disputedKeys ?? []) candidateKeys.add(key);
  }

  const resolvedRecords: ResolvedRepositoryRoleRecord[] = [];
  for (const key of [...candidateKeys].sort()) {
    const candidates = [...sourceAuthors].flatMap((author) => {
      const history = histories.get(author);
      if (!history) return [];
      const records = history.records.filter(
        (record) => roleKey(record.role, record.subject) === key,
      );
      const present = records.length > 0 || history.disputedKeys.includes(key);
      return present
        ? [
            {
              author,
              history,
              records,
              distance:
                author === membership.selectedMaintainer
                  ? -1
                  : (distances.get(author) ?? Number.MAX_SAFE_INTEGER),
            },
          ]
        : [];
    });
    candidates.sort(
      (left, right) =>
        left.distance - right.distance ||
        left.author.localeCompare(right.author),
    );
    const preferred = candidates[0];
    if (
      !preferred ||
      preferred.history.disputedKeys.includes(key) ||
      preferred.records.length !== 1
    ) {
      continue;
    }
    const selected = preferred.records[0];
    const conflicts = [...histories.values()]
      .flatMap(({ records }) => records)
      .filter((record) => roleKey(record.role, record.subject) === key)
      .filter(
        (record) =>
          record.author !== selected.author ||
          JSON.stringify(record.boundaries) !==
            JSON.stringify(selected.boundaries),
      );
    resolvedRecords.push({
      ...selected,
      sourceDistance: preferred.distance,
      conflicts,
    });
  }

  return {
    selectedMaintainer: membership.selectedMaintainer,
    dTag: membership.dTag,
    currentConfirmedMaintainers: membership.confirmedMaintainers,
    authorHistories: [...histories.values()].sort((a, b) =>
      a.author.localeCompare(b.author),
    ),
    resolvedRecords,
  };
}

/** Interpret one valid role record at a publication timestamp. */
export function repositoryRoleStateAt(
  record: Pick<RepositoryRoleRecord, "boundaries">,
  createdAt: number,
): HistoricalRoleState {
  const { boundaries } = record;
  if (boundaries.length === 0) return "active";
  for (let index = 0; index < boundaries.length; index += 2) {
    const start = boundaries[index];
    if (typeof start !== "number") return "unknown";
    if (createdAt < start) return "inactive";
    const end = boundaries[index + 1];
    if (end === undefined) return "active";
    if (end === "defer") return "unknown";
    if (createdAt < end) return "active";
  }
  return "inactive";
}

function authorHistoryByPubkey(
  history: RepositoryRoleHistory,
): Map<string, RepositoryAuthorRoleHistory> {
  return new Map(history.authorHistories.map((entry) => [entry.author, entry]));
}

function activeAuthorTargets(
  authorHistory: RepositoryAuthorRoleHistory | undefined,
  createdAt: number,
  roles: ReadonlySet<RepositoryRole>,
): string[] {
  if (!authorHistory) return [];
  return [
    ...new Set(
      authorHistory.records
        .filter(
          (record) =>
            roles.has(record.role) &&
            !authorHistory.disputedKeys.includes(
              roleKey(record.role, record.subject),
            ) &&
            repositoryRoleStateAt(record, createdAt) === "active",
        )
        .map((record) => record.subject),
    ),
  ];
}

function authorHasSelfRoleAt(
  authorHistory: RepositoryAuthorRoleHistory | undefined,
  createdAt: number,
  roles: ReadonlySet<RepositoryRole>,
): boolean {
  if (!authorHistory) return false;
  return authorHistory.records.some(
    (record) =>
      record.subject === authorHistory.author &&
      roles.has(record.role) &&
      !authorHistory.disputedKeys.includes(
        roleKey(record.role, record.subject),
      ) &&
      repositoryRoleStateAt(record, createdAt) === "active",
  );
}

function historicalSelfAcceptanceCoversAssignment(
  candidateHistory: RepositoryAuthorRoleHistory | undefined,
  createdAt: number,
  roles: ReadonlySet<RepositoryRole>,
): boolean {
  if (!candidateHistory) return false;
  const selfRecords = candidateHistory.records.filter(
    (record) =>
      record.subject === candidateHistory.author &&
      roles.has(record.role) &&
      !candidateHistory.disputedKeys.includes(
        roleKey(record.role, record.subject),
      ) &&
      repositoryRoleStateAt(record, createdAt) === "active",
  );
  return selfRecords.length > 0;
}

const MAINTAINER_ROLES = new Set<RepositoryRole>(["M", "m"]);
const LEAD_ROLE = new Set<RepositoryRole>(["M"]);
const MODERATOR_ROLE = new Set<RepositoryRole>(["o"]);
const historicalMemberCache = new WeakMap<
  RepositoryRoleHistory,
  Map<number, ReadonlySet<string>>
>();
const historicalMaintainerCache = new WeakMap<
  RepositoryRoleHistory,
  Map<number, ReadonlySet<string>>
>();

function historicalMaintainersFromRoot(
  history: RepositoryRoleHistory,
  createdAt: number,
  root: string,
): ReadonlySet<string> {
  const byAuthor = authorHistoryByPubkey(history);
  const confirmed = new Set<string>();
  const visited = new Set<string>();
  let current = root;
  let followedLead = false;
  while (true) {
    if (visited.has(current)) return new Set();
    visited.add(current);
    const currentHistory = byAuthor.get(current);
    const leads = activeAuthorTargets(currentHistory, createdAt, LEAD_ROLE);
    if (leads.length === 0) {
      if (
        !followedLead &&
        authorHasSelfRoleAt(currentHistory, createdAt, MAINTAINER_ROLES)
      ) {
        confirmed.add(current);
      }
      break;
    }
    if (leads.length !== 1) return new Set();
    followedLead = true;
    const target = leads[0];
    if (target === current) {
      if (authorHasSelfRoleAt(currentHistory, createdAt, LEAD_ROLE)) {
        confirmed.add(current);
      }
      break;
    }
    current = target;
  }

  const maintainerCandidates = new Set(
    history.resolvedRecords
      .filter(
        (record) =>
          MAINTAINER_ROLES.has(record.role) &&
          repositoryRoleStateAt(record, createdAt) === "active",
      )
      .map((record) => record.subject),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of maintainerCandidates) {
      if (confirmed.has(candidate)) continue;
      const assignedByMember = [...confirmed].some((author) => {
        const authorHistory = byAuthor.get(author);
        return activeAuthorTargets(
          authorHistory,
          createdAt,
          MAINTAINER_ROLES,
        ).includes(candidate);
      });
      if (!assignedByMember) continue;
      const candidateHistory = byAuthor.get(candidate);
      const acceptsAssignment = historicalSelfAcceptanceCoversAssignment(
        candidateHistory,
        createdAt,
        MAINTAINER_ROLES,
      );
      const acknowledgesMember = activeAuthorTargets(
        candidateHistory,
        createdAt,
        MAINTAINER_ROLES,
      ).some((target) => target !== candidate && confirmed.has(target));
      if (acceptsAssignment && acknowledgesMember) {
        confirmed.add(candidate);
        changed = true;
      }
    }
  }
  return confirmed;
}

/** Resolve the confirmed historical member set at an event timestamp. */
export function historicalRepositoryMembersAt(
  history: RepositoryRoleHistory,
  createdAt: number,
): ReadonlySet<string> {
  const cache = historicalMemberCache.get(history) ?? new Map();
  historicalMemberCache.set(history, cache);
  const cached = cache.get(createdAt);
  if (cached) return cached;

  const distinctComponents = new Map<string, ReadonlySet<string>>();
  for (const root of new Set([
    history.selectedMaintainer,
    ...history.currentConfirmedMaintainers,
  ])) {
    const component = historicalMaintainersFromRoot(history, createdAt, root);
    if (component.size === 0) continue;
    distinctComponents.set([...component].sort().join(":"), component);
  }
  // A present component assembled from multiple historical repositories is
  // ambiguous until a dedicated join workflow reconciles it.
  const confirmed =
    distinctComponents.size === 1
      ? new Set([...distinctComponents.values()][0])
      : new Set<string>();
  const byAuthor = authorHistoryByPubkey(history);

  const maintainerCache = historicalMaintainerCache.get(history) ?? new Map();
  historicalMaintainerCache.set(history, maintainerCache);
  maintainerCache.set(createdAt, new Set(confirmed));

  const members = new Set(confirmed);
  const moderatorCandidates = new Set(
    history.resolvedRecords
      .filter(
        (record) =>
          record.role === "o" &&
          repositoryRoleStateAt(record, createdAt) === "active",
      )
      .map((record) => record.subject),
  );
  for (const candidate of moderatorCandidates) {
    const assignedByMaintainer = [...confirmed].some((author) =>
      activeAuthorTargets(
        byAuthor.get(author),
        createdAt,
        MODERATOR_ROLE,
      ).includes(candidate),
    );
    if (!assignedByMaintainer) continue;
    const candidateHistory = byAuthor.get(candidate);
    const acceptsAssignment = historicalSelfAcceptanceCoversAssignment(
      candidateHistory,
      createdAt,
      MODERATOR_ROLE,
    );
    const acknowledgesMember = activeAuthorTargets(
      candidateHistory,
      createdAt,
      new Set<RepositoryRole>(["M", "m", "o"]),
    ).some((target) => target !== candidate && members.has(target));
    if (acceptsAssignment && acknowledgesMember) members.add(candidate);
  }

  cache.set(createdAt, members);
  return members;
}

export function historicalRepositoryMaintainersAt(
  history: RepositoryRoleHistory,
  createdAt: number,
): ReadonlySet<string> {
  const cache = historicalMaintainerCache.get(history) ?? new Map();
  historicalMaintainerCache.set(history, cache);
  const cached = cache.get(createdAt);
  if (cached) return cached;
  historicalRepositoryMembersAt(history, createdAt);
  return cache.get(createdAt) ?? new Set();
}

export function isHistoricalRepositoryMember(
  history: RepositoryRoleHistory | undefined,
  pubkey: string,
  createdAt: number,
): boolean {
  return (
    !!history && historicalRepositoryMembersAt(history, createdAt).has(pubkey)
  );
}

export function isHistoricalRepositoryMaintainer(
  history: RepositoryRoleHistory | undefined,
  pubkey: string,
  createdAt: number,
): boolean {
  return (
    !!history &&
    historicalRepositoryMaintainersAt(history, createdAt).has(pubkey)
  );
}
