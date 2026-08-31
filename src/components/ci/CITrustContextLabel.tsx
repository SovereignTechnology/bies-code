import { CircleHelp, ShieldAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { UserGroup } from "@/components/UserGroup";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CI_TRUST_CLASSIFICATION_COPY,
  CITrustClassification,
  type CITrustResolution,
} from "@/lib/ciTrustContext";
import { cn } from "@/lib/utils";
import {
  getCITrustAttentionTone,
  getSettledCITrustPresentation,
} from "./ciTrustPresentation";

export function CITrustContextLabel({
  resolution,
  visibility = "always",
  displayLabel,
  className,
}: {
  resolution: CITrustResolution;
  visibility?: "always" | "exceptions-only";
  displayLabel?: string;
  className?: string;
}) {
  if (resolution.phase === "loading") {
    if (visibility === "exceptions-only") {
      return <span data-ci-trust-phase="loading" aria-hidden="true" />;
    }

    return (
      <Skeleton
        className={cn("h-5 w-24 shrink-0 rounded", className)}
        aria-label="Checking CI trust context"
      />
    );
  }

  const { incomplete, hasPositiveEvidence, label } =
    getSettledCITrustPresentation(resolution, displayLabel);
  const hiddenByPolicy =
    visibility === "exceptions-only" &&
    (resolution.classification === CITrustClassification.MaintainerDirected ||
      resolution.classification ===
        CITrustClassification.OperationallyAssociated ||
      (incomplete && !hasPositiveEvidence));

  // Keep the shared component at every call site even when policy currently
  // suppresses the common positive classifications. Changing that policy is
  // therefore a one-file decision.
  if (hiddenByPolicy) {
    return (
      <span
        data-ci-trust-classification={resolution.classification}
        data-ci-trust-coverage={resolution.coverage}
        aria-hidden="true"
      />
    );
  }

  const attentionTone = getCITrustAttentionTone(resolution);

  const content = (
    <CITrustContextDetails resolution={resolution} displayLabel={label} />
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                attentionTone === "danger"
                  ? "border-red-500/40 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300"
                  : attentionTone === "caution"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
                    : "border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                className,
              )}
              aria-label={`${label}. Open CI trust context`}
            >
              {attentionTone === "caution" && (
                <CircleHelp className="h-3 w-3" aria-hidden="true" />
              )}
              {attentionTone === "danger" && (
                <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              )}
              {label}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="hidden w-80 p-3 md:block">
          {content}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
        {content}
      </PopoverContent>
    </Popover>
  );
}

export function CITrustContextDetails({
  resolution,
  displayLabel,
}: {
  resolution: CITrustResolution;
  displayLabel?: string;
}) {
  if (resolution.phase === "loading") {
    return (
      <div className="space-y-1 text-xs">
        <p className="font-semibold text-foreground">Checking runner context</p>
        <p className="leading-relaxed text-muted-foreground">
          The CI result is available while relationship evidence continues to
          load.
        </p>
      </div>
    );
  }

  const { label, hasPositiveEvidence } = getSettledCITrustPresentation(
    resolution,
    displayLabel,
  );
  const copy = CI_TRUST_CLASSIFICATION_COPY[resolution.classification];
  const incompleteWithoutEvidence =
    resolution.coverage === "partial" && !hasPositiveEvidence;
  return (
    <div className="space-y-2 text-xs">
      <div>
        <p className="font-semibold text-foreground">{label}</p>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          {incompleteWithoutEvidence
            ? "Some relevant relay or identity queries could not be completed, so an absent evidence path is not treated as a final classification."
            : copy.description}
        </p>
      </div>
      {resolution.coverage === "partial" && hasPositiveEvidence && (
        <p className="border-t border-border/60 pt-2 leading-relaxed text-muted-foreground">
          Some additional relay or identity queries could not be completed. The
          signed evidence below still supports this classification.
        </p>
      )}
      {resolution.evidence.length > 0 && (
        <ul className="space-y-2 border-t border-border/60 pt-2">
          {resolution.evidence.map((evidence, index) => (
            <li key={`${evidence.kind}:${evidence.summary}:${index}`}>
              <p className="font-medium text-foreground">{evidence.summary}</p>
              <p className="mt-0.5 leading-relaxed text-muted-foreground">
                {evidence.detail}
              </p>
              {!!evidence.authors?.length && (
                <p className="mt-1 leading-relaxed text-muted-foreground">
                  Signed by <UserGroup pubkeys={evidence.authors} />
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-border/60 pt-2 leading-relaxed text-muted-foreground">
        Trust context describes evidence around the signer. It does not change
        or guarantee the CI outcome.
      </p>
    </div>
  );
}
