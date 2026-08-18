import type { CIServiceControl } from "@/casts/CICoordinator";
import type { CIWorkflowRun } from "@/lib/ci";
import {
  getCIRunMaintainerLink,
  wasCIServiceRequestedWhenRunStarted,
} from "@/lib/ciCoordinatorRelationship";

export enum CITrustClassification {
  MaintainerDirected = "maintainer-directed",
  OperationallyAssociated = "operationally-associated",
  SociallyCorroborated = "socially-corroborated",
  NoKnownContext = "no-known-context",
}

export type CITrustEvidenceKind =
  | "maintainer-request"
  | "historical-maintainer-request"
  | "repository-domain"
  | "repository-subdomain"
  | "coordinator-delegation"
  | "contact-request"
  | "social-activity";

export interface CITrustEvidence {
  kind: CITrustEvidenceKind;
  classification: Exclude<
    CITrustClassification,
    CITrustClassification.NoKnownContext
  >;
  summary: string;
  detail: string;
  /** Current standing maintainer requests do not retroactively cover old runs. */
  scope: "current" | "historical" | "run";
}

export type CITrustResolution =
  | { phase: "loading" }
  | {
      phase: "settled";
      classification: CITrustClassification;
      evidence: readonly CITrustEvidence[];
      coverage: "complete" | "partial";
    };

export interface CITrustContextState {
  phase: "loading" | "settled";
  resolutions: ReadonlyMap<string, CITrustResolution>;
  coverage: "complete" | "partial";
}

const classificationRank: Record<CITrustClassification, number> = {
  [CITrustClassification.MaintainerDirected]: 0,
  [CITrustClassification.OperationallyAssociated]: 1,
  [CITrustClassification.SociallyCorroborated]: 2,
  [CITrustClassification.NoKnownContext]: 3,
};

export const CI_TRUST_CLASSIFICATION_COPY: Record<
  CITrustClassification,
  { label: string; description: string }
> = {
  [CITrustClassification.MaintainerDirected]: {
    label: "Maintainer-directed",
    description:
      "A confirmed repository maintainer requested this coordinator service or this particular run.",
  },
  [CITrustClassification.OperationallyAssociated]: {
    label: "Operationally associated",
    description:
      "Signed or independently verified evidence connects this identity to repository-listed infrastructure or a recognized coordinator.",
  },
  [CITrustClassification.SociallyCorroborated]: {
    label: "Socially corroborated",
    description:
      "This identity has prior CI activity on repositories maintained by people you follow.",
  },
  [CITrustClassification.NoKnownContext]: {
    label: "No known context",
    description:
      "No maintainer, repository-infrastructure, coordinator, or viewer-relative social evidence was found.",
  },
};

export function classifyCITrustEvidence(
  evidence: readonly CITrustEvidence[],
): CITrustClassification {
  if (evidence.length === 0) return CITrustClassification.NoKnownContext;
  return evidence.reduce<CITrustClassification>(
    (strongest, item) =>
      classificationRank[item.classification] < classificationRank[strongest]
        ? item.classification
        : strongest,
    CITrustClassification.NoKnownContext,
  );
}

export function settledCITrustResolution(
  evidence: readonly CITrustEvidence[],
  coverage: "complete" | "partial",
): CITrustResolution {
  return {
    phase: "settled",
    classification: classifyCITrustEvidence(evidence),
    evidence,
    coverage,
  };
}

export function getCITrustResolution(
  state: CITrustContextState | undefined,
  pubkey: string,
): CITrustResolution {
  if (!state || state.phase === "loading") return { phase: "loading" };
  return (
    state.resolutions.get(pubkey) ??
    settledCITrustResolution([], state.coverage)
  );
}

/** Apply immutable run provenance without treating today's request as retroactive. */
export function getCIRunTrustResolution(
  state: CITrustContextState | undefined,
  run: CIWorkflowRun,
  confirmedMaintainers: readonly string[],
  serviceControls: readonly CIServiceControl[],
): CITrustResolution {
  const base = getCITrustResolution(state, run.pubkey);
  if (base.phase === "loading") return base;

  const evidence = base.evidence.filter(
    (item) => item.kind !== "maintainer-request" || item.scope !== "current",
  );
  const maintainerLink = getCIRunMaintainerLink(run, confirmedMaintainers);
  const serviceRequestedAtRun = wasCIServiceRequestedWhenRunStarted(
    run,
    serviceControls,
  );

  if (maintainerLink === "manual") {
    evidence.unshift({
      kind: "maintainer-request",
      classification: CITrustClassification.MaintainerDirected,
      summary: "Requested by a maintainer",
      detail:
        "A confirmed repository maintainer manually requested this workflow run.",
      scope: "run",
    });
  } else if (maintainerLink === "service" || serviceRequestedAtRun === true) {
    evidence.unshift({
      kind: "maintainer-request",
      classification: CITrustClassification.MaintainerDirected,
      summary: "Covered by a maintainer request",
      detail:
        "A confirmed repository maintainer's service request was active when this workflow run started.",
      scope: "run",
    });
  }

  return settledCITrustResolution(evidence, base.coverage);
}

