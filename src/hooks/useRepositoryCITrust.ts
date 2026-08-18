import { useMemo } from "react";
import type { RelayGroup } from "applesauce-relay";
import { useCICoordinators } from "@/hooks/useCICoordinators";
import { useCITrustContext } from "@/hooks/useCITrustContext";
import type { CIWorkflowRun } from "@/lib/ci";
import { classifyCICoordinatorRelationships } from "@/lib/ciCoordinatorRelationship";
import type { ResolvedRepo } from "@/lib/nip34";

const EMPTY_PUBKEYS: ReadonlySet<string> = new Set();

export function useRepositoryCITrust(
  repo: ResolvedRepo | undefined,
  runs: readonly CIWorkflowRun[] | undefined,
  repoRelayGroup: RelayGroup | undefined,
) {
  const coordinatorState = useCICoordinators(
    repo?.allCoordinates,
    repo?.selectedCoordinate,
    repo?.confirmedMaintainers,
    repoRelayGroup,
  );
  const relationships = useMemo(
    () =>
      classifyCICoordinatorRelationships(
        runs ?? [],
        repo?.confirmedMaintainers ?? [],
        coordinatorState?.currentlyRequestedCoordinatorPubkeys ?? EMPTY_PUBKEYS,
        coordinatorState?.previouslyRequestedCoordinatorPubkeys ??
          EMPTY_PUBKEYS,
      ),
    [coordinatorState, repo?.confirmedMaintainers, runs],
  );
  const trust = useCITrustContext({
    repo,
    runs,
    coordinatorRelationships: relationships,
    coordinatorState,
  });

  return { coordinatorState, relationships, trust };
}
