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

import { useMemo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, GitBranch, GitCommit, Loader2, Tag } from "lucide-react";
import { safeFormatDistanceToNow, safeFormat, cn } from "@/lib/utils";
import type { Commit } from "@/lib/vendored/git-natural-api";
import {
  layoutCommitGraph,
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

function CommitGraphCell({
  row,
  laneCount,
  flip,
}: {
  row: CommitGraphRow;
  laneCount: number;
  /** Mirror vertically for oldest-first lists (children below parents). */
  flip?: boolean;
}) {
  const width = Math.min(laneCount, MAX_LANES) * LANE_WIDTH;
  const half = ROW_HEIGHT / 2;
  const dotColor = GRAPH_LANE_COLORS[row.color % GRAPH_LANE_COLORS.length];
  const dotX = laneX(row.lane);

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="block shrink-0"
      aria-hidden="true"
    >
      <g
        transform={flip ? `translate(0 ${ROW_HEIGHT}) scale(1 -1)` : undefined}
      >
        {row.edges.map((edge, i) => {
          const color =
            GRAPH_LANE_COLORS[edge.color % GRAPH_LANE_COLORS.length];
          const x1 = laneX(edge.from);
          const x2 = laneX(edge.to);
          let d: string;
          switch (edge.kind) {
            case "pass":
              d = `M ${x1} 0 L ${x2} ${ROW_HEIGHT}`;
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
                  ? `M ${x1} ${half} L ${x2} ${ROW_HEIGHT}`
                  : `M ${x1} ${half} C ${x1} ${ROW_HEIGHT}, ${x2} ${half}, ${x2} ${ROW_HEIGHT}`;
              break;
            case "stub":
              d = `M ${x1} ${half} L ${x1} ${ROW_HEIGHT}`;
              break;
          }
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeDasharray={edge.kind === "stub" ? "2 3" : undefined}
              opacity={edge.kind === "stub" ? 0.5 : 1}
            />
          );
        })}
        {row.isMerge ? (
          <circle
            cx={dotX}
            cy={half}
            r={3}
            fill="hsl(var(--card))"
            stroke={dotColor}
            strokeWidth={2}
          />
        ) : (
          <circle cx={dotX} cy={half} r={3.5} fill={dotColor} />
        )}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// CommitList — condensed graph rows
// ---------------------------------------------------------------------------

export function CommitList({
  commits,
  basePath,
  direction = "newest-first",
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
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  const rows = useMemo(
    () =>
      direction === "oldest-first" ? [...layout.rows].reverse() : layout.rows,
    [layout, direction],
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
        {rows.map((row) => (
          <CommitRow
            key={row.commit.hash}
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
        ))}
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
  const subject = commit.message.split("\n")[0];
  const shortHash = commit.hash.slice(0, 8);
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
