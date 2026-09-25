/**
 * CIRunListRow — a roomy, expandable workflow-run row for the repo Actions
 * list: status glyph, workflow name and trigger actor on the left, branch,
 * timing and a result pill on the right. Clicking the row expands the same
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
import { UserLink } from "@/components/UserAvatar";
import { EventCardActions } from "@/components/EventCardActions";
import { cn } from "@/lib/utils";
import {
  ciRunOutcome,
  ciStatusLabel,
  ciWorkflowName,
  formatCIDuration,
  getWorkflowTiming,
  type CIRunOutcome,
  type CIWorkflowRun,
} from "@/lib/ci";
import type {
  CITrustContextState,
  CITrustResolution,
} from "@/lib/ciTrustContext";
import { findNsitePreview } from "@/lib/ciOutputs";
import { NsitePreviewLink } from "./PRNsitePreview";
import { CICoordinatorLink } from "./CICoordinatorLink";
import { useCurrentUnixSeconds } from "@/hooks/useCurrentUnixSeconds";
import { CIRunDetails } from "./CIChecksPanel";

const OUTCOME_PILL: Record<CIRunOutcome, { label: string; className: string }> =
  {
    success: {
      label: "Success",
      className:
        "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    },
    failure: {
      label: "Failure",
      className:
        "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300",
    },
    running: {
      label: "Running",
      className:
        "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    queued: {
      label: "Queued",
      className:
        "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    },
    cancelled: {
      label: "Cancelled",
      className: "border-border bg-muted/60 text-muted-foreground",
    },
    neutral: {
      label: "Neutral",
      className: "border-border bg-muted/60 text-muted-foreground",
    },
    skipped: {
      label: "Skipped",
      className: "border-border bg-muted/60 text-muted-foreground",
    },
  };

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
  canRetry?: boolean;
  /** Branch / tag / PR pill linking to what triggered the run. */
  refContext?: ReactNode;
  trustIndicator?: ReactNode;
  attributionIndicator?: ReactNode;
  expandedTrustResolution?: CITrustResolution;
  providerTrust?: CITrustContextState;
}) {
  const [open, setOpen] = useState(false);
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
  const pill = OUTCOME_PILL[outcome];
  const workflowName = ciWorkflowName(run.workflowPath);
  const primaryEvent =
    run.workflowResult?.event ??
    run.pendingRun?.event ??
    run.jobs[0]?.result.event;
  const nsitePreview = findNsitePreview([run]);

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

  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "flex cursor-pointer flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/40 sm:px-5 md:flex-row md:items-center md:gap-4",
            open && "bg-muted/30",
          )}
          onClick={toggleFromRow}
        >
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <RunStatusGlyph run={run} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate text-base font-semibold leading-tight text-foreground"
                  title={run.workflowPath}
                >
                  {workflowName}
                </span>
                {trustIndicator}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                <span className="max-w-48 truncate font-medium text-foreground/80">
                  {run.workflowPath?.split("/").pop() ?? workflowName}
                </span>
                <span aria-hidden="true">·</span>
                <span>triggered by</span>
                {requester ? (
                  <>
                    <UserLink
                      pubkey={requester}
                      avatarSize="xs"
                      nameClassName="font-normal text-muted-foreground"
                    />
                    <span aria-hidden="true">·</span>
                    <span>via</span>
                  </>
                ) : (
                  run.trigger && <span>{run.trigger} on</span>
                )}
                <CICoordinatorLink
                  pubkey={run.pubkey}
                  avatarSize="xs"
                  nameClassName="max-w-32 truncate font-normal text-muted-foreground"
                />
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

          <div className="flex shrink-0 flex-wrap items-center gap-3 pl-10 md:flex-nowrap md:gap-5 md:pl-0">
            {refContext}
            <div className="flex min-w-[7.5rem] flex-col items-start text-sm text-muted-foreground md:items-end">
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
            <span
              className={cn(
                "inline-flex w-24 shrink-0 items-center justify-center rounded-full border px-3 py-1 text-sm font-medium",
                pill.className,
              )}
            >
              {pill.label}
            </span>
            <div className="flex items-center gap-1">
              {attributionIndicator}
              {primaryEvent && <EventCardActions event={primaryEvent} />}
              <CollapsibleTrigger
                className="group rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
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
          <CIRunDetails
            run={run}
            nowSeconds={nowSeconds}
            canRetry={canRetry}
            expandedTrustResolution={expandedTrustResolution}
            providerTrust={providerTrust}
            className="border-t border-border/60 bg-muted/20 px-4 py-3 sm:px-5 md:pl-[4.25rem]"
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
