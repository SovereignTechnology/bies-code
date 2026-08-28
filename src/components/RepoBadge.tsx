/**
 * RepoBadge — a compact rounded badge identifying a git repository.
 *
 * Renders as a link to the repo page showing:
 *   [avatar] username / repo-name
 *
 * The repo name is the primary piece of information (semibold); the username
 * is secondary (muted). The whole badge links to the repo.
 *
 * The repo name is resolved reactively from the EventStore; while loading it
 * falls back to the d-tag identifier so the badge is always meaningful
 * immediately.
 *
 * Props
 * ─────
 * coord        Required. A NIP-34 coordinate string: "30617:<pubkey>:<d-tag>".
 *              The pubkey drives the avatar and username; the d-tag is the
 *              initial repo name fallback.
 *
 * repoName     Optional pre-resolved name. When provided the EventStore lookup
 *              is skipped entirely — useful when the caller already holds a
 *              ResolvedRepo or has the name from another source.
 *
 * repoNameOnly When true, only the repo name is shown — the avatar, username
 *              and "/" separator are hidden. Useful in contexts where the
 *              author is already clear from surrounding UI (e.g. notifications).
 *
 * to           Optional route override for links to an equivalent sub-page.
 *
 * className    Extra classes forwarded to the outer element.
 *
 * Efficiency
 * ──────────
 * • Parsing the coord is O(1).
 * • When repoName is supplied no reactive subscription is created.
 * • When repoName is absent a single store.timeline() subscription is used
 *   (cheap: single-kind + single-author + single-d-tag filter).
 * • Avatar and username share the same profile lookup via UserAvatar/UserName.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { UserAvatar, UserName } from "@/components/UserAvatar";
import { getRepoName, REPO_KIND } from "@/lib/nip34";
import { cn } from "@/lib/utils";
import { nip19 } from "nostr-tools";
import type { Filter } from "applesauce-core/helpers";
import { map } from "rxjs/operators";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a NIP-34 coordinate string into its components.
 * Returns undefined when the string is malformed.
 */
function parseCoord(
  coord: string,
): { pubkey: string; dTag: string } | undefined {
  // Format: "30617:<pubkey>:<d-tag>"  (d-tag may itself contain colons)
  const firstColon = coord.indexOf(":");
  if (firstColon === -1) return undefined;
  const secondColon = coord.indexOf(":", firstColon + 1);
  if (secondColon === -1) return undefined;

  const pubkey = coord.slice(firstColon + 1, secondColon);
  const dTag = coord.slice(secondColon + 1);

  if (!/^[0-9a-f]{64}$/.test(pubkey) || !dTag) return undefined;
  return { pubkey, dTag };
}

// ---------------------------------------------------------------------------
// Hook — resolves repo name from the EventStore
// ---------------------------------------------------------------------------

/**
 * Reactively resolves the repo name for a given coordinate.
 * Returns the d-tag immediately (as a fallback) and updates to the event's
 * "name" tag once the kind:30617 event is in the store.
 *
 * When `knownName` is provided the hook returns it immediately without
 * subscribing to the store.
 */
function useRepoName(pubkey: string, dTag: string, knownName?: string): string {
  const store = useEventStore();

  const resolved = use$(() => {
    // Fast path: caller already knows the name — no subscription needed.
    if (knownName !== undefined) return undefined;

    const filter = {
      kinds: [REPO_KIND],
      authors: [pubkey],
      "#d": [dTag],
      limit: 1,
    } as Filter;

    return store
      .timeline([filter])
      .pipe(
        map((events) =>
          events.length > 0 ? getRepoName(events[0]) || dTag : undefined,
        ),
      );
  }, [pubkey, dTag, knownName, store]);

  if (knownName !== undefined) return knownName;
  return resolved ?? dTag;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface RepoBadgeProps {
  /**
   * NIP-34 coordinate string: "30617:<pubkey>:<d-tag>".
   * The pubkey drives the avatar; the d-tag is the initial display name.
   */
  coord: string;

  /**
   * Pre-resolved repo name. When provided the EventStore lookup is skipped.
   * Useful when the caller already holds a ResolvedRepo or similar.
   */
  repoName?: string;

  /**
   * When true, only the repo name is rendered — the avatar, username and "/"
   * separator are omitted. Useful when the author is already clear from
   * surrounding UI (e.g. a notifications list).
   */
  repoNameOnly?: boolean;

  /**
   * When true, renders as a plain <span> instead of a <Link>. Use this when
   * RepoBadge is already inside an <a> element to avoid nested anchor tags.
   */
  asSpan?: boolean;

  /** Override the repository link destination. */
  to?: string;

  /** Extra classes forwarded to the outer element. */
  className?: string;
}

/**
 * Compact rounded badge showing a repo's maintainer avatar and name.
 *
 * ```tsx
 * // From a raw coordinate tag value:
 * <RepoBadge coord="30617:<pubkey>:<d-tag>" />
 *
 * // With a pre-resolved name (skips store lookup):
 * <RepoBadge coord={repo.confirmedMemberCoordinates[0]} repoName={repo.name} />
 * ```
 */
export function RepoBadge({
  coord,
  repoName,
  repoNameOnly,
  asSpan,
  to,
  className,
}: RepoBadgeProps) {
  const parsed = parseCoord(coord);

  // Graceful fallback for malformed coords — show the raw string.
  if (!parsed) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground",
          className,
        )}
      >
        <span className="text-muted-foreground font-normal">{coord}</span>
      </span>
    );
  }

  return (
    <RepoBadgeInner
      pubkey={parsed.pubkey}
      dTag={parsed.dTag}
      repoName={repoName}
      repoNameOnly={repoNameOnly}
      asSpan={asSpan}
      to={to}
      className={className}
    />
  );
}

