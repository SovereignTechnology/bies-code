/**
 * Shared commit list display — used by RepoCommitsPage (branch history),
 * the PR commits view (range between tip and merge-base), and the compare
 * page.
 *
 * Renders a condensed commit graph (VS Code "Git Graph" style): one
 * fixed-height row per commit with an SVG rail column showing branch/merge
 * topology, computed by `layoutCommitGraph`. The caller supplies `basePath`;
 * commit links become `<basePath>/commit/<hash>`.
 */

import { Fragment, useMemo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  GitCommit,
  Loader2,
  Tag,
} from "lucide-react";
import { safeFormatDistanceToNow, safeFormat, cn } from "@/lib/utils";
import type { Commit } from "@/lib/vendored/git-natural-api";
import {
  layoutCommitGraph,
  collapseMergedInCommits,
  parseMergeSourceRef,
  GRAPH_LANE_COLORS,
  type CommitGraphRow,
} from "@/lib/commit-graph";
import { CIStatusTrustIcon } from "@/components/ci/CIStatusTrustIcon";
import { summarizeRuns } from "@/lib/ci";
import type { CommitCIChecks } from "@/hooks/useCI";
import type { CIServiceControl } from "@/casts/CICoordinator";
import type { ResolvedRepo } from "@/lib/nip34";
import {
  getCIRunTrustResolution,
  summarizeCIRunTrust,
  type CITrustContextState,
} from "@/lib/ciTrustContext";

// ---------------------------------------------------------------------------
// Graph cell geometry
// ---------------------------------------------------------------------------

const LANE_WIDTH = 14;
const ROW_HEIGHT = 36;
/** Row height for compact graph rows (push-event cards). */
const COMPACT_ROW_HEIGHT = 26;
const MAX_LANES = 8;

function laneX(lane: number): number {
  return LANE_WIDTH / 2 + Math.min(lane, MAX_LANES - 1) * LANE_WIDTH;
}

/** A branch or tag pointing at a commit, shown as a badge on its row. */
export interface CommitRefLabel {
  name: string;
  isBranch: boolean;
  isTag: boolean;
  isDefault?: boolean;
}

