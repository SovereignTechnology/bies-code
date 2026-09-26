/**
 * CIRunListRow — a roomy, expandable workflow-run row for the repo Actions
 * list: status glyph, workflow name and trigger actor on the left, branch,
 * timing and a result badge on the right. Clicking the row expands the same
 * details (timing, jobs, logs, artifacts) as the compact CIRunRow.
 */

import { type MouseEvent, type ReactNode, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleSlash,
  Clock,
  Loader2,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { UserLink } from "@/components/UserAvatar";
import { EventCardActions } from "@/components/EventCardActions";
import { cn } from "@/lib/utils";
import {
  CI_RUN_OUTCOME_LABELS,
  ciRunOutcome,
  ciStatusLabel,
  ciWorkflowName,
  formatCIDuration,
  getWorkflowTiming,
  type CIRunOutcome,
  type CIWorkflowRun,
} from "@/lib/ci";
import {
  CITrustClassification,
  type CITrustContextState,
  type CITrustResolution,
} from "@/lib/ciTrustContext";
import { findNsitePreview } from "@/lib/ciOutputs";
import { NsitePreviewLink } from "./PRNsitePreview";
import { CICoordinatorLink } from "./CICoordinatorLink";
import { CITrustContextLabel } from "./CITrustContextLabel";
import { useCurrentUnixSeconds } from "@/hooks/useCurrentUnixSeconds";
import { CIRunDetails } from "./CIChecksPanel";

const OUTCOME_BADGE_CLASSES: Record<CIRunOutcome, string> = {
  success:
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failure: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
  running:
    "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  queued:
    "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  cancelled: "border-border bg-muted/50 text-muted-foreground",
  neutral: "border-border bg-muted/50 text-muted-foreground",
  skipped: "border-border bg-muted/50 text-muted-foreground",
};

export interface CIRunListRowLayout {
  inlineIdentity: boolean;
  inlineActions: boolean;
}

function RunStatusGlyph({ run }: { run: CIWorkflowRun }) {
  const label = ciStatusLabel(run.status);
  const className = "h-5 w-5 shrink-0";
  switch (run.status) {
    case "success":
      return (
        <Check
          className={cn(className, "text-emerald-500")}
          strokeWidth={2.5}
          aria-label={label}
        />
      );
    case "failure":
      return (
        <X
          className={cn(className, "text-red-500")}
          strokeWidth={2.5}
          aria-label={label}
        />
      );
    case "timed_out":
    case "startup_failure":
      return (
        <AlertTriangle
          className={cn(className, "text-red-500")}
          aria-label={label}
        />
      );
    case "pending":
      if (run.pendingRun?.progressStatus === "queued") {
        return (
          <span
            role="img"
            aria-label="Queued"
            className="flex h-5 w-5 shrink-0 items-center justify-center gap-[3px]"
          >
            {[0, 250, 500].map((delay) => (
              <span
                key={delay}
                className="h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
        );
      }
      return (
        <Loader2
          className={cn(className, "text-amber-500 motion-safe:animate-spin")}
          aria-label={label}
        />
      );
    default:
      return (
        <CircleSlash
          className={cn(className, "text-muted-foreground")}
          aria-label={label}
        />
      );
  }
}

export function CIRunListRow({
  run,
  requester,
  layout,
  canRetry = false,
  refContext,
  trustIndicator,
  attributionIndicator,
  expandedTrustResolution,
  providerTrust,
}: {
  run: CIWorkflowRun;
  /** Confirmed-maintainer requester of the run, when validated by the caller. */
  requester?: string;
  layout: CIRunListRowLayout;
  canRetry?: boolean;
  /** Branch / tag / PR pill linking to what triggered the run. */
  refContext?: ReactNode;
  trustIndicator?: ReactNode;
  attributionIndicator?: ReactNode;
  expandedTrustResolution?: CITrustResolution;
  providerTrust?: CITrustContextState;
}) {
  const [open, setOpen] = useState(false);
  const { inlineActions } = layout;
  const isPending = run.status === "pending";
  const nowSeconds = useCurrentUnixSeconds(isPending);
  const { queuedAt, startedAt, completedAt } = getWorkflowTiming(run);
  const triggeredAt = startedAt ?? queuedAt ?? run.createdAt;
  const endAt = completedAt ?? (isPending ? nowSeconds : undefined);
  const duration = formatCIDuration(
    startedAt === undefined || endAt === undefined
      ? undefined
      : endAt - startedAt,
  );
  const outcome = ciRunOutcome(run);
  const workflowName = ciWorkflowName(run.workflowPath);
  const primaryEvent =
    run.workflowResult?.event ??
    run.pendingRun?.event ??
    run.jobs[0]?.result.event;
  const nsitePreview = findNsitePreview([run]);
  const maintainerDirected =
    expandedTrustResolution?.phase === "settled" &&
    expandedTrustResolution.classification ===
      CITrustClassification.MaintainerDirected;
  const maintainerRequested = !!requester || maintainerDirected;
  const trustPending = expandedTrustResolution?.phase === "loading";
  const inlineIdentity =
    layout.inlineIdentity && !maintainerDirected && !trustPending;

  // The whole row toggles, except clicks on nested links and controls.
  const toggleFromRow = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "a, button, [role='menuitem'], [data-radix-popper-content-wrapper]",
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    setOpen((value) => !value);
  };

  const identityDetails = (
    <dl
      className={cn(
        "grid w-fit max-w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        inlineIdentity && "ml-auto",
      )}
    >
      {requester && (
        <>
          <dt className="shrink-0 text-muted-foreground">Requested by</dt>
          <dd
            className={cn(
              "min-w-0 max-w-full",
              inlineIdentity && "justify-self-end",
            )}
          >
            <UserLink
              pubkey={requester}
              avatarSize="xs"
              className="min-w-0"
              nameClassName="truncate font-normal text-muted-foreground"
            />
          </dd>
        </>
      )}
      <dt className="shrink-0 text-muted-foreground">Coordinator</dt>
      <dd
        className={cn(
          "min-w-0 max-w-full",
          inlineIdentity && "justify-self-end",
        )}
      >
        <CICoordinatorLink
          pubkey={run.pubkey}
          avatarSize="xs"
          className="min-w-0"
          nameClassName="truncate font-normal text-muted-foreground"
        />
      </dd>
    </dl>
  );

  return (
    <li className="[container-type:inline-size]">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "flex cursor-pointer flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/40 sm:px-5 md:flex-row md:items-center md:gap-4",
            open && "bg-muted/30",
          )}
          onClick={toggleFromRow}
        >
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center [@container(max-width:30rem)]:hidden">
              <RunStatusGlyph run={run} />
            </span>
            <div className="min-w-0 flex-1 max-md:flex max-md:flex-wrap max-md:items-baseline max-md:gap-x-2 max-md:gap-y-1">
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <span
                  className="truncate text-base font-semibold leading-tight text-foreground"
                  title={run.workflowPath}
                >
                  {workflowName}
                </span>
                {trustIndicator}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground max-md:mt-0">
                <span className="max-w-48 truncate font-medium text-foreground/80">
                  {run.workflowPath?.split("/").pop() ?? workflowName}
                </span>
                {run.trigger && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{run.trigger}</span>
                  </>
                )}
                {!maintainerRequested && !trustPending && !inlineIdentity && (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true">·</span>
                    <span>via</span>
                    <CICoordinatorLink
                      pubkey={run.pubkey}
                      avatarSize="xs"
                      nameClassName="max-w-32 truncate font-normal text-muted-foreground"
                    />
                  </span>
                )}
                {run.commitId && (
                  <>
                    <span aria-hidden="true">·</span>
                    <code className="font-mono text-xs">
                      {run.commitId.slice(0, 7)}
                    </code>
                  </>
                )}
                {nsitePreview && (
                  <NsitePreviewLink preview={nsitePreview} className="text-xs">
                    nsite preview
                  </NsitePreviewLink>
                )}
              </div>
            </div>
          </div>

          {inlineIdentity && (
            <div className="w-64 shrink-0">{identityDetails}</div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-3 pl-10 md:flex-nowrap md:gap-5 md:pl-0 [@container(max-width:30rem)]:pl-0">
            <div className="flex min-w-0 sm:min-w-24 md:justify-end">
              {refContext}
            </div>
            <div className="flex min-w-[7.5rem] flex-col items-start text-sm text-muted-foreground sm:max-md:flex-row sm:max-md:items-center sm:max-md:gap-3 md:items-end">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {formatDistanceToNow(new Date(triggeredAt * 1000), {
                  addSuffix: true,
                })}
              </span>
              {duration && (
                <span className="whitespace-nowrap tabular-nums">
                  {duration}
                </span>
              )}
            </div>
            <div className="flex w-24 shrink-0 justify-end max-md:ml-auto">
              <Badge
                variant="outline"
                className={cn(
                  "w-full justify-center px-3 py-1 text-sm font-medium",
                  OUTCOME_BADGE_CLASSES[outcome],
                )}
              >
                {CI_RUN_OUTCOME_LABELS[outcome]}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              {attributionIndicator}
              {primaryEvent && inlineActions && (
                <EventCardActions event={primaryEvent} />
              )}
              <CollapsibleTrigger
                className="group rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={
                  open ? "Collapse workflow run" : "Expand workflow run"
                }
              >
                <ChevronRight className="h-5 w-5 transition-transform group-data-[state=open]:rotate-90" />
              </CollapsibleTrigger>
            </div>
          </div>
        </div>

        <CollapsibleContent>
          <div className="space-y-4 border-t border-border/60 bg-muted/20 px-4 py-4 sm:px-5 md:pl-[4.25rem]">
            {(!inlineIdentity || expandedTrustResolution) && (
              <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
                  {!inlineIdentity && identityDetails}
                  {expandedTrustResolution && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>Trust context</span>
                      <CITrustContextLabel
                        resolution={expandedTrustResolution}
                      />
                    </div>
                  )}
                </div>
                {primaryEvent && !inlineActions && (
                  <EventCardActions event={primaryEvent} className="shrink-0" />
                )}
              </div>
            )}
            <CIRunDetails
              run={run}
              nowSeconds={nowSeconds}
              canRetry={canRetry}
              providerTrust={providerTrust}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