/**
 * Add only the delegation evidence carried by this exact accepted Job Result.
 * Identity-wide context remains separate so one accepted job cannot bless
 * unrelated jobs from the same provider.
 */
export function getCIJobTrustResolution(
  state: CITrustContextState | undefined,
  run: CIWorkflowRun,
  job: CIWorkflowRun["jobs"][number],
): CITrustResolution {
  const provider = getCITrustResolution(state, job.result.pubkey);
  const coordinator = getCITrustResolution(state, run.pubkey);
  if (provider.phase === "loading" || coordinator.phase === "loading") {
    return { phase: "loading" };
  }
  if (
    !run.workflowResult ||
    job.result.pubkey === run.pubkey ||
    coordinator.classification === CITrustClassification.NoKnownContext
  ) {
    return provider;
  }

  const delegatedClassification =
    coordinator.classification === CITrustClassification.SociallyCorroborated
      ? CITrustClassification.SociallyCorroborated
      : CITrustClassification.OperationallyAssociated;
  const evidence: CITrustEvidence = {
    kind: "coordinator-delegation",
    classification: delegatedClassification,
    summary:
      delegatedClassification === CITrustClassification.SociallyCorroborated
        ? "Accepted by a socially corroborated coordinator"
        : "Accepted by the coordinator",
    detail:
      delegatedClassification === CITrustClassification.SociallyCorroborated
        ? "The coordinator signed a Workflow Result accepting this provider's Job Result, and that coordinator has CI history near your follow graph. This association is scoped to this job."
        : "The independently contextual coordinator signed a Workflow Result accepting this provider's Job Result. This association is scoped to this job.",
    scope: "run",
  };

  return settledCITrustResolution(
    [...provider.evidence, evidence],
    provider.coverage === "partial" || coordinator.coverage === "partial"
      ? "partial"
      : "complete",
  );
}

/**
 * Roll up several runs conservatively: the least-contextual run remains
 * visible instead of being hidden by a stronger result from another signer.
 */
export function summarizeCIRunTrust(
  resolutions: readonly CITrustResolution[],
): CITrustResolution {
  if (resolutions.some((resolution) => resolution.phase === "loading")) {
    return { phase: "loading" };
  }

  const settled = resolutions.filter(
    (
      resolution,
    ): resolution is Extract<CITrustResolution, { phase: "settled" }> =>
      resolution.phase === "settled",
  );
  if (settled.length === 0) return settledCITrustResolution([], "complete");

  const weakest = settled.reduce((current, resolution) =>
    classificationRank[resolution.classification] >
    classificationRank[current.classification]
      ? resolution
      : current,
  );
  return {
    phase: "settled",
    classification: weakest.classification,
    evidence: weakest.evidence,
    coverage: settled.some((resolution) => resolution.coverage === "partial")
      ? "partial"
      : "complete",
  };
}

export type CIDomainRelationship = "exact" | "subdomain" | undefined;

function normalizedDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").split(":")[0];
}

function isProperSubdomain(candidate: string, parent: string): boolean {
  return candidate !== parent && candidate.endsWith(`.${parent}`);
}

export function classifyCIDomainRelationship(
  identityDomain: string,
  repositoryDomains: readonly string[],
): { relationship: CIDomainRelationship; repositoryDomain?: string } {
  const identity = normalizedDomain(identityDomain);
  for (const rawRepositoryDomain of repositoryDomains) {
    const repositoryDomain = normalizedDomain(rawRepositoryDomain);
    if (identity === repositoryDomain) {
      return { relationship: "exact", repositoryDomain };
    }
  }
  for (const rawRepositoryDomain of repositoryDomains) {
    const repositoryDomain = normalizedDomain(rawRepositoryDomain);
    if (
      isProperSubdomain(identity, repositoryDomain) ||
      isProperSubdomain(repositoryDomain, identity)
    ) {
      return { relationship: "subdomain", repositoryDomain };
    }
  }
  return { relationship: undefined };
}