/** Inner component — only rendered when the coord is valid. */
function RepoBadgeInner({
  pubkey,
  dTag,
  repoName,
  repoNameOnly,
  asSpan,
  to,
  className,
}: {
  pubkey: string;
  dTag: string;
  repoName?: string;
  repoNameOnly?: boolean;
  asSpan?: boolean;
  to?: string;
  className?: string;
}) {
  const name = useRepoName(pubkey, dTag, repoName);
  const npub = nip19.npubEncode(pubkey);
  const repoPath = `/${npub}/${dTag}`;

  const badgeClass = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground transition-colors",
    !asSpan && "hover:bg-secondary/80",
    className,
  );

  const content = (
    <>
      {!repoNameOnly && (
        <>
          <UserAvatar
            pubkey={pubkey}
            size="xs"
            className="h-3.5 w-3.5 shrink-0"
            noHoverCard={asSpan}
          />
          <UserName
            pubkey={pubkey}
            className="text-xs text-muted-foreground font-normal"
          />
          <span className="text-muted-foreground/40 font-normal">/</span>
        </>
      )}
      <span className="min-w-0 truncate font-medium">{name}</span>
    </>
  );

  if (asSpan) {
    return <span className={badgeClass}>{content}</span>;
  }

  return (
    <Link
      to={to ?? repoPath}
      onClick={(e) => e.stopPropagation()}
      className={badgeClass}
    >
      {content}
    </Link>
  );
}

export interface RepoGroupBadgeMaintainer {
  pubkey: string;
  to: string;
}

interface RepoGroupBadgeProps {
  maintainers: RepoGroupBadgeMaintainer[];
  repoName: string;
  leadMaintainer?: string;
  initialMaintainer?: string;
  className?: string;
}

function RepoGroupMaintainerSegment({
  maintainer,
  selected,
  lead,
  onSelect,
  className,
}: {
  maintainer: RepoGroupBadgeMaintainer;
  selected: boolean;
  lead?: boolean;
  onSelect: (pubkey: string) => void;
  className?: string;
}) {
  return (
    <span
      onMouseEnter={() => onSelect(maintainer.pubkey)}
      onPointerDown={() => onSelect(maintainer.pubkey)}
      title={lead ? "Lead maintainer" : "Open through this maintainer"}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 transition-colors",
        selected && "bg-secondary/80",
        className,
      )}
    >
      <UserAvatar
        pubkey={maintainer.pubkey}
        size="xs"
        className="h-3.5 w-3.5 shrink-0"
        noHoverCard
      />
      <UserName
        pubkey={maintainer.pubkey}
        className="sr-only text-xs font-normal text-muted-foreground sm:not-sr-only sm:max-w-28 sm:truncate"
        noHoverCard
      />
    </span>
  );
}

/**
 * Multi-maintainer extension of RepoBadge.
 *
 * A unique lead is shown as `lead +N / repo`; without a lead every
 * maintainer remains visible. The entire badge is one repository link.
 * Hovering or pressing a maintainer selects which equivalent coordinate that
 * link opens.
 */
export function RepoGroupBadge({
  maintainers,
  repoName,
  leadMaintainer,
  initialMaintainer,
  className,
}: RepoGroupBadgeProps) {
  const initialPubkey =
    leadMaintainer ?? initialMaintainer ?? maintainers[0]?.pubkey;
  const [selectedPubkey, setSelectedPubkey] = useState(initialPubkey);
  const selectedMaintainer =
    maintainers.find((maintainer) => maintainer.pubkey === selectedPubkey) ??
    maintainers[0];

  if (!selectedMaintainer) return null;

  const lead = leadMaintainer
    ? maintainers.find((maintainer) => maintainer.pubkey === leadMaintainer)
    : undefined;
  const otherMaintainerCount = lead ? maintainers.length - 1 : 0;

  return (
    <Link
      to={selectedMaintainer.to}
      onClick={(event) => event.stopPropagation()}
      title="Open this repository"
      className={cn(
        "inline-flex max-w-full items-stretch overflow-hidden rounded-full bg-secondary text-xs text-secondary-foreground align-middle transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {lead ? (
        <>
          <RepoGroupMaintainerSegment
            maintainer={lead}
            selected={false}
            lead
            onSelect={setSelectedPubkey}
          />
          {otherMaintainerCount > 0 && (
            <span
              className="py-0.5 pr-2 text-muted-foreground"
              title={`${otherMaintainerCount} other ${
                otherMaintainerCount === 1 ? "maintainer" : "maintainers"
              }`}
            >
              +{otherMaintainerCount}
            </span>
          )}
        </>
      ) : (
        maintainers.map((maintainer, index) => (
          <RepoGroupMaintainerSegment
            key={maintainer.pubkey}
            maintainer={maintainer}
            selected={
              maintainers.length > 1 &&
              selectedMaintainer.pubkey === maintainer.pubkey
            }
            onSelect={setSelectedPubkey}
            className={cn(index > 0 && "border-l border-muted-foreground/20")}
          />
        ))
      )}
      <span className="inline-flex min-w-0 items-center py-0.5 pr-2 font-medium">
        <span className="text-muted-foreground/40 font-normal">/</span>
        <span className="ml-1 max-w-40 truncate">{repoName}</span>
      </span>
    </Link>
  );
}
