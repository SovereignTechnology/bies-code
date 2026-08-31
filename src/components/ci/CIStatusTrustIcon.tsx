import { CircleHelp, ShieldAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ciStatusLabel, type CICheckStatus } from "@/lib/ci";
import type { CITrustResolution } from "@/lib/ciTrustContext";
import { cn } from "@/lib/utils";
import { CIStatusIcon } from "./CIStatusIcon";
import { CITrustContextDetails } from "./CITrustContextLabel";
import {
  getCITrustAttentionTone,
  getCITrustContextLabel,
} from "./ciTrustPresentation";

interface CIStatusTrustIconProps {
  status: CICheckStatus;
  resolution: CITrustResolution;
  /** More specific rollup copy, such as “2 checks successful”. */
  statusSummary?: string;
  className?: string;
  buttonClassName?: string;
  align?: "start" | "center" | "end";
}

/**
 * A compact CI result whose button also carries runner relationship context.
 * Common and loading trust states stay visually quiet; exceptions add a
 * shield directly to the result icon instead of a disconnected text badge.
 */
export function CIStatusTrustIcon({
  status,
  resolution,
  statusSummary,
  className,
  buttonClassName,
  align = "end",
}: CIStatusTrustIconProps) {
  const statusLabel = ciStatusLabel(status);
  const trustLabel = getCITrustContextLabel(resolution);
  const attentionTone = getCITrustAttentionTone(resolution);
  const summary = statusSummary ?? `CI: ${statusLabel}`;
  const content = (
    <div className="space-y-3 text-xs">
      <div>
        <p className="font-semibold text-foreground">CI: {statusLabel}</p>
        {statusSummary && (
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {statusSummary}
          </p>
        )}
      </div>
      <div className="border-t border-border/60 pt-3">
        <CITrustContextDetails resolution={resolution} />
      </div>
    </div>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                attentionTone === "caution" &&
                  "bg-amber-500/10 ring-1 ring-inset ring-amber-500/40 hover:bg-amber-500/15",
                attentionTone === "danger" &&
                  "bg-red-500/10 ring-1 ring-inset ring-red-500/50 hover:bg-red-500/15",
                buttonClassName,
              )}
              aria-label={`${summary}. ${trustLabel}. Open CI details`}
            >
              <CIStatusIcon
                status={status}
                className={cn("h-4 w-4", className)}
                decorative
              />
              {attentionTone === "caution" && (
                <CircleHelp
                  className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-background text-amber-600 dark:text-amber-400"
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
              )}
              {attentionTone === "danger" && (
                <ShieldAlert
                  className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-background text-red-600 dark:text-red-400"
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {summary} · {trustLabel}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align={align} sideOffset={6} className="w-80 p-3">
        {content}
      </PopoverContent>
    </Popover>
  );
}
