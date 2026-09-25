/**
 * Advanced repair — raw role-tag replacement for the signer's OWN kind:30617
 * repository announcement.
 *
 * Nostr is permissionless: any keyholder can already hand-craft their own
 * announcement with another client, so this builder adds no authority a
 * signer does not already hold. It exists so histories the guided repair
 * flows cannot fix (multiple invalid self-defers of one role, unparseable
 * role tags, genuine duplicate valid records, projection mismatches) can be
 * repaired with an explicit signer-reviewed preview instead of a text
 * editor. The published output still resolves through the normal reciprocal
 * authorization model.
 *
 * Guards enforced here, never in the UI alone:
 * - only `M` / `m` / `o` tags may be supplied; every other tag is carried
 *   over from the existing announcement byte-for-byte;
 * - the deprecated `maintainers` projection is regenerated from the edited
 *   active M/m records, so a replacement can never introduce an
 *   `inconsistent-maintainers-projection` warning;
 * - a replacement that belongs to a private component before or after the
 *   edit is refused without its own relay hint;
 * - `created_at` is strictly greater than the existing announcement's;
 * - a signer without an existing announcement is refused outright.
 */

import type { EventTemplate, NostrEvent } from "nostr-tools";

import { resolveChain, type ResolvedRepo } from "@/lib/nip34";
import {
  parseInvalidSelfDeferRoleRecord,
  parseRepositoryRoleRecord,
  REPOSITORY_ANNOUNCEMENT_KIND,
} from "@/lib/nip34-maintainer-model";
import { RepositoryMembershipMutationRefusal } from "@/lib/repositoryMembershipMutation";

const ROLE_TAG_NAMES = new Set<string>(["M", "m", "o"]);
const MEMBERSHIP_TAG_NAMES = new Set<string>(["M", "m", "o", "maintainers"]);

/** Copies of the announcement's raw `M` / `m` / `o` tags, in event order. */
export function repositoryAnnouncementRoleTags(event: NostrEvent): string[][] {
  return event.tags
    .filter(([name]) => ROLE_TAG_NAMES.has(name ?? ""))
    .map((tag) => [...tag]);
}

/**
 * Regenerate the deprecated `maintainers` projection from the edited role
 * tags: the deduplicated subjects of every valid active M/m record, matching
 * the set the health check compares the projection against.
 */
export function regenerateMaintainersProjection(
  author: string,
  roleTags: string[][],
): string[] {
  return [
    ...new Set(
      roleTags.flatMap((tag) => {
        const record = parseRepositoryRoleRecord(author, tag);
        return record?.active && (record.role === "M" || record.role === "m")
          ? [record.subject]
          : [];
      }),
    ),
  ];
}

export type RoleTagClassification =
  | "active"
  | "inactive"
  | "invalid-self-defer"
  | "malformed";

/** Classify one raw role tag exactly as the announcement parser would. */
export function classifyRoleTag(
  author: string,
  tag: string[],
): RoleTagClassification {
  const record = parseRepositoryRoleRecord(author, tag);
  if (record) return record.active ? "active" : "inactive";
  return parseInvalidSelfDeferRoleRecord(author, tag)
    ? "invalid-self-defer"
    : "malformed";
}

export interface RoleTagDiff {
  added: string[][];
  removed: string[][];
  unchanged: string[][];
}

/** Multiset diff of raw role tags between the current and edited tag lists. */
export function diffRoleTags(
  current: string[][],
  edited: string[][],
): RoleTagDiff {
  const key = (tag: string[]) => JSON.stringify(tag);
  const remaining = new Map<string, number>();
  for (const tag of current) {
    const tagKey = key(tag);
    remaining.set(tagKey, (remaining.get(tagKey) ?? 0) + 1);
  }
  const added: string[][] = [];
  const unchanged: string[][] = [];
  for (const tag of edited) {
    const tagKey = key(tag);
    const count = remaining.get(tagKey) ?? 0;
    if (count > 0) {
      remaining.set(tagKey, count - 1);
      unchanged.push(tag);
    } else {
      added.push(tag);
    }
  }
  const removed: string[][] = [];
  for (const tag of current) {
    const tagKey = key(tag);
    const count = remaining.get(tagKey) ?? 0;
    if (count > 0) {
      remaining.set(tagKey, count - 1);
      removed.push(tag);
    }
  }
  return { added, removed, unchanged };
}

