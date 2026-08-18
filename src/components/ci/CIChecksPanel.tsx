/**
 * CIChecksPanel — GitHub-style checks box for a PR / patch detail page.
 *
 * Displays ngit-ci workflow runs (kinds 9841/9842): a summary header, one
 * expandable row per workflow attempt for the current tip commit, and a
 * collapsed section for runs against superseded commits.
 *
 * No trust filtering is applied — the signing runner identity is shown on
 * every row so users can judge results for themselves. When the caller
 * supplies a trust context (resolved repo plus settled evidence),
 * rows additionally carry the same settled trust-context labels and
 * repository-attribution warnings as the repo Actions tab.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { nip19, type NostrEvent } from "nostr-tools";
import { formatDistanceToNow } from "date-fns";
import { EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  Loader2,
  RotateCcw,
  Tag,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { UserLink } from "@/components/UserAvatar";
import { EventCardActions } from "@/components/EventCardActions";
import { CIStatusIcon } from "./CIStatusIcon";
import { cn } from "@/lib/utils";
import {
  ciStatusLabel,
  formatCIDuration,
  summarizeRuns,
  workflowRunRepoCoords,
  type CIJobResult,
  type CIWorkflowRun,
} from "@/lib/ci";
import {
  getCIJobTrustResolution,
  getCIRunTrustResolution,
  type CITrustContextState,
  type CITrustResolution,
} from "@/lib/ciTrustContext";
import { hasAcceptedRepositoryReference, type ResolvedRepo } from "@/lib/nip34";
import { findNsitePreview, parsePublicOutputUrl } from "@/lib/ciOutputs";
import { NsitePreviewLink } from "./PRNsitePreview";
import type { CIServiceControl } from "@/casts/CICoordinator";
import { RepoItemAttributionIndicator } from "@/components/RepoItemAttributionWarning";
import { CITrustContextLabel } from "./CITrustContextLabel";
import type { CIRun } from "@/casts/CIRun";
import type {
  CIManualTriggerRef,
  CIServiceRequestRef,
} from "@/casts/CIContext";
import type { PRCIChecks } from "@/hooks/useCI";
import { runner } from "@/services/actions";
import { TriggerManualCI } from "@/actions/nip34";
import { useToast } from "@/hooks/useToast";
import { Button } from "@/components/ui/button";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { resilientRequest } from "@/lib/resilientSubscription";
import { CI_MANUAL_TRIGGER_KIND, CI_SERVICE_REQUEST_KIND } from "@/lib/ci";
import { pool } from "@/services/nostr";
import { mapEventsToStore } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import { CICoordinatorLink } from "./CICoordinatorLink";

/**
 * Repository trust inputs for per-run warnings. `repo` alone enables the
 * attribution warning; trust evidence and service controls additionally
 * enable the shared classification labels.
 */
export interface CIRunTrustContext {
  repo: ResolvedRepo;
  trust: CITrustContextState;
  serviceControls?: readonly CIServiceControl[];
}

interface CIChecksPanelProps {
  checks: PRCIChecks;
  /** Whether the active account is a confirmed repository maintainer. */
  canRetry?: boolean;
  /** When provided, rows show coordinator-trust and attribution warnings. */
  trustContext?: CIRunTrustContext;
  className?: string;
}

const LOG_TAIL_PREFIX_RE = /^\[log-tail omitted=(\d+)\]\n/;

function parseLogTail(content: string): {
  log: string;
  omittedBytes: number | undefined;
} {
  const match = LOG_TAIL_PREFIX_RE.exec(content);
  if (!match) return { log: content, omittedBytes: undefined };

  const omittedBytes = Number.parseInt(match[1], 10);
  return {
    log: content.slice(match[0].length),
    omittedBytes: Number.isFinite(omittedBytes) ? omittedBytes : undefined,
  };
}

