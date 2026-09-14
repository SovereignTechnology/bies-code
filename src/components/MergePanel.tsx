import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { ManualRetryAction } from "@/components/ErrorRetryAction";
/**
 * MergePanel — merge/apply button and status panel for PRs on Grasp repos.
 *
 * Shown at the bottom of the conversation tab, above the reply box. Eagerly
 * checks whether the patch chain / PR branch can be merged or applied and
 * shows one of:
 *   - "Ready to merge" with a green Merge button (merge strategy succeeded)
 *   - "Apply to Tip" with an amber Apply button + warning (only apply-to-tip works)
 *   - "Conflicts detected" with file-level details
 *   - "Error" with a human-readable message
 *
 * The heavy lifting lives in `@/lib/git-grasp-pool`:
 *   - `performMerge` / `performPRMerge` / `performApplyToTip` — the shared
 *     pre-push state acceptance → push → status → broadcast orchestration
 *     (`merge.ts`).
 *   - `GitGraspPool.pushRefUpdate` — the multi-server Grasp push that
 *     tolerates lagging mirrors (`grasp-push.ts`).
 *
 * The mergeability checks and the best-effort "already merged?" history scan
 * run at the PR page level via `useMergeAnalysis` (so their results survive
 * tab switches) and arrive here through the `analysis` prop. This component
 * only wires the merge actions up with the app's account, outbox, relay
 * pool, and EventStore, and renders the states.
 */

