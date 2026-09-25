import { useErrorRetry } from "@/hooks/useErrorRetry";
import { useMemo, useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { useRepoContext } from "./RepoContext";
import { useProfile } from "@/hooks/useProfile";
import {
  useInfiniteCommitHistory,
  useGitExplorer,
} from "@/hooks/useGitExplorer";
import { useGitPool } from "@/hooks/useGitPool";
import { RefSelector } from "@/components/RefSelector";
import { GitServerStatus } from "@/components/GitServerStatus";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  CommitList,
  CommitListLoading,
  CommitListEmpty,
  CommitListError,
} from "@/components/CommitList";
import { useCIForCommits } from "@/hooks/useCI";
import { AlertCircle, GitCommit, Loader2 } from "lucide-react";
import { safeFormatDistanceToNow } from "@/lib/utils";
import { isNonHttpUrl } from "@/lib/git-grasp-pool";
import { IncompatibleProtocolError } from "@/components/IncompatibleProtocolError";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";

export default function RepoCommitsPage() {
  const {
    cloneUrls,
    repoState,
    repoRelayEose,
    commitsRef,
    resolved,
    pubkey,
    repoId,
    basePath,
  } = useRepoContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const repo = resolved?.repo;
  const repoOwnerProfile = useProfile(pubkey);

  // Pool must come before explorer since pool is passed to explorer.
  const { pool, poolState } = useGitPool(cloneUrls, {
    private: repo?.isPrivate,
  });

  const pulling =
    cloneUrls.length > 0 ? !repoRelayEose || poolState.pulling : false;
  const gitPulling = cloneUrls.length > 0 ? poolState.pulling : false;
  const stateBehindGit =
    !gitPulling && poolState.warning?.kind === "state-behind-git";

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

  const activeExplorer = useGitExplorer(pool, poolState, {
    refAndPath: commitsRef,
    stateRefs: repoState?.refs,
  });
  const resolvedRef = activeExplorer.resolvedRef ?? undefined;
  const historyCommit = activeExplorer.commitHash ?? undefined;

  const history = useInfiniteCommitHistory(pool, poolState, historyCommit);
  const recoveryKey = useMemo(
    () => ({ pool, historyCommit }),
    [pool, historyCommit],
  );
  const recovery = useErrorRetry({
    resourceKey: recoveryKey,
    failed: !!history.error,
    busy:
      history.loading ||
      history.loadingMore ||
      poolState.loading ||
      poolState.pulling,
    onRetry: async (signal) => {
      await pool?.retryReads();
      if (!signal.aborted) history.reload();
    },
    policy:
      pool && !pool.requiresSigningForReads
        ? { mode: "read", requiresSigning: false, context: "availability" }
        : { mode: "manual" },
  });

  // CI checks (ngit-ci kinds 9841/9842) for the commits being displayed —
  // the singleton #c loader batches the whole page into one REQ per relay.
  const commitIds = useMemo(
    () => history.commits.map((c) => c.hash),
    [history.commits],
  );
  const ciChecks = useCIForCommits(
    commitIds,
    repo?.isPrivate ? undefined : resolved?.repoRelayGroup,
  );
  // Branch/tag badges for the graph — group refs by the commit they point at.
  const refLabels = useMemo(() => {
    const map = new Map<
      string,
      { name: string; isBranch: boolean; isTag: boolean; isDefault?: boolean }[]
    >();
    for (const ref of activeExplorer.refs) {
      const list = map.get(ref.hash) ?? [];
      list.push(ref);
      map.set(ref.hash, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          Number(b.isDefault ?? false) - Number(a.isDefault ?? false) ||
          Number(b.isBranch) - Number(a.isBranch),
      );
    }
    return map;
  }, [activeExplorer.refs]);

  const ciRuns = useMemo(
    () =>
      ciChecks ? [...ciChecks.values()].flatMap((checks) => checks.runs) : [],
    [ciChecks],
  );
  const { coordinatorState, trust } = useRepositoryCITrust(repo, ciRuns);

  useSeoMeta({
    title: repo
      ? resolvedRef
        ? `Commits on ${resolvedRef} - ${repo.name} - BIES Code`
        : `Commits - ${repo.name} - BIES Code`
      : "Commits - BIES Code",
    description: repo?.description ?? "Browse commit history",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  // Preserve the source query param when switching branches so the selected
  // source isn't silently reverted to default.
  const handleRefChange = useCallback(
    (newRef: string) => {
      const base = `${basePath}/commits/${newRef}`;
      if (selectedSource !== "default") {
        navigate(`${base}?source=${encodeURIComponent(selectedSource)}`);
      } else {
        navigate(base);
      }
    },
    [navigate, selectedSource, basePath],
  );

  const handleRefAndSourceChange = useCallback(
    (newRef: string, newSource: string) => {
      const params = new URLSearchParams(searchParams);
      if (newSource === "default") {
        params.delete("source");
      } else {
        params.set("source", newSource);
      }
      const query = params.toString();
      navigate(`${basePath}/commits/${newRef}${query ? `?${query}` : ""}`);
    },
    [navigate, searchParams, basePath],
  );

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
          context="commit history"
          pubkey={pubkey}
          repoId={repoId}
        />
      </div>
    );
  }

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6 space-y-4">
      {/* Header: "Commits on" + ref selector + checked status + server status */}
      <div className="flex items-center gap-3 flex-wrap">
        <GitCommit className="h-5 w-5 text-muted-foreground shrink-0" />
        <h2 className="text-lg font-semibold shrink-0">Commits on</h2>
        {activeExplorer.refs.length > 0 ? (
          <RefSelector
            refs={activeExplorer.refs}
            currentRef={resolvedRef ?? ""}
            onRefChange={handleRefChange}
            selectedSource={selectedSource}
            onSourceChange={handleSourceChange}
            onRefAndSourceChange={handleRefAndSourceChange}
            repoState={repoState}
            repoRelayEose={repoRelayEose}
            loading={activeExplorer.loading}
            stateBehindGit={stateBehindGit}
            poolWarning={poolState.warning}
            winnerUrl={poolState.winnerUrl}
            viewSource={poolState.viewSource}
            effectiveRefs={poolState.effectiveRefs}
            stateCreatedAt={repoState?.event.created_at}
            urlStates={poolState.urls}
            cloneUrls={cloneUrls}
            pool={pool}
          />
        ) : activeExplorer.loading ? (
          <Skeleton className="h-8 w-28" />
        ) : resolvedRef ? (
          <code className="font-mono text-primary text-sm">
            {resolvedRef}
          </code>
        ) : null}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Checked status */}
        {pulling ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking…
          </span>
        ) : repoState ? (
          <span className="text-xs text-muted-foreground/60 shrink-0 whitespace-nowrap">
            checked just now
          </span>
        ) : poolState.lastCheckedAt ? (
          <span className="text-xs text-muted-foreground/60 shrink-0 whitespace-nowrap">
            checked{" "}
            {safeFormatDistanceToNow(poolState.lastCheckedAt, {
              addSuffix: true,
            })}
          </span>
        ) : null}

        {/* Git server status */}
        {cloneUrls.length > 0 && (
          <GitServerStatus
            currentRefFull={(() => {
              const ref = activeExplorer.refs.find(
                (r) => r.name === resolvedRef,
              );
              if (!ref || !resolvedRef) return "";
              return ref.isBranch
                ? `refs/heads/${resolvedRef}`
                : `refs/tags/${resolvedRef}`;
            })()}
            currentRefShort={resolvedRef ?? ""}
            repoRelayEose={repoRelayEose}
            hasStateEvent={!!repoState}
            urlStates={poolState.urls}
            cloneUrls={cloneUrls}
            graspCloneUrls={repo?.graspCloneUrls ?? []}
            additionalGitServerUrls={repo?.additionalGitServerUrls ?? []}
            crossRefDiscrepancies={poolState.crossRefDiscrepancies}
            pool={pool}
            stateCreatedAt={repoState?.event.created_at}
          />
        )}
      </div>

      {history.error && (
        <CommitListError message={history.error} recovery={recovery} />
      )}

      {history.loading && <CommitListLoading count={8} />}

      {!history.loading && history.commits.length > 0 && (
        <CommitList
          commits={history.commits}
          basePath={basePath}
          refLabels={refLabels}
          hasMore={history.hasMore}
          loadingMore={history.loadingMore}
          onLoadMore={history.loadMore}
          ciChecks={ciChecks}
          ciTrust={trust}
          ciRepo={repo}
          ciServiceControls={coordinatorState?.serviceControls}
        />
      )}

      {!history.loading && !history.error && history.commits.length === 0 && (
        <CommitListEmpty />
      )}
    </div>
  );
}
