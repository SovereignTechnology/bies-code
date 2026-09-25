/**
 * useMergeAnalysis — PR-page-level merge analysis for a PR or patch chain.
 *
 * Bundles the eager mergeability checks (usePatchMergeability /
 * usePRMergeability) and the best-effort "already merged?" history scan
 * (useDetectedMergeCommit) so they can run from PRPage, which stays mounted
 * while the user moves between the Conversation, Commits and Files Changed
 * tabs. MergePanel lives inside the conversation tab's content and unmounts
 * on every tab switch — running the analysis there meant the whole check
 * restarted (and showed "Checking..." again) each time the user came back.
 *
 * The analysis runs once per PR context and keeps running in the background
 * on the other tabs; MergePanel just renders the results.
 */

import { useCallback, useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { nip19 } from "nostr-tools";

import { useMyProfile, useProfile } from "@/hooks/useProfile";
import {
  usePatchMergeability,
  type PatchMergeability,
} from "@/hooks/usePatchMergeability";
import {
  usePRMergeability,
  type PRMergeability,
} from "@/hooks/usePRMergeability";
import { useDetectedMergeCommit } from "@/hooks/useDetectedMergeCommit";
import {
  createCommitPersonNow,
  type DetectedMergeCommit,
  type DetectedMergeScanResult,
  type GitGraspPool,
} from "@/lib/git-grasp-pool";
import type { CommitPerson } from "@/lib/git-objects";
import type { Patch } from "@/casts/Patch";
import type { ResolvedPR, ResolvedRepo } from "@/lib/nip34";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseMergeAnalysisOptions {
  /** The resolved PR (patch-type or pr-type). */
  pr: ResolvedPR | undefined;
  /** The resolved repository. */
  repo: ResolvedRepo | undefined;
  /** The patch chain (cover letters excluded) for patch-type items. */
  patchChain: Patch[] | undefined;
  /** GitGraspPool for fetching trees / history. */
  gitPool: GitGraspPool | null;
  /** All effective clone URLs (repo + PR-specific). */
  effectiveCloneUrls: string[];
  /** Current authoritative tip commit of the effective merge target. */
  defaultBranchHead: string | undefined;
  /**
   * Guessed base commit ID from the timestamp heuristic, used when the first
   * patch has no `parent-commit` tag. Patch-type only.
   */
  guessedBaseCommitId: string | undefined;
  /** NIP-19 nevent for the PR event (PR-type only, for the commit message). */
  prNevent: string | undefined;
  /**
   * Master switch — mirrors the MergePanel render condition so the analysis
   * only runs when the panel could actually be shown (maintainer, open item,
   * git-backed repo).
   */
  enabled: boolean;
  /**
   * True once this tab successfully pushed a merge. Stops the already-merged
   * history scan from re-firing against the post-merge branch head.
   */
  suppressDetection: boolean;
}

export interface MergeAnalysis {
  /**
   * Committer identity used to pre-build merge objects. Undefined when logged
   * out. Merge handlers rebuild the committer at click time for patch-type
   * merges so pushed commits carry the actual merge time.
   */
  maintainerCommitter: CommitPerson | undefined;
  /**
   * The PR/patch author's display name (kind-0 metadata) for the `PR-Author:`
   * trailer in merge commit messages.
   */
  rootAuthorName: string | undefined;
  /** Patch-type mergeability (idle for PR-type items). */
  patchMergeability: PatchMergeability;
  /** PR-type mergeability (idle for patch-type items). */
  prMergeability: PRMergeability;
  /** Detected ngit-style merge commit missing its merged status, or null. */
  detectedMergeCommit: DetectedMergeCommit | null;
  /** Full already-merged scan outcome (hit limit, scanned count, …). */
  detectedMergeScanResult: DetectedMergeScanResult | null;
  /** True while the already-merged scan is in flight. */
  detectingMergeCommit: boolean;
  /** Extend the already-merged scan cap by one look-back step. */
  lookBackFurther: () => void;
  /** How many extra commits each look-back step adds. */
  lookbackStep: number;
  /** The tip commit a detected merge must list as a parent. */
  detectionTipCommitId: string | undefined;
  /** The stated base commit bounding the already-merged scan, when known. */
  detectionStopCommitId: string | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMergeAnalysis({
  pr,
  repo,
  patchChain,
  gitPool,
  effectiveCloneUrls,
  defaultBranchHead,
  guessedBaseCommitId,
  prNevent,
  enabled,
  suppressDetection,
}: UseMergeAnalysisOptions): MergeAnalysis {
  const account = useActiveAccount();
  const profile = useMyProfile();

  // The PR/patch author's profile — used for the `PR-Author:` trailer in the
  // merge commit message. Only a real human name is surfaced (matching
  // `ngit merge`); when none is known the trailer carries just the npub.
  const authorProfile = useProfile(pr?.pubkey);
  const rootAuthorName =
    authorProfile?.displayName || authorProfile?.name || undefined;

  // Committer identity for browser-created commits. The memoised value feeds
  // the mergeability hooks (which pre-build objects).
  const buildCommitterNow = useCallback((): CommitPerson | undefined => {
    if (!account) return undefined;
    return createCommitPersonNow(
      profile?.displayName || profile?.name || "Anonymous",
      profile?.nip05 ?? `${nip19.npubEncode(account.pubkey)}@nostr`,
    );
  }, [account, profile]);

  const maintainerCommitter = useMemo(
    () => buildCommitterNow(),
    [buildCommitterNow],
  );

  const isPRType = pr?.itemType === "pr";

  // Eagerly check mergeability (patch-type only)
  const patchMergeability = usePatchMergeability(
    isPRType ? undefined : patchChain,
    gitPool,
    effectiveCloneUrls,
    enabled && !isPRType,
    guessedBaseCommitId,
    defaultBranchHead,
    maintainerCommitter,
  );

  // PR-type mergeability: fetch tip tree and pre-build merge commit
  const coverNoteBody = pr?.coverNote?.content || undefined;
  const prBody = pr?.body || undefined;
  const prMergeability = usePRMergeability(
    isPRType ? pr?.tip.commitId : undefined,
    defaultBranchHead,
    maintainerCommitter,
    pr?.rootEvent.id ?? "",
    pr ? pr.currentSubject || pr.originalSubject : "",
    prNevent ?? "",
    pr?.pubkey ?? "",
    rootAuthorName,
    coverNoteBody,
    prBody,
    gitPool,
    effectiveCloneUrls,
    enabled && isPRType,
    pr?.tip.explicitMergeBase,
  );

  const mergeabilityStatus = isPRType
    ? prMergeability.status
    : patchMergeability.status;

  const supportsBrowserMerge =
    !!repo &&
    repo.graspCloneUrls.length > 0 &&
    repo.additionalGitServerUrls.length === 0;

  const patchTipCommitId =
    !isPRType && patchChain?.length
      ? patchChain[patchChain.length - 1]?.commitId
      : undefined;

  const detectionTipCommitId = isPRType ? pr?.tip.commitId : patchTipCommitId;
  const detectionStopCommitId = isPRType
    ? pr?.tip.explicitMergeBase
    : patchChain?.[0]?.parentCommitId;

  const shouldScanForMissingMergedStatus =
    enabled &&
    !suppressDetection &&
    (pr?.status === "open" || pr?.status === "draft") &&
    (mergeabilityStatus === "ready" ||
      mergeabilityStatus === "already-merged" ||
      mergeabilityStatus === "ready-apply-only" ||
      mergeabilityStatus === "conflicts" ||
      (!supportsBrowserMerge && mergeabilityStatus !== "loading"));

  // Best-effort scan for an ngit-style merge commit whose kind:1631 merged
  // status never made it to the relays.
  const {
    detectedMergeCommit,
    scanResult: detectedMergeScanResult,
    detecting: detectingMergeCommit,
    lookBackFurther,
    lookbackStep,
  } = useDetectedMergeCommit({
    gitPool,
    defaultBranchHead,
    rootEventId: pr?.rootEvent.id ?? "",
    fallbackUrls: effectiveCloneUrls,
    enabled: shouldScanForMissingMergedStatus,
    tipCommitId: detectionTipCommitId,
    stopAtCommitId: detectionStopCommitId,
  });

  return {
    maintainerCommitter,
    rootAuthorName,
    patchMergeability,
    prMergeability,
    detectedMergeCommit,
    detectedMergeScanResult,
    detectingMergeCommit,
    lookBackFurther,
    lookbackStep,
    detectionTipCommitId,
    detectionStopCommitId,
  };
}
