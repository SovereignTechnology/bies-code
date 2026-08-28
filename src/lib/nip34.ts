/**
 * NIP-34 Git Stuff - Constants and helpers
 */

import { nip19, type NostrEvent } from "nostr-tools";
import {
  getNip10References,
  getCommentRootPointer,
  getZapAmount,
  getZapRequest,
  getZapSender,
} from "applesauce-common/helpers";
import {
  getReplaceableIdentifier,
  getOrComputeCachedValue,
  parseReplaceableAddress,
} from "applesauce-core/helpers";
import { ISSUE_LABEL_NAMESPACE } from "@/factories/IssueLabelFactory";
import { normalizeGraspServiceAddress } from "@/lib/grasp";
import { getThreadTree } from "@/lib/threadTree";
import { normalizeUrl } from "@/lib/url";
import {
  getRepositoryAnnouncementDiscoveryPubkeys,
  getRepositoryMaintainerAssignments,
  latestRepositoryAnnouncements,
  resolveRepositoryMembership,
  type LeadResolution,
  type MaintainerEdge,
  type ModeratorEdge,
  type RepositoryHealthWarning,
  type RepositoryMembershipResolution,
} from "@/lib/nip34-maintainer-model";

export type {
  LeadResolution,
  MaintainerEdge,
  ModeratorEdge,
  RepositoryHealthWarning,
} from "@/lib/nip34-maintainer-model";

// ---------------------------------------------------------------------------
// Patch-chain identification tags — excluded from user-visible labels
// ---------------------------------------------------------------------------

/**
 * `t` tag values that are used internally for patch chain identification
 * (NIP-34) and must be excluded from user-visible label lists.
 */
export const PATCH_CHAIN_TAGS = new Set([
  "revision-root",
  "root-revision",
  "root",
  "cover-letter",
]);

// ---------------------------------------------------------------------------
// Patch message parsing (ported from gitworkshop)
// ---------------------------------------------------------------------------

/**
 * Extract the commit message from a git format-patch string.
 * Returns subject + optional body separated by a blank line.
 */
export function extractPatchMessage(s: string): string | undefined {
  try {
    const subjectMatch = s.match(/^Subject: \[PATCH[^\]]*\] (.*)$/m);
    if (!subjectMatch) return undefined;

    const subjectLineEnd = (subjectMatch.index ?? 0) + subjectMatch[0].length;
    const remaining = s.substring(subjectLineEnd);

    let subject = subjectMatch[1];
    const lines = remaining.split("\n");
    let bodyStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && lines[i] === "") {
        bodyStartIndex = i + 1;
        break;
      } else if (lines[i].startsWith(" ")) {
        subject += "\n" + lines[i].substring(1);
        bodyStartIndex = i + 1;
      } else if (lines[i] === "") {
        bodyStartIndex = i + 1;
        break;
      } else {
        bodyStartIndex = i;
        break;
      }
    }

    const bodyLines = lines.slice(bodyStartIndex);
    let message = subject;
    let messageEndIndex = bodyLines.length;

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      if (line.match(/^ .+ \| \d+/)) {
        messageEndIndex = i;
        break;
      }
      if (line.startsWith("diff --git ")) {
        messageEndIndex = i;
        break;
      }
    }

    if (messageEndIndex > 0) {
      let bodyText = bodyLines.slice(0, messageEndIndex).join("\n").trim();
      if (bodyText === "---" || bodyText.endsWith("\n---")) {
        bodyText = bodyText.replace(/\n?---$/, "").trim();
      }
      if (bodyText) message += "\n\n" + bodyText;
    }

    return message;
  } catch {
    return undefined;
  }
}

/**
 * Extract the unified diff portion from a git format-patch string.
 * Returns everything from the first `diff --git` line onwards, or an empty
 * string if no diff section is found.
 */
export function extractPatchDiff(s: string): string {
  const idx = s.indexOf("diff --git ");
  if (idx === -1) return "";
  return s.substring(idx).trimEnd();
}

/** First line of a string. */
export function firstLine(s: string): string {
  return s.split(/\r?\n/)[0];
}

/** Everything after the first line of a string, trimmed. */
export function remainingLines(s: string): string {
  const idx = s.indexOf("\n");
  if (idx === -1) return "";
  return s.substring(idx).trim();
}

/**
 * Strip the `[PATCH N/M]` prefix from a subject line.
 * e.g. "[PATCH 0/1] host: fix foo" → "host: fix foo"
 * e.g. "[PATCH v2 3/5] host: fix foo" → "host: fix foo"
 * Returns the original string if no prefix is found.
 */
export function stripPatchPrefix(subject: string): string {
  return subject.replace(/^\[PATCH[^\]]*\]\s*/, "");
}

/**
 * Returns true when a subject line (or description tag first line) indicates
 * this is a cover letter — i.e. the patch number is 0 (e.g. `[PATCH 0/3]`).
 * Matches patterns like: [PATCH 0/1], [PATCH v2 0/5], [PATCH RFC 0/3]
 */
export function subjectIsCoverLetter(subject: string): boolean {
  // Match [PATCH ...] where the patch number (before the /) is 0.
  // Non-greedy [^\]]*? so the \s+0\/ can still match inside the bracket.
  return /^\[PATCH[^\]]*?\s+0\/\d+\]/.test(subject);
}

/**
 * Extract the subject (title) for a patch event.
 * Uses the first line of the `description` tag, falling back to
 * parsing the patch content via extractPatchMessage.
 * Strips the `[PATCH N/M]` prefix in both cases.
 */
export function extractPatchSubject(ev: NostrEvent): string {
  const desc = ev.tags.find(([t]) => t === "description")?.[1];
  if (desc) return stripPatchPrefix(firstLine(desc));
  const fromContent = extractPatchMessage(ev.content);
  if (fromContent) return stripPatchPrefix(firstLine(fromContent));
  return "(untitled)";
}

/**
 * Extract the body for a patch event.
 * Uses lines 2+ of the `description` tag when present and non-empty,
 * falling back to parsing the patch content via extractPatchMessage.
 *
 * Note: some clients (e.g. ngit) set the `description` tag to only the
 * subject line (no body), so we must fall through to the content when
 * `remainingLines` returns an empty string.
 */
export function extractPatchBody(ev: NostrEvent): string {
  const desc = ev.tags.find(([t]) => t === "description")?.[1];
  if (desc) {
    const body = remainingLines(desc);
    if (body) return body;
  }
  const fromContent = extractPatchMessage(ev.content);
  if (fromContent) return remainingLines(fromContent);
  return "";
}

/** Repository announcement (addressable, kind 30617) */
export const REPO_KIND = 30617;

/** Repository state announcement (addressable, kind 30618) */
export const REPO_STATE_KIND = 30618;

/** Git issue (kind 1621) */
export const ISSUE_KIND = 1621;

/** Git patch — root patch of a patch set (kind 1617) */
export const PATCH_KIND = 1617;

/** Git pull request (kind 1618) */
export const PR_KIND = 1618;

/** Git pull request update — changes the tip of a referenced PR (kind 1619) */
export const PR_UPDATE_KIND = 1619;

/** Root kinds that appear in the PRs list (patches + PRs). */
export const PR_ROOT_KINDS = [PATCH_KIND, PR_KIND] as const;

/**
 * Return the non-default target branch declared by a pull request.
 *
 * NIP-34 omits the optional `b` tag when the repository default branch is the
 * target. Empty values are treated as absent; validation happens before the
 * value is used as a git ref so malformed metadata is never retargeted to the
 * default branch.
 */
export function getPRTargetBranch(event: NostrEvent): string | undefined {
  if (event.kind !== PR_KIND) return undefined;
  return event.tags.find(([name]) => name === "b")?.[1] || undefined;
}

/**
 * Return the repository coordinates an issue, PR, or patch is filed against.
 *
 * Older clients used an `a` tag with a `mention` marker where modern clients
 * use a `q` tag. Relays cannot distinguish those legacy mentions in a `#a`
 * query, so consumers must exclude them before attributing the item to a
 * repository.
 */
export function getRootRepositoryCoordinates(event: NostrEvent): string[] {
  return event.tags
    .filter(
      ([name, coordinate, , marker]) =>
        name === "a" && Boolean(coordinate) && marker !== "mention",
    )
    .map(([, coordinate]) => coordinate);
}

/** Whether an item is filed against any of the given repository coordinates. */
export function isRepositoryRootItem(
  event: NostrEvent,
  coordinates: ReadonlySet<string>,
): boolean {
  return getRootRepositoryCoordinates(event).some((coordinate) =>
    coordinates.has(coordinate),
  );
}

/** NIP-22 comment (kind 1111) */
export const COMMENT_KIND = 1111;

/**
 * Cover note (kind 1624).
 *
 * A pinned note posted by the item author or a maintainer that appears above
 * the first description card on an issue or PR page. Only the latest
 * authorised cover note is shown. Mirrors gitworkshop's CoverNote feature.
 */
export const COVER_NOTE_KIND = 1624;

/**
 * Legacy NIP-34 reply kinds — pre-NIP-22 replies that use NIP-10 #e tagging.
 * Kind 1622 is the original NIP-34 reply kind; kind 1 is a generic text note
 * sometimes used as a reply in older clients. Both thread correctly via the
 * NIP-10 root/reply markers already handled by threadTree.ts.
 */
export const LEGACY_REPLY_KIND = 1622;
export const LEGACY_REPLY_KINDS = [1, LEGACY_REPLY_KIND] as const;

/** Status kinds */
export const STATUS_OPEN = 1630;
export const STATUS_RESOLVED = 1631;
export const STATUS_CLOSED = 1632;
export const STATUS_DRAFT = 1633;

/** NIP-32 label event kind */
export const LABEL_KIND = 1985;

/** NIP-09 deletion request kind */
export const DELETION_KIND = 5;

/** NIP-32 label namespace used for subject-rename events */
export const SUBJECT_LABEL_NAMESPACE = "#subject";

export const STATUS_KINDS = [
  STATUS_OPEN,
  STATUS_RESOLVED,
  STATUS_CLOSED,
  STATUS_DRAFT,
] as const;

export type IssueStatus = "open" | "resolved" | "closed" | "draft" | "deleted";

export function kindToStatus(kind: number): IssueStatus {
  switch (kind) {
    case STATUS_OPEN:
      return "open";
    case STATUS_RESOLVED:
      return "resolved";
    case STATUS_CLOSED:
      return "closed";
    case STATUS_DRAFT:
      return "draft";
    default:
      return "open";
  }
}

// ---------------------------------------------------------------------------
// Cached per-event tag extractors for kind:30617 announcement events
//
// Each function uses getOrComputeCachedValue to attach the result to the raw
// NostrEvent object via a symbol key. Because the EventStore reuses the same
// event object reference across reactive updates, the parse runs at most once
// per event version regardless of how many times resolveChain, cast classes,
// or models call these helpers.
// ---------------------------------------------------------------------------

const RepoNameSymbol = Symbol.for("repo-ev-name");
const RepoDescriptionSymbol = Symbol.for("repo-ev-description");
const RepoCloneUrlsSymbol = Symbol.for("repo-ev-clone-urls");
const RepoWebUrlsSymbol = Symbol.for("repo-ev-web-urls");
const RepoRelaysSymbol = Symbol.for("repo-ev-relays");
const RepoMaintainersSymbol = Symbol.for("repo-ev-current-maintainers-v2");
const RepoUpstreamsSymbol = Symbol.for("repo-ev-upstreams");

export interface RepoUpstream {
  /** Upstream repository coordinate, e.g. "30617:<pubkey>:<identifier>". */
  repository?: string;
  /** Preferred HTTPS git URL for the upstream, when supplied. */
  gitUrl?: string;
  /** Relay hint for the upstream repository coordinate. */
  relayHint?: string;
  /** Upstream repository announcement author pubkey, when supplied. */
  authorPubkey?: string;
}

/** Extract the human-readable name from a kind:30617 event. Falls back to the d-tag. */
export function getRepoName(ev: NostrEvent): string {
  return getOrComputeCachedValue(
    ev,
    RepoNameSymbol,
    () =>
      ev.tags.find(([t]) => t === "name")?.[1] ??
      ev.tags.find(([t]) => t === "d")?.[1] ??
      "",
  );
}

/** Extract the description from a kind:30617 event. Falls back to content. */
export function getRepoDescription(ev: NostrEvent): string {
  return getOrComputeCachedValue(
    ev,
    RepoDescriptionSymbol,
    () => ev.tags.find(([t]) => t === "description")?.[1] ?? ev.content ?? "",
  );
}

/**
 * Extract all clone URLs from a kind:30617 event.
 * NIP-34 packs multiple URLs as extra elements of a single tag:
 *   ["clone", "url1", "url2", ...]
 */