function formatPendingRunStatus(run: CIRun, nowSeconds: number): string {
  if (run.progressStatus === "queued") {
    const queuedAt = run.queuedAt ?? run.event.created_at;
    const queuePosition =
      run.queueRounds === undefined
        ? ""
        : ` (queue position ${run.queueRounds})`;
    return `queued ${formatDistanceToNow(new Date(queuedAt * 1000), { addSuffix: true })}${queuePosition}`;
  }

  const startedAt = run.startedAt ?? run.queuedAt ?? run.event.created_at;
  const duration = formatCIDuration(nowSeconds - startedAt);
  return duration
    ? `running for ${duration}`
    : `started ${formatDistanceToNow(new Date(startedAt * 1000), { addSuffix: true })}`;
}

/**
 * Keeps pending CI durations accurate without polling completed workflow rows.
 */
function useCurrentUnixSeconds(enabled: boolean): number {
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    if (!enabled) return;

    const tick = () => setNowSeconds(Math.floor(Date.now() / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  return nowSeconds;
}

interface WorkflowTiming {
  queuedAt: number | undefined;
  startedAt: number | undefined;
  completedAt: number | undefined;
  queuePosition: number | undefined;
}

function getWorkflowTiming(run: CIWorkflowRun): WorkflowTiming {
  const earliestJobTimestamp = (
    key: "queuedAt" | "startedAt",
  ): number | undefined =>
    run.jobs.reduce<number | undefined>((earliest, { result }) => {
      const timestamp = result[key];
      return timestamp === undefined
        ? earliest
        : Math.min(earliest ?? timestamp, timestamp);
    }, undefined);
  const latestJobCompletionAt = run.jobs.reduce<number | undefined>(
    (latest, { result }) =>
      latest === undefined
        ? result.event.created_at
        : Math.max(latest, result.event.created_at),
    undefined,
  );

  return {
    queuedAt:
      run.pendingRun?.queuedAt ??
      run.workflowResult?.queuedAt ??
      earliestJobTimestamp("queuedAt"),
    startedAt:
      run.pendingRun?.startedAt ??
      run.workflowResult?.startedAt ??
      earliestJobTimestamp("startedAt"),
    completedAt: run.pendingRun
      ? undefined
      : (run.workflowResult?.event.created_at ?? latestJobCompletionAt),
    queuePosition: run.pendingRun?.queueRounds,
  };
}

function formatCompletedRunStatus(run: CIWorkflowRun): string {
  const status = ciStatusLabel(run.status).toLowerCase();
  const { startedAt, completedAt } = getWorkflowTiming(run);
  const isFailure =
    run.status === "failure" ||
    run.status === "timed_out" ||
    run.status === "startup_failure";

  if (isFailure) {
    const duration = formatCIDuration(
      startedAt === undefined || completedAt === undefined
        ? undefined
        : completedAt - startedAt,
    );
    if (duration) {
      return `${status} · ${duration} · ${formatDistanceToNow(new Date(run.createdAt * 1000), { addSuffix: true })}`;
    }
  }

  return `${status} ${formatDistanceToNow(new Date(run.createdAt * 1000), { addSuffix: true })}`;
}

function TimingPhase({
  label,
  detail,
  className,
}: {
  label: string;
  detail: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "shrink-0 rounded-md bg-muted/50 px-2 py-1 text-center",
        className,
      )}
    >
      <div className="font-medium leading-tight text-foreground">{label}</div>
      <div className="text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

/** Load the exact maintainer request quoted by a workflow container. */
function useRequestProvenanceEvent(
  manualTriggerRef: CIManualTriggerRef | undefined,
  serviceRequestRef: CIServiceRequestRef | undefined,
): NostrEvent | undefined {
  const store = useEventStore();
  const requestRef = manualTriggerRef ?? serviceRequestRef;
  const eventId = requestRef?.eventId;
  const relay = requestRef?.relay;
  const pubkey = requestRef?.pubkey;
  const kind = manualTriggerRef
    ? CI_MANUAL_TRIGGER_KIND
    : CI_SERVICE_REQUEST_KIND;

  use$(() => {
    if (!eventId || !relay || !pubkey) return undefined;
    return resilientRequest(
      pool,
      [relay],
      [
        {
          ids: [eventId],
          kinds: [kind],
          authors: [pubkey],
        },
      ],
    ).pipe(
      onlyEvents(),
      mapEventsToStore(store),
      catchError(() => EMPTY),
    );
  }, [eventId, kind, pubkey, relay, store]);

  return use$(
    () =>
      eventId
        ? (store.event(eventId) as import("rxjs").Observable<
            NostrEvent | undefined
          >)
        : undefined,
    [eventId, store],
  );
}

function TimingConnector({ duration }: { duration: string | null }) {
  return (
    <div className="relative hidden w-20 shrink-0 items-center justify-center self-stretch sm:flex">
      <div className="absolute inset-x-0 top-1/2 border-t border-border" />
      {duration && (
        <span className="relative bg-card px-1 text-[10px] text-muted-foreground">
          {duration}
        </span>
      )}
    </div>
  );
}

function WorkflowConclusion({ run }: { run: CIWorkflowRun }) {
  const className =
    run.status === "success"
      ? "bg-emerald-500/10 text-emerald-500"
      : run.status === "failure" ||
          run.status === "timed_out" ||
          run.status === "startup_failure"
        ? "bg-red-500/10 text-red-500"
        : run.status === "pending"
          ? "bg-amber-500/10 text-amber-500"
          : "bg-muted/50 text-muted-foreground";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1",
        className,
      )}
    >
      <CIStatusIcon status={run.status} className="h-4 w-4" />
      <span className="text-sm font-medium">{ciStatusLabel(run.status)}</span>
    </div>
  );
}

