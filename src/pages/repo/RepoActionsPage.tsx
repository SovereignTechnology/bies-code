/** Repository-wide CI activity with adaptive coordinator trust filtering. */

import { useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useSeoMeta } from "@unhead/react";
import { RepoActionsList } from "@/components/ci/RepoActionsList";
import { CICoordinatorSummaryBar } from "@/components/ci/CICoordinatorPanel";
import { useCICoordinators } from "@/hooks/useCICoordinators";
import { useRepoCI } from "@/hooks/useCI";
import { classifyCICoordinatorRelationships } from "@/lib/ciCoordinatorRelationship";
import { useRepoContext } from "./RepoContext";

const EMPTY_PUBKEYS: ReadonlySet<string> = new Set();

export default function RepoActionsPage() {
  const { resolved, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const account = useActiveAccount();
  const isMaintainer =
    !!account && !!repo?.confirmedMaintainers.includes(account.pubkey);
  const runs = useRepoCI(repo?.allCoordinates, resolved?.repoRelayGroup);
  const coordinatorState = useCICoordinators(
    repo?.allCoordinates,
    repo?.selectedCoordinate,
    repo?.confirmedMaintainers,
    resolved?.repoRelayGroup,
  );
  const coordinators = coordinatorState?.coordinators;
  const requestedCoordinatorPubkeys =
    coordinatorState?.currentlyRequestedCoordinatorPubkeys ?? EMPTY_PUBKEYS;
  const previouslyRequestedCoordinatorPubkeys =
    coordinatorState?.previouslyRequestedCoordinatorPubkeys ?? EMPTY_PUBKEYS;
  const coordinatorAvailability = useMemo(
    () =>
      new Map(
        (coordinators ?? []).map(
          ({ pubkey, availability }) => [pubkey, availability] as const,
        ),
      ),
    [coordinators],
  );
  const coordinatorRelationships = useMemo(
    () =>
      classifyCICoordinatorRelationships(
        runs ?? [],
        repo?.confirmedMaintainers ?? [],
        requestedCoordinatorPubkeys,
        previouslyRequestedCoordinatorPubkeys,
      ),
    [
      previouslyRequestedCoordinatorPubkeys,
      repo?.confirmedMaintainers,
      requestedCoordinatorPubkeys,
      runs,
    ],
  );

  useSeoMeta({
    title: repo ? `Actions - ${repo.name} - ngit` : "Actions - ngit",
    description: "CI workflow runs for this repository",
  });

  return (
    <div className="container max-w-screen-xl px-4 py-6 md:px-8">
      <CICoordinatorSummaryBar
        coordinators={coordinators}
        runs={runs}
        basePath={basePath}
        relationships={coordinatorRelationships}
      />

      <RepoActionsList
        runs={coordinators === undefined ? undefined : runs}
        repo={repo}
        basePath={basePath}
        canRetry={isMaintainer}
        coordinatorRelationships={coordinatorRelationships}
        serviceControls={coordinatorState?.serviceControls}
        coordinatorAvailability={coordinatorAvailability}
        adaptiveCoordinatorFilter
      />
    </div>
  );
}
