import { useErrorRetry } from "@/hooks/useErrorRetry";
import { CommitListError } from "@/components/CommitList";
/**
 * RepoBranchesPage — full-page expansion of the popover ref selector's
 * branches list. Shows every branch in the merged ref view (across all
 * configured git servers + Nostr state) with:
 *
 *   - default-branch badge
 *   - per-ref status vs the Nostr-signed state (verified / mismatch / etc.)
 *   - latest commit hash, message and committer timestamp
 *   - ahead/behind labels vs the default branch (or "merged" / "up to date"
 *     / "orphaned" when one of the special cases applies)
 *
 * The source selector is rendered as a right-aligned dropdown
 * (`SourceSelectorDropdown`) so it stays visually compact next to the page
 * title — the same affordance as the popover ref selector's source row,
 * just promoted to a standalone trigger.
 */
import { useCallback, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { useRepoContext } from "./RepoContext";
import { useProfile } from "@/hooks/useProfile";
import { useGitPool } from "@/hooks/useGitPool";
import { useGitExplorer } from "@/hooks/useGitExplorer";
import { useRefsWithStatus } from "@/hooks/useRefsWithStatus";
import { useBranchDivergence } from "@/hooks/useBranchDivergence";
import { SourceSelectorDropdown } from "@/components/SourceSelector";
import { RefRow, type BranchDivergence } from "@/components/RefRow";
import type { RefWithStatus } from "@/lib/refStatus";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GitBranch, AlertCircle } from "lucide-react";
import { isNonHttpUrl } from "@/lib/git-grasp-pool";
import { IncompatibleProtocolError } from "@/components/IncompatibleProtocolError";
import { useCIForCommits } from "@/hooks/useCI";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";
import { CIStatusTrustIcon } from "@/components/ci/CIStatusTrustIcon";
import { summarizeRuns } from "@/lib/ci";
import {
  getCIRunTrustResolution,
  summarizeCIRunTrust,
} from "@/lib/ciTrustContext";

// ---------------------------------------------------------------------------
// Branch ranking — drives the on-page sort order
// ---------------------------------------------------------------------------

type DivergenceMap = ReturnType<typeof useBranchDivergence>["divergence"];

/**
 * Lower rank = sorted earlier (closer to the top of the list, after the
 * default branch).
 *
 * Buckets:
 *   0 — merged (no commits ahead, some commits behind)
 *   1 — up-to-date (ahead === 0 && behind === 0)
 *   2 — ahead-only (commits ahead, none behind)
 *   3 — diverged (both ahead and behind)
 *   4 — unknown (divergence not yet computed)
 *   5 — orphaned (no shared ancestor) — sinks to the bottom so the rest of
 *       the list stays readable
 */
function branchRank(
  divergence:
    | { ahead: number | null; behind: number | null; noMergeBase?: boolean }
    | undefined,
): number {
  if (!divergence) return 4;
  const { ahead, behind, noMergeBase } = divergence;
  if (noMergeBase) return 5;
  if (ahead === null || behind === null) return 4;
  if (ahead === 0 && behind > 0) return 0;
  if (ahead === 0 && behind === 0) return 1;
  if (ahead > 0 && behind === 0) return 2;
  return 3; // diverged
}

