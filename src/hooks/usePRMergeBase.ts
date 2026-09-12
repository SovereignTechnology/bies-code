/**
 * usePRMergeBase — derive the merge base for a PR when the merge-base tag
 * is absent from the PR event.
 *
 * The merge-base tag is optional in NIP-34. When it is missing we walk the
 * commit chain to find the common ancestor with the target branch. The hook
 * also re-runs whenever the tip commit changes (e.g. after a PR rebase).
 *
 * Returns:
 *   - `mergeBase`: the resolved commit hash, or undefined while computing
 *   - `computing`: true while the async lookup is in progress
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useErrorRetry, type ErrorRetryState } from "@/hooks/useErrorRetry";
import type { GitGraspPool, PoolState } from "@/lib/git-grasp-pool";

export interface UsePRMergeBaseResult {
  /** The resolved merge-base commit hash, or undefined if not yet known. */
  mergeBase: string | undefined;
  /** True while the async computation is in progress. */
  computing: boolean;
  recovery: ErrorRetryState;
}

/**
 * Derive the merge base for a PR.
 *
 * If `explicitMergeBase` is provided it is returned immediately (no git
 * operations are performed). Otherwise the hook walks the commit chain via
 * `gitPool.findMergeBase()`.
 *
 * The computation re-runs whenever `tipCommitId` changes so that PR updates
 * (rebases) are handled correctly.
 *
 * @param gitPool           - The git pool for the repo (may be null while connecting).
 * @param poolState         - Reactive pool state used for the default target.
 * @param tipCommitId       - The PR's tip commit (may be undefined while loading).
 * @param explicitMergeBase - The merge-base from the PR event tag, if present.
 * @param fallbackUrls      - Extra clone URLs (e.g. PR author's fork).
 * @param targetBranchHead  - Current authoritative tip of the target branch.
 * @param targetBranchLoading - Whether target-ref discovery is still pending.
 * @param requireTargetBranchHead - Do not fall back to repository HEAD.
 */
export function usePRMergeBase(
  gitPool: GitGraspPool | null,
  poolState: PoolState,
  tipCommitId: string | undefined,
  explicitMergeBase: string | undefined,
  fallbackUrls?: string[],
  targetBranchHead?: string,
  targetBranchLoading: boolean = poolState.loading,
  requireTargetBranchHead: boolean = false,
): UsePRMergeBaseResult {
  const [derived, setDerived] = useState<string | undefined>(undefined);
  const [computing, setComputing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [failed, setFailed] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const fallbackKey = fallbackUrls?.join(",");
  const effectiveTargetBranchHead =
    targetBranchHead ??
    (requireTargetBranchHead
      ? undefined
      : poolState.authoritativeHead?.commitId);

  const resourceKey = useMemo(
    () => ({
      gitPool,
      effectiveTargetBranchHead,
      tipCommitId,
      explicitMergeBase,
      fallbackKey,
    }),
    [
      gitPool,
      effectiveTargetBranchHead,
      tipCommitId,
      explicitMergeBase,
      fallbackKey,
    ],
  );
  const recovery = useErrorRetry({
    resourceKey,
    failed,
    busy: computing || targetBranchLoading,
    onRetry: async (signal) => {
      await gitPool?.retryReads();
      if (!signal.aborted) setRetryVersion((version) => version + 1);
    },
    policy:
      gitPool && !gitPool.requiresSigningForReads
        ? { mode: "read", requiresSigning: false, context: "availability" }
        : { mode: "manual" },
  });

  useEffect(() => {
    setFailed(false);
    // If an explicit merge base is provided, nothing to do.
    if (explicitMergeBase !== undefined) {
      setDerived(undefined);
      setComputing(false);
      abortRef.current?.abort();
      return;
    }

    // Need a pool and both ends of the comparison to proceed.
    if (!gitPool || !effectiveTargetBranchHead || !tipCommitId) {
      setDerived(undefined);
      setFailed(Boolean(gitPool && tipCommitId && !targetBranchLoading));
      setComputing(Boolean(tipCommitId && gitPool && targetBranchLoading));
      return;
    }

    // Abort any previous in-flight computation.
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setComputing(true);
    setDerived(undefined);

    gitPool
      .findMergeBaseBetween(
        effectiveTargetBranchHead,
        tipCommitId,
        abort.signal,
        fallbackUrls,
      )
      .then((result) => {
        if (abort.signal.aborted) return;
        setDerived(result ?? undefined);
        setFailed(!result);
        setComputing(false);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setFailed(true);
        setComputing(false);
      });

    return () => {
      abort.abort();
    };
    // fallbackKey tracks the URL values without cancelling work on array identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gitPool,
    effectiveTargetBranchHead,
    tipCommitId,
    explicitMergeBase,
    fallbackKey,
    retryVersion,
    targetBranchLoading,
    requireTargetBranchHead,
  ]);

  // If an explicit merge base is provided, use it directly.
  if (explicitMergeBase !== undefined) {
    return { mergeBase: explicitMergeBase, computing: false, recovery };
  }

  return { mergeBase: derived, computing, recovery };
}