export function getRepoCloneUrls(ev: NostrEvent): string[] {
  return getOrComputeCachedValue(ev, RepoCloneUrlsSymbol, () =>
    ev.tags
      .filter(([t]) => t === "clone")
      .flatMap(([, ...urls]) => urls.filter(Boolean)),
  );
}

/**
 * Returns true if the URL is a Grasp server clone URL.
 *
 * A Grasp clone URL has the form:
 *   https://<domain>/<npub1...>/<repo-name>.git
 *
 * Ported from the Rust implementation in ngit (src/lib/repo_ref.rs).
 */
export function isGraspCloneUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (!url.endsWith(".git") && !url.endsWith(".git/")) return false;

  return parseGraspCloneUrl(url) !== undefined;
}

interface ParsedGraspCloneUrl {
  npub: string;
  servicePath: string;
}

/** Locate the rightmost valid npub path segment before a `.git` repository. */
function parseGraspCloneUrl(url: string): ParsedGraspCloneUrl | undefined {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\/$/, "").split("/");

    for (let index = segments.length - 2; index >= 1; index--) {
      const npub = segments[index];
      try {
        const decoded = nip19.decode(npub);
        if (decoded.type !== "npub") continue;
      } catch {
        continue;
      }

      const repositoryPath = segments.slice(index + 1).join("/");
      if (!repositoryPath.endsWith(".git") || repositoryPath === ".git") {
        continue;
      }

      return {
        npub,
        servicePath: segments.slice(0, index).join("/"),
      };
    }
  } catch {
    // Invalid URL.
  }
  return undefined;
}

/**
 * Extract the domain (host and optional port) from a Grasp clone URL.
 * Returns undefined if the URL is not a valid Grasp clone URL or cannot be parsed.
 */
