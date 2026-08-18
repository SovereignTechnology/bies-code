import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
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

export function CITrustContextLabel({
  resolution,
  visibility = "always",
  className,
}: {
  resolution: CITrustResolution;
  visibility?: "always" | "exceptions-only";
  className?: string;
}) {
  if (resolution.phase === "loading") {
    return (
      <Skeleton
        className={cn("h-5 w-24 shrink-0 rounded", className)}
        aria-label="Checking CI trust context"
      />
    );
  }

  const hiddenCommonClassification =
    visibility === "exceptions-only" &&
    resolution.coverage === "complete" &&
    (resolution.classification === CITrustClassification.MaintainerDirected ||
      resolution.classification ===
        CITrustClassification.OperationallyAssociated);

  // Keep the shared component at every call site even when policy currently
  // suppresses the common positive classifications. Changing that policy is
  // therefore a one-file decision.
  if (hiddenCommonClassification) {
    return (
      <span
        data-ci-trust-classification={resolution.classification}
        aria-hidden="true"
      />
    );
  }

  const incomplete = resolution.coverage === "partial";
  const copy = CI_TRUST_CLASSIFICATION_COPY[resolution.classification];
  const label = incomplete ? "Context incomplete" : copy.label;

  const content = <CITrustExplanation resolution={resolution} label={label} />;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-5 shrink-0 items-center rounded border border-border bg-muted/50 px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                className,
              )}
              aria-label={`${label}. Open CI trust context`}
            >
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

function CITrustExplanation({
  resolution,
  label,
}: {
  resolution: Extract<CITrustResolution, { phase: "settled" }>;
  label: string;
}) {
  const copy = CI_TRUST_CLASSIFICATION_COPY[resolution.classification];
  return (
    <div className="space-y-2 text-xs">
      <div>
        <p className="font-semibold text-foreground">{label}</p>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          {resolution.coverage === "partial"
            ? "Some relevant relay or identity queries could not be completed, so an absent evidence path is not treated as a final score."
            : copy.description}
        </p>
      </div>
      {resolution.evidence.length > 0 && (
        <ul className="space-y-2 border-t border-border/60 pt-2">
          {resolution.evidence.map((evidence, index) => (
            <li key={`${evidence.kind}:${evidence.summary}:${index}`}>
              <p className="font-medium text-foreground">{evidence.summary}</p>
              <p className="mt-0.5 leading-relaxed text-muted-foreground">
                {evidence.detail}
              </p>
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