import { useState, useCallback, useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { TimeoutError } from "applesauce-core/observable";
import type { PublishResponse } from "applesauce-relay";
import { nip19 } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import {
  GitMerge,
  GitBranch,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Info,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/useToast";
import { useMyProfile } from "@/hooks/useProfile";
import { type MergeabilityStatus } from "@/hooks/usePatchMergeability";
import { type PRMergeabilityStatus } from "@/hooks/usePRMergeability";
import type { MergeAnalysis } from "@/hooks/useMergeAnalysis";
import { useMergedPRCommitMatch } from "@/hooks/useMergedPRCommitMatch";
import {
  performMerge,
  performPRMerge,
  performApplyToTip,
  signMergedStatus,
  buildPRNevent,
  createCommitPersonNow,
  summarizePushDelivery,
  formatCloneUrlHost,
  getGitRemoteHostname,
  type GitGraspPool,
  type GraspMergeTransports,
  type IssueAutoResolveContext,
  type IssueCandidate,
  type PushDeliverySummary,
  type PushDeliveryOutcome,
} from "@/lib/git-grasp-pool";
import { pool as relayPool, eventStore } from "@/services/nostr";
import { outboxStore } from "@/services/outbox";

import type { CommitPerson } from "@/lib/git-objects";
import type { PackableObject } from "@/lib/git-packfile";
import type { Patch } from "@/casts/Patch";
import {
  type ResolvedRepo,
  type ResolvedPR,
  type ResolvedPRLite,
  type ResolvedIssueLite,
  REPO_STATE_KIND,
  graspCloneUrlServiceAddress,
} from "@/lib/nip34";
import {
  fetchPRBranchObjectsWithTimeout,
  fetchIssueScanObjectsForStateDelta,
} from "@/lib/merge-push-fetch";
import type { PrefetchedMergePushObjects } from "@/hooks/usePrefetchedMergePushObjects";
import {
  graspServiceAddressToRelayUrl,
  relayMatchesGraspService,
} from "@/lib/grasp";
import type { InferredPRParent } from "@/lib/inferredPRParents";
import { requestRelaySnapshot, type RelaySnapshot } from "@/lib/relaySnapshot";
import type { ResolvedRepository } from "@/hooks/useResolvedRepository";
import {
  useRepositoryReplaceablePreflight,
  type RepositoryReplaceableSnapshot,
} from "@/hooks/useRepositoryReplaceablePreflight";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MergePanelProps {
  /** Page-owned repository relay groups and replaceable coverage lease. */
  resolved: ResolvedRepository;
  /** The resolved PR (patch-type or pr-type) */
  pr: ResolvedPR;
  /** The resolved repository */
  repo: ResolvedRepo;
  /**
   * The patch chain (cover letters excluded). Required for patch-type items.
   * Omit (or pass undefined) for PR-type items.
   */
  patchChain?: Patch[];
  /** GitGraspPool for fetching base tree / file content */
  gitPool: GitGraspPool | null;
  /** All effective clone URLs */
  effectiveCloneUrls: string[];
  /** Behind count (how many commits the merge target moved since the item base) */
  behindCount: number | undefined;
  /** Effective merge target branch name (the default when b is absent). */
  defaultBranchName: string;
  /** Current authoritative tip commit of the effective merge target. */
  defaultBranchHead: string | undefined;
  /** Whether the effective merge target is the repository default branch. */
  targetIsDefaultBranch: boolean;
  /** Current kind:30618 repository state, used to preserve existing branches/tags. */
  currentStateEvent?: NostrEvent | null;
  /**
   * Guessed base commit ID from the timestamp heuristic, used when the first
   * patch has no `parent-commit` tag. Passed through to usePatchMergeability.
   * Only relevant for patch-type items.
   */
  guessedBaseCommitId?: string;
  /**
   * Page-level merge analysis (mergeability checks + already-merged
   * detection) from `useMergeAnalysis`. Hoisted to PRPage so results survive
   * switching between the Conversation, Commits and Files Changed tabs.
   */
  analysis: MergeAnalysis;
  /**
   * Push objects prefetched in the background while the page was idle
   * (usePrefetchedMergePushObjects). Parameters are re-verified at click
   * time; on any mismatch the handlers fall back to a live fetch.
   */
  prefetched?: PrefetchedMergePushObjects;
  /**
   * The repo's known issues (from RepoContext). Used to auto-resolve issues
   * referenced by `closes/fixes/resolves/implements` keywords in the commit
   * messages landing with the merge — including the merge commit itself —
   * matching ngit's push-time behaviour.
   */
  issues?: ResolvedIssueLite[];
  /** Repository PRs, used to explain stale bases from already-merged stacks. */
  prs?: ResolvedPRLite[];
  /**
   * Definite inferred stack parent while it is open or draft. Undefined means
   * repository PR state is still loading; null means no active parent.
   */
  openStackParent: InferredPRParent | null | undefined;
  /**
   * Called after at least one Grasp server accepted the git push. Lets the
   * parent keep this panel mounted after the merged status event changes the PR
   * status to resolved.
   */
  onSuccessfulPush?: () => void;
}

type MergeStep =
  | "idle"
  | "building"
  | "publishing-state"
  | "pushing"
  | "publishing-status"
  | "broadcasting-state"
  | "done"
  | "failed";

type StatePublishResponse = PublishResponse & {
  failure?: "timeout" | "transport";
};

interface StatePublishDelivery {
  event: NostrEvent;
  responses: StatePublishResponse[];
}

type MergePanelStatus =
  | MergeabilityStatus
  | PRMergeabilityStatus
  | "detected-merged"
  | "waiting-for-stack-parent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGitServerName(cloneUrls: string[]): string {
  const hostname = cloneUrls
    .map(getGitRemoteHostname)
    .find((host): host is string => !!host);

  if (!hostname) return "a non-GRASP git server";

  const lowerHost = hostname.toLowerCase();
  if (lowerHost.includes("gitlab")) return "GitLab";
  if (lowerHost.includes("github")) return "GitHub";
  if (lowerHost.includes("bitbucket")) return "Bitbucket";
  if (lowerHost.includes("codeberg")) return "Codeberg";
  if (lowerHost.includes("sr.ht") || lowerHost.includes("sourcehut")) {
    return "SourceHut";
  }

  return hostname;
}

/** Toast suffix for issues auto-resolved from commit-message keywords. */
function formatResolvedIssuesSuffix(count: number): string {
  if (count === 0) return "";
  return ` Auto-resolved ${count} issue${count !== 1 ? "s" : ""} from commit keywords.`;
}

/**
 * Publish an event to Grasp relays only and await at least one acceptance.
 */
async function publishToGraspRelays(
  event: NostrEvent,
  relayUrls: string[],
): Promise<StatePublishResponse[]> {
  if (relayUrls.length === 0) {
    throw new Error("No Grasp relay URLs available");
  }

  return Promise.all(
    relayUrls.map(async (from): Promise<StatePublishResponse> => {
      try {
        return await relayPool.relay(from).publish(event);
      } catch (error) {
        return {
          from,
          ok: false,
          failure: error instanceof TimeoutError ? "timeout" : "transport",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

const STEP_LABELS: Record<MergeStep, string> = {
  idle: "",
  building: "Building merge commit...",
  "publishing-state": "Publishing state to Grasp...",
  pushing: "Pushing to git server...",
  "publishing-status": "Publishing merged status...",
  "broadcasting-state": "Broadcasting state event...",
  done: "Complete!",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MergePanel({
  resolved,
  pr,
  repo,
  patchChain,
  gitPool,
  effectiveCloneUrls,
  behindCount,
  defaultBranchName,
  defaultBranchHead,
  targetIsDefaultBranch,
  currentStateEvent,
  guessedBaseCommitId,
  analysis,
  prefetched,
  issues,
  prs,
  openStackParent,
  onSuccessfulPush,
}: MergePanelProps) {
  const copyToClipboard = useCopyToClipboard();
  const account = useActiveAccount();
  const profile = useMyProfile();
  const { toast } = useToast();
  const replaceablePreflight = useRepositoryReplaceablePreflight(resolved);

  // The PR/patch author's display name — used for the `PR-Author:` trailer in
  // the merge commit message (resolved by useMergeAnalysis).
  const rootAuthorName = analysis.rootAuthorName;

  // Merge step tracking
  const [mergeStep, setMergeStep] = useState<MergeStep>("idle");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [pushDelivery, setPushDelivery] = useState<PushDeliverySummary | null>(
    null,
  );
  const [statePublishDelivery, setStatePublishDelivery] =
    useState<StatePublishDelivery | null>(null);

  const hasAdditionalGitServers = repo.additionalGitServerUrls.length > 0;
  const supportsBrowserMerge =
    repo.graspCloneUrls.length > 0 && !hasAdditionalGitServers;
  const localMergeCommand = `ngit merge ${pr.rootEvent.id.slice(0, 8)} && git push`;
  const gitServerName = formatGitServerName(repo.additionalGitServerUrls);
  const localMergeReason = hasAdditionalGitServers
    ? `This repository also lists ${gitServerName} as a git server, so gitworkshop can't safely update every advertised server.`
    : `This repository uses ${gitServerName}, so merging directly from gitworkshop isn't supported.`;

  // Committer identity for browser-created commits. useMergeAnalysis feeds a
  // memoised committer to the mergeability hooks (which pre-build objects);
  // this builder is called again at click time so pushed commits carry the
  // actual merge time.
  const buildCommitterNow = useCallback((): CommitPerson | undefined => {
    if (!account) return undefined;
    return createCommitPersonNow(
      profile?.displayName || profile?.name || "Anonymous",
      profile?.nip05 ?? `${nip19.npubEncode(account.pubkey)}@nostr`,
    );
  }, [account, profile]);

  const isPRType = pr.itemType === "pr";

  const patchEventIds = useMemo(
    () =>
      (patchChain ?? []).map((patch) => ({
        id: patch.event.id,
        pubkey: patch.pubkey,
      })),
    [patchChain],
  );

  // Issue auto-resolution context (ngit parity): commit messages landing on
  // the repository default branch are scanned for resolution keywords against
  // the repo's open/draft issues. Resolved/closed/deleted issues are filtered
  // here so the merge never re-resolves them.
  const issueAutoResolve = useMemo<IssueAutoResolveContext | undefined>(() => {
    if (!targetIsDefaultBranch || !issues?.length) return undefined;
    const candidates: IssueCandidate[] = issues
      .filter((issue) => issue.status === "open" || issue.status === "draft")
      .map((issue) => ({
        id: issue.id,
        pubkey: issue.pubkey,
        status: issue.status,
      }));
    if (candidates.length === 0) return undefined;
    return { issues: candidates, maintainers: repo.confirmedMaintainers };
  }, [issues, repo.confirmedMaintainers, targetIsDefaultBranch]);

  const { detectionStopCommitId } = analysis;

  // Mergeability results — computed at the PR page level by useMergeAnalysis
  // so the check runs once per PR context and survives tab switches.
  const { patchMergeability, prMergeability } = analysis;

  // Unified mergeability view for the render logic
  const mergeability = isPRType
    ? {
        status: prMergeability.status as
          | MergeabilityStatus
          | PRMergeabilityStatus,
        buildResult: null,
        applyResult: null,
        conflicts: prMergeability.conflicts,
        errorMessage: prMergeability.errorMessage,
        mergeStrategyError: null,
        mergeBaseMismatch: prMergeability.mergeBaseMismatch,
        recheck: prMergeability.recheck,
      }
    : {
        ...patchMergeability,
        status: patchMergeability.status as
          | MergeabilityStatus
          | PRMergeabilityStatus,
        mergeBaseMismatch: null,
      };

  const mergedPRCommitMatch = useMergedPRCommitMatch(
    isPRType ? prMergeability.mergeBaseMismatch?.computed : undefined,
    pr.rootEvent.id,
    pr.rootEvent.created_at,
    prs,
    repo,
  );

  // Best-effort scan for an ngit-style merge commit whose kind:1631 merged
  // status never made it to the relays. The scan itself runs at the page
  // level (useMergeAnalysis); while a merge from this panel is in flight the
  // results are hidden, matching the previous behaviour of disabling the
  // scan whenever mergeStep left "idle".
  const detectedMergeCommit =
    mergeStep === "idle" ? analysis.detectedMergeCommit : null;
  const detectedMergeScanResult =
    mergeStep === "idle" ? analysis.detectedMergeScanResult : null;
  const detectingMergeCommit =
    mergeStep === "idle" ? analysis.detectingMergeCommit : false;
  const { lookBackFurther, lookbackStep } = analysis;

  const mergeabilityCheckWillStart =
    supportsBrowserMerge &&
    mergeStep === "idle" &&
    mergeability.status === "idle" &&
    (isPRType ? !!pr.tip.commitId : !!patchChain?.length);

  const displayedStatus: MergePanelStatus = detectedMergeCommit
    ? "detected-merged"
    : openStackParent && mergeability.status === "ready"
      ? "waiting-for-stack-parent"
      : mergeabilityCheckWillStart
        ? "loading"
        : mergeability.status;

  // GRASP relay URLs: repo relays matching an exact service address.
  const graspRelayUrls = useMemo(
    () =>
      repo.relays.filter((relay) =>
        relayMatchesGraspService(relay, repo.graspServerAddresses),
      ),
    [repo.relays, repo.graspServerAddresses],
  );

  // Can we offer the browser merge action? An open stack parent keeps the
  // familiar action visible but disabled until that parent lands.
  const canOfferBrowserMerge =
    supportsBrowserMerge &&
    !detectedMergeCommit &&
    mergeability.status === "ready" &&
    !!defaultBranchHead &&
    (targetIsDefaultBranch || !!currentStateEvent) &&
    mergeStep === "idle";
  const canMerge = canOfferBrowserMerge && !openStackParent;
  const mergeBlockedByStackParent = canOfferBrowserMerge && !!openStackParent;

  // Can we show the apply-to-tip button? (patch-type only)
  const canApplyToTip =
    supportsBrowserMerge &&
    !detectedMergeCommit &&
    !isPRType &&
    mergeability.status === "ready-apply-only" &&
    defaultBranchHead &&
    mergeStep === "idle";

  const canShowLocalMerge =
    !supportsBrowserMerge &&
    !detectedMergeCommit &&
    !openStackParent &&
    mergeStep === "idle";

  const canMarkDetectedMerged =
    !!account && !!detectedMergeCommit && mergeStep === "idle";

  const copyLocalMergeCommand = useCallback(async () => {
    await copyToClipboard(localMergeCommand, () => {
      toast({
        title: "Local merge command copied",
        description: localMergeCommand,
      });
    });
  }, [localMergeCommand, toast, copyToClipboard]);

  // ── Shared merge wiring ──────────────────────────────────────────────────

  /**
   * Build the transports every merge strategy runs against: state events first
   * obtain Grasp relay acceptance, the push fans out to every Grasp server via
   * the pool, and status/state broadcasts go through the outbox. A
   * `purgatory:` response proves staging; a plain successful response may have
   * broadcast immediately. The returned `getPushSummary` exposes the delivery
   * summary for the success toast.
   */
  const createMergeTransports = useCallback(
    (accountPubkey: string, preflightStateEvent: NostrEvent | undefined) => {
      let pushSummary: PushDeliverySummary | null = null;

      const transports: GraspMergeTransports = {
        publishStateToGrasp: async (state) => {
          const responses = await publishToGraspRelays(state, graspRelayUrls);
          setStatePublishDelivery({ event: state, responses });

          if (!responses.some((response) => response.ok)) {
            throw new Error(
              "No Grasp relay acknowledged the state event. Git objects have not been pushed.",
            );
          }
        },
        pushObjects: async (objects, refUpdate) => {
          if (!gitPool) throw new Error("Git pool unavailable");
          // Resolves once one server accepted; the rest keep syncing in the
          // background and stream their outcomes through onUpdate, so the
          // delivery summary keeps updating after the merge completes.
          await gitPool.pushRefUpdate(objects, refUpdate, {
            targetCloneUrls: repo.graspCloneUrls,
            currentStateEvent: preflightStateEvent,
            onUpdate: (summary) => {
              pushSummary = summary;
              setPushDelivery(summary);
            },
          });
          onSuccessfulPush?.();
        },
        publishStatusBroadly: (status) =>
          outboxStore.publish(status, [
            `outbox:${accountPubkey}`,
            ...repo.confirmedMemberCoordinates,
            ...(pr.pubkey !== accountPubkey ? [`inbox:${pr.pubkey}`] : []),
          ]),
        publishIssueStatus: (status, issue) =>
          outboxStore.publish(status, [
            `outbox:${accountPubkey}`,
            ...repo.confirmedMemberCoordinates,
            ...(issue.pubkey !== accountPubkey
              ? [`inbox:${issue.pubkey}`]
              : []),
          ]),
        broadcastStateBroadly: (state) =>
          outboxStore.publish(state, [
            `outbox:${accountPubkey}`,
            ...repo.confirmedMemberCoordinates,
            "fallback-relays",
          ]),
        onEvent: (event) => eventStore.add(event),
        onStep: (step) => setMergeStep(step),
      };

      return { transports, getPushSummary: () => pushSummary };
    },
    [
      gitPool,
      graspRelayUrls,
      repo.graspCloneUrls,
      repo.confirmedMemberCoordinates,
      pr.pubkey,
      onSuccessfulPush,
    ],
  );

  const beginMerge = useCallback(() => {
    setMergeStep("building");
    setMergeError(null);
    setPushDelivery(null);
    setStatePublishDelivery(null);
  }, []);

  const failMerge = useCallback(
    (err: unknown, title: string, fallbackMessage: string) => {
      const message = err instanceof Error ? err.message : fallbackMessage;
      setMergeStep("failed");
      setMergeError(message);
      toast({ title, description: message, variant: "destructive" });
    },
    [toast],
  );

  /**
   * Objects for the issue auto-resolution commit-message scan. Uses the
   * background-prefetched state-delta objects when they match the current
   * branch head + state event, otherwise fetches live.
   */
  const resolveIssueScanObjects = useCallback(async (): Promise<
    PackableObject[]
  > => {
    if (!issueAutoResolve || !gitPool || !defaultBranchHead) return [];
    const pf = prefetched?.issueScan;
    if (
      pf &&
      pf.defaultBranchHead === defaultBranchHead &&
      pf.stateEventId === (currentStateEvent?.id ?? null)
    ) {
      return pf.objects;
    }
    return fetchIssueScanObjectsForStateDelta(
      gitPool,
      currentStateEvent,
      defaultBranchName,
      defaultBranchHead,
      effectiveCloneUrls,
    );
  }, [
    issueAutoResolve,
    gitPool,
    defaultBranchHead,
    prefetched,
    currentStateEvent,
    defaultBranchName,
    effectiveCloneUrls,
  ]);

  const publishMergedStatus = useCallback(
    async (mergeCommitHash: string): Promise<void> => {
      if (!account) return;

      const signedStatus = await signMergedStatus({
        signer: account.signer,
        signerPubkey: account.pubkey,
        rootEventId: pr.rootEvent.id,
        repoCoords: pr.repoCoords,
        rootAuthorPubkey: pr.pubkey,
        mergeCommitHash,
        patchEventIds,
      });

      await outboxStore.publish(signedStatus, [
        `outbox:${account.pubkey}`,
        ...repo.confirmedMemberCoordinates,
        ...(pr.pubkey !== account.pubkey ? [`inbox:${pr.pubkey}`] : []),
      ]);
      eventStore.add(signedStatus);
    },
    [account, patchEventIds, pr, repo.confirmedMemberCoordinates],
  );

  const handleMarkDetectedMerged = useCallback(async () => {
    if (!account || !detectedMergeCommit) return;

    setMergeStep("publishing-status");
    setMergeError(null);
    setPushDelivery(null);
    setStatePublishDelivery(null);

    try {
      await publishMergedStatus(detectedMergeCommit.hash);
      setMergeStep("done");
      toast({
        title: "Marked as merged",
        description: `Detected merge commit ${detectedMergeCommit.hash.slice(0, 8)} and published the missing merged status.`,
      });
    } catch (err) {
      failMerge(
        err,
        "Could not mark as merged",
        "Could not publish merged status",
      );
    }
  }, [account, detectedMergeCommit, publishMergedStatus, failMerge, toast]);

  const runRepositoryStateTransition = useCallback(
    async <T,>(
      action: (snapshot: RepositoryReplaceableSnapshot) => Promise<T>,
    ): Promise<T> => {
      if (!account) throw new Error("Sign in before merging.");
      return replaceablePreflight.execute(
        {
          kind: REPO_STATE_KIND,
          actorPubkey: account.pubkey,
          expectedEventId: currentStateEvent?.id ?? null,
          holdWriteWindow: true,
        },
        action,
      );
    },
    [account, currentStateEvent, replaceablePreflight],
  );

  // ── Merge orchestration (patch-type merge strategy) ─────────────────────

  const handleMerge = useCallback(async () => {
    const buildResult = mergeability.buildResult;
    if (!account || !buildResult || !defaultBranchHead || !gitPool) {
      return;
    }

    beginMerge();

    try {
      await runRepositoryStateTransition(async (stateSnapshot) => {
        const committer = buildCommitterNow();
        if (!committer) return;

        const { transports, getPushSummary } = createMergeTransports(
          account.pubkey,
          stateSnapshot.winner,
        );
        const issueScanObjects = await resolveIssueScanObjects();

        const { mergeCommit, issueStatuses } = await performMerge({
          signer: account.signer,
          signerPubkey: account.pubkey,
          chainObjects: buildResult.objects,
          finalTreeHash: buildResult.finalTreeHash,
          tipCommitHash: buildResult.tipCommitHash,
          dTag: repo.dTag,
          defaultBranchName,
          defaultBranchHead,
          updateHead: targetIsDefaultBranch,
          currentStateEvent: stateSnapshot.winner,
          repoCoords: pr.repoCoords,
          rootEventId: pr.rootEvent.id,
          rootAuthorPubkey: pr.pubkey,
          issueScanObjects,
          issueAutoResolve,
          subject: pr.currentSubject || pr.originalSubject,
          prNevent: buildPRNevent(pr.rootEvent.id, pr.pubkey, repo.relays),
          rootAuthorName,
          // Cover note takes precedence over the PR body in the merge commit
          // message (recorded under different headings — see buildMergeCommitMessage).
          coverNote: pr.coverNote?.content || undefined,
          prDescription: pr.body || undefined,
          committer,
          patchEventIds,
          ...transports,
        });

        const summary = getPushSummary();
        toast({
          title: "Patch merged",
          description: `Merge commit ${mergeCommit.hash.slice(0, 8)} pushed to ${defaultBranchName}.${summary ? ` ${summarizePushDelivery(summary)}` : ""}${formatResolvedIssuesSuffix(issueStatuses.length)}`,
        });
      });
    } catch (err) {
      failMerge(err, "Merge failed", "Merge failed unexpectedly");
    }
  }, [
    account,
    mergeability.buildResult,
    defaultBranchHead,
    defaultBranchName,
    targetIsDefaultBranch,
    gitPool,
    pr,
    patchEventIds,
    issueAutoResolve,
    repo,
    rootAuthorName,
    beginMerge,
    buildCommitterNow,
    createMergeTransports,
    resolveIssueScanObjects,
    runRepositoryStateTransition,
    failMerge,
    toast,
  ]);

  // ── Apply-to-tip orchestration ────────────────────────────────────────────

  const handleApplyToTip = useCallback(async () => {
    const applyResult = mergeability.applyResult;
    if (!account || !applyResult || !defaultBranchHead || !gitPool) {
      return;
    }

    beginMerge();

    try {
      await runRepositoryStateTransition(async (stateSnapshot) => {
        const { transports, getPushSummary } = createMergeTransports(
          account.pubkey,
          stateSnapshot.winner,
        );
        const issueScanObjects = await resolveIssueScanObjects();

        const { newTipCommitHash, issueStatuses } = await performApplyToTip({
          signer: account.signer,
          signerPubkey: account.pubkey,
          objects: applyResult.objects,
          newTipCommitHash: applyResult.newTipCommitHash,
          dTag: repo.dTag,
          defaultBranchName,
          defaultBranchHead,
          updateHead: targetIsDefaultBranch,
          currentStateEvent: stateSnapshot.winner,
          repoCoords: pr.repoCoords,
          rootEventId: pr.rootEvent.id,
          rootAuthorPubkey: pr.pubkey,
          issueScanObjects,
          issueAutoResolve,
          patchEventIds,
          ...transports,
        });

        const summary = getPushSummary();
        const patchCount = patchChain?.length ?? 0;
        toast({
          title: "Patch applied",
          description: `${patchCount} commit${patchCount !== 1 ? "s" : ""} applied to ${defaultBranchName} (tip: ${newTipCommitHash.slice(0, 8)}).${summary ? ` ${summarizePushDelivery(summary)}` : ""}${formatResolvedIssuesSuffix(issueStatuses.length)}`,
        });
      });
    } catch (err) {
      failMerge(err, "Apply failed", "Apply failed unexpectedly");
    }
  }, [
    account,
    mergeability.applyResult,
    defaultBranchHead,
    defaultBranchName,
    targetIsDefaultBranch,
    gitPool,
    pr,
    patchChain,
    patchEventIds,
    issueAutoResolve,
    repo,
    beginMerge,
    createMergeTransports,
    resolveIssueScanObjects,
    runRepositoryStateTransition,
    failMerge,
    toast,
  ]);

  // ── PR merge orchestration ────────────────────────────────────────────────

  const handlePRMerge = useCallback(async () => {
    const mergeResult = prMergeability.result;
    const tipCommitId = pr.tip.commitId;
    if (
      !account ||
      !mergeResult ||
      !defaultBranchHead ||
      !gitPool ||
      !tipCommitId
    ) {
      return;
    }

    beginMerge();

    try {
      await runRepositoryStateTransition(async (stateSnapshot) => {
        const { transports, getPushSummary } = createMergeTransports(
          account.pubkey,
          stateSnapshot.winner,
        );
        const issueScanObjects = await resolveIssueScanObjects();

        const { mergeCommit, issueStatuses } = await performPRMerge({
          signer: account.signer,
          signerPubkey: account.pubkey,
          mergeCommitObj: mergeResult.mergeCommitObj,
          prTipCommitHash: tipCommitId,
          mergeBase: mergeResult.mergeBase,
          extraObjects: mergeResult.extraObjects,
          dTag: repo.dTag,
          defaultBranchName,
          defaultBranchHead,
          updateHead: targetIsDefaultBranch,
          currentStateEvent: stateSnapshot.winner,
          repoCoords: pr.repoCoords,
          rootEventId: pr.rootEvent.id,
          rootAuthorPubkey: pr.pubkey,
          issueScanObjects,
          issueAutoResolve,
          fetchBranchObjects: (tipCommitHash, stopAtCommitHash) => {
            // Use the branch pack prefetched while the page was idle when it
            // matches the exact range being pushed; otherwise fetch live.
            const pf = prefetched?.branchObjects;
            if (
              pf &&
              pf.tipCommitId === tipCommitHash &&
              pf.stopAtCommitId === stopAtCommitHash &&
              pf.objects
            ) {
              return Promise.resolve(pf.objects);
            }
            return fetchPRBranchObjectsWithTimeout(
              gitPool,
              tipCommitHash,
              stopAtCommitHash,
              effectiveCloneUrls,
            );
          },
          ...transports,
        });

        const summary = getPushSummary();
        toast({
          title: "PR merged",
          description: `Merge commit ${mergeCommit.hash.slice(0, 8)} pushed to ${defaultBranchName}.${summary ? ` ${summarizePushDelivery(summary)}` : ""}${formatResolvedIssuesSuffix(issueStatuses.length)}`,
        });
      });
    } catch (err) {
      failMerge(err, "Merge failed", "Merge failed unexpectedly");
    }
  }, [
    account,
    prMergeability.result,
    defaultBranchHead,
    defaultBranchName,
    targetIsDefaultBranch,
    gitPool,
    effectiveCloneUrls,
    pr,
    issueAutoResolve,
    repo,
    prefetched,
    beginMerge,
    createMergeTransports,
    resolveIssueScanObjects,
    runRepositoryStateTransition,
    failMerge,
    toast,
  ]);

  // ── Render ──────────────────────────────────────────────────────────────

  const isMerging =
    mergeStep !== "idle" && mergeStep !== "done" && mergeStep !== "failed";

  return (
    <Card className="border-border/60">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">
            <StatusIcon status={displayedStatus} mergeStep={mergeStep} />
          </div>

          <div className="flex-1 min-w-0 space-y-2">
            {/* Status headline */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <StatusHeadline
                  status={displayedStatus}
                  mergeStep={mergeStep}
                  mergeError={mergeError}
                  defaultBranchName={defaultBranchName}
                  behindCount={behindCount}
                  allHashesVerified={
                    mergeability.buildResult?.allHashesVerified ??
                    mergeability.applyResult?.allHashesVerified ??
                    false
                  }
                  isBaseGuessed={!!guessedBaseCommitId}
                  isPRType={isPRType}
                  openStackParent={openStackParent}
                />
              </div>

              {/* Action buttons / recheck */}
              <div className="shrink-0 flex items-center gap-2">
                {displayedStatus === "loading" && (
                  <span className="text-xs text-muted-foreground">
                    Checking...
                  </span>
                )}

                {detectingMergeCommit && !detectedMergeCommit && (
                  <span className="text-xs text-muted-foreground">
                    Checking recent history...
                  </span>
                )}

                {(mergeability.status === "error" ||
                  mergeability.status === "conflicts" ||
                  mergeStep === "failed") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setMergeStep("idle");
                      setMergeError(null);
                      setPushDelivery(null);
                      setStatePublishDelivery(null);
                      mergeability.recheck();
                    }}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Recheck
                  </Button>
                )}

                {canMarkDetectedMerged && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 bg-green-600 hover:bg-green-700 text-white"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                        Mark merged
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Mark this PR as merged?
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                          <div className="space-y-2 text-sm text-muted-foreground">
                            <p>
                              We found a recent ngit-style merge commit on{" "}
                              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                                {defaultBranchName}
                              </code>{" "}
                              that references this {isPRType ? "PR" : "patch"}.
                            </p>
                            <p>
                              This will not push git objects or change the
                              branch. It only publishes the missing merged
                              status event.
                            </p>
                            <p className="font-mono text-xs text-foreground">
                              {detectedMergeCommit.hash.slice(0, 8)} {" — "}
                              {detectedMergeCommit.subject || "merge commit"}
                            </p>
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleMarkDetectedMerged}
                          className="bg-green-600 hover:bg-green-700 text-white"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                          Publish merged status
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {mergeBlockedByStackParent && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-8 bg-muted text-muted-foreground hover:bg-muted"
                    disabled
                    aria-label={`Merge disabled until parent PR #${openStackParent.rootId.slice(0, 8)} lands`}
                  >
                    <GitMerge className="h-3.5 w-3.5 mr-1.5" />
                    Merge
                  </Button>
                )}

                {canMerge && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 bg-green-600 hover:bg-green-700 text-white"
                      >
                        <GitMerge className="h-3.5 w-3.5 mr-1.5" />
                        Merge
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Merge this {isPRType ? "PR" : "patch"}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          This will create a merge commit on{" "}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                            {defaultBranchName}
                          </code>{" "}
                          and push it to the Grasp server
                          {repo.graspCloneUrls.length > 1 ? "s" : ""}.
                          {behindCount !== undefined && behindCount > 0 && (
                            <>
                              {" "}
                              The target branch is{" "}
                              <strong>
                                {behindCount} commit
                                {behindCount !== 1 ? "s" : ""}
                              </strong>{" "}
                              ahead of the {isPRType ? "PR" : "patch"} base.
                              {isPRType && (
                                <>
                                  {" "}
                                  Consider updating the PR branch first to avoid
                                  an outdated merge tree.
                                </>
                              )}
                            </>
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={isPRType ? handlePRMerge : handleMerge}
                          className="bg-green-600 hover:bg-green-700 text-white"
                        >
                          <GitMerge className="h-3.5 w-3.5 mr-1.5" />
                          Confirm merge
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {canShowLocalMerge && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 border-muted-foreground/30 text-muted-foreground hover:text-foreground"
                        onClick={copyLocalMergeCommand}
                      >
                        <Terminal className="h-3.5 w-3.5 mr-1.5" />
                        Local merge only
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      Copy local merge command
                    </TooltipContent>
                  </Tooltip>
                )}

                {canApplyToTip && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 bg-amber-600 hover:bg-amber-700 text-white"
                      >
                        <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                        Apply to Tip
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Apply patches to tip?
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                          <div className="space-y-2 text-sm text-muted-foreground">
                            <p>
                              The patches could not be merged cleanly against
                              their original base, but they apply cleanly on top
                              of{" "}
                              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                                {defaultBranchName}
                              </code>
                              .
                            </p>
                            <p>
                              This will replay the patch commits directly on top
                              of the current branch tip (like{" "}
                              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                                git am
                              </code>
                              ), producing a linear history with no merge
                              commit. The original author and timestamps are
                              preserved; you will be recorded as the committer.
                            </p>
                            {mergeability.mergeStrategyError && (
                              <p className="text-amber-600 dark:text-amber-400 text-xs">
                                Merge strategy failed:{" "}
                                {mergeability.mergeStrategyError}
                              </p>
                            )}
                          </div>
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleApplyToTip}
                          className="bg-amber-600 hover:bg-amber-700 text-white"
                        >
                          <GitBranch className="h-3.5 w-3.5 mr-1.5" />
                          Confirm apply
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}

                {isMerging && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span className="text-xs">{STEP_LABELS[mergeStep]}</span>
                  </div>
                )}

                {mergeStep === "done" && (
                  <div className="flex items-center gap-1.5 text-sm text-green-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span className="text-xs font-medium">Done</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stale claimed merge-base explanation */}
            {mergeStep === "idle" &&
              !detectedMergeCommit &&
              mergeability.mergeBaseMismatch &&
              openStackParent !== undefined &&
              (openStackParent ? (
                <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <GitBranch className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <p>
                      <span className="font-medium text-foreground">
                        Stacked on open PR #{openStackParent.rootId.slice(0, 8)}
                        .
                      </span>{" "}
                      “{openStackParent.subject}” provides this PR's recorded
                      base. Merge that parent into {defaultBranchName} first;
                      this PR can be merged after it lands.
                    </p>
                  </div>
                </div>
              ) : mergedPRCommitMatch !== undefined && mergedPRCommitMatch ? (
                <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <p>
                      <span className="font-medium text-foreground">
                        Stack parent already merged.
                      </span>{" "}
                      This PR was opened before its stack parent “
                      {mergedPRCommitMatch.subject}” was merged, so this merge
                      uses Git's computed base.
                    </p>
                  </div>
                </div>
              ) : mergedPRCommitMatch !== undefined ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p>
                        <span className="font-medium">
                          Incorrect merge base in PR.
                        </span>{" "}
                        The PR's recorded{" "}
                        <code className="rounded bg-muted px-0.5 font-mono text-[10px]">
                          merge-base
                        </code>{" "}
                        does not match the common ancestor computed from git
                        history. The PR author's tooling likely miscalculated it
                        — treat the PR's metadata with caution.
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        claimed{" "}
                        {mergeability.mergeBaseMismatch.claimed.slice(0, 8)} ·
                        computed{" "}
                        {mergeability.mergeBaseMismatch.computed.slice(0, 8)}
                      </p>
                      <p>
                        This merge uses the computed base, so no commits will be
                        orphaned.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null)}

            {/* Already-merged detection hit its look-back cap */}
            {!detectedMergeCommit &&
              !detectingMergeCommit &&
              detectedMergeScanResult?.hitLimit &&
              mergeStep === "idle" && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <p>
                        <span className="font-medium">
                          Already-merged check stopped after{" "}
                          {detectedMergeScanResult.scannedCount} commits.
                        </span>{" "}
                        {detectionStopCommitId
                          ? "It did not reach the stated merge base, so this item may already be merged further back in history."
                          : "Older merges are possible but unlikely unless this repository has very high activity."}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 border-amber-500/40 px-2 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                          onClick={lookBackFurther}
                        >
                          Look back further
                        </Button>
                        <span className="text-[10px] text-muted-foreground">
                          Next scan checks up to{" "}
                          {detectedMergeScanResult.maxTotal + lookbackStep}{" "}
                          commits.
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            {/* Best-effort already-merged detection */}
            {detectedMergeCommit && mergeStep === "idle" && (
              <div className="rounded-md border border-green-600/30 bg-green-600/5 px-3 py-2 text-xs text-green-700 dark:text-green-400">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p>
                      <span className="font-medium">
                        This {isPRType ? "PR" : "patch"} appears to already be
                        merged.
                      </span>{" "}
                      We found a recent ngit-style merge commit on{" "}
                      <code className="rounded bg-muted px-0.5 font-mono text-[10px] text-foreground">
                        {defaultBranchName}
                      </code>
                      , but no merged status event is present yet.
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {detectedMergeCommit.hash.slice(0, 8)} {" — "}
                      {detectedMergeCommit.subject || "merge commit"}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* GRASP push delivery summary */}
            {(mergeStep === "done" || mergeStep === "failed") &&
              pushDelivery && (
                <PushDeliverySummaryView
                  summary={pushDelivery}
                  statePublishDelivery={statePublishDelivery}
                  repoIdentifier={repo.dTag}
                />
              )}

            {/* Local merge guidance for non-GRASP git servers */}
            {canShowLocalMerge && (
              <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm">
                <p className="text-muted-foreground">
                  {localMergeReason} To merge, run this from your local repo:
                </p>
                <button
                  type="button"
                  className="mt-2 block w-full rounded-md bg-background px-3 py-2 text-left font-mono text-xs text-foreground ring-1 ring-border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={copyLocalMergeCommand}
                >
                  {localMergeCommand}
                </button>
              </div>
            )}

            {/* Apply-to-tip warning banner */}
            {mergeability.status === "ready-apply-only" &&
              mergeability.mergeStrategyError && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <div>
                      <span className="font-medium">
                        Merge strategy unavailable.
                      </span>{" "}
                      Patches apply cleanly against the current tip but not
                      against the original base (
                      {mergeability.mergeStrategyError}
                      ). Applying will produce a linear history without a merge
                      commit.
                    </div>
                  </div>
                </div>
              )}

            {/* Conflict details */}
            {mergeability.status === "conflicts" &&
              mergeability.conflicts.length > 0 && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                  <p className="font-medium text-destructive mb-1">
                    Conflicting files:
                  </p>
                  <ul className="space-y-0.5">
                    {mergeability.conflicts.map((c, i) => (
                      <li
                        key={i}
                        className="font-mono text-xs text-muted-foreground"
                      >
                        {c.path}
                        <span className="text-destructive/70 ml-2">
                          — {c.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            {/* Error details */}
            {mergeStep === "failed" && mergeError && !pushDelivery && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <p role="alert">{mergeError}</p>
                {statePublishDelivery && (
                  <div className="mt-2 space-y-2 text-xs">
                    <p className="break-all text-muted-foreground">
                      State event: {statePublishDelivery.event.id}
                    </p>
                    <ul className="space-y-1">
                      {statePublishDelivery.responses.map((response) => (
                        <li key={response.from} className="break-words">
                          <span className="font-medium">{response.from}</span>
                          {": "}
                          {response.ok
                            ? "Accepted"
                            : response.failure === "timeout"
                              ? "Acknowledgment timed out"
                              : response.failure === "transport"
                                ? "No acknowledgment received"
                                : "Rejected by relay"}
                          {response.message && ` — ${response.message}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <ManualRetryAction
                  onRetry={() => {
                    setMergeStep("idle");
                    setMergeError(null);
                    mergeability.recheck();
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PushDeliverySummaryView({
  summary,
  statePublishDelivery,
  repoIdentifier,
}: {
  summary: PushDeliverySummary;
  statePublishDelivery: StatePublishDelivery | null;
  repoIdentifier: string;
}) {
  const failedEverywhere =
    summary.successCount === 0 && summary.pendingCount === 0;

  return (
    <div
      className={
        failedEverywhere
          ? "rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
          : "rounded-md border border-green-600/30 bg-green-600/5 px-3 py-2 text-sm"
      }
    >
      <div className="flex items-start gap-2">
        {failedEverywhere ? (
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-600" />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p
            className={
              failedEverywhere
                ? "font-medium text-destructive"
                : "font-medium text-green-700 dark:text-green-400"
            }
          >
            {failedEverywhere
              ? `Push failed on all ${summary.totalCount} Grasp server${summary.totalCount !== 1 ? "s" : ""}.`
              : summarizePushDelivery(summary)}
          </p>
          <ul className="space-y-1 text-xs">
            {summary.outcomes.map((outcome) => (
              <li
                key={outcome.cloneUrl}
                className="flex items-start gap-2 text-muted-foreground"
              >
                {outcome.pending ? (
                  <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                ) : outcome.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
                ) : (
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">
                    {formatCloneUrlHost(outcome.cloneUrl)}
                  </span>
                  {outcome.pending
                    ? ": still syncing"
                    : outcome.ok
                      ? `: ${outcome.message}`
                      : ": did not update"}
                  {!outcome.pending && !outcome.ok && (
                    <PushOutcomeDetails
                      outcome={outcome}
                      statePublishDelivery={statePublishDelivery}
                      repoIdentifier={repoIdentifier}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

type StateRelayCheck =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "complete";
      exact: RelaySnapshot;
      current: RelaySnapshot;
    };

function PushOutcomeDetails({
  outcome,
  statePublishDelivery,
  repoIdentifier,
}: {
  outcome: PushDeliveryOutcome;
  statePublishDelivery: StatePublishDelivery | null;
  repoIdentifier: string;
}) {
  const [relayCheck, setRelayCheck] = useState<StateRelayCheck>({
    status: "idle",
  });
  const serviceAddress = graspCloneUrlServiceAddress(outcome.cloneUrl);
  const publishResponse = serviceAddress
    ? statePublishDelivery?.responses.find((response) =>
        relayMatchesGraspService(response.from, [serviceAddress]),
      )
    : undefined;
  const relayUrl =
    publishResponse?.from ??
    (serviceAddress
      ? graspServiceAddressToRelayUrl(serviceAddress)
      : undefined);

  const checkStateRelay = useCallback(async () => {
    if (!relayUrl || !statePublishDelivery || relayCheck.status !== "idle") {
      return;
    }

    setRelayCheck({ status: "loading" });
    const [exact, current] = await Promise.all([
      requestRelaySnapshot(
        relayPool,
        relayUrl,
        [
          {
            ids: [statePublishDelivery.event.id],
            authors: [statePublishDelivery.event.pubkey],
          },
        ],
        5_000,
      ),
      requestRelaySnapshot(
        relayPool,
        relayUrl,
        [
          {
            kinds: [REPO_STATE_KIND],
            authors: [statePublishDelivery.event.pubkey],
            "#d": [repoIdentifier],
            limit: 1,
          },
        ],
        5_000,
      ),
    ]);
    setRelayCheck({ status: "complete", exact, current });
  }, [relayCheck.status, relayUrl, repoIdentifier, statePublishDelivery]);

  const acceptedIntoPurgatory =
    publishResponse?.ok === true &&
    /^purgatory:/i.test(publishResponse.message?.trim() ?? "");

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void checkStateRelay();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="ml-1 h-auto p-0 align-baseline text-xs"
          aria-label={`Show push details for ${formatCloneUrlHost(outcome.cloneUrl)}`}
        >
          Details
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-2rem)] max-w-sm space-y-3 text-xs"
      >
        <div>
          <p className="font-medium text-sm">Grasp push details</p>
          <p className="break-all text-muted-foreground">{outcome.cloneUrl}</p>
        </div>

        <div className="space-y-1">
          <p className="font-medium">State publication</p>
          {!statePublishDelivery ? (
            <p className="text-muted-foreground">
              No state publication result was recorded.
            </p>
          ) : !publishResponse ? (
            <p className="text-muted-foreground">
              No acknowledgement was recorded from this server&apos;s relay.
            </p>
          ) : publishResponse.ok ? (
            <>
              <p>
                {acceptedIntoPurgatory
                  ? "Accepted into purgatory."
                  : "Accepted without the standard purgatory response."}
              </p>
              {publishResponse.message && (
                <p className="break-words text-muted-foreground">
                  Relay response: {publishResponse.message}
                </p>
              )}
            </>
          ) : (
            <p className="break-words text-destructive">
              Rejected by relay
              {publishResponse.message ? `: ${publishResponse.message}` : "."}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <p className="font-medium">State relay check</p>
          <StateRelayCheckView
            check={relayCheck}
            stateEventId={statePublishDelivery?.event.id}
            acceptedIntoPurgatory={acceptedIntoPurgatory}
            publishAccepted={publishResponse?.ok}
            relayUrl={relayUrl}
          />
        </div>

        <div className="space-y-1">
          <p className="font-medium">Git push</p>
          {outcome.httpStatus && (
            <p>
              HTTP {outcome.httpStatus}
              {outcome.httpStatusText ? ` ${outcome.httpStatusText}` : ""}
            </p>
          )}
          <p className="break-words text-muted-foreground">{outcome.message}</p>
          {outcome.httpResponseBody && (
            <div className="space-y-1 pt-1">
              <p className="font-medium text-foreground">Server response</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                {outcome.httpResponseBody}
              </pre>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StateRelayCheckView({
  check,
  stateEventId,
  acceptedIntoPurgatory,
  publishAccepted,
  relayUrl,
}: {
  check: StateRelayCheck;
  stateEventId: string | undefined;
  acceptedIntoPurgatory: boolean;
  publishAccepted: boolean | undefined;
  relayUrl: string | undefined;
}) {
  if (!relayUrl || !stateEventId) {
    return (
      <p className="text-muted-foreground">
        The matching relay could not be determined.
      </p>
    );
  }

  if (check.status === "idle" || check.status === "loading") {
    return (
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking {relayUrl}…
      </p>
    );
  }

  const exactVisible = check.exact.events.some(
    (event) => event.id === stateEventId,
  );
  const currentEvent = check.current.events[0];
  const exactIsCurrent = currentEvent?.id === stateEventId;

  if (exactVisible) {
    return (
      <p
        className={
          acceptedIntoPurgatory
            ? "text-amber-700 dark:text-amber-400"
            : undefined
        }
      >
        {acceptedIntoPurgatory
          ? "The relay is broadcasting this event even though it reported that the event was in purgatory"
          : "The relay is broadcasting this state event"}
        {exactIsCurrent
          ? " as the current repository state."
          : currentEvent
            ? `, but its current state is ${currentEvent.id.slice(0, 8)}.`
            : "."}
      </p>
    );
  }

  if (!check.exact.complete || !check.current.complete) {
    return (
      <p className="text-muted-foreground">
        The relay check did not complete, so its state is unknown.
      </p>
    );
  }

  if (acceptedIntoPurgatory) {
    return (
      <p className="text-muted-foreground">
        The event is not being broadcast, which is expected while it remains in
        purgatory.
      </p>
    );
  }

  if (publishAccepted !== true) {
    return (
      <p className="text-muted-foreground">
        The state event is not being broadcast by this relay.
      </p>
    );
  }

  return (
    <p className="text-amber-700 dark:text-amber-400">
      The relay accepted the event but is not broadcasting it
      {currentEvent
        ? `; its current state is ${currentEvent.id.slice(0, 8)}.`
        : "."}
    </p>
  );
}

function StatusIcon({
  status,
  mergeStep,
}: {
  status: MergePanelStatus;
  mergeStep: MergeStep;
}) {
  if (mergeStep === "done") {
    return <CheckCircle2 className="h-5 w-5 text-green-600" />;
  }
  if (mergeStep !== "idle" && mergeStep !== "failed") {
    return <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />;
  }
  if (mergeStep === "failed") {
    return <XCircle className="h-5 w-5 text-destructive" />;
  }

  switch (status) {
    case "loading":
      return <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />;
    case "ready":
    case "already-merged":
    case "detected-merged":
      return <CheckCircle2 className="h-5 w-5 text-green-600" />;
    case "waiting-for-stack-parent":
      return <GitMerge className="h-5 w-5 text-muted-foreground" />;
    case "ready-apply-only":
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    case "conflicts":
      return <XCircle className="h-5 w-5 text-destructive" />;
    case "error":
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    default:
      return <GitMerge className="h-5 w-5 text-muted-foreground" />;
  }
}

function StatusHeadline({
  status,
  mergeStep,
  mergeError,
  defaultBranchName,
  behindCount,
  allHashesVerified,
  isBaseGuessed,
  isPRType,
  openStackParent,
}: {
  status: MergePanelStatus;
  mergeStep: MergeStep;
  mergeError: string | null;
  defaultBranchName: string;
  behindCount: number | undefined;
  allHashesVerified: boolean;
  isBaseGuessed: boolean;
  isPRType: boolean;
  openStackParent: InferredPRParent | null | undefined;
}) {
  if (mergeStep === "done") {
    return (
      <p className="text-sm font-medium text-green-600">
        {isPRType ? "PR" : "Patch"} merged into{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {defaultBranchName}
        </code>
      </p>
    );
  }

  if (mergeStep === "failed") {
    return <p className="text-sm font-medium text-destructive">Failed</p>;
  }

  if (mergeStep !== "idle") {
    return (
      <p className="text-sm text-muted-foreground">{STEP_LABELS[mergeStep]}</p>
    );
  }

  switch (status) {
    case "loading":
      return (
        <p className="text-sm text-muted-foreground">
          Checking if this {isPRType ? "PR" : "patch"} can be merged into{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            {defaultBranchName}
          </code>
          ...
        </p>
      );
    case "ready":
      return (
        <div>
          <p className="text-sm font-medium text-green-600">
            Ready to merge into{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {defaultBranchName}
            </code>
          </p>
          {behindCount !== undefined && behindCount > 0 && (
            <p className="text-xs text-amber-600 mt-0.5">
              {isPRType
                ? `Target branch is ${behindCount} commit${behindCount !== 1 ? "s" : ""} ahead of the PR base. Consider updating the PR branch first.`
                : `Target branch is ${behindCount} commit${behindCount !== 1 ? "s" : ""} ahead of the patch base, but patches apply cleanly.`}
            </p>
          )}
          {!isPRType && isBaseGuessed && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              Merge base approximated from patch timestamp (no{" "}
              <code className="rounded bg-muted px-0.5 font-mono text-[10px]">
                parent-commit
              </code>{" "}
              tag).
            </p>
          )}
          {!isPRType && !allHashesVerified && (
            <p className="text-xs text-amber-600 mt-0.5">
              Diffs applied correctly. Tooling produced commit ID mismatch but
              for cosmetic reasons only (GPG signatures, whitespace, timezone
              encoding).
            </p>
          )}
        </div>
      );
    case "waiting-for-stack-parent":
      return (
        <div>
          <p className="text-sm font-medium text-foreground">
            Not ready to merge
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Waiting for stack parent PR #{openStackParent?.rootId.slice(0, 8)}{" "}
            to land on{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {defaultBranchName}
            </code>{" "}
            first.
          </p>
        </div>
      );
    case "detected-merged":
      return (
        <div>
          <p className="text-sm font-medium text-green-600">
            Detected already merged into{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {defaultBranchName}
            </code>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Publish the missing merged status event to update this PR.
          </p>
        </div>
      );
    case "already-merged":
      return (
        <div>
          <p className="text-sm font-medium text-green-600">
            PR tip is already reachable from{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {defaultBranchName}
            </code>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The PR tip is in the branch history; checking for a missing merged
            status event.
          </p>
        </div>
      );
    case "ready-apply-only":
      return (
        <p className="text-sm font-medium text-amber-600 dark:text-amber-500">
          Patches apply cleanly to tip of{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {defaultBranchName}
          </code>
        </p>
      );
    case "conflicts":
      return (
        <p className="text-sm font-medium text-destructive">
          This patch has conflicts with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {defaultBranchName}
          </code>
        </p>
      );
    case "error":
      return (
        <div>
          <p className="text-sm text-amber-600">
            Could not determine mergeability
            {mergeError ? `: ${mergeError}` : ""}
          </p>
          {isBaseGuessed && (
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              Merge base was approximated from patch timestamp — it may be
              incorrect.
            </p>
          )}
        </div>
      );
    default:
      return (
        <p className="text-sm text-muted-foreground">
          Merge status unavailable
        </p>
      );
  }
}