function WorkflowTimingDetails({
  run,
  nowSeconds,
  canRetry = false,
}: {
  run: CIWorkflowRun;
  nowSeconds: number;
  canRetry?: boolean;
}) {
  const { queuedAt, startedAt, completedAt, queuePosition } =
    getWorkflowTiming(run);
  const hasQueuePhase =
    queuedAt !== undefined &&
    (startedAt === undefined || queuedAt !== startedAt);
  const queueDuration = formatCIDuration(
    !hasQueuePhase || startedAt === undefined
      ? undefined
      : startedAt - queuedAt,
  );
  const executionEnd = completedAt ?? nowSeconds;
  const executionDuration = formatCIDuration(
    startedAt === undefined ? undefined : executionEnd - startedAt,
  );
  const manualTriggerRef =
    run.workflowResult?.manualTriggerRef ?? run.pendingRun?.manualTriggerRef;
  const serviceRequestRef =
    run.workflowResult?.serviceRequestRef ?? run.pendingRun?.serviceRequestRef;
  const requestEvent = useRequestProvenanceEvent(
    manualTriggerRef,
    serviceRequestRef,
  );
  const requestDuration = formatCIDuration(
    requestEvent
      ? (queuedAt ?? startedAt ?? requestEvent.created_at) -
          requestEvent.created_at
      : undefined,
  );

  if (
    queuedAt === undefined &&
    startedAt === undefined &&
    executionDuration === null &&
    !requestEvent &&
    !canRetry
  ) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 py-1 text-xs">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {requestEvent && (
          <>
            <TimingPhase
              label={manualTriggerRef ? "Manual replay" : "Service requested"}
              className="px-3 py-1.5"
              detail={
                <span className="flex flex-col items-center">
                  <UserLink
                    pubkey={requestEvent.pubkey}
                    avatarSize="xs"
                    nameClassName="max-w-20 truncate text-[11px]"
                  />
                  <span>
                    {formatDistanceToNow(
                      new Date(requestEvent.created_at * 1000),
                      { addSuffix: true },
                    )}
                  </span>
                </span>
              }
            />
            {(hasQueuePhase || startedAt !== undefined) && (
              <TimingConnector duration={requestDuration} />
            )}
          </>
        )}
        {hasQueuePhase && queuedAt !== undefined && (
          <TimingPhase
            label="Queued"
            detail={`${formatDistanceToNow(new Date(queuedAt * 1000), { addSuffix: true })}${queuePosition === undefined ? "" : ` (position ${queuePosition})`}`}
          />
        )}
        {hasQueuePhase && startedAt !== undefined && (
          <TimingConnector duration={queueDuration} />
        )}
        {startedAt !== undefined && (
          <TimingPhase
            label="Started"
            detail={formatDistanceToNow(new Date(startedAt * 1000), {
              addSuffix: true,
            })}
          />
        )}
        {startedAt !== undefined && (
          <TimingConnector duration={executionDuration} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <WorkflowConclusion run={run} />
        {canRetry && run.workflowResult && (
          <ManualRetryButton workflowResult={run.workflowResult.event} />
        )}
      </div>
    </div>
  );
}