function sortBranches(
  branches: RefWithStatus[],
  divergence: DivergenceMap,
): RefWithStatus[] {
  return [...branches].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const da = divergence.get(`refs/heads/${a.name}`);
    const db = divergence.get(`refs/heads/${b.name}`);
    const ra = branchRank(da);
    const rb = branchRank(db);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RepoBranchesPage() {
  const {
    cloneUrls,
    repoState,
    repoRelayEose,
    relayStateMap,
    resolved,
    pubkey,
    repoId,
    basePath,
  } = useRepoContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = resolved?.repo;
  const repoOwnerProfile = useProfile(pubkey);

  const { pool, poolState } = useGitPool(cloneUrls, {
    private: repo?.isPrivate,
  });

  const stateBehindGit =
    cloneUrls.length > 0 &&
    !poolState.pulling &&
    poolState.warning?.kind === "state-behind-git";

  const sourceParam = searchParams.get("source");
  const selectedSource =
    sourceParam ??
    (poolState.viewSource === "authoritative"
      ? "default"
      : poolState.viewSource);

  useEffect(() => {
    if (pool && sourceParam) pool.setViewSource(sourceParam);
  }, [pool, sourceParam]);

  const handleSourceChange = useCallback(
    (src: string) => {
      pool?.setViewSource(src);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (src === "default") next.delete("source");
          else next.set("source", src);
          return next;
        },
        { replace: false },
      );
    },
    [pool, setSearchParams],
  );

  const explorer = useGitExplorer(pool, poolState, {
    stateRefs: repoState?.refs,
  });

  const { branches, mismatchCount, effectiveSource } = useRefsWithStatus({
    refs: explorer.refs,
    repoState,
    repoRelayEose,
    relayStateMap,
    stateBehindGit,
    viewSource: poolState.viewSource,
    effectiveRefs: poolState.effectiveRefs,
    winnerUrl: poolState.winnerUrl,
    urlStates: poolState.urls,
    cloneUrls,
  });

  const defaultBranch = useMemo(
    () => branches.find((b) => b.isDefault && b.isBranch),
    [branches],
  );

  const { divergence, loading: divergenceLoading } = useBranchDivergence(
    pool,
    branches,
    defaultBranch,
  );

  const sortedBranches = useMemo(
    () => sortBranches(branches, divergence),
    [branches, divergence],
  );
  const branchCommitIds = useMemo(
    () => sortedBranches.map((branch) => branch.hash),
    [sortedBranches],
  );
  const ciChecks = useCIForCommits(
    branchCommitIds,
    repo?.isPrivate ? undefined : resolved?.repoRelayGroup,
  );
  const ciRuns = useMemo(
    () =>
      ciChecks ? [...ciChecks.values()].flatMap((checks) => checks.runs) : [],
    [ciChecks],
  );
  const { coordinatorState, trust } = useRepositoryCITrust(repo, ciRuns);

  useSeoMeta({
    title: repo
      ? `Branches - ${repo.name} - BIES Code`
      : "Branches - BIES Code",
    description: repo?.description ?? "Browse repository branches",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  // Build the per-branch tree URL while preserving the source query param so
  // navigating into a branch keeps the user on the same server.
  const branchHref = useCallback(
    (name: string) => {
      const base = `${basePath}/tree/${name}`;
      return selectedSource !== "default"
        ? `${base}?source=${encodeURIComponent(selectedSource)}`
        : base;
    },
    [selectedSource, basePath],
  );

  // -------------------------------------------------------------------------
  // Early returns: no clone URLs, incompatible protocols
  // -------------------------------------------------------------------------
  const recoveryKey = useMemo(
    () => ({ pool, selectedSource }),
    [pool, selectedSource],
  );
  const recovery = useErrorRetry({
    resourceKey: recoveryKey,
    failed: !!explorer.error,
    busy: explorer.loading || poolState.loading || poolState.pulling,
    onRetry: async (signal) => {
      await pool?.retryReads();
      if (!signal.aborted) await explorer.reload();
    },
    policy:
      pool && !pool.requiresSigningForReads
        ? { mode: "read", requiresSigning: false, context: "connection" }
        : { mode: "manual" },
  });

  if (cloneUrls.length === 0) {
    return (
      <div className="container max-w-screen-xl px-4 md:px-8 py-6">
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              This repository has no clone URLs configured.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (cloneUrls.every(isNonHttpUrl)) {
    return (
      <div className="container max-w-screen-xl px-4 md:px-8 py-6">
        <IncompatibleProtocolError
          cloneUrls={cloneUrls}
          context="branches"
          pubkey={pubkey}
          repoId={repoId}
        />
      </div>
    );
  }

  const showSkeletons = explorer.loading && sortedBranches.length === 0;
  const showEmpty =
    !explorer.error && !explorer.loading && sortedBranches.length === 0;
  const branchCount = sortedBranches.length;
  const defaultBranchName = defaultBranch?.name;

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6 space-y-4">
      {explorer.error && (
        <CommitListError message={explorer.error} recovery={recovery} />
      )}
      {/* Title row: branch icon + count on the left, source dropdown on the right */}
      <div className="flex items-center gap-3 flex-wrap">
        <GitBranch className="h-5 w-5 text-muted-foreground shrink-0" />
        <h2 className="text-lg font-semibold shrink-0">Branches</h2>
        {branchCount > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {branchCount}
          </Badge>
        )}
        {mismatchCount > 0 && (
          <Badge
            variant="outline"
            className="h-5 px-1.5 text-[11px] border-amber-500/40 text-amber-600 dark:text-amber-400"
            title={`${mismatchCount} branch${mismatchCount === 1 ? "" : "es"} differ from Nostr state`}
          >
            {mismatchCount} differ
          </Badge>
        )}
        <div className="ml-auto">
          <SourceSelectorDropdown
            selectedSource={selectedSource}
            onSelectSource={handleSourceChange}
            repoState={repoState}
            repoRelayEose={repoRelayEose}
            stateCreatedAt={repoState?.event.created_at}
            urlStates={poolState.urls}
            cloneUrls={cloneUrls}
            graspCloneUrls={repo?.graspCloneUrls ?? []}
            additionalGitServerUrls={repo?.additionalGitServerUrls ?? []}
            stateBehindGit={stateBehindGit}
            poolWarning={poolState.warning}
            pool={pool}
            relayStateMap={relayStateMap}
            effectiveSource={effectiveSource}
          />
        </div>
      </div>

      {/* List body */}
      {showSkeletons && <BranchesSkeleton />}

      {showEmpty && (
        <Card className="border-dashed">
          <CardContent className="py-12 px-8 text-center">
            <p className="text-muted-foreground max-w-sm mx-auto">
              No branches found on the selected source.
            </p>
          </CardContent>
        </Card>
      )}

      {!showSkeletons && !showEmpty && (
        <Card>
          {defaultBranchName && (
            <div className="px-4 py-2 border-b border-border/40 text-xs text-muted-foreground">
              Compared with{" "}
              <code className="font-mono text-foreground/80">
                {defaultBranchName}
              </code>
              {divergenceLoading && (
                <span className="ml-2 text-muted-foreground/60">
                  · computing divergence…
                </span>
              )}
            </div>
          )}
          <div className="divide-y divide-border/40">
            {sortedBranches.map((branch) => {
              const fullName = `refs/heads/${branch.name}`;
              // The default branch is intentionally absent from the
              // divergence map (divergence vs itself is always 0). Pass a
              // virtual entry so the row still has a `divergence` prop and
              // renders consistently — `BranchDivergenceBadges` suppresses
              // the badge for the default branch automatically.
              const div: BranchDivergence | undefined = branch.isDefault
                ? {
                    ahead: 0,
                    behind: 0,
                    latestCommit: null,
                    noMergeBase: false,
                  }
                : divergence.get(fullName);
              const row = (
                <RefRow
                  density="expanded"
                  refWithStatus={branch}
                  pool={pool}
                  urlStates={poolState.urls}
                  cloneUrls={cloneUrls}
                  divergence={div}
                />
              );
              const ci = ciChecks?.get(branch.hash);
              const trustResolution = summarizeCIRunTrust(
                (ci?.runs ?? []).map((run) =>
                  getCIRunTrustResolution(
                    trust,
                    run,
                    repo?.confirmedMaintainers ?? [],
                    coordinatorState?.serviceControls ?? [],
                  ),
                ),
              );
              // Wrap each row in a Link so the whole row navigates to the
              // branch's tree. We pass no `onSelect` to RefRow so it renders
              // as a non-interactive div inside the Link.
              return (
                <div key={branch.name} className="flex items-center pr-4">
                  <Link
                    to={branchHref(branch.name)}
                    className="min-w-0 flex-1 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {row}
                  </Link>
                  {ci?.status && (
                    <CIStatusTrustIcon
                      to={`${basePath}/commit/${branch.hash}#checks`}
                      status={ci.status}
                      resolution={trustResolution}
                      statusSummary={summarizeRuns(ci.runs)}
                      className="h-3.5 w-3.5"
                      buttonClassName="ml-2"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function BranchesSkeleton() {
  return (
    <Card>
      <div className="divide-y divide-border/40">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="h-4 w-4 mt-0.5 rounded" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
            <Skeleton className="h-5 w-12 rounded" />
          </div>
        ))}
      </div>
    </Card>
  );
}
