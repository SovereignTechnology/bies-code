/**
 * PatchCommitList — renders a NIP-34 patch chain as condensed commit-graph
 * rows, matching the visual language of CommitList (PR commits tab, repo
 * commits page).
 *
 * Each patch in the chain represents one commit. When the patch includes
 * `commit`, `parent-commit`, and `committer` tags, we display the git commit
 * metadata. Otherwise we fall back to the patch subject and event timestamp.
 * The chain is linear and displayed oldest-first; the base commit always
 * lies outside the chain, so the boundary row fades into a dashed stub.
 *
 * Commit links point to `<basePath>/commit/<nevent1>` — the patch event ID
 * is the canonical URL segment, matching CommitList's pattern for PRs.
 */

import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, ChevronDown, GitCommit } from "lucide-react";
import { eventIdToNevent } from "@/lib/routeUtils";
import { layoutCommitGraph } from "@/lib/commit-graph";
import { GraphCommitRow } from "@/components/CommitList";
import type { Commit } from "@/lib/git-grasp-pool";
import type { Patch } from "@/casts/Patch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the committer tag from a patch event.
 * Format: ["committer", "<name>", "<email>", "<timestamp>", "<timezone>"]
 */
function parseCommitterTag(
  patch: Patch,
): { name: string; email: string; timestamp: number } | undefined {
  const tag = patch.event.tags.find(([t]) => t === "committer");
  if (!tag) return undefined;
  const [, name, email, tsStr] = tag;
  if (!name || !tsStr) return undefined;
  const timestamp = parseInt(tsStr, 10);
  if (isNaN(timestamp)) return undefined;
  return { name, email: email ?? "", timestamp };
}

// ---------------------------------------------------------------------------
// PatchCommitList
// ---------------------------------------------------------------------------

export function PatchCommitList({
  patches,
  basePath,
  relayHints,
  isBaseGuessed = false,
  applyResult,
}: {
  /** Ordered patches in the latest revision (oldest first). */
  patches: Patch[];
  /** Prefix for commit links — links become `<basePath>/commit/<nevent1>`. */
  basePath: string;
  /**
   * Relay hints to embed in nevent1 identifiers for patch commit links.
   * Typically the repo relay group URLs.
   */
  relayHints?: string[];
  /**
   * When true, the merge base was approximated because the patch events omit
   * the `parent-commit` tag. Combined with `applyResult` to determine the
   * right banner to show.
   */
  isBaseGuessed?: boolean;
  /**
   * The result of attempting to apply the patch chain from PatchFilesTab.
   * When undefined, the apply hasn't run yet (e.g. user hasn't visited the
   * Files tab). When provided, used to show the accurate outcome banner.
   */
  applyResult?: {
    failedCount: number;
    failureReason?: "no-base" | "fetch-failed" | "hunk-mismatch";
  };
}) {
  // One entry per non-cover patch, oldest first (natural chain order).
  const entries = useMemo(() => {
    const chain = patches.filter((p) => !p.isCoverLetter);
    return chain.map((patch) => {
      const committer = parseCommitterTag(patch);
      return {
        patch,
        // The commit hash keys the graph row; patches without a commit tag
        // fall back to the event ID, which is equally unique.
        hash: patch.commitId ?? patch.event.id,
        commitId: patch.commitId,
        timestamp: committer?.timestamp ?? patch.event.created_at,
        authorName: committer?.name ?? "(unknown)",
        linkSegment: eventIdToNevent(patch.event.id, relayHints),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patches, relayHints?.join(",")]);

  // Synthesize the linear chain for the graph: each patch's parent is its
  // predecessor; the oldest patch points at its parent-commit tag (outside
  // the set → natural stub) or, lacking one, relies on continuesBelow — the
  // base commit always exists below a patch chain.
  const layout = useMemo(() => {
    const commits: Commit[] = entries.map((entry, i) => {
      const person = {
        name: entry.authorName,
        email: "",
        timestamp: entry.timestamp,
        timezone: "+0000",
      };
      const parentCommitId = entry.patch.parentCommitId;
      return {
        hash: entry.hash,
        tree: "",
        parents:
          i > 0
            ? [entries[i - 1].hash]
            : parentCommitId
              ? [parentCommitId]
              : [],
        author: person,
        committer: person,
        message: entry.patch.subject,
      };
    });
    return layoutCommitGraph(commits, { continuesBelow: true });
  }, [entries]);

  const rows = useMemo(() => {
    const byHash = new Map(entries.map((entry) => [entry.hash, entry]));
    // Layout rows are newest-first; display oldest-first like the PR tab.
    return [...layout.rows].reverse().map((graphRow) => ({
      graphRow,
      entry: byHash.get(graphRow.commit.hash),
    }));
  }, [layout, entries]);

  // Determine which banner to show based on what we know.
  // applyResult is only available after the user has visited the Files tab.
  const applyFailed = applyResult && applyResult.failedCount > 0;

  const patchBadge = (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="hidden sm:inline-flex text-[10px] px-1.5 py-0 h-4 font-normal text-muted-foreground/70 border-muted-foreground/20 shrink-0"
          >
            patch
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Sourced from a Nostr patch event
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <div className="space-y-4">
      {/* Apply failed — amber warning */}
      {isBaseGuessed && applyFailed && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer list-none">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="font-medium flex-1">
                Couldn't cleanly apply patch — unknown merge base
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 ml-6 space-y-1.5 text-amber-700/80 dark:text-amber-400/80">
              <p>
                Tried the tip of the default branch and a timestamp-approximated
                base — neither applied cleanly. Individual commit diffs show the
                raw patch diff.
              </p>
            </div>
          </details>
        </div>
      )}
      <Card className="overflow-hidden py-1">
        {rows.map(({ graphRow, entry }) => {
          if (!entry) return null;
          const { patch } = entry;
          const href = `${basePath}/commit/${entry.linkSegment}`;
          return (
            <GraphCommitRow
              key={patch.id}
              graphRow={graphRow}
              laneCount={layout.laneCount}
              flip
              subject={patch.subject}
              subjectTitle={
                patch.body ? `${patch.subject}\n\n${patch.body}` : patch.subject
              }
              href={href}
              shortHash={entry.commitId?.slice(0, 8) ?? "[unknown]"}
              hashTitle={
                entry.commitId
                  ? undefined
                  : "No git commit ID — click to view patch event"
              }
              authorName={entry.authorName}
              timestamp={entry.timestamp}
              badge={patchBadge}
            />
          );
        })}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PatchCommitListEmpty (re-exported for convenience)
// ---------------------------------------------------------------------------

export function PatchCommitListEmpty({
  message = "No patches found.",
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
