import type { CIWorkflowRun } from "@/lib/ci";
import type { CIServiceControl } from "@/casts/CICoordinator";

export type CICoordinatorRelationshipLevel =
  | "requested"
  | "previously-requested"
  | "unassociated";

export interface CICoordinatorRelationship {
  level: CICoordinatorRelationshipLevel;
  manualRunCount: number;
  serviceRunCount: number;
  requesterPubkeys: string[];
}

export type CIRunMaintainerLink = "manual" | "service" | undefined;

/**
 * Whether a standing Service Request was active when a run was handed off.
 *
 * Automatic runs deliberately omit a per-run request quote, so their
 * repository-level maintainer recognition is reconstructed from the immutable
 * control history. A later Stop changes future service without rewriting an
 * earlier run's trust state.
 */
export function wasCIServiceRequestedWhenRunStarted(
  run: CIWorkflowRun,
  controls: readonly CIServiceControl[],
): boolean | undefined {
  const startedAt =
    run.workflowResult?.startedAt ??
    run.pendingRun?.startedAt ??
    run.workflowResult?.queuedAt ??
    run.pendingRun?.queuedAt;
  if (startedAt === undefined) return undefined;

  let latest: CIServiceControl | undefined;
  for (const control of controls) {
    if (
      control.coordinatorPubkey !== run.pubkey ||
      control.event.created_at > startedAt
    ) {
      continue;
    }

    if (
      !latest ||
      control.event.created_at > latest.event.created_at ||
      (control.event.created_at === latest.event.created_at &&
        control.event.id.localeCompare(latest.event.id) < 0)
    ) {
      latest = control;
    }
  }

  return latest?.isRequest ?? false;
}

/** Classify a run's frozen maintainer provenance quote, when present. */
export function getCIRunMaintainerLink(
  run: CIWorkflowRun,
  confirmedMaintainers: readonly string[],
): CIRunMaintainerLink {
  const container = run.workflowResult ?? run.pendingRun;
  const manualPubkey = container?.manualTriggerRef?.pubkey;
  if (manualPubkey && confirmedMaintainers.includes(manualPubkey)) {
    return "manual";
  }

  const servicePubkey = container?.serviceRequestRef?.pubkey;
  if (servicePubkey && confirmedMaintainers.includes(servicePubkey)) {
    return "service";
  }

  return undefined;
}

/** Return the requester from the same quote that passed maintainer validation. */
export function getCIRunMaintainerRequester(
  run: CIWorkflowRun,
  confirmedMaintainers: readonly string[],
): string | undefined {
  const link = getCIRunMaintainerLink(run, confirmedMaintainers);
  const container = run.workflowResult ?? run.pendingRun;
  if (link === "manual") return container?.manualTriggerRef?.pubkey;
  if (link === "service") return container?.serviceRequestRef?.pubkey;
  return undefined;
}

/**
 * Derive repository-to-coordinator relationship tiers.
 *
 * A current standing Service Request is strongest. Historical controls or
 * per-run request provenance establish a previous relationship with the
 * coordinator, while every individual run retains its frozen provenance.
 */
export function classifyCICoordinatorRelationships(
  runs: readonly CIWorkflowRun[],
  confirmedMaintainers: readonly string[],
  requestedCoordinatorPubkeys: ReadonlySet<string>,
  previouslyRequestedCoordinatorPubkeys: ReadonlySet<string>,
  serviceControls: readonly CIServiceControl[],
): Map<string, CICoordinatorRelationship> {
  const relationships = new Map<string, CICoordinatorRelationship>();

  for (const run of runs) {
    const current = relationships.get(run.pubkey) ?? {
      level: "unassociated" as const,
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [],
    };
    const link = getCIRunMaintainerLink(run, confirmedMaintainers);
    if (link) {
      current.level = "previously-requested";
      if (link === "manual") current.manualRunCount += 1;
      if (link === "service") current.serviceRunCount += 1;
      const requesterPubkey =
        link === "manual"
          ? (run.workflowResult?.manualTriggerRef?.pubkey ??
            run.pendingRun?.manualTriggerRef?.pubkey)
          : (run.workflowResult?.serviceRequestRef?.pubkey ??
            run.pendingRun?.serviceRequestRef?.pubkey);
      if (
        requesterPubkey &&
        !current.requesterPubkeys.includes(requesterPubkey)
      ) {
        current.requesterPubkeys.push(requesterPubkey);
      }
    }
    relationships.set(run.pubkey, current);
  }

  for (const control of serviceControls) {
    if (
      !control.isRequest ||
      !confirmedMaintainers.includes(control.event.pubkey)
    ) {
      continue;
    }
    const current = relationships.get(control.coordinatorPubkey) ?? {
      level: "unassociated" as const,
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [],
    };
    if (!current.requesterPubkeys.includes(control.event.pubkey)) {
      current.requesterPubkeys.push(control.event.pubkey);
    }
    relationships.set(control.coordinatorPubkey, current);
  }

  for (const pubkey of previouslyRequestedCoordinatorPubkeys) {
    const current = relationships.get(pubkey) ?? {
      level: "unassociated" as const,
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [],
    };
    current.level = "previously-requested";
    relationships.set(pubkey, current);
  }

  for (const pubkey of requestedCoordinatorPubkeys) {
    const current = relationships.get(pubkey) ?? {
      level: "unassociated" as const,
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [],
    };
    current.level = "requested";
    relationships.set(pubkey, current);
  }

  return relationships;
}

export function getCICoordinatorRelationship(
  relationships: ReadonlyMap<string, CICoordinatorRelationship>,
  pubkey: string,
): CICoordinatorRelationship {
  return (
    relationships.get(pubkey) ?? {
      level: "unassociated",
      manualRunCount: 0,
      serviceRunCount: 0,
      requesterPubkeys: [],
    }
  );
}
