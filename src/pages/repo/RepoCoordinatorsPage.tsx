import { useMemo } from "react";
import { Link } from "react-router-dom";
import { nip19 } from "nostr-tools";
import { useActiveAccount } from "applesauce-react/hooks";
import { useSeoMeta } from "@unhead/react";
import { ArrowLeft, ArrowUpRight, RadioTower } from "lucide-react";
import {
  CICoordinatorDetailsCard,
  CICoordinatorDirectory,
  CIServiceControlPanel,
} from "@/components/ci/CICoordinatorPanel";
import { CICoordinatorLink } from "@/components/ci/CICoordinatorLink";
import { RepoActionsList } from "@/components/ci/RepoActionsList";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRepoCI } from "@/hooks/useCI";
import { getCICoordinatorRelationship } from "@/lib/ciCoordinatorRelationship";
import { useRepositoryCITrust } from "@/hooks/useRepositoryCITrust";
import { decodePubkeyIdentifier } from "@/lib/routeUtils";
import NotFound from "@/pages/NotFound";
import { useRepoContext } from "./RepoContext";

export default function RepoCoordinatorsPage({
  coordinatorIdentifier,
}: {
  coordinatorIdentifier?: string;
}) {
  const { resolved, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const account = useActiveAccount();
  const coordinatorPubkey = coordinatorIdentifier
    ? decodePubkeyIdentifier(coordinatorIdentifier)
    : undefined;
  const runs = useRepoCI(
    repo?.confirmedMaintainerCoordinates,
    repo?.selectedCoordinate,
  );
  const {
    coordinatorState,
    relationships: coordinatorRelationships,
    trust,
  } = useRepositoryCITrust(repo, runs);
  const coordinators = coordinatorState?.coordinators;
  const coordinator = coordinators?.find(
    ({ pubkey }) => pubkey === coordinatorPubkey,
  );
  const coordinatorPageHeading =
    coordinators === undefined || coordinator
      ? "Coordinator service"
      : "Offline coordinator";
  const coordinatorRuns = useMemo(
    () =>
      coordinatorPubkey
        ? runs?.filter(({ pubkey }) => pubkey === coordinatorPubkey)
        : undefined,
    [coordinatorPubkey, runs],
  );
  const coordinatorControls = useMemo(
    () =>
      coordinatorPubkey
        ? coordinatorState?.serviceControls.filter(
            ({ coordinatorPubkey: target }) => target === coordinatorPubkey,
          )
        : undefined,
    [coordinatorPubkey, coordinatorState?.serviceControls],
  );
  const isMaintainer =
    !!account && !!repo?.confirmedMaintainers.includes(account.pubkey);

  useSeoMeta({
    title: repo
      ? `${coordinatorIdentifier ? "Coordinator" : "CI coordinators"} - ${repo.name} - ngit`
      : "CI coordinators - ngit",
    description: coordinatorIdentifier
      ? "CI coordinator details and repository workflow runs"
      : "CI coordinators available to this repository",
  });

  if (coordinatorIdentifier && !coordinatorPubkey) return <NotFound />;

  if (!coordinatorPubkey) {
    return (
      <div className="container max-w-screen-xl px-4 py-6 md:px-8">
        <PageBackLink to={`${basePath}/actions`} label="Actions" />
        <div className="mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500/20 to-violet-500/20 text-pink-500">
              <RadioTower className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                CI coordinators
              </h1>
              <p className="text-sm text-muted-foreground">
                Live services and offline coordinators with request or workflow
                history for this repository.
              </p>
            </div>
          </div>
        </div>
        <CICoordinatorDirectory
          coordinators={coordinators}
          runs={runs}
          basePath={basePath}
          relationships={coordinatorRelationships}
          trust={trust}
        />
      </div>
    );
  }

  const coordinatorRelationship = getCICoordinatorRelationship(
    coordinatorRelationships,
    coordinatorPubkey,
  );

  return (
    <div className="container max-w-screen-xl px-4 py-6 md:px-8">
      <PageBackLink
        to={`${basePath}/actions/coordinators`}
        label="CI coordinators"
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {coordinatorPageHeading}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {coordinators === undefined || coordinator
              ? "Service details and workflow activity for this coordinator."
              : "Historical request and workflow activity from this offline coordinator."}
          </p>
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="gap-1.5 self-start"
        >
          <Link to={`/coordinator/${nip19.npubEncode(coordinatorPubkey)}`}>
            Coordinator profile
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <section className="mb-7 space-y-4" aria-label="Coordinator details">
        {coordinators === undefined || !repo ? (
          <Card>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-8 w-56" />
            </CardContent>
          </Card>
        ) : coordinator ? (
          <CICoordinatorDetailsCard
            summary={coordinator}
            repo={repo}
            isMaintainer={isMaintainer}
            relationship={coordinatorRelationship}
            controls={coordinatorControls ?? []}
            trust={trust}
          />
        ) : (
          <Card className="border-amber-500/30 bg-amber-500/[0.06]">
            <CardContent className="space-y-4 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <CICoordinatorLink pubkey={coordinatorPubkey} avatarSize="md" />
                <p className="text-sm text-muted-foreground sm:ml-auto">
                  This coordinator is offline; no unexpired service
                  advertisement is available.
                  {isMaintainer &&
                    " It cannot currently accept secret updates over Nostr."}{" "}
                  Historical request and workflow activity remains visible
                  below.
                </p>
              </div>
              {coordinatorControls && (
                <CIServiceControlPanel
                  coordinatorPubkey={coordinatorPubkey}
                  controls={coordinatorControls}
                  repo={repo}
                  isMaintainer={isMaintainer}
                  executionPolicy={undefined}
                  relationship={coordinatorRelationship}
                  availability={undefined}
                  trust={trust}
                />
              )}
            </CardContent>
          </Card>
        )}
      </section>

      <RepoActionsList
        title="Actions by this coordinator"
        runs={coordinatorRuns}
        repo={repo}
        basePath={basePath}
        canRetry={isMaintainer}
        coordinatorRelationships={coordinatorRelationships}
        serviceControls={coordinatorState?.serviceControls}
        trust={trust}
      />
    </div>
  );
}

function PageBackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      {label}
    </Link>
  );
}
