/** Repository-wide CI activity with adaptive coordinator trust filtering. */

import { useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { useSeoMeta } from "@unhead/react";
import { RepoActionsList } from "@/components/ci/RepoActionsList";
import { CICoordinatorSummaryBar } from "@/components/ci/CICoordinatorPanel";
import { useRepoCI } from "@/hooks/useCI";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";
import { useRepoContext } from "./RepoContext";

export default function RepoActionsPage() {
  const { resolved, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const account = useActiveAccount();
  const isMaintainer =
    !!account && !!repo?.confirmedMaintainers.includes(account.pubkey);
  const runs = useRepoCI(repo?.allCoordinates, resolved?.repoRelayGroup);
  const { coordinatorState, relationships, trust } = useRepositoryCITrust(
    repo,
    runs,
    resolved?.repoRelayGroup,
  );
  const coordinators = coordinatorState?.coordinators;
  const coordinatorAvailability = useMemo(
    () =>
      new Map(
        (coordinators ?? []).map(
          ({ pubkey, availability }) => [pubkey, availability] as const,
        ),
      ),
    [coordinators],
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
        relationships={relationships}
        trust={trust}
      />

      <RepoActionsList
        runs={coordinators === undefined ? undefined : runs}
        repo={repo}
        basePath={basePath}
        canRetry={isMaintainer}
        coordinatorRelationships={relationships}
        serviceControls={coordinatorState?.serviceControls}
        coordinatorAvailability={coordinatorAvailability}
        adaptiveCoordinatorFilter
        trust={trust}
      />
    </div>
  );
}
