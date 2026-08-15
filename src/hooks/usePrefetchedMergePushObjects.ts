/**
 * usePrefetchedMergePushObjects — proactively fetch the git objects a merge
 * push will need, while the PR page is otherwise idle.
 *
 * The merge commit itself is pre-built by the mergeability hooks, but
 * clicking Merge still had to download the PR branch object pack (up to a
 * 90s timeout) and, when issue auto-resolution applies, the state-delta
 * objects for the commit-message keyword scan. Neither download is cached by
 * the pool, so the click stalled on the network even though the outcome was
 * fully determined.
 *
 * This hook performs those same fetches in the background once the merge
 * button could be shown, but only after the page's other git work has gone
 * quiet — it polls a caller-supplied `busy` flag and requires a short quiet
 * streak before starting, so the prefetch never competes with visible
 * loading for bandwidth or CPU. Results are keyed by the exact fetch
 * parameters; MergePanel verifies the parameters at click time and falls
 * back to a live fetch on any mismatch, so a stale prefetch can never be
 * pushed.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { NostrEvent } from "nostr-tools";
import type { GitGraspPool } from "@/lib/git-grasp-pool";
import type { PackableObject } from "@/lib/git-packfile";
import {
  fetchPRBranchObjectsWithTimeout,
  fetchIssueScanObjectsForStateDelta,
} from "@/lib/merge-push-fetch";

/** How often the idle-wait loop samples the `busy` flag. */
const IDLE_POLL_MS = 500;
/** Consecutive quiet samples required before a prefetch starts (~1.5s). */
const IDLE_QUIET_POLLS = 3;
/** Samples after which a prefetch starts even if the page never went quiet. */
const IDLE_MAX_POLLS = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrefetchedBranchObjects {
  /** PR tip commit the objects were fetched for. */
  tipCommitId: string;
  /** Merge base the fetch range stopped at. */
  stopAtCommitId: string;
  /** The fetched pack, or null when every clone URL failed. */
  objects: PackableObject[] | null;
}

export interface PrefetchedIssueScanObjects {
  /** Branch head the state delta was computed against. */
  defaultBranchHead: string;
  /** Id of the kind:30618 state event used, or null when none existed. */
  stateEventId: string | null;
  objects: PackableObject[];
}

export interface PrefetchedMergePushObjects {
  /** PR-type branch range pack (null until prefetched / for patch-type). */
  branchObjects: PrefetchedBranchObjects | null;
  /** Issue auto-resolution state-delta objects (null until prefetched). */
  issueScan: PrefetchedIssueScanObjects | null;
}

export interface UsePrefetchedMergePushObjectsOptions {
  gitPool: GitGraspPool | null;
  effectiveCloneUrls: string[];
  /** Prefetch only while a browser merge is actually on offer. */
  enabled: boolean;
  /** True while other page loads are in flight — defers the prefetch. */
  busy: boolean;
  /** PR tip commit (PR-type only; patch-type pushes pre-built objects). */
  prTipCommitId: string | undefined;
  /** Computed merge base from usePRMergeability's result. */
  mergeBase: string | undefined;
  /** Whether issue auto-resolution would scan commit messages on merge. */
  issueScanNeeded: boolean;
  currentStateEvent: NostrEvent | null | undefined;
  defaultBranchName: string;
  defaultBranchHead: string | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Resolves after the page has been quiet for a short streak (or the cap). */
async function waitForIdle(
  busyRef: MutableRefObject<boolean>,
  isCancelled: () => boolean,
): Promise<void> {
  let quiet = 0;
  for (
    let polls = 0;
    polls < IDLE_MAX_POLLS && quiet < IDLE_QUIET_POLLS;
    polls++
  ) {
    if (isCancelled()) return;
    quiet = busyRef.current ? 0 : quiet + 1;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
}

export function usePrefetchedMergePushObjects({
  gitPool,
  effectiveCloneUrls,
  enabled,
  busy,
  prTipCommitId,
  mergeBase,
  issueScanNeeded,
  currentStateEvent,
  defaultBranchName,
  defaultBranchHead,
}: UsePrefetchedMergePushObjectsOptions): PrefetchedMergePushObjects {
  const [branchObjects, setBranchObjects] =
    useState<PrefetchedBranchObjects | null>(null);
  const [issueScan, setIssueScan] = useState<PrefetchedIssueScanObjects | null>(
    null,
  );

  // The busy flag is read through a ref by the idle-wait loop so busy-ness
  // flapping neither restarts the effect nor aborts an in-flight prefetch.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Mirror the latest results for parameter checks without re-running the
  // fetch effects when a prefetch lands.
  const branchRef = useRef(branchObjects);
  branchRef.current = branchObjects;
  const issueScanRef = useRef(issueScan);
  issueScanRef.current = issueScan;

  // ── PR branch range pack ────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !gitPool || !prTipCommitId || !mergeBase) return;

    const have = branchRef.current;
    if (
      have &&
      have.tipCommitId === prTipCommitId &&
      have.stopAtCommitId === mergeBase &&
      have.objects
    ) {
      return;
    }

    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      await waitForIdle(busyRef, () => cancelled);
      if (cancelled) return;
      try {
        const objects = await fetchPRBranchObjectsWithTimeout(
          gitPool,
          prTipCommitId,
          mergeBase,
          effectiveCloneUrls,
          abort.signal,
        );
        if (cancelled) return;
        setBranchObjects({
          tipCommitId: prTipCommitId,
          stopAtCommitId: mergeBase,
          objects,
        });
      } catch {
        // Background prefetch only — the merge click falls back to fetching.
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [enabled, gitPool, prTipCommitId, mergeBase, effectiveCloneUrls]);

  // ── Issue auto-resolution state-delta objects ───────────────────────────
  const stateEventId = currentStateEvent?.id ?? null;

  useEffect(() => {
    if (!enabled || !gitPool || !issueScanNeeded || !defaultBranchHead) return;

    const have = issueScanRef.current;
    if (
      have &&
      have.defaultBranchHead === defaultBranchHead &&
      have.stateEventId === stateEventId
    ) {
      return;
    }

    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      await waitForIdle(busyRef, () => cancelled);
      if (cancelled) return;
      const objects = await fetchIssueScanObjectsForStateDelta(
        gitPool,
        currentStateEvent,
        defaultBranchName,
        defaultBranchHead,
        effectiveCloneUrls,
        abort.signal,
      );
      if (cancelled) return;
      setIssueScan({ defaultBranchHead, stateEventId, objects });
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [
    enabled,
    gitPool,
    issueScanNeeded,
    defaultBranchHead,
    stateEventId,
    currentStateEvent,
    defaultBranchName,
    effectiveCloneUrls,
  ]);

  return useMemo(
    () => ({ branchObjects, issueScan }),
    [branchObjects, issueScan],
  );
}