/** A compact branch or tag badge for the git ref that caused a CI run. */
export function CITriggerRefBadge({
  triggerRef,
  className,
}: {
  triggerRef: string | undefined;
  className?: string;
}) {
  if (!triggerRef) return undefined;

  const isBranch = triggerRef.startsWith("refs/heads/");
  const isTag = triggerRef.startsWith("refs/tags/");
  if (!isBranch && !isTag) return undefined;

  const name = triggerRef.slice(
    isBranch ? "refs/heads/".length : "refs/tags/".length,
  );
  const Icon = isBranch ? GitBranch : Tag;

  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 max-w-40 gap-1 px-1.5 text-[10px] font-normal",
        className,
      )}
      aria-label={`${isBranch ? "Branch" : "Tag"}: ${name}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </Badge>
  );
}

export function CIChecksPanel({
  checks,
  canRetry = false,
  trustContext,
  className,
}: CIChecksPanelProps) {
  const { currentRuns, olderRuns } = checks;
  if (checks.runs.length === 0) return null;

  return (
    <Card className={className}>
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          {checks.status && (
            <CIStatusIcon status={checks.status} className="h-5 w-5" />
          )}
          <span className="text-sm font-medium">Checks</span>
          {currentRuns.length > 0 && (
            <span className="text-xs text-muted-foreground truncate">
              {summarizeRuns(currentRuns)}
            </span>
          )}
        </div>

        {/* Runs for the current tip commit */}
        {currentRuns.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">
            No checks for the latest commit yet.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {currentRuns.map((run) => (
              <TrustAwareRunRow
                key={run.key}
                run={run}
                canRetry={canRetry}
                trustContext={trustContext}
                defaultOpen={
                  currentRuns.length === 1 &&
                  (run.status === "failure" ||
                    run.status === "timed_out" ||
                    run.status === "startup_failure")
                }
              />
            ))}
          </ul>
        )}

        {/* Runs for superseded commits — collapsed by default */}
        {olderRuns.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-2 border-t border-border/60 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/40 transition-colors">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
              Checks for previous commits ({olderRuns.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y divide-border/60 border-t border-border/60 opacity-80">
                {olderRuns.map((run) => (
                  <TrustAwareRunRow
                    key={run.key}
                    run={run}
                    canRetry={canRetry}
                    trustContext={trustContext}
                  />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

const EMPTY_SERVICE_CONTROLS: readonly CIServiceControl[] = [];

/**
 * CIRunRow plus the per-run trust decorations derived from a trust context —
 * mirrors how the repo Actions tab decorates its rows.
 */
function TrustAwareRunRow({
  run,
  canRetry,
  trustContext,
  defaultOpen,
}: {
  run: CIWorkflowRun;
  canRetry: boolean;
  trustContext: CIRunTrustContext | undefined;
  defaultOpen?: boolean;
}) {
  if (!trustContext) {
    return <CIRunRow run={run} canRetry={canRetry} defaultOpen={defaultOpen} />;
  }

  const { repo, trust, serviceControls } = trustContext;
  const repoCoords = workflowRunRepoCoords(run);
  const needsAttributionCheck = !hasAcceptedRepositoryReference(
    repoCoords,
    repo,
  );

  return (
    <CIRunRow
      run={run}
      canRetry={canRetry}
      defaultOpen={defaultOpen}
      maintainerRequestedOverride={false}
      trustIndicator={
        <CITrustContextLabel
          resolution={getCIRunTrustResolution(
            trust,
            run,
            repo.confirmedMaintainers,
            serviceControls ?? EMPTY_SERVICE_CONTROLS,
          )}
          visibility="exceptions-only"
        />
      }
      providerTrust={trust}
      attributionIndicator={
        needsAttributionCheck ? (
          <RepoItemAttributionIndicator
            repo={repo}
            repoCoords={repoCoords}
            itemLabel="workflow"
            pageSuffix="/actions"
          />
        ) : undefined
      }
    />
  );
}

export function CIRunRow({
  run,
  defaultOpen = false,
  canRetry = false,
  triggerContext,
  attributionIndicator,
  trustIndicator,
  maintainerRequestedOverride,
  providerTrust,
}: {
  run: CIWorkflowRun;
  defaultOpen?: boolean;
  /** Whether the active account is a confirmed repository maintainer. */
  canRetry?: boolean;
  /**
   * Optional trigger context element (branch name, PR link) shown on the
   * right of the row — used by the repo Actions tab.
   */
  triggerContext?: ReactNode;
  /** Optional repository-attribution warning shown at the right edge. */
  attributionIndicator?: ReactNode;
  /** Optional interactive trust indicator shown outside the row trigger. */
  trustIndicator?: ReactNode;
  /** Override quote-only provenance detection when the caller validated it. */
  maintainerRequestedOverride?: boolean;
  /** Settled identity context used for provider labels inside expanded jobs. */
  providerTrust?: CITrustContextState;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const nowSeconds = useCurrentUnixSeconds(run.status === "pending");

  const pendingStatus = run.pendingRun
    ? formatPendingRunStatus(run.pendingRun, nowSeconds)
    : undefined;
  const status =
    run.status === "pending" ? pendingStatus : formatCompletedRunStatus(run);
  const compactStatus =
    run.status === "pending"
      ? pendingStatus
      : formatDistanceToNow(new Date(run.createdAt * 1000), {
          addSuffix: true,
        });
  const primaryEvent =
    run.workflowResult?.event ??
    run.pendingRun?.event ??
    run.jobs[0]?.result.event;
  const maintainerRequested =
    maintainerRequestedOverride ??
    !!(
      run.workflowResult?.manualTriggerRef ||
      run.pendingRun?.manualTriggerRef ||
      run.workflowResult?.serviceRequestRef ||
      run.pendingRun?.serviceRequestRef
    );
  const nsitePreview = findNsitePreview([run]);

  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-4 py-2.5 sm:flex">
          {/* Trigger area — UserLink stays outside to avoid nested anchors */}
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <CIStatusIcon status={run.status} />
            <span className="truncate font-mono text-xs">
              {run.workflowPath ?? "(workflow)"}
            </span>
            {run.trigger && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {run.trigger}
              </span>
            )}
            {maintainerRequested && (
              <Badge
                variant="outline"
                className="inline-flex h-5 shrink-0 border-border bg-muted/60 px-1.5 text-[10px] font-normal text-foreground"
              >
                <span className="hidden lg:inline">Maintainer requested</span>
                <span className="lg:hidden">Requested</span>
              </Badge>
            )}
            <CITriggerRefBadge
              triggerRef={run.branchRef}
              className="hidden shrink-0 lg:inline-flex"
            />
            {run.commitId && (
              <code className="hidden shrink-0 font-mono text-[10px] text-muted-foreground lg:inline">
                {run.commitId.slice(0, 7)}
              </code>
            )}
          </CollapsibleTrigger>

          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {trustIndicator}
            {nsitePreview && (
              <NsitePreviewLink
                preview={nsitePreview}
                className="shrink-0 text-[11px]"
              >
                nsite preview
              </NsitePreviewLink>
            )}
            <span className="hidden xl:contents">{triggerContext}</span>
            <span className="hidden shrink-0 sm:inline lg:hidden">
              {compactStatus}
            </span>
            <span className="hidden shrink-0 lg:inline">{status}</span>
            <CICoordinatorLink
              pubkey={run.pubkey}
              avatarSize="xs"
              nameClassName="hidden max-w-24 truncate text-xs font-normal text-muted-foreground xl:block"
            />
            {primaryEvent && <EventCardActions event={primaryEvent} />}
            {attributionIndicator}
          </div>

          <span className="col-span-2 pl-10 text-[11px] text-muted-foreground sm:hidden">
            {compactStatus}
          </span>
        </div>

        <CollapsibleContent>
          <div className="space-y-2 px-3 pb-3 sm:pl-10 sm:pr-4">
            <WorkflowTimingDetails
              run={run}
              nowSeconds={nowSeconds}
              canRetry={
                canRetry && !!run.workflowResult && run.status !== "pending"
              }
            />
            {(run.runner || run.platform) && (
              <div className="text-[11px] text-muted-foreground">
                {[run.runner, run.platform].filter(Boolean).join(" · ")}
              </div>
            )}
            {run.pendingRun && (
              <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <CIStatusIcon status="pending" className="h-3.5 w-3.5" />
                Workflow {formatPendingRunStatus(run.pendingRun, nowSeconds)}
                <EventCardActions event={run.pendingRun.event} />
              </div>
            )}
            {run.jobs.map((job) => (
              <CIJobRow
                key={job.jobId}
                job={job}
                trustResolution={
                  providerTrust
                    ? getCIJobTrustResolution(providerTrust, run, job)
                    : undefined
                }
              />
            ))}
            {run.inProgressJobs.map((jobId) => (
              <div
                key={`progress-${jobId}`}
                className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >
                <CIStatusIcon status="pending" className="h-3.5 w-3.5" />
                <span className="truncate font-mono">{jobId}</span>
                <span className="ml-auto shrink-0">in progress</span>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function ManualRetryButton({ workflowResult }: { workflowResult: NostrEvent }) {
  const { toast } = useToast();
  const [isRetrying, setIsRetrying] = useState(false);

  const retry = useCallback(async () => {
    setIsRetrying(true);
    try {
      await runner.run(TriggerManualCI, workflowResult);
      toast({
        title: "Workflow retry requested",
        description:
          "The CI coordinator has been asked to run this workflow again.",
      });
    } catch (error) {
      toast({
        title: "Failed to request workflow retry",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsRetrying(false);
    }
  }, [toast, workflowResult]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      disabled={isRetrying}
      onClick={retry}
    >
      {isRetrying ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      Retry workflow
    </Button>
  );
}

function CIJobRow({
  job,
  trustResolution,
}: {
  job: CIJobResult;
  trustResolution?: CITrustResolution;
}) {
  const [showLog, setShowLog] = useState(false);
  const { result } = job;
  const hasLog = result.log.trim().length > 0;
  const duration = formatCIDuration(result.duration);
  const hasResultMetadata =
    result.outputs.length > 0 || result.omittedOutputs.length > 0;

  return (
    <div className="rounded-md border border-border/60">
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <CIStatusIcon status={job.status} className="h-3.5 w-3.5" />
        <span className="truncate font-mono">{result.name ?? job.jobId}</span>
        {result.exitCode !== undefined && result.exitCode !== 0 && (
          <span className="shrink-0 text-red-500">exit {result.exitCode}</span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {duration}
        </span>
        {hasLog && (
          <button
            type="button"
            onClick={() => setShowLog((s) => !s)}
            className="shrink-0 text-muted-foreground hover:text-foreground hover:underline transition-colors"
          >
            {showLog ? "Hide log" : "Show log"}
          </button>
        )}
        {result.logUrl && (
          <a
            href={result.logUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Open full log"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <EventCardActions event={result.event} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          Executed by
          <UserLink
            pubkey={result.pubkey}
            avatarSize="xs"
            nameClassName="max-w-28 truncate text-[11px]"
            profilePath={`/provider/${nip19.npubEncode(result.pubkey)}`}
          />
          {trustResolution && (
            <CITrustContextLabel
              resolution={trustResolution}
              visibility="exceptions-only"
            />
          )}
        </span>
        {result.allocationRef?.coordinatorPubkey && (
          <span className="flex items-center gap-1.5">
            allocated by
            <CICoordinatorLink
              pubkey={result.allocationRef.coordinatorPubkey}
              avatarSize="xs"
              nameClassName="max-w-28 truncate text-[11px]"
            />
          </span>
        )}
        {result.runsOn.length > 0 && (
          <span className="font-mono">{result.runsOn.join(" · ")}</span>
        )}
      </div>
      {result.artifacts.length > 0 && (
        <div className="border-t border-border/60 px-3 py-2">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-[46%] pb-1 font-medium sm:w-[42%]">
                  Artifact
                </th>
                <th className="w-[40%] pb-1 font-medium sm:w-[28%]">Name</th>
                <th className="w-[14%] pb-1 font-medium sm:w-[30%]">
                  <span className="sm:hidden">Hash</span>
                  <span className="hidden sm:inline">SHA-256</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.artifacts.map((artifact, index) => (
                <CIArtifactRow
                  key={`${artifact.url}-${artifact.filename ?? index}`}
                  url={artifact.url}
                  filename={artifact.filename}
                  artifactName={artifact.name}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasResultMetadata && (
        <div className="border-t border-border/60 px-3 py-2 text-xs">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Public outputs
          </p>
          <dl className="space-y-1.5">
            {result.outputs.map((output) => (
              <div
                key={output.name}
                className="grid gap-1 sm:grid-cols-[minmax(8rem,0.35fr)_minmax(0,1fr)]"
              >
                <dt className="font-mono font-medium">{output.name}</dt>
                <dd className="min-w-0 break-all font-mono text-muted-foreground">
                  {(() => {
                    if (!output.value)
                      return <span className="italic">empty string</span>;
                    const url = parsePublicOutputUrl(output.value);
                    return url ? (
                      <a
                        href={url.toString()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-start gap-1 text-foreground underline-offset-2 hover:text-pink-600 hover:underline dark:hover:text-pink-400"
                      >
                        <span>{output.value}</span>
                        <ExternalLink
                          className="mt-0.5 h-3 w-3 shrink-0"
                          aria-hidden="true"
                        />
                      </a>
                    ) : (
                      output.value
                    );
                  })()}
                </dd>
              </div>
            ))}
            {result.omittedOutputs.map((output) => (
              <div
                key={output.name}
                className="grid gap-1 sm:grid-cols-[minmax(8rem,0.35fr)_minmax(0,1fr)]"
              >
                <dt className="font-mono font-medium">{output.name}</dt>
                <dd className="text-muted-foreground">
                  unavailable ({output.reason})
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {hasLog && showLog && (
        <CILogViewer log={result.log} logUrl={result.logUrl} />
      )}
    </div>
  );
}

const BLOSSOM_HASH_PATH_RE = /^\/([a-f0-9]{64})\b/i;

function getBlossomHash(url: string): string | undefined {
  try {
    return BLOSSOM_HASH_PATH_RE.exec(new URL(url).pathname)?.[1];
  } catch {
    return undefined;
  }
}

function CIArtifactRow({
  url,
  filename,
  artifactName,
}: {
  url: string;
  filename: string | undefined;
  artifactName: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const hash = getBlossomHash(url);

  const copyHash = useCallback(async () => {
    if (!hash) return;

    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be unavailable in insecure browser contexts.
    }
  }, [hash]);

  return (
    <tr className="border-t border-border/40 align-middle first:border-t-0">
      <td className="min-w-0 py-1.5 pr-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-pink-600 underline-offset-2 hover:text-pink-700 hover:underline dark:text-pink-400 dark:hover:text-pink-300"
          title={`Download ${filename ?? "artifact"}`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{filename ?? "Download artifact"}</span>
        </a>
      </td>
      <td
        className="truncate py-1.5 pr-2 text-muted-foreground"
        title={artifactName}
      >
        {artifactName ?? "—"}
      </td>
      <td className="py-1.5">
        {hash ? (
          <button
            type="button"
            onClick={copyHash}
            className="group flex max-w-full items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title={copied ? "Copied!" : `Copy sha256:${hash}`}
            aria-label={copied ? "Artifact hash copied" : "Copy artifact hash"}
          >
            <span className="hidden truncate sm:inline">
              sha256:{hash.slice(0, 12)}
            </span>
            {copied ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0 text-foreground/70 group-hover:text-foreground" />
            )}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function CILogViewer({
  log,
  logUrl,
}: {
  log: string;
  logUrl: string | undefined;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const logContentRef = useRef<HTMLPreElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const didInitialPositionRef = useRef(false);
  const restoreDistanceFromBottomRef = useRef<number | null>(null);

  const parsed = useMemo(() => parseLogTail(log), [log]);
  const [fullLog, setFullLog] = useState<string | undefined>(undefined);
  const [isLoadingFullLog, setIsLoadingFullLog] = useState(false);
  const [fullLogError, setFullLogError] = useState<string | undefined>(
    undefined,
  );

  const visibleLog = fullLog ?? parsed.log;
  const isTailOnly = parsed.omittedBytes !== undefined && fullLog === undefined;
  const hasFullLogNotice =
    isTailOnly || isLoadingFullLog || fullLogError !== undefined;

  useLayoutEffect(() => {
    didInitialPositionRef.current = false;
    restoreDistanceFromBottomRef.current = null;
  }, [log, logUrl]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    restoreDistanceFromBottomRef.current = null;
    setFullLog(undefined);
    setIsLoadingFullLog(false);
    setFullLogError(undefined);

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [log, logUrl]);

  const loadFullLog = useCallback(async () => {
    if (fullLog !== undefined || isLoadingFullLog || !logUrl) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoadingFullLog(true);
    setFullLogError(undefined);

    try {
      const response = await fetch(logUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      const node = containerRef.current;
      const noticeHeight = noticeRef.current?.offsetHeight ?? 0;
      const logHeight = logContentRef.current?.scrollHeight ?? 0;
      restoreDistanceFromBottomRef.current = node
        ? Math.max(
            0,
            logHeight -
              Math.max(0, node.scrollTop - noticeHeight) -
              node.clientHeight,
          )
        : null;
      setFullLog(text);
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = error instanceof Error ? error.message : "Unknown error";
      const savedLogDescription = isTailOnly ? "tail" : "log output";
      setFullLogError(
        `Full log is no longer available. Showing the saved ${savedLogDescription}. (${reason})`,
      );
    } finally {
      if (!controller.signal.aborted) {
        setIsLoadingFullLog(false);
        abortRef.current = null;
      }
    }
  }, [fullLog, isLoadingFullLog, isTailOnly, logUrl]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    if (!didInitialPositionRef.current) {
      node.scrollTop = node.scrollHeight;
      didInitialPositionRef.current = true;
      return;
    }

    const distanceFromBottom = restoreDistanceFromBottomRef.current;
    if (distanceFromBottom === null) return;

    const logHeight = logContentRef.current?.scrollHeight ?? node.scrollHeight;
    node.scrollTop = Math.max(
      0,
      logHeight - node.clientHeight - distanceFromBottom,
    );
    restoreDistanceFromBottomRef.current = null;
  }, [visibleLog]);

  useEffect(() => {
    if (!logUrl || fullLog !== undefined || fullLogError) return;
    void loadFullLog();
  }, [fullLog, fullLogError, loadFullLog, logUrl]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "max-h-64 overflow-auto border-t border-border/60 bg-muted/50",
        "font-mono text-[11px] leading-relaxed",
      )}
    >
      {hasFullLogNotice && (
        <div
          ref={noticeRef}
          className="border-b border-border/60 bg-muted/95 px-3 py-2 font-sans text-xs text-muted-foreground"
        >
          {isLoadingFullLog ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading full log…
            </span>
          ) : fullLogError ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex min-w-0 items-center gap-2 text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{fullLogError}</span>
              </span>
              {logUrl && (
                <button
                  type="button"
                  onClick={() => void loadFullLog()}
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Retry
                </button>
              )}
            </span>
          ) : isTailOnly && logUrl ? (
            <span>
              Earlier log output omitted ({parsed.omittedBytes} bytes). Loading
              the full log…
            </span>
          ) : logUrl ? (
            <span>Loading full log…</span>
          ) : (
            <span className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              Earlier log output omitted ({parsed.omittedBytes} bytes), but no
              full log link was included.
            </span>
          )}
        </div>
      )}
      <pre
        ref={logContentRef}
        className="m-0 whitespace-pre-wrap break-words p-3"
      >
        {visibleLog}
      </pre>
    </div>
  );
}
