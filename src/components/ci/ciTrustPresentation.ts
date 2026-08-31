import {
  CI_TRUST_CLASSIFICATION_COPY,
  CITrustClassification,
  type CITrustResolution,
} from "@/lib/ciTrustContext";

export function getSettledCITrustPresentation(
  resolution: Extract<CITrustResolution, { phase: "settled" }>,
  displayLabel?: string,
): {
  incomplete: boolean;
  hasPositiveEvidence: boolean;
  label: string;
} {
  const incomplete = resolution.coverage === "partial";
  const hasPositiveEvidence =
    resolution.classification !== CITrustClassification.NoKnownContext;
  const copy = CI_TRUST_CLASSIFICATION_COPY[resolution.classification];
  return {
    incomplete,
    hasPositiveEvidence,
    label:
      incomplete && !hasPositiveEvidence
        ? "Context incomplete"
        : (displayLabel ?? copy.label),
  };
}

export function getCITrustContextLabel(resolution: CITrustResolution): string {
  if (resolution.phase === "loading") return "Checking runner context";
  return getSettledCITrustPresentation(resolution).label;
}

export type CITrustAttentionTone = "caution" | "danger" | undefined;

/** Matches the exceptions-only policy while distinguishing caution from risk. */
export function getCITrustAttentionTone(
  resolution: CITrustResolution,
): CITrustAttentionTone {
  if (resolution.phase === "loading") return undefined;
  if (resolution.classification === CITrustClassification.SeenInYourNetwork) {
    return "caution";
  }
  if (
    resolution.classification === CITrustClassification.NoKnownContext &&
    resolution.coverage === "complete"
  ) {
    return "danger";
  }
  return undefined;
}
