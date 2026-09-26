import { Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  RelayCoverageDetail,
  RelayCoverageGroup,
} from "@/lib/replaceablePreflightCoverage";
import { cn } from "@/lib/utils";

function relayStatus(detail: RelayCoverageDetail): string {
  if (detail.phase === "covered") return "Ready";
  if (detail.phase === "initial" || detail.phase === "catching-up") {
    return "Checking";
  }
  if (detail.phase === "not-responding") return "Not responding";
  if (detail.phase === "stopped") return "Stopped";
  if (detail.phase === "not-checked") return "Not checked";
  switch (detail.reason) {
    case "auth":
      return "Authentication required";
    case "rate-limited":
      return "Rate limited";
    case "permanent":
      return "Request rejected";
    case "transport":
      return "Disconnected";
    case "closed":
    case "error":
      return "Recovering";
    default:
      return "Unavailable";
  }
}

function statusClass(detail: RelayCoverageDetail): string {
  if (detail.phase === "covered") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (detail.phase === "initial" || detail.phase === "catching-up") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

export interface RelayCoveragePopoverProps {
  groups: readonly RelayCoverageGroup[];
  className?: string;
}

/** Small reusable diagnostic for a preflight surface with structured facts. */
export function RelayCoveragePopover({
  groups,
  className,
}: RelayCoveragePopoverProps) {
  const visibleGroups = groups.filter((group) => group.relays.length > 0);
  if (visibleGroups.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 shrink-0 px-2 text-xs", className)}
        >
          <Info className="mr-1.5 h-3.5 w-3.5" />
          Relay details
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
        aria-label="Relay check details"
      >
        <div className="border-b px-4 py-3">
          <p className="text-sm font-medium">Relay check details</p>
          <p className="mt-1 text-xs text-muted-foreground">
            A write proceeds only when this feature's relay threshold is met.
          </p>
        </div>
        <div className="max-h-72 space-y-4 overflow-y-auto p-4">
          {visibleGroups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">
                {group.label}
              </h4>
              <div className="space-y-2">
                {group.relays.map((detail) => (
                  <div
                    key={detail.relay}
                    className="flex items-start justify-between gap-3"
                  >
                    <span className="min-w-0 break-all text-xs leading-5">
                      {detail.relay}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0 whitespace-nowrap px-2 py-0 text-[10px]",
                        statusClass(detail),
                      )}
                    >
                      {relayStatus(detail)}
                    </Badge>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