export function CommitGraphCell({
  row,
  laneCount,
  flip,
  height = ROW_HEIGHT,
  superseded,
}: {
  row: CommitGraphRow;
  laneCount: number;
  /** Mirror vertically for oldest-first lists (children below parents). */
  flip?: boolean;
  /** Cell height — geometry scales so rails stay continuous between rows. */
  height?: number;
  /** Faded hollow dot: the commit is no longer on the branch (force push). */
  superseded?: boolean;
}) {
  const width = Math.min(laneCount, MAX_LANES) * LANE_WIDTH;
  const half = height / 2;
  const dotColor = GRAPH_LANE_COLORS[row.color % GRAPH_LANE_COLORS.length];
  const dotX = laneX(row.lane);

  return (
    <svg
      width={width}
      height={height}
      className="block shrink-0"
      aria-hidden="true"
    >
      <g transform={flip ? `translate(0 ${height}) scale(1 -1)` : undefined}>
        {row.edges.map((edge, i) => {
          const color =
            GRAPH_LANE_COLORS[edge.color % GRAPH_LANE_COLORS.length];
          const x1 = laneX(edge.from);
          const x2 = laneX(edge.to);
          let d: string;
          switch (edge.kind) {
            case "pass":
              d = `M ${x1} 0 L ${x2} ${height}`;
              break;
            case "in":
              d =
                x1 === x2
                  ? `M ${x1} 0 L ${x2} ${half}`
                  : `M ${x1} 0 C ${x1} ${half}, ${x2} 0, ${x2} ${half}`;
              break;
            case "out":
              d =
                x1 === x2
                  ? `M ${x1} ${half} L ${x2} ${height}`
                  : `M ${x1} ${half} C ${x1} ${height}, ${x2} ${half}, ${x2} ${height}`;
              break;
            case "stub":
              d = `M ${x1} ${half} L ${x1} ${height}`;
              break;
            case "stub-in":
              d = `M ${x1} 0 L ${x1} ${half}`;
              break;
          }
          const isStub = edge.kind === "stub" || edge.kind === "stub-in";
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray={isStub ? "2 3" : undefined}
              opacity={isStub ? 0.5 : 1}
            />
          );
        })}
        {row.isMerge || superseded ? (
          <circle
            cx={dotX}
            cy={half}
            r={row.isMerge ? 3 : 3.5}
            fill="hsl(var(--card))"
            stroke={dotColor}
            strokeWidth={row.isMerge ? 2 : 1.5}
            opacity={superseded ? 0.4 : 1}
          />
        ) : (
          <circle cx={dotX} cy={half} r={3.5} fill={dotColor} />
        )}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// GraphCommitRow — lean graph row for windows that aren't full Commit lists
// ---------------------------------------------------------------------------

/**
 * A leaner sibling of CommitRow for surfaces that show a window of commits
 * without CI-trust, ref badges, or the copy button: patch chains (one row
 * per NIP-34 patch event) and push-event cards on the PR conversation tab.
 * The caller supplies display strings and links directly, so rows can point
 * at nevent1 patch URLs or omit links entirely. `superseded` renders the
 * force-pushed-away state: struck-through text and a faded hollow dot.
 */
export function GraphCommitRow({
  graphRow,
  laneCount = 1,
  flip,
  compact = false,
  height,
  subject,
  subjectTitle,
  href,
  shortHash,
  hashHref,
  hashTitle,
  authorName,
  timestamp,
  badge,
  superseded = false,
}: {
  /** Graph layout for this row — omits the rail column when absent. */
  graphRow?: CommitGraphRow;
  laneCount?: number;
  /** Mirror the rail vertically for oldest-first lists. */
  flip?: boolean;
  /** Smaller row height and type for dense push-event cards. */
  compact?: boolean;
  /** Explicit row height override; defaults per `compact`. */
  height?: number;
  subject: string;
  /** Hover title for the subject (e.g. the full commit message). */
  subjectTitle?: string;
  /** Link target for the subject (and the hash unless hashHref is given). */
  href?: string;
  shortHash?: string;
  hashHref?: string;
  hashTitle?: string;
  /** Author/committer name — hidden below md, omitted when absent. */
  authorName?: string;
  /** Unix seconds — renders a relative time with a full-date title. */
  timestamp?: number;
  /** Extra element rendered between the time and the hash (e.g. a badge). */
  badge?: React.ReactNode;
  superseded?: boolean;
}) {
  const rowHeight = height ?? (compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT);
  const subjectClass = cn(
    "min-w-0 flex-1 truncate transition-colors",
    compact ? "text-sm" : "text-sm font-medium",
    superseded
      ? "line-through text-foreground/40"
      : compact
        ? "text-foreground/80"
        : undefined,
    href && "hover:text-pink-600 dark:hover:text-pink-400",
  );
  const hashClass = cn(
    "shrink-0 font-mono transition-colors",
    compact
      ? "text-[11px]"
      : "hidden sm:inline-block rounded bg-muted px-1.5 py-0.5 text-xs",
    superseded
      ? "line-through text-muted-foreground/50"
      : compact
        ? "text-muted-foreground/70"
        : "text-muted-foreground",
    (hashHref ?? href) && !superseded && "hover:text-foreground",
    (hashHref ?? href) && !compact && "hover:bg-muted/70",
  );
  const resolvedHashHref = hashHref ?? href;

  return (
    <div
      className={cn(
        "flex items-center gap-2 hover:bg-muted/20 transition-colors group",
        compact ? "pl-1 pr-2" : "pl-2 pr-3",
      )}
      style={{ height: rowHeight }}
    >
      {graphRow && (
        <CommitGraphCell
          row={graphRow}
          laneCount={laneCount}
          flip={flip}
          height={rowHeight}
          superseded={superseded}
        />
      )}
      {href ? (
        <Link to={href} className={subjectClass} title={subjectTitle}>
          {subject}
        </Link>
      ) : (
        <span className={subjectClass} title={subjectTitle}>
          {subject}
        </span>
      )}
      {authorName && (
        <span className="hidden md:inline shrink-0 max-w-32 truncate text-xs text-muted-foreground">
          {authorName}
        </span>
      )}
      {timestamp !== undefined && (
        <span
          className="shrink-0 whitespace-nowrap text-xs text-muted-foreground/70"
          title={safeFormat(timestamp, "PPpp") ?? undefined}
        >
          {safeFormatDistanceToNow(timestamp, { addSuffix: true })}
        </span>
      )}
      {badge}
      {shortHash &&
        (resolvedHashHref ? (
          <Link to={resolvedHashHref} className={hashClass} title={hashTitle}>
            {shortHash}
          </Link>
        ) : (
          <span className={hashClass} title={hashTitle}>
            {shortHash}
          </span>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommitList — condensed graph rows
// ---------------------------------------------------------------------------

export function CommitList({
  commits,
  basePath,
  direction = "newest-first",
  collapseMergedCommits = false,
  mergeSourceNames,
  refLabels,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  ciChecks,
  ciTrust,
  ciRepo,
  ciServiceControls = [],
}: {
  commits: Commit[];
  /** Prefix for commit links — links become `<basePath>/commit/<hash>`. */
  basePath: string;
  /**
   * Display order. The graph is always laid out topologically (children
   * adjacent to parents); "oldest-first" mirrors it for PR-style lists.
   */
  direction?: "newest-first" | "oldest-first";
  /**
   * Collapse commits merged in from other branches (e.g. "merge master into
   * feature") behind an expandable count row, keeping only the tip's
   * first-parent spine as graph rows. For PR-style single-tip ranges.
   */
  collapseMergedCommits?: boolean;
  /**
   * Graph-resolved source branch per merge commit hash (from
   * useMergedInSourceBranches). Names collapsed merge groups; merges absent
   * from the map fall back to parsing the merge subject.
   */
  mergeSourceNames?: Map<string, string>;
  /** Branch/tag names per commit hash, shown as badges on their rows. */
  refLabels?: Map<string, CommitRefLabel[]>;
  /** Whether there are more commits to load. */
  hasMore?: boolean;
  /** True while the next batch is being fetched. */
  loadingMore?: boolean;
  /** Called when the sentinel scrolls into view. */
  onLoadMore?: () => void;
  /** CI checks per commit hash (from useCIForCommits) — shows a status tick. */
  ciChecks?: Map<string, CommitCIChecks>;
  /** Shared trust evidence for the CI signers shown in this list. */
  ciTrust?: CITrustContextState;
  ciRepo?: ResolvedRepo;
  ciServiceControls?: readonly CIServiceControl[];
}) {
  const collapse = useMemo(
    () => (collapseMergedCommits ? collapseMergedInCommits(commits) : null),
    [collapseMergedCommits, commits],
  );
  const layout = useMemo(
    () => layoutCommitGraph(collapse ? collapse.spine : commits),
    [collapse, commits],
  );
  const rows = useMemo(
    () =>
      direction === "oldest-first" ? [...layout.rows].reverse() : layout.rows,
    [layout, direction],
  );
  const [expandedMerges, setExpandedMerges] = useState<Set<string>>(
    () => new Set(),
  );

  // IntersectionObserver sentinel — fires onLoadMore when visible.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore]);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden py-1">
        {rows.map((row) => {
          const group = collapse?.groups.get(row.commit.hash);
          const groupRows = group && (
            <MergedInGroup
              commits={group}
              mergeCommit={row.commit}
              sourceName={mergeSourceNames?.get(row.commit.hash)}
              basePath={basePath}
              lane={row.lane}
              laneColor={row.color}
              laneCount={layout.laneCount}
              direction={direction}
              expanded={expandedMerges.has(row.commit.hash)}
              onToggle={() =>
                setExpandedMerges((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.commit.hash)) next.delete(row.commit.hash);
                  else next.add(row.commit.hash);
                  return next;
                })
              }
            />
          );
          const commitRow = (
            <CommitRow
              commit={row.commit}
              basePath={basePath}
              graphRow={row}
              graphLaneCount={layout.laneCount}
              graphFlip={direction === "oldest-first"}
              refLabels={refLabels?.get(row.commit.hash)}
              ci={ciChecks?.get(row.commit.hash)}
              ciTrust={ciTrust}
              ciRepo={ciRepo}
              ciServiceControls={ciServiceControls}
            />
          );
          // Group rows sit on the merge's parent side: below the merge row
          // when newest-first, above it when oldest-first.
          return (
            <Fragment key={row.commit.hash}>
              {direction === "oldest-first" ? (
                <>
                  {groupRows}
                  {commitRow}
                </>
              ) : (
                <>
                  {commitRow}
                  {groupRows}
                </>
              )}
            </Fragment>
          );
        })}
      </Card>

      {/* Infinite scroll sentinel */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-4">
          {loadingMore && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading more commits…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MergedInGroup — collapsed commits brought in by a spine merge
// ---------------------------------------------------------------------------

/** Vertical rail continuing the spine lane through group rows. */
function GraphRailSpacer({
  lane,
  laneColor,
  laneCount,
  height,
}: {
  lane: number;
  laneColor: number;
  laneCount: number;
  height: number;
}) {
  const width = Math.min(laneCount, MAX_LANES) * LANE_WIDTH;
  const x = laneX(lane);
  return (
    <svg
      width={width}
      height={height}
      className="block shrink-0"
      aria-hidden="true"
    >
      <path
        d={`M ${x} 0 L ${x} ${height}`}
        fill="none"
        stroke={GRAPH_LANE_COLORS[laneColor % GRAPH_LANE_COLORS.length]}
        strokeWidth={2}
      />
    </svg>
  );
}

function MergedInGroup({
  commits,
  mergeCommit,
  sourceName,
  basePath,
  lane,
  laneColor,
  laneCount,
  direction,
  expanded,
  onToggle,
}: {
  /** Merged-in commits, newest first. */
  commits: Commit[];
  /** The spine merge commit that brought these in — names the source ref. */
  mergeCommit: Commit;
  /** Graph-resolved source branch name, when ancestry could determine it. */
  sourceName?: string;
  basePath: string;
  lane: number;
  laneColor: number;
  laneCount: number;
  direction: "newest-first" | "oldest-first";
  expanded: boolean;
  onToggle: () => void;
}) {
  const SUB_ROW_HEIGHT = 28;
  // Graph ancestry names the branch when possible; the merge subject is a
  // last resort for branches deleted after merging, whose name survives
  // nowhere else.
  const sourceRef =
    sourceName ?? parseMergeSourceRef(mergeCommit.message.split("\n")[0]);
  const ordered =
    direction === "oldest-first" ? [...commits].reverse() : commits;
  const subRows = expanded
    ? ordered.map((commit) => {
        const subject = commit.message.split("\n")[0];
        const timestamp =
          commit.committer?.timestamp ?? commit.author.timestamp;
        return (
          <div
            key={commit.hash}
            className="flex items-center gap-2 pl-2 pr-3 hover:bg-muted/20 transition-colors"
            style={{ height: SUB_ROW_HEIGHT }}
          >
            <GraphRailSpacer
              lane={lane}
              laneColor={laneColor}
              laneCount={laneCount}
              height={SUB_ROW_HEIGHT}
            />
            <span className="w-3.5 shrink-0" />
            <Link
              to={`${basePath}/commit/${commit.hash}`}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground transition-colors hover:text-pink-600 dark:hover:text-pink-400"
              title={commit.message}
            >
              {subject}
            </Link>
            <span
              className="shrink-0 whitespace-nowrap text-xs text-muted-foreground/60"
              title={safeFormat(timestamp, "PPpp") ?? undefined}
            >
              {safeFormatDistanceToNow(timestamp, { addSuffix: true })}
            </span>
            <Link
              to={`${basePath}/commit/${commit.hash}`}
              className="hidden sm:inline-block shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
            >
              {commit.hash.slice(0, 8)}
            </Link>
          </div>
        );
      })
    : null;

  const toggleRow = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2 pl-2 pr-3 text-left hover:bg-muted/20 transition-colors"
      style={{ height: ROW_HEIGHT }}
      title="History merged in from another branch — not authored on this branch"
    >
      <GraphRailSpacer
        lane={lane}
        laneColor={laneColor}
        laneCount={laneCount}
        height={ROW_HEIGHT}
      />
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {commits.length} commit{commits.length === 1 ? "" : "s"} merged in from{" "}
        {sourceRef ? (
          <span className="font-mono text-foreground/70">{sourceRef}</span>
        ) : (
          "another branch"
        )}
      </span>
    </button>
  );

  // Sub-rows sit on the merge's parent side of the toggle, matching the
  // group's own placement relative to the merge row.
  return direction === "oldest-first" ? (
    <>
      {subRows}
      {toggleRow}
    </>
  ) : (
    <>
      {toggleRow}
      {subRows}
    </>
  );
}

// ---------------------------------------------------------------------------
// CommitRow
// ---------------------------------------------------------------------------

export function CommitRow({
  commit,
  basePath,
  graphRow,
  graphLaneCount = 1,
  graphFlip,
  refLabels,
  ci,
  ciTrust,
  ciRepo,
  ciServiceControls = [],
}: {
  commit: Commit;
  basePath: string;
  /** Graph layout for this row — omits the rail column when absent. */
  graphRow?: CommitGraphRow;
  graphLaneCount?: number;
  graphFlip?: boolean;
  refLabels?: CommitRefLabel[];
  /** CI checks for this commit — shows a status tick next to the hash. */
  ci?: CommitCIChecks;
  ciTrust?: CITrustContextState;
  ciRepo?: ResolvedRepo;
  ciServiceControls?: readonly CIServiceControl[];
}) {
  const [copied, setCopied] = useState(false);
  const subject = commit.message.split("\n")[0];
  const shortHash = commit.hash.slice(0, 8);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(commit.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isMerge = commit.parents.length > 1;
  const timestamp = commit.committer?.timestamp ?? commit.author.timestamp;
  const relativeTime = safeFormatDistanceToNow(timestamp, { addSuffix: true });
  const fullDate = safeFormat(timestamp, "PPpp") ?? undefined;
  const trustResolution = summarizeCIRunTrust(
    (ci?.runs ?? []).map((run) =>
      getCIRunTrustResolution(
        ciTrust,
        run,
        ciRepo?.confirmedMaintainers ?? [],
        ciServiceControls,
      ),
    ),
  );

  const visibleRefs = refLabels?.slice(0, 3) ?? [];
  const hiddenRefCount = (refLabels?.length ?? 0) - visibleRefs.length;

  return (
    <div
      className="flex items-center gap-2 pl-2 pr-3 hover:bg-muted/20 transition-colors group"
      style={{ height: ROW_HEIGHT }}
    >
      {graphRow && (
        <CommitGraphCell
          row={graphRow}
          laneCount={graphLaneCount}
          flip={graphFlip}
        />
      )}
      {visibleRefs.map((ref) => (
        <span
          key={`${ref.isTag ? "tag" : "branch"}:${ref.name}`}
          className={cn(
            "hidden sm:inline-flex max-w-32 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
            ref.isDefault
              ? "border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400"
              : "border-border bg-muted/50 text-muted-foreground",
          )}
          title={ref.name}
        >
          {ref.isTag ? (
            <Tag className="h-3 w-3 shrink-0" />
          ) : (
            <GitBranch className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">{ref.name}</span>
        </span>
      ))}
      {hiddenRefCount > 0 && (
        <span className="hidden sm:inline text-xs text-muted-foreground shrink-0">
          +{hiddenRefCount}
        </span>
      )}
      <Link
        to={`${basePath}/commit/${commit.hash}`}
        className={cn(
          "min-w-0 flex-1 truncate text-sm transition-colors hover:text-pink-600 dark:hover:text-pink-400",
          isMerge ? "text-muted-foreground" : "font-medium",
        )}
        title={commit.message}
      >
        {subject}
      </Link>
      <span className="hidden md:inline shrink-0 max-w-32 truncate text-xs text-muted-foreground">
        {commit.author.name}
      </span>
      <span
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground/70"
        title={fullDate}
      >
        {relativeTime}
      </span>
      {ci?.status && (
        <CIStatusTrustIcon
          status={ci.status}
          resolution={trustResolution}
          statusSummary={summarizeRuns(ci.runs)}
          className="h-3.5 w-3.5 shrink-0"
        />
      )}
      <Link
        to={`${basePath}/commit/${commit.hash}`}
        className="hidden sm:inline-block shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        {shortHash}
      </Link>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy commit hash ${shortHash}`}
        title="Copy full commit hash"
        className="hidden sm:inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommitRowSkeleton
// ---------------------------------------------------------------------------

export function CommitRowSkeleton() {
  return (
    <div
      className="flex items-center gap-3 pl-2 pr-3"
      style={{ height: ROW_HEIGHT }}
    >
      <Skeleton className="h-full w-3.5 shrink-0" />
      <Skeleton className="h-4 flex-1 max-w-md" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-5 w-16 rounded" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommitListLoading — skeleton rows with spinner header
// ---------------------------------------------------------------------------

export function CommitListLoading({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-px">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading commits…</span>
      </div>
      {Array.from({ length: count }).map((_, i) => (
        <CommitRowSkeleton key={i} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommitListEmpty
// ---------------------------------------------------------------------------

export function CommitListEmpty({
  message = "No commits found.",
}: {
  message?: string;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-12 text-center">
        <GitCommit className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// CommitListError
// ---------------------------------------------------------------------------

export function CommitListError({ message }: { message: string }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{message}</span>
        </div>
      </CardContent>
    </Card>
  );
}