export interface AdvancedRepairReplacementOptions {
  /** The signer's own latest announcement; absent means nothing to repair. */
  announcement: NostrEvent | undefined;
  /** The edited raw `M` / `m` / `o` tags replacing the current ones. */
  roleTags: string[][];
  /** Complete loaded resolution context used to preview the replacement. */
  repository: Pick<
    ResolvedRepo,
    | "selectedMaintainer"
    | "dTag"
    | "isPrivate"
    | "discoveredAnnouncements"
    | "historicalAnnouncements"
  >;
  createdAt?: number;
}

export interface AdvancedRepairReplacement {
  template: EventTemplate;
  /** Unsigned stand-in for preview parsing and resolution only. */
  simulated: NostrEvent;
  /** The regenerated `maintainers` projection carried by the template. */
  maintainersProjection: string[];
  /** Repository resolved with the simulated replacement in place. */
  resolvedRepository: ResolvedRepo | undefined;
}

function refuse(
  code: ConstructorParameters<typeof RepositoryMembershipMutationRefusal>[0],
  message: string,
): never {
  throw new RepositoryMembershipMutationRefusal(code, message);
}

export function buildAdvancedRepairReplacement({
  announcement,
  roleTags,
  repository,
  createdAt = Math.floor(Date.now() / 1000),
}: AdvancedRepairReplacementOptions): AdvancedRepairReplacement {
  if (!announcement) {
    refuse(
      "history_conflict",
      "Advanced repair replaces your own existing repository announcement; this account has not published one for this identifier.",
    );
  }
  for (const tag of roleTags) {
    if (!ROLE_TAG_NAMES.has(tag[0] ?? "")) {
      refuse(
        "membership_side_effect",
        `Advanced repair edits only M, m, and o role tags; a "${tag[0] ?? ""}" tag cannot be supplied.`,
      );
    }
  }

  const carried = announcement.tags
    .filter(([name]) => !MEMBERSHIP_TAG_NAMES.has(name ?? ""))
    .map((tag) => [...tag]);
  const maintainersProjection = regenerateMaintainersProjection(
    announcement.pubkey,
    roleTags,
  );
  const tags = [
    ...carried,
    ...roleTags.map((tag) => [...tag]),
    ["maintainers", ...maintainersProjection],
  ];
  const template: EventTemplate = {
    kind: REPOSITORY_ANNOUNCEMENT_KIND,
    content: announcement.content,
    created_at: Math.max(createdAt, announcement.created_at + 1),
    tags,
  };
  const simulated: NostrEvent = {
    id: "0".repeat(64),
    sig: "0".repeat(128),
    pubkey: announcement.pubkey,
    ...template,
  };
  const others = new Map<string, NostrEvent>();
  for (const event of [
    ...repository.historicalAnnouncements,
    ...repository.discoveredAnnouncements,
  ]) {
    if (event.pubkey !== announcement.pubkey) others.set(event.id, event);
  }
  const resolvedRepository = resolveChain(
    [...others.values(), simulated],
    repository.selectedMaintainer,
    repository.dTag,
  );
  if (
    (repository.isPrivate || resolvedRepository?.isPrivate === true) &&
    !tags.some(
      ([name, ...relayUrls]) =>
        name === "relays" && relayUrls.some((url) => url.length > 0),
    )
  ) {
    refuse(
      "missing_private_relay_hint",
      "A private repository announcement must include at least one relay hint.",
    );
  }

  return {
    template,
    simulated,
    maintainersProjection,
    resolvedRepository,
  };
}