export function graspCloneUrlDomain(url: string): string | undefined {
  if (!isGraspCloneUrl(url)) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Extract the GRASP service address, including its mount path, from a clone
 * URL. Plaintext services retain an `http://` prefix to distinguish them from
 * the default HTTPS/WSS transport.
 */
export function graspCloneUrlServiceAddress(url: string): string | undefined {
  if (!isGraspCloneUrl(url)) return undefined;
  const clone = parseGraspCloneUrl(url);
  if (!clone) return undefined;

  try {
    const parsed = new URL(url);
    return normalizeGraspServiceAddress(
      `${parsed.protocol}//${parsed.host}${clone.servicePath}`,
    );
  } catch {
    return undefined;
  }
}

/**
 * Extract the npub from a Grasp clone URL.
 * Grasp URLs have the form: https://<domain>/<npub1...>/<repo-name>.git
 * Returns undefined if the URL is not a valid Grasp clone URL.
 */
export function graspCloneUrlNpub(url: string): string | undefined {
  if (!isGraspCloneUrl(url)) return undefined;
  return parseGraspCloneUrl(url)?.npub;
}

/**
 * Extract all web URLs from a kind:30617 event.
 * Same multi-value tag format as clone: ["web", "url1", "url2", ...]
 */
export function getRepoWebUrls(ev: NostrEvent): string[] {
  return getOrComputeCachedValue(ev, RepoWebUrlsSymbol, () =>
    ev.tags
      .filter(([t]) => t === "web")
      .flatMap(([, ...urls]) => urls.filter(Boolean)),
  );
}

/**
 * Extract all relay URLs from a kind:30617 event, normalized and deduplicated.
 * NIP-34 packs multiple relay URLs as extra elements of a single tag:
 *   ["relays", "wss://relay1", "wss://relay2", ...]
 *
 * Returns normalized URLs so callers can safely compare and deduplicate
 * across sources without additional normalization.
 */
export function getRepoRelays(ev: NostrEvent): string[] {
  return getOrComputeCachedValue(ev, RepoRelaysSymbol, () => [
    ...new Set(
      ev.tags
        .filter(([t]) => t === "relays")
        .flatMap(([, ...urls]) => urls.filter(Boolean))
        .map(normalizeUrl),
    ),
  ]);
}

/** Active maintainer assignments, using indexed M/m roles when present. */
export function getRepoMaintainers(ev: NostrEvent): string[] {
  return getOrComputeCachedValue(ev, RepoMaintainersSymbol, () =>
    getRepositoryMaintainerAssignments(ev),
  );
}

/** Active maintainer and moderator subjects used only for announcement discovery. */
export function getRepoRoleSubjects(ev: NostrEvent): string[] {
  return getRepositoryAnnouncementDiscoveryPubkeys(ev);
}

const GIT_CLONE_URL_SCHEME_PATTERN = /^(?:https?|ssh|git|file|nostr):\/\//i;
const SCP_LIKE_GIT_URL_PATTERN = /^[^@\s]+@[^:\s]+:.+$/;

function isGitCloneUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (SCP_LIKE_GIT_URL_PATTERN.test(trimmed)) return true;
  if (!GIT_CLONE_URL_SCHEME_PATTERN.test(trimmed)) return false;

  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

function parseRepoUpstreamTarget(
  target: string | undefined,
): Pick<RepoUpstream, "repository" | "gitUrl"> | undefined {
  const trimmed = target?.trim();
  if (!trimmed) return undefined;

  if (parseRepoCoordinate(trimmed)) return { repository: trimmed };
  if (isGitCloneUrl(trimmed)) return { gitUrl: trimmed };

  return undefined;
}

/**
 * Extract subordinate-fork upstream metadata from NIP-34 `u` tags.
 * Format: ["u", "30617:<pubkey>:<identifier>", "<relay-hint>", "<author-pubkey>"]
 * or ["u", "<git-url>"].
 */
export function getRepoUpstreams(ev: NostrEvent): RepoUpstream[] {
  return getOrComputeCachedValue(ev, RepoUpstreamsSymbol, () =>
    ev.tags
      .filter(([t]) => t === "u")
      .flatMap(([, target, relayHint, authorPubkey]) => {
        const upstreamTarget = parseRepoUpstreamTarget(target);
        if (!upstreamTarget) return [];

        const upstream: RepoUpstream = {
          ...upstreamTarget,
        };
        if (relayHint) upstream.relayHint = relayHint;
        if (authorPubkey) upstream.authorPubkey = authorPubkey;

        return [upstream];
      }),
  );
}

export function repoUpstreamsToTags(upstreams: RepoUpstream[]): string[][] {
  return upstreams
    .map((upstream) => {
      const repository = upstream.repository?.trim() ?? "";
      const gitUrl = upstream.gitUrl?.trim() ?? "";
      const relayHint = upstream.relayHint?.trim() ?? "";
      const authorPubkey = upstream.authorPubkey?.trim() ?? "";
      const target = repository || gitUrl;
      if (!target) return undefined;

      const tag = ["u", target];
      if (authorPubkey) tag.push(relayHint, authorPubkey);
      else if (relayHint) tag.push(relayHint);
      return tag;
    })
    .filter((tag): tag is string[] => tag !== undefined);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function repoUpstreamsEqual(
  a: RepoUpstream[],
  b: RepoUpstream[],
): boolean {
  const aTags = repoUpstreamsToTags(a);
  const bTags = repoUpstreamsToTags(b);
  return (
    aTags.length === bTags.length &&
    aTags.every((tag, index) => stringArraysEqual(tag, bTags[index] ?? []))
  );
}

export function emptyRepoUpstream(): RepoUpstream {
  return { repository: "", gitUrl: "", relayHint: "", authorPubkey: "" };
}

// ---------------------------------------------------------------------------
// Cached per-event tag extractors for kind:30618 state events
// ---------------------------------------------------------------------------

const StateRefsSymbol = Symbol.for("repo-state-ev-refs");
const StateHeadSymbol = Symbol.for("repo-state-ev-head");

/**
 * A single ref entry from a kind:30618 state event.
 * `name` is the full ref path, e.g. "refs/heads/main".
 * `commitId` is the full commit hash.
 * `parentCommitIds` are the optional shorthand parent/grandparent commit IDs
 * used to identify how many commits ahead a ref is.
 */
export interface RepoStateRef {
  name: string;
  commitId: string;
  parentCommitIds: string[];
}

/**
 * Extract all refs from a kind:30618 state event.
 * Format: ["refs/<heads|tags>/<name>", "<commit-id>", "<parent>", ...]
 *
 * For annotated tags the state event may include both the tag object entry
 * and a peeled entry (name + "^{}") that holds the actual commit hash.
 * We use the peeled commit hash when available so comparisons against git
 * infoRefs (which we also peel) stay consistent.
 */
export function getStateRefs(ev: NostrEvent): RepoStateRef[] {
  return getOrComputeCachedValue(ev, StateRefsSymbol, () => {
    // Build a map of peeled commit hashes: "refs/tags/v1.0.0" → "abc123..."
    const peeled = new Map<string, string>();
    for (const [name, commitId] of ev.tags) {
      if (name?.endsWith("^{}") && commitId) {
        peeled.set(name.slice(0, -3), commitId);
      }
    }

    return ev.tags
      .filter(([t]) => t?.startsWith("refs/") && !t.endsWith("^{}"))
      .map(([name, commitId, ...parents]) => ({
        name,
        // Prefer the peeled commit hash for annotated tags
        commitId: peeled.get(name) ?? commitId ?? "",
        parentCommitIds: parents.filter(Boolean),
      }))
      .filter((r) => r.commitId);
  });
}

/**
 * Extract the HEAD ref from a kind:30618 state event.
 * Format: ["HEAD", "ref: refs/heads/<branch-name>"]
 * Returns the full ref path (e.g. "refs/heads/main") or undefined.
 */
export function getStateHead(ev: NostrEvent): string | undefined {
  return getOrComputeCachedValue(ev, StateHeadSymbol, () => {
    const tag = ev.tags.find(([t]) => t === "HEAD");
    if (!tag) return undefined;
    const val = tag[1] ?? "";
    // Format: "ref: refs/heads/<branch>"
    const match = val.match(/^ref:\s*(.+)$/);
    return match ? match[1] : undefined;
  });
}

/**
 * Get the commit ID for the HEAD branch from a kind:30618 state event.
 * Returns undefined if HEAD or the target ref is missing.
 */
export function getStateHeadCommit(ev: NostrEvent): string | undefined {
  const headRef = getStateHead(ev);
  if (!headRef) return undefined;
  const refs = getStateRefs(ev);
  return refs.find((r) => r.name === headRef)?.commitId;
}

/**
 * Default git nostr index relay. Any relay operator can run their own index;
 * this is just the well-known default used to seed the user-configurable
 * gitIndexRelays setting.
 */
export const DEFAULT_GIT_INDEX_RELAY = "wss://index.ngit.dev";

/**
 * Options controlling which relays are queried for repo-specific events
 * (issues, comments, status, zaps). Announcement events (kind 30617) are
 * always fetched from gitIndexRelays regardless of these options.
 *
 * relayHints: extra relays to query in addition to the repo's declared relays.
 *   Defaults to [] (empty). Populated from naddr URL relay hints or per-repo
 *   settings. gitIndexRelays is NOT included by default — add it here explicitly
 *   if you want issues from the discovery relay.
 *
 * useItemAuthorRelays: when true, also query the NIP-65 outbox relays of the
 *   issue author for comments and zaps. Defaults to false — no existing
 *   behaviour changes when this is omitted or false. Leave off on list pages
 *   (RepoPage) to avoid per-item relay churn; enable on detail pages
 *   (IssuePage) where completeness matters.
 *
 * maintainerPubkeys: the full list of maintainer pubkeys from
 *   ResolvedRepo.confirmedMaintainers. Required when useItemAuthorRelays is true so
 *   that outbox relays can be fetched for issues and status queries. Ignored
 *   when useItemAuthorRelays is false.
 */
export interface RepoQueryOptions {
  relayHints: string[];
  useItemAuthorRelays?: boolean;
  maintainerPubkeys?: string[];
}

/**
 * Build an naddr-style coordinate string for a repo.
 * Format: "30617:<pubkey>:<d-tag>"
 */
export function repoCoordinate(pubkey: string, identifier: string): string {
  return `${REPO_KIND}:${pubkey}:${identifier}`;
}

export function parseRepoCoordinate(
  coordinate: string | undefined,
): { pubkey: string; identifier: string } | undefined {
  if (!coordinate) return undefined;

  const pointer = parseReplaceableAddress(coordinate, true);
  if (!pointer || pointer.kind !== REPO_KIND) return undefined;

  return { pubkey: pointer.pubkey, identifier: pointer.identifier };
}

export function isRepoUpstreamSelfReference(
  upstream: RepoUpstream,
  repoPubkey: string,
  repoIdentifier: string,
  repoCloneUrls: string[],
): boolean {
  const parsed = parseRepoCoordinate(upstream.repository);
  if (parsed?.pubkey === repoPubkey && parsed.identifier === repoIdentifier) {
    return true;
  }

  const gitUrl = upstream.gitUrl?.trim();
  if (!gitUrl) return false;

  const normalizedGitUrl = normalizeUrl(gitUrl);
  return repoCloneUrls.some((url) => normalizeUrl(url) === normalizedGitUrl);
}

/**
 * Extract the pubkey from a NIP-34 coordinate string.
 * Format: "<kind>:<pubkey>:<d-tag>"
 * Returns undefined if the coordinate is malformed.
 */
export function pubkeyFromCoordinate(coord: string): string | undefined {
  const parts = coord.split(":");
  // Minimum: kind + pubkey + d-tag (d-tag may itself contain colons)
  if (parts.length < 3) return undefined;
  const pubkey = parts[1];
  // Pubkey must be a 64-char hex string
  return /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : undefined;
}

/**
 * Derive a stable, sorted cache key from an array of repo coordinate strings.
 * Sorting ensures that the same set of coords in a different order produces
 * the same key, avoiding duplicate model instances.
 */
export function coordsCacheKey(coords: string[]): string {
  return [...coords].sort().join(",");
}

// ---------------------------------------------------------------------------
// ResolvedRepo — the merged view of a multi-maintainer repository
// ---------------------------------------------------------------------------

/** Provenance record: which maintainer contributed a value and when */
export interface FieldProvenance {
  pubkey: string;
  createdAt: number;
  value: string;
}

/**
 * The fully-resolved view of a repository after BFS chain resolution.
 *
 * Display fields (name, description, webUrls) use latest-wins across all
 * maintainer announcements. Infrastructure fields (cloneUrls, relays) are
 * unioned. The raw announcements and provenance data are preserved for the
 * detailed maintainership graph view.
 */
export interface ResolvedRepo {
  // --- Identity ---
  /** Stable identity for this identifier's confirmed maintainer component. */
  componentId: string;
  /** The pubkey used as the starting point for resolution (route anchor) */
  selectedMaintainer: string;
  /** The selected maintainer's repository coordinate (current route anchor). */
  selectedCoordinate: string;
  /** The d-tag identifier shared by all announcements in this repo */
  dTag: string;

  // --- Merged display fields (latest-wins) ---
  name: string;
  description: string;
  /** Web URLs from the single latest announcement */
  webUrls: string[];
  /** Timestamp of the latest announcement (for display) */
  updatedAt: number;

  // --- Unioned infrastructure fields ---
  /** All clone URLs across all maintainer announcements, deduplicated */
  cloneUrls: string[];
  /** Subset of cloneUrls that are Grasp server clone URLs */
  graspCloneUrls: string[];
  /** Subset of cloneUrls that are NOT Grasp server clone URLs */
  additionalGitServerUrls: string[];
  /** Unique Grasp server domains (hostnames) derived from graspCloneUrls */
  graspServerDomains: string[];
  /** Unique Grasp service addresses, including mount paths */
  graspServerAddresses: string[];
  /** All relay URLs across all maintainer announcements, deduplicated */
  relays: string[];

  // --- Resolved membership and authority ---
  /** Maintainers in the reciprocal component; the sole state/merge authority set. */
  confirmedMaintainers: string[];
  /** Reciprocally acknowledged moderators with member-action authority. */
  confirmedModerators: string[];
  /** Confirmed maintainers followed by confirmed moderators. */
  confirmedMembers: string[];
  /** Coordinates authorized to publish state and perform maintainer-only actions. */
  confirmedMaintainerCoordinates: string[];
  /** Coordinates used for collaboration tags and member-authorized events. */
  confirmedMemberCoordinates: string[];
  /** Assigned maintainer subjects that have not reciprocally acknowledged membership. */
  invitedMaintainers: string[];
  /** Assigned moderator subjects that have not reciprocally acknowledged membership. */
  invitedModerators: string[];
  /** Authors whose latest self-role explicitly ends or declines maintainership. */
  departedMaintainers: string[];
  /** Authors whose latest self-role explicitly ends or declines moderatorship. */
  departedModerators: string[];
  /** Pubkeys fetched while discovering active assignments; never an authority set. */
  discoveryPubkeys: string[];
  /** Union of `t` tags across all announcements */
  labels: string[];

  // --- Graph / provenance data (for detailed view) ---
  /** Raw events reached during assignment discovery, including invitations. */
  discoveredAnnouncements: NostrEvent[];
  /** Raw events belonging to confirmed maintainers and moderators only. */
  confirmedAnnouncements: NostrEvent[];
  /** Directed current maintainer assignments with indexed/legacy provenance. */
  maintainerEdges: MaintainerEdge[];
  /** Directed current moderator assignments. */
  moderatorEdges: ModeratorEdge[];
  /** Fail-closed parsing and compatibility warnings. */
  repositoryHealth: RepositoryHealthWarning[];
  /** Signed lead result rooted at the selected coordinate. */
  leadResolution: LeadResolution;
  /** Per-URL provenance for clone URLs */
  cloneUrlProvenance: FieldProvenance[];
  /** Per-URL provenance for relay URLs */
  relayProvenance: FieldProvenance[];
  /** Which announcement's name won (latest created_at) */
  nameSource: FieldProvenance;
  /** Which announcement's description won */
  descriptionSource: FieldProvenance;
}

/**
 * Whether an issue, PR, or patch explicitly references the selected
 * maintainer or a maintainer with a reciprocal path back into that accepted
 * component.
 *
 * Items that reference only directionally authorized / invited coordinates
 * remain discoverable for ngit and GRASP interoperability, but their
 * repository attribution is not confirmed and the UI must say so.
 */
export function hasAcceptedRepositoryReference(
  repoCoords: Iterable<string>,
  repo: Pick<ResolvedRepo, "confirmedMembers" | "dTag">,
): boolean {
  const acceptedCoordinates = new Set(
    repo.confirmedMembers.map((pubkey) => repoCoordinate(pubkey, repo.dTag)),
  );
  for (const coordinate of repoCoords) {
    if (acceptedCoordinates.has(coordinate)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ResolvedIssueLite — lightweight summary for list pages
// ---------------------------------------------------------------------------

/**
 * The fully-resolved view of an issue after merging the raw issue event with
 * its status, label, and subject-rename events.
 *
 * Mirrors the ResolvedRepo pattern: a single entity combining information from
 * multiple Nostr events so consumers can filter and display without holding
 * separate maps.
 *
 * `status` is the single source of truth for deletion — a valid NIP-09
 * deletion request sets status to "deleted", which takes precedence over any
 * status event.
 *
 * For the full detail-page view (with comments, zaps, timeline nodes, etc.),
 * see `ResolvedIssue` which extends this interface.
 */
export interface ResolvedIssueLite {
  /** The raw issue event ID */
  id: string;
  /** The issue author's pubkey */
  pubkey: string;
  /** The raw issue event — for consumers that need fields not in the flat interface */
  event: NostrEvent;
  /** Original subject from the issue event itself */
  originalSubject: string;
  /**
   * Current (effective) subject — the latest authorised rename, or
   * originalSubject when no renames exist.
   */
  currentSubject: string;
  /** Issue body */
  content: string;
  /** Unix timestamp (seconds) of the root issue event */
  createdAt: number;
  /**
   * Unix timestamp (seconds) of the most recent activity — the latest of the
   * root event, any comment, or any status/label event. Used for sorting lists
   * by "most recently active".
   */
  lastActivityAt: number;
  /**
   * Current status. "deleted" takes precedence over all other status events
   * when a valid NIP-09 deletion request exists.
   */
  status: IssueStatus;
  /**
   * Deduplicated labels from both the issue's own `t` tags and NIP-32
   * kind:1985 label events, sorted alphabetically.
   */
  labels: string[];
  /** Repository root coordinates from `a` tags, excluding legacy mentions */
  repoCoords: string[];
  /**
   * Number of NIP-22 comments (kind:1111). Zero until nip34ListLoader
   * has fetched comment events into the store.
   */
  commentCount: number;
  /**
   * Number of unique commenter pubkeys (including the issue author).
   * Zero until nip34ListLoader has fetched comment events into the store.
   */
  participantCount: number;
  /**
   * Total sats zapped (sum of zap receipt amounts). Zero until
   * nip34ThreadItemLoader has fetched zap events into the store.
   */
  zapTotal: number;
  /**
   * The set of pubkeys authorised to write status, label, and subject-rename
   * events for this item. Includes the item author and all confirmed members.
   *
   * Convenience property so consumers (e.g. edit buttons) can check
   * authorisation without independently reconstructing the member set.
   */
  authorisedUsers: Set<string>;
  /**
   * Set of label event IDs (kind:1985) that have been deleted by their author
   * via NIP-09. Populated on detail pages; always an empty set on list pages
   * where label deletion events are not fetched.
   */
  deletedEssentialEventIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Subject / body extraction
// ---------------------------------------------------------------------------

/**
 * Extract the original subject from a root event.
 *
 * Different NIP-34 kinds store the subject in different tags:
 * - Issues (1621) and PRs (1618): `subject` tag
 * - Patches (1617): first line of `description` tag, falling back to content parsing
 *
 * This function is the single source of truth for subject extraction from
 * raw events. The cast classes (Issue, PR, Patch) mirror this logic.
 */
export function extractSubject(ev: NostrEvent): string {
  if (ev.kind === PATCH_KIND) return extractPatchSubject(ev);
  return (
    (ev.tags.find(([t]) => t === "subject")?.[1] ??
      ev.content.split("\n")[0].trim()) ||
    "(untitled)"
  );
}

/**
 * Extract the body/description from a root event.
 *
 * - Issues (1621) and PRs (1618): `content` field
 * - Patches (1617): lines 2+ of `description` tag, falling back to content parsing
 */
export function extractBody(ev: NostrEvent): string {
  if (ev.kind === PATCH_KIND) return extractPatchBody(ev);
  return ev.content;
}

/**
 * Options that vary between entity types when building resolved lists.
 *
 * prUpdateEvents: kind:1619 PR Update events to factor into lastActivityAt.
 *   These are keyed by their `E` (uppercase) root pointer to the original PR.
 *   Only used for PRs — ignored for issues.
 */
export interface ResolveEssentialsOptions {
  prUpdateEvents?: NostrEvent[];
  /**
   * NIP-09 deletion events (kind:5) that reference one or more essential event
   * IDs (status events, label/rename events). Used to exclude essentials whose
   * source event has been deleted by its author. Only deletions where the
   * deleter's pubkey matches the target event's author are honoured.
   */
  essentialDeletionEvents?: NostrEvent[];
}

/**
 * Build a fully-resolved list of items from raw root events and their
 * associated essentials, comments, and zaps. Single pass over each input
 * array — no intermediate Maps escape this function.
 *
 * Auth rules:
 * - Deletion (kind:5): only the root event author is valid (NIP-09).
 * - Status events: root author and confirmed members are authorised.
 * - Label events: root author and confirmed members are authorised.
 * Deletion takes precedence over all status events.
 *
 * The returned list is sorted descending by lastActivityAt (max of root
 * created_at, latest comment, latest essential event).
 */
function buildResolvedList(
  rootEvents: NostrEvent[],
  essentialEvents: NostrEvent[],
  commentEvents: NostrEvent[],
  zapEvents: NostrEvent[],
  memberSet: Set<string>,
  options: ResolveEssentialsOptions = {},
): (ResolvedIssueLite & { itemType?: PRItemType })[] {
  const { prUpdateEvents } = options;

  // ── Index root events ────────────────────────────────────────────────────
  const authorById = new Map<string, string>();
  const subjectById = new Map<string, string>();
  const tLabelsById = new Map<string, string[]>();
  for (const ev of rootEvents) {
    authorById.set(ev.id, ev.pubkey);
    subjectById.set(ev.id, extractSubject(ev));
    tLabelsById.set(
      ev.id,
      ev.tags
        .filter(([t, v]) => t === "t" && !PATCH_CHAIN_TAGS.has(v))
        .map(([, v]) => v),
    );
  }

  // ── Process essentials (single pass) ────────────────────────────────────
  const deletedIds = new Set<string>();
  const latestStatusByRoot = new Map<
    string,
    { kind: number; createdAt: number }
  >();
  const labelsByRoot = new Map<string, Set<string>>();
  const renamesByRoot = new Map<
    string,
    { createdAt: number; id: string; value: string }[]
  >();
  const latestEssentialAt = new Map<string, number>();

  for (const ev of essentialEvents) {
    const rootId = getNip10References(ev).root?.e?.id;
    if (!rootId || !authorById.has(rootId)) continue;

    // Track latest essential timestamp for lastActivityAt.
    const prev = latestEssentialAt.get(rootId) ?? 0;
    if (ev.created_at > prev) latestEssentialAt.set(rootId, ev.created_at);

    const issuePubkey = authorById.get(rootId)!;
    const isMember = memberSet.has(ev.pubkey);
    const isAuthor = ev.pubkey === issuePubkey;

    // ── Deletion (kind:5) — NIP-09: only the original author's deletion is valid.
    if (ev.kind === DELETION_KIND) {
      if (isAuthor) deletedIds.add(rootId);
      continue;
    }

    // ── Status events (kinds 1630–1633)
    if ((STATUS_KINDS as readonly number[]).includes(ev.kind)) {
      const statusRootId = getNip10References(ev).root?.e?.id;
      if (!statusRootId || !authorById.has(statusRootId)) continue;

      // NIP-34 authorises the root author or a confirmed repository member
      // for every status kind. A merged status records an authorised merge;
      // it does not grant permission to create or push the merge itself.
      if (!isAuthor && !isMember) continue;

      const existing = latestStatusByRoot.get(statusRootId);
      if (!existing || ev.created_at > existing.createdAt) {
        latestStatusByRoot.set(statusRootId, {
          kind: ev.kind,
          createdAt: ev.created_at,
        });
      }
      continue;
    }

    // ── Label events (kind:1985)
    if (ev.kind === LABEL_KIND) {
      if (!isAuthor && !isMember) continue;

      const subjectLabel = ev.tags.find(
        ([t, , ns]) => t === "l" && ns === SUBJECT_LABEL_NAMESPACE,
      );
      if (subjectLabel) {
        const existing = renamesByRoot.get(rootId) ?? [];
        existing.push({
          createdAt: ev.created_at,
          id: ev.id,
          value: subjectLabel[1],
        });
        renamesByRoot.set(rootId, existing);
      }

      for (const [t, label, ns] of ev.tags) {
        if (t === "l" && ns === ISSUE_LABEL_NAMESPACE && label) {
          const set = labelsByRoot.get(rootId) ?? new Set<string>();
          set.add(label);
          labelsByRoot.set(rootId, set);
        }
      }
    }
  }

  // ── Index comments and zaps ──────────────────────────────────────────────
  const commentsByRoot = new Map<string, NostrEvent[]>();
  for (const ev of commentEvents) {
    const rootPointer = getCommentRootPointer(ev);
    const rootId =
      rootPointer && "id" in rootPointer ? rootPointer.id : undefined;
    if (!rootId) continue;
    const existing = commentsByRoot.get(rootId) ?? [];
    existing.push(ev);
    commentsByRoot.set(rootId, existing);
  }

  const zapsByRoot = new Map<string, number>();
  for (const ev of zapEvents) {
    const rootId = getNip10References(ev).root?.e?.id;
    if (!rootId) continue;
    const msats = getZapAmount(ev) ?? 0;
    zapsByRoot.set(rootId, (zapsByRoot.get(rootId) ?? 0) + msats);
  }

  // ── Index PR Update events (kind:1619) for lastActivityAt ────────────────
  // PR Updates use ["E", "<pr-id>"] (uppercase, NIP-22 root pointer).
  // Auth: only the PR author or a maintainer may push a PR Update.
  // We don't enforce auth here — the timestamp is used only for sorting, so
  // an unauthorised update at most bumps the sort order, not the displayed tip.
  const latestPRUpdateAt = new Map<string, number>();
  if (prUpdateEvents) {
    for (const ev of prUpdateEvents) {
      const rootId = ev.tags.find(([t]) => t === "E")?.[1];
      if (!rootId || !authorById.has(rootId)) continue;
      const prev = latestPRUpdateAt.get(rootId) ?? 0;
      if (ev.created_at > prev) latestPRUpdateAt.set(rootId, ev.created_at);
    }
  }

  // ── Build resolved items ─────────────────────────────────────────────────
  return rootEvents
    .map((ev) => {
      const originalSubject = extractSubject(ev);

      // Derive status, labels, currentSubject from accumulated data.
      let status: IssueStatus;
      if (deletedIds.has(ev.id)) {
        status = "deleted";
      } else {
        const latestStatus = latestStatusByRoot.get(ev.id);
        status = latestStatus ? kindToStatus(latestStatus.kind) : "open";
      }

      const tLabels = tLabelsById.get(ev.id) ?? [];
      const nip32Labels = Array.from(labelsByRoot.get(ev.id) ?? []);
      const labels = Array.from(new Set([...tLabels, ...nip32Labels])).sort();

      const renames = (renamesByRoot.get(ev.id) ?? []).sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
      const currentSubject =
        renames.length > 0
          ? renames[renames.length - 1].value
          : originalSubject;

      const comments = commentsByRoot.get(ev.id) ?? [];
      const participantPubkeys = new Set(comments.map((c) => c.pubkey));

      const authorisedUsers = new Set(memberSet);
      authorisedUsers.add(ev.pubkey);

      const latestCommentAt = comments.reduce(
        (max, c) => Math.max(max, c.created_at),
        0,
      );
      const lastActivityAt = Math.max(
        ev.created_at,
        latestCommentAt,
        latestEssentialAt.get(ev.id) ?? 0,
        latestPRUpdateAt.get(ev.id) ?? 0,
      );

      return {
        id: ev.id,
        pubkey: ev.pubkey,
        event: ev,
        originalSubject,
        currentSubject,
        content: extractBody(ev),
        createdAt: ev.created_at,
        lastActivityAt,
        status,
        labels,
        repoCoords: getRootRepositoryCoordinates(ev).sort(),
        commentCount: comments.length,
        participantCount: participantPubkeys.size,
        zapTotal: Math.floor((zapsByRoot.get(ev.id) ?? 0) / 1000),
        authorisedUsers,
        // List model doesn't fetch deletion events for individual label events —
        // label deletions are only resolved on detail pages.
        deletedEssentialEventIds: new Set<string>(),
      };
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/**
 * Build a sorted list of ResolvedIssueLite objects from raw events. Pure function,
 * no side effects. Comment counts are 0 until nip34ListLoader fetches them;
 * zap counts are 0 until nip34ThreadItemLoader fetches them.
 */
export function buildResolvedIssues(
  rootEvents: NostrEvent[],
  essentialEvents: NostrEvent[],
  commentEvents: NostrEvent[],
  zapEvents: NostrEvent[],
  memberSet: Set<string>,
  options: ResolveEssentialsOptions = {},
): ResolvedIssueLite[] {
  return buildResolvedList(
    rootEvents,
    essentialEvents,
    commentEvents,
    zapEvents,
    memberSet,
    options,
  );
}

// ---------------------------------------------------------------------------
// ResolvedPRLite — lightweight summary for list pages
// ---------------------------------------------------------------------------

/** Discriminator for whether a resolved PR item is a patch or a pull request. */
export type PRItemType = "patch" | "pr";

/**
 * Lightweight resolved view of a PR or root patch for list pages.
 *
 * Contains the core fields derived from merging the raw event with its
 * status, label, and subject-rename events. Used by PRListModel and
 * RepoPRsPage for rendering list rows.
 *
 * For the full detail-page view (with revisions, timeline nodes, tip info),
 * see `ResolvedPR` which extends this interface.
 */
export interface ResolvedPRLite {
  /** The raw event ID */
  id: string;
  /** The author's pubkey */
  pubkey: string;
  /** The raw event — for consumers that need fields not in the flat interface */
  event: NostrEvent;
  /** Whether this is a root patch (kind 1617) or a pull request (kind 1618) */
  itemType: PRItemType;
  /** Non-default target branch from the PR's `b` tag; absent means default. */
  targetBranch: string | undefined;
  /** Original subject from the event itself */
  originalSubject: string;
  /** Current (effective) subject — latest authorised rename, or originalSubject */
  currentSubject: string;
  /** Body text (description tag for patches, content for PRs) */
  content: string;
  /** Unix timestamp (seconds) of the root event */
  createdAt: number;
  /**
   * Unix timestamp (seconds) of the most recent activity — the latest of the
   * root event, any comment, or any status/label event. Used for sorting lists
   * by "most recently active".
   */
  lastActivityAt: number;
  /** Current status — "deleted" takes precedence over all status events */
  status: IssueStatus;
  /** Deduplicated labels from t-tags and NIP-32 label events, sorted */
  labels: string[];
  /** Repository root coordinates from `a` tags, excluding legacy mentions */
  repoCoords: string[];
  /** Number of NIP-22 comments (kind:1111) */
  commentCount: number;
  /** Number of unique commenter pubkeys */
  participantCount: number;
  /** Total sats zapped (sum of zap receipt amounts) */
  zapTotal: number;
  /** Pubkeys authorised to write status/label/rename events */
  authorisedUsers: Set<string>;
  /**
   * Set of label event IDs (kind:1985) that have been deleted by their author
   * via NIP-09. Forwarded to buildTimelineNodes so label timeline entries are
   * suppressed for deleted events.
   */
  deletedEssentialEventIds: Set<string>;
}

/** Whether an event author may update state for a repository item. */
export function isItemEventAuthorised(
  pubkey: string,
  itemPubkey: string,
  maintainers: ReadonlySet<string>,
): boolean {
  // An empty set means repository resolution is still loading. Existing
  // models keep events visible until the authoritative set arrives.
  return (
    maintainers.size === 0 || pubkey === itemPubkey || maintainers.has(pubkey)
  );
}

/**
 * Sort events from oldest to newest using NIP-01 replacement ordering.
 * For equal timestamps the lower event ID wins, so it sorts last.
 */
export function compareNip01Chronologically(
  a: Pick<NostrEvent, "created_at" | "id">,
  b: Pick<NostrEvent, "created_at" | "id">,
): number {
  return a.created_at - b.created_at || b.id.localeCompare(a.id);
}

// ---------------------------------------------------------------------------
// resolveItemEssentials — per-item resolution shared by detail model & list
// ---------------------------------------------------------------------------

/**
 * The core resolved fields for a single PR/patch/issue, derived from its
 * essentials events. This is the per-item resolution logic extracted from
 * `buildResolvedList` so that both the list model (batch) and the detail
 * model (single item) can share the same auth and resolution rules.
 *
 * @param rootEvent       - The root event (kind 1617, 1618, or 1621)
 * @param essentialEvents - Status, label, and deletion events for this item
 * @param commentEvents   - NIP-22 comments (kind:1111) for this item
 * @param zapEvents       - Zap receipts (kind:9735) for this item
 * @param memberSet       - Current confirmed member pubkeys
 * @param options         - PR updates and deleted-essential events
 */
export function resolveItemEssentials(
  rootEvent: NostrEvent,
  essentialEvents: NostrEvent[],
  commentEvents: NostrEvent[],
  zapEvents: NostrEvent[],
  memberSet: Set<string>,
  options: ResolveEssentialsOptions = {},
): ResolvedItemEssentials {
  const { prUpdateEvents, essentialDeletionEvents } = options;
  const rootId = rootEvent.id;
  const rootPubkey = rootEvent.pubkey;

  // ── Build deleted essential event ID set ─────────────────────────────────
  // A deletion is valid only when the deleter's pubkey matches the pubkey
  // that originally published the target essential event (status or label).
  const essentialById = new Map(essentialEvents.map((e) => [e.id, e]));
  const deletedEssentialEventIds = new Set<string>();
  for (const delEv of essentialDeletionEvents ?? []) {
    for (const [t, id] of delEv.tags) {
      if (t !== "e") continue;
      const target = essentialById.get(id);
      if (target && delEv.pubkey === target.pubkey) {
        deletedEssentialEventIds.add(id);
      }
    }
  }

  // ── Process essentials ──────────────────────────────────────────────────
  let isDeleted = false;
  let latestStatus: { kind: number; createdAt: number } | undefined;
  const nip32Labels = new Set<string>();
  const renames: { createdAt: number; id: string; value: string }[] = [];
  let latestEssentialAt = 0;

  for (const ev of essentialEvents) {
    const evRootId = getNip10References(ev).root?.e?.id;
    if (evRootId !== rootId) continue;

    if (ev.created_at > latestEssentialAt) latestEssentialAt = ev.created_at;

    const isMember = memberSet.has(ev.pubkey);
    const isAuthor = ev.pubkey === rootPubkey;

    // Deletion (kind:5) — NIP-09: only the original author's deletion is valid.
    if (ev.kind === DELETION_KIND) {
      if (isAuthor) isDeleted = true;
      continue;
    }

    // Status events (kinds 1630-1633)
    if ((STATUS_KINDS as readonly number[]).includes(ev.kind)) {
      // Skip status events that have been deleted by their author.
      if (deletedEssentialEventIds.has(ev.id)) continue;
      // NIP-34 authorises the root author or a confirmed repository member
      // for every status kind. A merged status records an authorised merge;
      // it does not grant permission to create or push the merge itself.
      if (!isAuthor && !isMember) continue;

      if (!latestStatus || ev.created_at > latestStatus.createdAt) {
        latestStatus = { kind: ev.kind, createdAt: ev.created_at };
      }
      continue;
    }

    // Label events (kind:1985)
    if (ev.kind === LABEL_KIND) {
      if (!isAuthor && !isMember) continue;
      // Skip label events that have been deleted by their author.
      if (deletedEssentialEventIds.has(ev.id)) continue;

      const subjectLabel = ev.tags.find(
        ([t, , ns]) => t === "l" && ns === SUBJECT_LABEL_NAMESPACE,
      );
      if (subjectLabel) {
        renames.push({
          createdAt: ev.created_at,
          id: ev.id,
          value: subjectLabel[1],
        });
      }

      for (const [t, label, ns] of ev.tags) {
        if (t === "l" && ns === ISSUE_LABEL_NAMESPACE && label) {
          nip32Labels.add(label);
        }
      }
    }
  }

  // ── Derive status ─────────────────────────────────────────────────────
  let status: IssueStatus;
  if (isDeleted) {
    status = "deleted";
  } else {
    status = latestStatus ? kindToStatus(latestStatus.kind) : "open";
  }

  // ── Derive subject ────────────────────────────────────────────────────
  const originalSubject = extractSubject(rootEvent);
  const sortedRenames = renames.sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const currentSubject =
    sortedRenames.length > 0
      ? sortedRenames[sortedRenames.length - 1].value
      : originalSubject;

  // ── Derive labels ─────────────────────────────────────────────────────
  const tLabels = rootEvent.tags
    .filter(([t, v]) => t === "t" && !PATCH_CHAIN_TAGS.has(v))
    .map(([, v]) => v);
  const labels = Array.from(
    new Set([...tLabels, ...Array.from(nip32Labels)]),
  ).sort();

  // ── Comments and zaps ─────────────────────────────────────────────────
  const filteredComments = commentEvents.filter((ev) => {
    const rootPointer = getCommentRootPointer(ev);
    const commentRootId =
      rootPointer && "id" in rootPointer ? rootPointer.id : undefined;
    return commentRootId === rootId;
  });
  const participantPubkeys = new Set(filteredComments.map((c) => c.pubkey));

  const filteredZapTotal = Math.floor(
    zapEvents
      .filter((ev) => {
        const zapRootId = getNip10References(ev).root?.e?.id;
        return zapRootId === rootId;
      })
      .reduce((sum, ev) => sum + (getZapAmount(ev) ?? 0), 0) / 1000,
  );

  // ── PR Update activity ────────────────────────────────────────────────
  let latestPRUpdateAt = 0;
  if (prUpdateEvents) {
    for (const ev of prUpdateEvents) {
      const updateRootId = ev.tags.find(([t]) => t === "E")?.[1];
      if (updateRootId === rootId && ev.created_at > latestPRUpdateAt) {
        latestPRUpdateAt = ev.created_at;
      }
    }
  }

  const latestCommentAt = filteredComments.reduce(
    (max, c) => Math.max(max, c.created_at),
    0,
  );
  const lastActivityAt = Math.max(
    rootEvent.created_at,
    latestCommentAt,
    latestEssentialAt,
    latestPRUpdateAt,
  );

  const authorisedUsers = new Set(memberSet);
  authorisedUsers.add(rootPubkey);

  return {
    id: rootId,
    pubkey: rootPubkey,
    event: rootEvent,
    originalSubject,
    currentSubject,
    content: extractBody(rootEvent),
    createdAt: rootEvent.created_at,
    lastActivityAt,
    status,
    labels,
    repoCoords: getRootRepositoryCoordinates(rootEvent).sort(),
    commentCount: filteredComments.length,
    participantCount: participantPubkeys.size,
    zapTotal: filteredZapTotal,
    authorisedUsers,
    deletedEssentialEventIds,
    subjectRenames: sortedRenames,
  };
}

/**
 * The result of resolving a single item's essentials. Extends the core
 * ResolvedIssueLite fields with the sorted rename events (needed by the detail
 * page for the conversation timeline).
 */
export interface ResolvedItemEssentials extends ResolvedIssueLite {
  /** Sorted subject-rename events (oldest first), for timeline display. */
  subjectRenames: { createdAt: number; id: string; value: string }[];
}

// ---------------------------------------------------------------------------
// ResolvedIssue — full detail-page view of an issue
// ---------------------------------------------------------------------------

/**
 * A node in the issue conversation timeline — interleaved comments and
 * subject renames, sorted chronologically.
 */
export type IssueTimelineNode =
  | {
      type: "rename";
      event: NostrEvent;
      oldSubject: string;
      newSubject: string;
      ts: number;
    }
  | {
      type: "thread";
      node: import("@/lib/threadTree").ThreadTreeNode;
      ts: number;
    }
  | {
      type: "status";
      event: NostrEvent;
      /** The status this event sets */
      status: IssueStatus;
      /** True when the author is authorised (maintainer or item author) */
      authorised: boolean;
      ts: number;
    }
  | {
      type: "label";
      event: NostrEvent;
      /** Labels added by this event */
      labels: string[];
      /** True when the author is authorised (maintainer or item author) */
      authorised: boolean;
      ts: number;
    }
  | {
      type: "zap";
      /** The kind:9735 zap receipt */
      event: NostrEvent;
      /** Sender pubkey extracted from the embedded zap request */
      sender: string | undefined;
      /** Payment amount in sats */
      amountSats: number;
      /** Message from the zap request content */
      message: string;
      ts: number;
    };

/**
 * The fully-resolved detail-page view of an issue.
 *
 * Extends `ResolvedIssueLite` (the list-page summary) with full comment list,
 * zaps, timeline nodes, rename items, participants, and the raw root event.
 *
 * Produced by `IssueDetailModel`. The UI page consumes this directly without
 * needing to call per-item hooks for status, labels, subject, etc.
 */
export interface ResolvedIssue extends ResolvedIssueLite {
  /** Issue body (same as content, provided for symmetry with ResolvedPR) */
  body: string;

  /**
   * The latest authorised cover note (kind:1624) for this issue, if any.
   * Only the item author or a maintainer may post a cover note.
   */
  coverNote?: NostrEvent;

  /**
   * All authorised cover notes (kind:1624) for this issue, sorted newest-first.
   * Includes the resolved `coverNote` plus any older versions by other authors.
   */
  coverNotes: NostrEvent[];

  /**
   * Pre-built conversation timeline: interleaved comments and subject renames,
   * sorted chronologically.
   */
  timelineNodes: IssueTimelineNode[];

  /** All NIP-22 comments (kind:1111) for this issue. */
  comments: NostrEvent[];

  /** Zap receipts (kind:9735) for this issue. */
  zaps: NostrEvent[];

  /** Sorted subject-rename events with old/new subjects for display. */
  renameItems: {
    event: NostrEvent;
    oldSubject: string;
    newSubject: string;
  }[];

  /** All unique participant pubkeys (author + commenters). */
  participants: string[];

  /** The raw root event (kind:1621). */
  rootEvent: NostrEvent;

  /** The effective maintainer set. */
  maintainers: Set<string>;
}

// ---------------------------------------------------------------------------
// Shared detail-page helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the latest authorised cover note (kind:1624) for an item.
 *
 * A cover note is authorised when its author is the item author or a
 * confirmed maintainer. When multiple authorised cover notes exist, the
 * one with the highest `created_at` wins (ties broken by event ID).
 *
 * @param rootId          - The event ID of the root issue / PR / patch
 * @param rootPubkey      - The pubkey of the root event author
 * @param coverNoteEvents - All kind:1624 events referencing this root
 * @param authorisedUsers - Pubkeys authorised to write for this item
 */
export function resolveCoverNote(
  rootId: string,
  rootPubkey: string,
  coverNoteEvents: NostrEvent[],
  authorisedUsers: Set<string>,
): NostrEvent | undefined {
  const candidates = resolveCoverNotes(
    rootId,
    rootPubkey,
    coverNoteEvents,
    authorisedUsers,
  );
  return candidates[0];
}

/**
 * Return all authorised cover notes (kind:1624) for an item, sorted
 * newest-first (highest `created_at`, ties broken by event ID descending).
 *
 * A cover note is authorised when its author is the item author or a
 * confirmed member.
 *
 * @param rootId          - The event ID of the root issue / PR / patch
 * @param rootPubkey      - The pubkey of the root event author
 * @param coverNoteEvents - All kind:1624 events referencing this root
 * @param authorisedUsers - Pubkeys authorised to write for this item
 */
export function resolveCoverNotes(
  rootId: string,
  rootPubkey: string,
  coverNoteEvents: NostrEvent[],
  authorisedUsers: Set<string>,
): NostrEvent[] {
  const candidates = coverNoteEvents.filter(
    (ev) =>
      ev.kind === COVER_NOTE_KIND &&
      ev.tags.some((t) => t[0] === "e" && t[1] === rootId) &&
      // authorisedUsers.size === 0 means members are not yet loaded — treat
      // the item author as authorised to avoid a flash of no cover note.
      (authorisedUsers.size === 0
        ? ev.pubkey === rootPubkey
        : authorisedUsers.has(ev.pubkey)),
  );
  return candidates.sort((a, b) =>
    b.created_at !== a.created_at
      ? b.created_at - a.created_at
      : b.id < a.id
        ? -1
        : 1,
  );
}

/**
 * Build rename items with old/new subjects for display.
 *
 * Used by both IssueDetailModel and PRDetailModel.
 */
export function buildRenameItems(
  originalSubject: string,
  subjectRenames: { createdAt: number; id: string; value: string }[],
  essentialEvents: NostrEvent[],
): { event: NostrEvent; oldSubject: string; newSubject: string }[] {
  if (subjectRenames.length === 0) return [];

  // Build a map of essential events by ID for quick lookup
  const evById = new Map<string, NostrEvent>();
  for (const ev of essentialEvents) evById.set(ev.id, ev);

  let prevSubject = originalSubject;
  return subjectRenames
    .map((rename) => {
      const ev = evById.get(rename.id);
      if (!ev) return null;
      const item = {
        event: ev,
        oldSubject: prevSubject,
        newSubject: rename.value,
      };
      prevSubject = rename.value;
      return item;
    })
    .filter(
      (
        item,
      ): item is {
        event: NostrEvent;
        oldSubject: string;
        newSubject: string;
      } => item !== null,
    );
}

// ---------------------------------------------------------------------------
// buildTimelineNodes — unified timeline builder for issues and PRs
// ---------------------------------------------------------------------------

interface BuildTimelineBaseArgs {
  rootEvent: NostrEvent;
  /** All comments (NIP-22 + legacy replies), already merged and deduplicated. */
  comments: NostrEvent[];
  /**
   * Raw essential events (status, label/rename, deletion) — unfiltered.
   * buildTimelineNodes applies its own auth logic for display purposes,
   * independently of resolveItemEssentials which filters for effective status.
   */
  essentials: NostrEvent[];
  /** Authorised users set (confirmed members + item author). */
  authorisedUsers: Set<string>;
  /**
   * Set of essential event IDs (status, label/rename) deleted by their author
   * via NIP-09. Label timeline nodes whose event ID appears here are omitted.
   * Comes from resolveItemEssentials.deletedEssentialEventIds.
   */
  deletedEssentialEventIds?: Set<string>;
  /**
   * Zap receipts (kind:9735) on the root item. When provided, zaps with a
   * message longer than 18 characters or an amount above 499 sats are
   * surfaced as compact `"zap"` timeline nodes.
   */
  zaps?: NostrEvent[];
}

export interface BuildIssueTimelineArgs extends BuildTimelineBaseArgs {
  itemType: "issue";
}

export interface BuildPRTimelineArgs extends BuildTimelineBaseArgs {
  itemType: "pr" | "patch";
  /** Ordered revisions (oldest first). */
  revisions: PRRevision[];
  /**
   * IDs of revision root patch events (excluding the original root).
   * Used to route comments to the correct revision sub-thread.
   */
  revisionRootIds: string[];
}

export type BuildTimelineArgs = BuildIssueTimelineArgs | BuildPRTimelineArgs;

/**
 * Build the interleaved conversation timeline for an issue or PR/patch.
 *
 * Handles all node types:
 * - `"status"`:   status change events (1630–1633), shown for all authors
 *                 with an `authorised` flag for display purposes
 * - `"rename"`:   subject-rename label events (kind:1985 with #subject ns)
 * - `"label"`:    label/hashtag events (kind:1985 with #t ns), shown for all
 *                 authors with an `authorised` flag for display purposes
 * - `"revision"`: patch-set pushes or PR Updates (PR/patch only)
 * - `"thread"`:   NIP-22 comments and legacy replies, threaded
 * - `"zap"`:      zap receipts with message > 18 chars or amount > 499 sats
 *
 * All nodes are sorted chronologically. At equal timestamps, non-thread
 * nodes sort before thread nodes (activity markers before replies).
 * For PR/patch, revision nodes sort before other nodes at equal timestamps.
 */
export function buildTimelineNodes(
  args: BuildIssueTimelineArgs,
): IssueTimelineNode[];
export function buildTimelineNodes(args: BuildPRTimelineArgs): PRTimelineNode[];
export function buildTimelineNodes(
  args: BuildTimelineArgs,
): IssueTimelineNode[] | PRTimelineNode[] {
  const { rootEvent, comments, essentials, authorisedUsers } = args;
  const rootId = rootEvent.id;

  const isStatusAuthorised = (ev: NostrEvent): boolean =>
    // authorisedUsers.size === 0 means members are not yet loaded — treat as
    // authorised to avoid a flash of "proposed" on initial load.
    authorisedUsers.size === 0 || authorisedUsers.has(ev.pubkey);

  // ── Status nodes ──────────────────────────────────────────────────────────
  // Show all status events regardless of auth; flag unauthorised ones so the
  // UI can render "proposed status" vs "set status".
  const statusNodes: (IssueTimelineNode | PRTimelineNode)[] = essentials
    .filter((ev) => (STATUS_KINDS as readonly number[]).includes(ev.kind))
    .map((ev) => ({
      type: "status" as const,
      event: ev,
      status: kindToStatus(ev.kind),
      authorised: isStatusAuthorised(ev),
      ts: ev.created_at,
    }));

  // ── Rename nodes ──────────────────────────────────────────────────────────
  // Only authorised renames (already filtered by resolveItemEssentials for
  // effective subject, but here we derive them directly from essentials for
  // the timeline — same auth rule: root author or confirmed member).
  const renameEvs = essentials
    .filter(
      (ev) =>
        ev.kind === LABEL_KIND &&
        (authorisedUsers.size === 0 || authorisedUsers.has(ev.pubkey)) &&
        ev.tags.some(
          ([t, , ns]) => t === "l" && ns === SUBJECT_LABEL_NAMESPACE,
        ),
    )
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  // Reconstruct old/new subject pairs in order
  const originalSubject = extractSubject(rootEvent);
  let prevSubject = originalSubject;
  const renameNodes: (IssueTimelineNode | PRTimelineNode)[] = renameEvs.map(
    (ev) => {
      const newSubject = ev.tags.find(
        ([t, , ns]) => t === "l" && ns === SUBJECT_LABEL_NAMESPACE,
      )![1];
      const node: IssueTimelineNode = {
        type: "rename",
        event: ev,
        oldSubject: prevSubject,
        newSubject,
        ts: ev.created_at,
      };
      prevSubject = newSubject;
      return node;
    },
  );

  // ── Label nodes ───────────────────────────────────────────────────────────
  // Show label events that carry ISSUE_LABEL_NAMESPACE labels (not subject
  // renames). Show all authors; flag unauthorised ones for display purposes.
  // Skip events deleted by their author via NIP-09.
  const labelNodes: (IssueTimelineNode | PRTimelineNode)[] = essentials
    .filter(
      (ev) =>
        ev.kind === LABEL_KIND &&
        !args.deletedEssentialEventIds?.has(ev.id) &&
        ev.tags.some(([t, , ns]) => t === "l" && ns === ISSUE_LABEL_NAMESPACE),
    )
    .map((ev) => {
      const labels = ev.tags
        .filter(([t, , ns]) => t === "l" && ns === ISSUE_LABEL_NAMESPACE)
        .map(([, label]) => label)
        .filter(Boolean);
      return {
        type: "label" as const,
        event: ev,
        labels,
        authorised:
          authorisedUsers.size === 0 || authorisedUsers.has(ev.pubkey),
        ts: ev.created_at,
      };
    })
    .filter((n) => n.labels.length > 0);

  // ── Zap nodes ─────────────────────────────────────────────────────────────
  // Only show zaps that meet the display threshold:
  //   message length > 18 characters, OR amount > 499 sats.
  const ZAP_MSG_MIN_LENGTH = 19;
  const ZAP_SATS_MIN = 500;
  const zapNodes: (IssueTimelineNode | PRTimelineNode)[] = (
    args.zaps ?? []
  ).flatMap((ev) => {
    const zapRequest = getZapRequest(ev);
    const message = (zapRequest?.content ?? "").trim();
    const amountSats = Math.floor((getZapAmount(ev) ?? 0) / 1000);
    if (message.length < ZAP_MSG_MIN_LENGTH && amountSats < ZAP_SATS_MIN)
      return [];
    return [
      {
        type: "zap" as const,
        event: ev,
        sender: getZapSender(ev),
        amountSats,
        message,
        ts: ev.created_at,
      },
    ];
  });

  // ── Thread nodes (root-level comments) ───────────────────────────────────
  // For patches: only comments whose E root tag points at the original root.
  // Revision-rooted comments are handled below, interleaved after their revision.
  const isPatch = args.itemType === "patch";
  const revisionRootIdSet: Set<string> =
    args.itemType !== "issue" ? new Set(args.revisionRootIds) : new Set();

  const rootComments =
    isPatch && revisionRootIdSet.size > 0
      ? comments.filter((c) => {
          const rootTag = c.tags.find((t) => t[0] === "E");
          if (!rootTag) return true;
          return rootTag[1] === rootId;
        })
      : comments;

  const threadTree = getThreadTree(rootEvent, rootComments);
  const rootThreadNodes: (IssueTimelineNode | PRTimelineNode)[] = threadTree
    ? threadTree.children.map((child) => ({
        type: "thread" as const,
        node: child,
        ts: child.event.created_at,
      }))
    : [];

  if (args.itemType === "issue") {
    // ── Issue: merge all nodes and sort ──────────────────────────────────
    const nodes: IssueTimelineNode[] = [
      ...statusNodes,
      ...renameNodes,
      ...labelNodes,
      ...zapNodes,
      ...rootThreadNodes,
    ] as IssueTimelineNode[];

    nodes.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      // Non-thread nodes (activity markers) sort before thread nodes
      const order = (t: IssueTimelineNode["type"]) => (t === "thread" ? 1 : 0);
      return order(a.type) - order(b.type);
    });

    return nodes;
  }

  // ── PR/patch: build revision nodes, each with their sub-thread ───────────
  const { revisions } = args;
  const revisionNodes: PRTimelineNode[] = [];

  for (const revision of revisions) {
    revisionNodes.push({
      type: "revision",
      revision,
      ts: revision.createdAt,
    });

    // For patch revisions (not the original root): emit comments rooted at
    // this revision's root patch immediately after the revision node.
    // They'll be re-sorted into chronological position below, but keeping
    // them logically associated here makes the sort stable.
    if (
      isPatch &&
      revision.rootPatchEvent &&
      revision.rootPatchEvent.id !== rootId
    ) {
      const revId = revision.rootPatchEvent.id;
      const revComments = comments.filter((c) => {
        const rootTag = c.tags.find((t) => t[0] === "E");
        return rootTag?.[1] === revId;
      });
      if (revComments.length > 0) {
        const revTree = getThreadTree(revision.rootPatchEvent, revComments);
        if (revTree) {
          for (const child of revTree.children) {
            revisionNodes.push({
              type: "thread",
              node: child,
              ts: child.event.created_at,
            });
          }
        }
      }
    }
  }

  const nodes: PRTimelineNode[] = [
    ...statusNodes,
    ...renameNodes,
    ...labelNodes,
    ...zapNodes,
    ...rootThreadNodes,
    ...revisionNodes,
  ] as PRTimelineNode[];

  nodes.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // At equal timestamps: revision < other activity markers < thread
    const order = (t: PRTimelineNode["type"]) => {
      if (t === "revision") return 0;
      if (t === "thread") return 2;
      return 1;
    };
    return order(a.type) - order(b.type);
  });

  return nodes;
}

// ---------------------------------------------------------------------------
// ResolvedPR — full detail-page view of a PR or patch
// ---------------------------------------------------------------------------

/**
 * A single revision of a PR or patch set. Unified across both mechanisms:
 * - For patches: a patch chain (original or root-revision)
 * - For PRs: a PR Update event (kind:1619), or the original PR as revision 0
 */
export interface PRRevision {
  /** Discriminator: "patch-set" for patch chains, "pr-update" for kind:1619 */
  type: "patch-set" | "pr-update";
  /** Timestamp of this revision */
  createdAt: number;
  /** Tip commit ID from this revision, if available */
  tipCommitId: string | undefined;
  /** Merge-base from tags, if available */
  mergeBase: string | undefined;
  /** Clone URLs from this revision's tags */
  cloneUrls: string[];
  /** True when this revision has been superseded by a later one */
  superseded: boolean;
  /** The pubkey of the revision author */
  pubkey: string;
  /**
   * For patch-set revisions: the ordered patches in this chain.
   * Undefined for pr-update revisions.
   */
  patches?: import("@/casts/Patch").Patch[];
  /**
   * For pr-update revisions: the raw PR Update event.
   * Undefined for patch-set revisions.
   */
  updateEvent?: NostrEvent;
  /**
   * For patch-set revisions: the root patch of this revision.
   * Undefined for pr-update revisions.
   */
  rootPatchEvent?: NostrEvent;
}

/**
 * A node in the conversation timeline — interleaved push events, comments,
 * and subject renames, sorted chronologically.
 */
export type PRTimelineNode =
  | { type: "revision"; revision: PRRevision; ts: number }
  | {
      type: "rename";
      event: NostrEvent;
      oldSubject: string;
      newSubject: string;
      ts: number;
    }
  | {
      type: "thread";
      node: import("@/lib/threadTree").ThreadTreeNode;
      ts: number;
    }
  | {
      type: "status";
      event: NostrEvent;
      /** The status this event sets */
      status: IssueStatus;
      /** True when the author is authorised (maintainer or item author) */
      authorised: boolean;
      ts: number;
    }
  | {
      type: "label";
      event: NostrEvent;
      /** Labels added by this event */
      labels: string[];
      /** True when the author is authorised (maintainer or item author) */
      authorised: boolean;
      ts: number;
    }
  | {
      type: "zap";
      /** The kind:9735 zap receipt */
      event: NostrEvent;
      /** Sender pubkey extracted from the embedded zap request */
      sender: string | undefined;
      /** Payment amount in sats */
      amountSats: number;
      /** Message from the zap request content */
      message: string;
      ts: number;
    };

/**
 * The fully-resolved detail-page view of a PR or patch.
 *
 * Extends `ResolvedPRLite` (the list-page summary) with revision history,
 * timeline nodes, tip info, comments, and other detail-page data.
 *
 * Produced by `PRDetailModel`. The UI page consumes this directly without
 * needing to call per-item hooks for status, labels, subject, etc.
 */
export interface ResolvedPR extends ResolvedPRLite {
  /** Body text (description tag for patches, content for PRs) */
  body: string;

  /**
   * The latest authorised cover note (kind:1624) for this PR/patch, if any.
   * Only the item author or a maintainer may post a cover note.
   */
  coverNote?: NostrEvent;

  /**
   * All authorised cover notes (kind:1624) for this PR/patch, sorted newest-first.
   * Includes the resolved `coverNote` plus any older versions by other authors.
   */
  coverNotes: NostrEvent[];

  /**
   * All revisions ordered oldest-first. The last entry is the current
   * (latest) revision; all earlier ones are superseded.
   *
   * For patches: one entry per patch chain (original + root-revisions).
   * For PRs: one entry per kind:1619 PR Update (plus the original PR as
   * revision 0 when it has a tip commit).
   */
  revisions: PRRevision[];

  /**
   * The effective tip info from the latest authorised revision.
   * Unified across both PR and patch mechanisms.
   */
  tip: {
    /** Tip commit ID from the latest revision */
    commitId: string | undefined;
    /** Merge-base from tags (explicit), if available */
    explicitMergeBase: string | undefined;
    /** Clone URLs from the latest revision + the root event */
    cloneUrls: string[];
  };

  /**
   * Pre-built conversation timeline: interleaved push events, comments,
   * and subject renames, sorted chronologically.
   */
  timelineNodes: PRTimelineNode[];

  /** All NIP-22 comments (kind:1111) across all revisions, deduplicated. */
  comments: NostrEvent[];

  /** Zap receipts (kind:9735) for this item. */
  zaps: NostrEvent[];

  /** Sorted subject-rename events with old/new subjects for display. */
  renameItems: {
    event: NostrEvent;
    oldSubject: string;
    newSubject: string;
  }[];

  /** All unique participant pubkeys (author + commenters + update authors). */
  participants: string[];

  /** The raw root event (kind:1617 or kind:1618). */
  rootEvent: NostrEvent;

  /** The effective maintainer set. */
  maintainers: Set<string>;

  /**
   * For patches: the raw patch diff from the root patch's content.
   * Undefined for PRs.
   */
  patchDiff?: string;

  /**
   * For patches: commits from the first (original) revision that were
   * published at roughly the same time as the root event (within a few
   * seconds). These are shown inline in the body card, matching the PR
   * behaviour. Undefined when the first revision was published later (i.e.
   * it was a separate push and should remain in the timeline).
   */
  initialPatchCommits?: Array<{
    commitId: string | undefined;
    /** Nostr event ID of the patch — used as a fallback link target when commitId is absent. */
    eventId: string;
    subject: string;
  }>;

  /**
   * True when the first patch revision has been inlined into the body card
   * via `initialPatchCommits`. The timeline should skip rendering that
   * revision as a separate push event.
   */
  firstRevisionInlined?: boolean;

  /**
   * For patches: true when the body was sourced from a cover-letter patch
   * (a patch with `[PATCH 0/N]` subject or `t:cover-letter` tag).
   * Undefined / false for PRs and patches without a cover letter.
   */
  hasCoverLetter?: boolean;
}

// ---------------------------------------------------------------------------
// buildResolvedPRs — batch builder for list pages
// ---------------------------------------------------------------------------

/**
 * Build a sorted list of ResolvedPRLite objects from raw patch and PR events.
 * Identical to buildResolvedIssues, with an itemType discriminator
 * ("patch" | "pr") added to each item.
 *
 * prUpdateEvents (kind:1619) are factored into lastActivityAt so the list
 * sorts correctly when a PR branch is updated. They are NOT counted as
 * comments.
 */
export function buildResolvedPRs(
  rootEvents: NostrEvent[],
  essentialEvents: NostrEvent[],
  commentEvents: NostrEvent[],
  zapEvents: NostrEvent[],
  memberSet: Set<string>,
  prUpdateEvents: NostrEvent[] = [],
): ResolvedPRLite[] {
  return buildResolvedList(
    rootEvents,
    essentialEvents,
    commentEvents,
    zapEvents,
    memberSet,
    {
      prUpdateEvents,
    },
  ).map((item) => ({
    ...item,
    itemType: (item.event.kind === PATCH_KIND ? "patch" : "pr") as PRItemType,
    targetBranch: getPRTargetBranch(item.event),
  }));
}

// ---------------------------------------------------------------------------
// BFS chain resolution
// ---------------------------------------------------------------------------

function repositoryComponentId(dTag: string, maintainers: Iterable<string>) {
  return JSON.stringify([dTag, [...new Set(maintainers)].sort()]);
}

function resolvedRepoFromMembership(
  membership: RepositoryMembershipResolution,
): ResolvedRepo {
  const { selectedMaintainer, dTag } = membership;

  // Shared metadata and infrastructure are accepted only from confirmed
  // members. Invitations and departed authors remain discovery inputs.
  const announcements = membership.confirmedAnnouncements;
  const selectedAnnouncement = membership.discoveredAnnouncements.find(
    (event) => event.pubkey === selectedMaintainer,
  )!;

  // --- Merge fields ---

  // Latest-wins: name, description, webUrls
  let latestEv: NostrEvent | undefined;
  for (const ev of announcements) {
    if (
      !latestEv ||
      ev.created_at > latestEv.created_at ||
      (ev.created_at === latestEv.created_at && ev.id < latestEv.id)
    ) {
      latestEv = ev;
    }
  }

  // Find the latest announcement that actually has a name/description
  // (fall back to overall latest if none have it)
  const nameSource = announcements.reduce(
    (best, ev) => {
      const val = getRepoName(ev);
      if (!val) return best;
      return ev.created_at > best.createdAt ||
        (ev.created_at === best.createdAt && ev.id < best.eventId)
        ? {
            pubkey: ev.pubkey,
            createdAt: ev.created_at,
            eventId: ev.id,
            value: val,
          }
        : best;
    },
    {
      pubkey: latestEv?.pubkey ?? selectedMaintainer,
      createdAt: 0,
      eventId: "f".repeat(64),
      value: latestEv ? getRepoName(latestEv) : dTag,
    },
  );

  const descriptionSource = announcements.reduce(
    (best, ev) => {
      const val = getRepoDescription(ev);
      return ev.created_at > best.createdAt ||
        (ev.created_at === best.createdAt && ev.id < best.eventId)
        ? {
            pubkey: ev.pubkey,
            createdAt: ev.created_at,
            eventId: ev.id,
            value: val,
          }
        : best;
    },
    {
      pubkey: latestEv?.pubkey ?? selectedMaintainer,
      createdAt: 0,
      eventId: "f".repeat(64),
      value: latestEv ? getRepoDescription(latestEv) : "",
    },
  );

  // Union: clone URLs and relays with provenance
  const cloneUrlProvenance: FieldProvenance[] = [];
  const relayProvenance: FieldProvenance[] = [];
  const seenClone = new Set<string>();
  const seenRelay = new Set<string>();
  const seenLabel = new Set<string>();
  const labels: string[] = [];

  for (const ev of announcements) {
    for (const v of getRepoCloneUrls(ev)) {
      const key = normalizeUrl(v);
      if (!seenClone.has(key)) {
        seenClone.add(key);
        cloneUrlProvenance.push({
          pubkey: ev.pubkey,
          createdAt: ev.created_at,
          value: v,
        });
      }
    }
    for (const v of getRepoRelays(ev)) {
      const key = normalizeUrl(v);
      if (!seenRelay.has(key)) {
        seenRelay.add(key);
        relayProvenance.push({
          pubkey: ev.pubkey,
          createdAt: ev.created_at,
          value: v,
        });
      }
    }
    for (const [t, v] of ev.tags) {
      if (t === "t" && v && !seenLabel.has(v)) {
        seenLabel.add(v);
        labels.push(v);
      }
    }
  }

  const selectedCoordinate = repoCoordinate(selectedMaintainer, dTag);

  const allCloneUrls = cloneUrlProvenance.map((p) => p.value);
  const graspCloneUrls = allCloneUrls.filter(isGraspCloneUrl);
  const additionalGitServerUrls = allCloneUrls.filter(
    (u) => !isGraspCloneUrl(u),
  );
  const graspServerDomains = Array.from(
    new Set(
      graspCloneUrls
        .map(graspCloneUrlDomain)
        .filter((d): d is string => d !== undefined),
    ),
  );
  const graspServerAddresses = Array.from(
    new Set(
      graspCloneUrls
        .map(graspCloneUrlServiceAddress)
        .filter((address): address is string => address !== undefined),
    ),
  );

  return {
    componentId: repositoryComponentId(dTag, membership.confirmedMaintainers),
    selectedMaintainer,
    selectedCoordinate,
    dTag,
    name: nameSource.value || dTag,
    description: descriptionSource.value,
    webUrls: latestEv ? getRepoWebUrls(latestEv) : [],
    updatedAt: latestEv?.created_at ?? selectedAnnouncement.created_at,
    cloneUrls: allCloneUrls,
    graspCloneUrls,
    additionalGitServerUrls,
    graspServerDomains,
    graspServerAddresses,
    relays: relayProvenance.map((p) => p.value),
    confirmedMaintainers: membership.confirmedMaintainers,
    confirmedModerators: membership.confirmedModerators,
    confirmedMembers: membership.confirmedMembers,
    confirmedMaintainerCoordinates: membership.confirmedMaintainers.map((pk) =>
      repoCoordinate(pk, dTag),
    ),
    confirmedMemberCoordinates: membership.confirmedMembers.map((pk) =>
      repoCoordinate(pk, dTag),
    ),
    invitedMaintainers: membership.invitedMaintainers,
    invitedModerators: membership.invitedModerators,
    departedMaintainers: membership.departedMaintainers,
    departedModerators: membership.departedModerators,
    discoveryPubkeys: membership.discoveryPubkeys,
    labels,
    discoveredAnnouncements: membership.discoveredAnnouncements,
    confirmedAnnouncements: membership.confirmedAnnouncements,
    maintainerEdges: membership.maintainerEdges,
    moderatorEdges: membership.moderatorEdges,
    repositoryHealth: membership.repositoryHealth,
    leadResolution: membership.leadResolution,
    cloneUrlProvenance,
    relayProvenance,
    nameSource,
    descriptionSource,
  };
}

/** Resolve one coordinate-rooted repository view before component deduplication. */
function resolveRootedRepository(
  events: NostrEvent[],
  selectedMaintainer: string,
  dTag: string,
): ResolvedRepo | undefined {
  const membership = resolveRepositoryMembership(
    events,
    selectedMaintainer,
    dTag,
  );
  return membership ? resolvedRepoFromMembership(membership) : undefined;
}

/**
 * Order-independent repository partition for the announcements currently in
 * memory. Coordinate maps contain at most one component ID, enforcing the
 * protocol rule that one active announcement cannot represent two repos.
 */
export interface RepositoryComponentIndex {
  components: ResolvedRepo[];
  componentById: ReadonlyMap<string, ResolvedRepo>;
  coordinateComponentIds: ReadonlyMap<string, string>;
  confirmedCoordinateComponentIds: ReadonlyMap<string, string>;
  rootedRepositories: ReadonlyMap<string, ResolvedRepo>;
}

interface RepositoryComponentDraft {
  id: string;
  dTag: string;
  anchor: string;
  maintainers: string[];
  moderatorCandidates: string[];
  views: ResolvedRepo[];
  anchorView: ResolvedRepo;
  latestByPubkey: ReadonlyMap<string, NostrEvent>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function chooseComponentAnchor(
  maintainers: string[],
  views: ResolvedRepo[],
): { anchor: string; view: ResolvedRepo } {
  const memberSet = new Set(maintainers);
  const ranked = views
    .flatMap((view) => {
      const lead = view.leadResolution.leadMaintainer;
      if (!lead || !memberSet.has(lead)) return [];
      const rank =
        view.leadResolution.source === "explicit"
          ? 0
          : view.leadResolution.source === "legacy_inferred"
            ? 1
            : view.leadResolution.source === "implicit_sole"
              ? 2
              : 3;
      return [{ lead, rank, view }];
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.lead.localeCompare(b.lead) ||
        a.view.selectedMaintainer.localeCompare(b.view.selectedMaintainer),
    );
  const anchor = ranked[0]?.lead ?? maintainers[0];
  const view =
    views.find((candidate) => candidate.selectedMaintainer === anchor) ??
    ranked[0]?.view ??
    views[0];
  return { anchor, view };
}

function uniqueMaintainerEdges(views: ResolvedRepo[]): MaintainerEdge[] {
  const edges = new Map<string, MaintainerEdge>();
  for (const edge of views.flatMap((view) => view.maintainerEdges)) {
    edges.set(`${edge.from}:${edge.to}:${edge.role}:${edge.source}`, edge);
  }
  return [...edges.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.role.localeCompare(b.role) ||
      a.source.localeCompare(b.source),
  );
}

function uniqueModeratorEdges(views: ResolvedRepo[]): ModeratorEdge[] {
  const edges = new Map<string, ModeratorEdge>();
  for (const edge of views.flatMap((view) => view.moderatorEdges)) {
    edges.set(`${edge.from}:${edge.to}`, edge);
  }
  return [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

function uniqueRepositoryHealth(
  views: ResolvedRepo[],
): RepositoryHealthWarning[] {
  const warnings = new Map<string, RepositoryHealthWarning>();
  for (const warning of views.flatMap((view) => view.repositoryHealth)) {
    warnings.set(
      JSON.stringify([
        warning.code,
        warning.author,
        warning.role,
        warning.subject,
        warning.message,
      ]),
      warning,
    );
  }
  return [...warnings.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, warning]) => warning);
}

/** Build the deterministic component index shared by all repository readers. */
export function buildRepositoryComponentIndex(
  events: Iterable<NostrEvent>,
): RepositoryComponentIndex {
  const sourceEvents = [...events];
  const dTags = uniqueSorted(
    sourceEvents.flatMap((event) => {
      if (event.kind !== REPO_KIND) return [];
      const dTag = getReplaceableIdentifier(event);
      return dTag ? [dTag] : [];
    }),
  );
  const drafts: RepositoryComponentDraft[] = [];
  const rootedRepositories = new Map<string, ResolvedRepo>();
  const maintainerComponentIds = new Map<string, string>();

  for (const dTag of dTags) {
    const latestByPubkey = latestRepositoryAnnouncements(sourceEvents, dTag);
    const latestEvents = [...latestByPubkey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, event]) => event);
    const views = latestEvents.flatMap((event) => {
      const view = resolveRootedRepository(latestEvents, event.pubkey, dTag);
      if (!view) return [];
      rootedRepositories.set(repoCoordinate(event.pubkey, dTag), view);
      if (view.confirmedMaintainers.length === 0) return [];
      return [view];
    });

    const parents = new Map<string, string>();
    const find = (pubkey: string): string => {
      const parent = parents.get(pubkey);
      if (!parent) {
        parents.set(pubkey, pubkey);
        return pubkey;
      }
      if (parent === pubkey) return pubkey;
      const root = find(parent);
      parents.set(pubkey, root);
      return root;
    };
    const union = (left: string, right: string) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      const [first, second] = [leftRoot, rightRoot].sort();
      parents.set(second, first);
    };

    for (const view of views) {
      const [first, ...rest] = uniqueSorted(view.confirmedMaintainers);
      if (!first) continue;
      find(first);
      for (const maintainer of rest) union(first, maintainer);
    }

    const membersByRoot = new Map<string, string[]>();
    for (const maintainer of [...parents].map(([pubkey]) => pubkey).sort()) {
      const root = find(maintainer);
      const members = membersByRoot.get(root) ?? [];
      members.push(maintainer);
      membersByRoot.set(root, members);
    }

    for (const maintainers of [...membersByRoot.values()].sort((a, b) =>
      a.join(",").localeCompare(b.join(",")),
    )) {
      const memberSet = new Set(maintainers);
      const componentViews = views.filter((view) =>
        view.confirmedMaintainers.some((pubkey) => memberSet.has(pubkey)),
      );
      const { anchor, view: anchorView } = chooseComponentAnchor(
        maintainers,
        componentViews,
      );
      const orderedMaintainers = [
        anchor,
        ...maintainers.filter((pubkey) => pubkey !== anchor),
      ];
      const id = repositoryComponentId(dTag, orderedMaintainers);
      for (const maintainer of orderedMaintainers) {
        maintainerComponentIds.set(repoCoordinate(maintainer, dTag), id);
      }
      drafts.push({
        id,
        dTag,
        anchor,
        maintainers: orderedMaintainers,
        moderatorCandidates: uniqueSorted(
          componentViews.flatMap((view) => view.confirmedModerators),
        ),
        views: componentViews,
        anchorView,
        latestByPubkey,
      });
    }
  }

  // A role-aware announcement can belong to only one active repository. A
  // maintainer component wins over a moderator acknowledgement; otherwise a
  // pathological acknowledgement of two components resolves by stable ID.
  const moderatorOwners = new Map<string, string>();
  const moderatorDrafts = new Map<string, RepositoryComponentDraft[]>();
  for (const draft of drafts) {
    for (const moderator of draft.moderatorCandidates) {
      const coordinate = repoCoordinate(moderator, draft.dTag);
      const candidates = moderatorDrafts.get(coordinate) ?? [];
      candidates.push(draft);
      moderatorDrafts.set(coordinate, candidates);
    }
  }
  for (const [coordinate, candidates] of moderatorDrafts) {
    const maintainerOwner = maintainerComponentIds.get(coordinate);
    moderatorOwners.set(
      coordinate,
      maintainerOwner ?? candidates.map(({ id }) => id).sort()[0],
    );
  }

  const componentById = new Map<string, ResolvedRepo>();
  const coordinateComponentIds = new Map(maintainerComponentIds);
  const confirmedCoordinateComponentIds = new Map(maintainerComponentIds);

  for (const draft of drafts) {
    const confirmedModerators = draft.moderatorCandidates.filter(
      (pubkey) =>
        moderatorOwners.get(repoCoordinate(pubkey, draft.dTag)) === draft.id &&
        !draft.maintainers.includes(pubkey),
    );
    const confirmedMembers = [...draft.maintainers, ...confirmedModerators];
    const discoveryPubkeys = uniqueSorted([
      ...confirmedMembers,
      ...draft.views.flatMap((view) => view.discoveryPubkeys),
    ]);
    const confirmedAnnouncements = confirmedMembers.flatMap((pubkey) => {
      const event = draft.latestByPubkey.get(pubkey);
      return event ? [event] : [];
    });
    const discoveredAnnouncements = discoveryPubkeys.flatMap((pubkey) => {
      const event = draft.latestByPubkey.get(pubkey);
      return event ? [event] : [];
    });
    const membership: RepositoryMembershipResolution = {
      selectedMaintainer: draft.anchor,
      dTag: draft.dTag,
      confirmedMaintainers: draft.maintainers,
      confirmedModerators,
      confirmedMembers,
      invitedMaintainers: uniqueSorted(
        draft.views
          .flatMap((view) => view.invitedMaintainers)
          .filter((pubkey) => !draft.maintainers.includes(pubkey)),
      ),
      invitedModerators: uniqueSorted(
        draft.views
          .flatMap((view) => view.invitedModerators)
          .filter((pubkey) => !confirmedMembers.includes(pubkey)),
      ),
      departedMaintainers: uniqueSorted(
        draft.views.flatMap((view) => view.departedMaintainers),
      ),
      departedModerators: uniqueSorted(
        draft.views.flatMap((view) => view.departedModerators),
      ),
      discoveryPubkeys,
      discoveredAnnouncements,
      confirmedAnnouncements,
      maintainerEdges: uniqueMaintainerEdges(draft.views),
      moderatorEdges: uniqueModeratorEdges(draft.views),
      repositoryHealth: uniqueRepositoryHealth(draft.views),
      leadResolution: draft.anchorView.leadResolution,
    };
    const repository = resolvedRepoFromMembership(membership);
    componentById.set(draft.id, repository);
    for (const moderator of confirmedModerators) {
      const coordinate = repoCoordinate(moderator, draft.dTag);
      coordinateComponentIds.set(coordinate, draft.id);
      confirmedCoordinateComponentIds.set(coordinate, draft.id);
    }
  }

  // Redirect-only and other rooted coordinates resolve to their component but
  // never expand its authority or metadata inputs.
  for (const [coordinate, rooted] of rootedRepositories) {
    const componentId = rooted.confirmedMaintainers
      .map((pubkey) =>
        maintainerComponentIds.get(repoCoordinate(pubkey, rooted.dTag)),
      )
      .find((id): id is string => !!id);
    if (componentId && !coordinateComponentIds.has(coordinate)) {
      coordinateComponentIds.set(coordinate, componentId);
    }
  }

  const components = [...componentById.values()].sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || a.componentId.localeCompare(b.componentId),
  );
  return {
    components,
    componentById,
    coordinateComponentIds,
    confirmedCoordinateComponentIds,
    rootedRepositories,
  };
}

/** Look up the one component assigned to a repository announcement coordinate. */
export function getRepositoryComponentForCoordinate(
  index: RepositoryComponentIndex,
  pubkey: string,
  dTag: string,
  confirmedOnly = false,
): ResolvedRepo | undefined {
  const coordinate = repoCoordinate(pubkey, dTag);
  const componentId = (
    confirmedOnly
      ? index.confirmedCoordinateComponentIds
      : index.coordinateComponentIds
  ).get(coordinate);
  return componentId ? index.componentById.get(componentId) : undefined;
}

function repositoryForSelectedCoordinate(
  index: RepositoryComponentIndex,
  pubkey: string,
  dTag: string,
): ResolvedRepo | undefined {
  const selectedCoordinate = repoCoordinate(pubkey, dTag);
  const rooted = index.rootedRepositories.get(selectedCoordinate);
  const component = getRepositoryComponentForCoordinate(index, pubkey, dTag);
  if (!component) return rooted;
  return {
    ...component,
    selectedMaintainer: pubkey,
    selectedCoordinate,
    leadResolution: rooted?.leadResolution ?? component.leadResolution,
  };
}

/** Resolve and deduplicate an ordered set of explicit repository coordinates. */
export function selectRepositoryComponents(
  events: Iterable<NostrEvent>,
  coordinates: Iterable<string>,
): ResolvedRepo[] {
  const index = buildRepositoryComponentIndex(events);
  const selected: ResolvedRepo[] = [];
  const seen = new Set<string>();
  for (const coordinate of coordinates) {
    const parsed = parseRepoCoordinate(coordinate);
    if (!parsed) continue;
    const repository = repositoryForSelectedCoordinate(
      index,
      parsed.pubkey,
      parsed.identifier,
    );
    if (!repository || seen.has(repository.componentId)) continue;
    seen.add(repository.componentId);
    selected.push(repository);
  }
  return selected;
}

/**
 * Resolve a selected coordinate through the shared component index. Authority,
 * metadata, and infrastructure come from the component; the selected view's
 * lead path is retained so direct routes can still follow signed redirects.
 */
export function resolveChain(
  events: NostrEvent[],
  selectedMaintainer: string,
  dTag: string,
): ResolvedRepo | undefined {
  const index = buildRepositoryComponentIndex(events);
  return repositoryForSelectedCoordinate(index, selectedMaintainer, dTag);
}

export interface RequestedRepositoryGroup {
  /** Reciprocally confirmed maintainers of this requested repository. */
  members: string[];
  /** Requested pubkeys whose coordinates resolved to this repository group. */
  referencedMaintainers: string[];
  /** Unique lead within the requested repository, when one can be inferred. */
  leadMaintainer?: string;
  /** Whether the requested pubkey has a repository announcement for this id. */
  hasAnnouncement: boolean;
  /** Confirmed maintainers who sent a direct request into this group. */
  requestingMaintainers: string[];
  /** Members of this group who directly received the request. */
  recipientMaintainers: string[];
}

/**
 * Classify requested maintainers as existing repository groups or individual
 * invitations without an announcement.
 *
 * Several requested pubkeys may already be reciprocal maintainers of the same
 * repository. Those pubkeys collapse into one group so the UI does not present
 * a repository-join request as several unrelated maintainer invitations.
 */
export function groupRequestedMaintainers(
  repo: ResolvedRepo,
  requestedMaintainers: Iterable<string> = repo.invitedMaintainers,
): RequestedRepositoryGroup[] {
  const referenced = new Set(requestedMaintainers);
  const requested = new Set(repo.invitedMaintainers);
  const announced = new Set(
    repo.discoveredAnnouncements.map((announcement) => announcement.pubkey),
  );
  const groups = new Map<string, RequestedRepositoryGroup>();

  for (const referencedMaintainer of referenced) {
    const hasAnnouncement = announced.has(referencedMaintainer);
    const alternateRepo = hasAnnouncement
      ? resolveChain(
          repo.discoveredAnnouncements,
          referencedMaintainer,
          repo.dTag,
        )
      : undefined;
    const members = alternateRepo?.confirmedMaintainers.filter((pubkey) =>
      requested.has(pubkey),
    ) ?? [referencedMaintainer];
    if (!members.includes(referencedMaintainer)) {
      members.unshift(referencedMaintainer);
    }

    const uniqueMembers = Array.from(new Set(members));
    const key = `${hasAnnouncement ? "repository" : "invitation"}:${[
      ...uniqueMembers,
    ]
      .sort()
      .join(",")}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.referencedMaintainers.includes(referencedMaintainer)) {
        existing.referencedMaintainers.push(referencedMaintainer);
      }
      continue;
    }

    const leadMaintainer = alternateRepo?.leadResolution.leadMaintainer;
    groups.set(key, {
      members: uniqueMembers,
      referencedMaintainers: [referencedMaintainer],
      leadMaintainer,
      hasAnnouncement,
      requestingMaintainers: [],
      recipientMaintainers: [],
    });
  }

  const confirmed = new Set(repo.confirmedMaintainers);
  return Array.from(groups.values(), (group) => {
    const members = new Set(group.members);
    const requestEdges = repo.maintainerEdges.filter(
      ({ from, to }) => confirmed.has(from) && members.has(to),
    );
    return {
      ...group,
      requestingMaintainers: Array.from(
        new Set(
          requestEdges.length > 0
            ? requestEdges.map(({ from }) => from)
            : [repo.selectedMaintainer],
        ),
      ),
      recipientMaintainers: Array.from(
        new Set(
          requestEdges.length > 0
            ? requestEdges.map(({ to }) => to)
            : group.referencedMaintainers.slice(0, 1),
        ),
      ),
    };
  });
}

/**
 * Given all 30617 events in the store, group them into resolved repositories.
 * Each reciprocal component becomes one deterministically anchored entry.
 *
 * @param events - All 30617 events to consider
 * @param forPubkey - If provided, return only components where this pubkey is
 *   a confirmed maintainer or moderator. Invitations remain relationships and
 *   do not create profile repository cards.
 */
export function groupIntoResolvedRepos(
  events: NostrEvent[],
  forPubkey?: string,
): ResolvedRepo[] {
  const components = buildRepositoryComponentIndex(events).components;
  return forPubkey
    ? components.filter((repository) =>
        repository.confirmedMembers.includes(forPubkey),
      )
    : components;
}
