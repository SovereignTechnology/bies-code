/**
 * CoordinatorTrustIndicator — per-run shield explaining whether a CI run was
 * requested by a confirmed repository maintainer.
 *
 * Shared by the repo Actions tab and the PR/commit checks panel so both
 * surfaces communicate coordinator trust identically. Renders nothing when a
 * run is covered by a maintainer's currently active request — the trusted
 * default needs no caveat.
 */

import {
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import type {
  CICoordinatorRelationship,
  CIRunMaintainerLink,
} from "@/lib/ciCoordinatorRelationship";
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
import { cn } from "@/lib/utils";

export function CoordinatorTrustIndicator({
  maintainerLink,
  relationship,
  serviceRequestedAtRun,
}: {
  maintainerLink: CIRunMaintainerLink;
  relationship: CICoordinatorRelationship;
  serviceRequestedAtRun: boolean | undefined;
}) {
  const runWasMaintainerRequested =
    maintainerLink !== undefined || serviceRequestedAtRun === true;
  const isCoveredByCurrentRequest =
    relationship.level === "requested" && runWasMaintainerRequested;

  if (isCoveredByCurrentRequest) return null;

  const hasMaintainerContext =
    runWasMaintainerRequested || relationship.level !== "unassociated";
  const explanation = getCoordinatorTrustExplanation(
    maintainerLink,
    relationship,
    serviceRequestedAtRun,
  );
  const Icon = runWasMaintainerRequested
    ? ShieldCheck
    : hasMaintainerContext
      ? ShieldQuestion
      : ShieldAlert;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                hasMaintainerContext
                  ? "border-border bg-muted/60 text-foreground hover:bg-muted"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300",
              )}
              aria-label={`${explanation.title}. Open explanation`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="hidden w-72 p-3 text-xs md:block">
          <CoordinatorTrustExplanation
            icon={Icon}
            title={explanation.title}
            description={explanation.description}
            hasMaintainerContext={hasMaintainerContext}
          />
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="end" sideOffset={6} className="w-72 p-3 text-xs">
        <CoordinatorTrustExplanation
          icon={Icon}
          title={explanation.title}
          description={explanation.description}
          hasMaintainerContext={hasMaintainerContext}
        />
      </PopoverContent>
    </Popover>
  );
}

function CoordinatorTrustExplanation({
  icon: Icon,
  title,
  description,
  hasMaintainerContext,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  hasMaintainerContext: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          hasMaintainerContext
            ? "text-muted-foreground"
            : "text-amber-600 dark:text-amber-300",
        )}
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function getCoordinatorTrustExplanation(
  maintainerLink: CIRunMaintainerLink,
  relationship: CICoordinatorRelationship,
  serviceRequestedAtRun: boolean | undefined,
): { title: string; description: string } {
  if (maintainerLink === "service") {
    return {
      title: "Requested by a maintainer",
      description:
        "A confirmed repository maintainer asked this coordinator to run CI automatically. This run was part of that request.",
    };
  }

  if (maintainerLink === "manual") {
    return {
      title: "Requested by a maintainer",
      description:
        "A confirmed repository maintainer manually requested this run from this coordinator.",
    };
  }

  if (serviceRequestedAtRun === true) {
    return relationship.level === "requested"
      ? {
          title: "Requested by a maintainer",
          description:
            "When this run started, a maintainer had asked this coordinator to run CI automatically. That request is still active.",
        }
      : {
          title: "Requested when this run started",
          description:
            "When this run started, a maintainer had asked this coordinator to run CI automatically. They stopped that request later, but this run was covered at the time.",
        };
  }

  if (relationship.level === "requested") {
    return serviceRequestedAtRun === false
      ? {
          title: "Requested after this run",
          description:
            "After this run, a maintainer asked this coordinator to run CI automatically. This earlier result was not part of that request.",
        }
      : {
          title: "Request timing unknown",
          description:
            "A maintainer currently asks this coordinator to run CI automatically, but this run has no reliable start time. We cannot tell whether it happened before or after that request.",
        };
  }

  if (relationship.level === "previously-requested") {
    if (relationship.manualRunCount > 0) {
      const runLabel = relationship.manualRunCount === 1 ? "run" : "runs";
      return {
        title: "Not requested by a maintainer",
        description: `A maintainer did not request this run. They manually started at least ${relationship.manualRunCount} other ${runLabel} with this coordinator.`,
      };
    }

    return {
      title: "Not requested by a maintainer",
      description:
        "A maintainer did not request this run. They had asked this coordinator to run CI automatically in the past, but that request is no longer active.",
    };
  }

  return {
    title: "Not requested by a maintainer",
    description:
      "A maintainer did not request this run, and we found no other runs they asked this coordinator to perform.",
  };
}
