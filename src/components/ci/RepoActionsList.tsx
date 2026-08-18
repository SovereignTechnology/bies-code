import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GitPullRequest, Users, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { workflowRunRepoCoords, type CIWorkflowRun } from "@/lib/ci";
import {
  getCICoordinatorRelationship,
  getCIRunMaintainerLink,
  type CICoordinatorRelationship,
  type CIRunMaintainerLink,
  wasCIServiceRequestedWhenRunStarted,
} from "@/lib/ciCoordinatorRelationship";
import {
  getCIRunTrustResolution,
  type CITrustContextState,
  type CITrustResolution,
} from "@/lib/ciTrustContext";
import type { CIServiceControl } from "@/casts/CICoordinator";
import type { ResolvedRepo } from "@/lib/nip34";
import { hasAcceptedRepositoryReference } from "@/lib/nip34";
import { eventIdToNevent } from "@/lib/routeUtils";
import {
  RepoItemAttributionIndicator,
  RepoItemAttributionWarning,
} from "@/components/RepoItemAttributionWarning";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CIRunRow, CITriggerRefBadge } from "./CIChecksPanel";
import { CITrustContextLabel } from "./CITrustContextLabel";

const ALL = "__all__";
const RELATED = "__related__";
const REQUESTED_NOW = "__requested_now__";
const REQUESTED_PREVIOUSLY = "__requested_previously__";
const UNASSOCIATED = "__unassociated__";
const EMPTY_RELATIONSHIPS: ReadonlyMap<string, CICoordinatorRelationship> =
  new Map();
const EMPTY_SERVICE_CONTROLS: readonly CIServiceControl[] = [];

interface RepoActionsListProps {
  runs: CIWorkflowRun[] | undefined;
  repo: ResolvedRepo | undefined;
  basePath: string;
  canRetry: boolean;
  title?: string;
  coordinatorRelationships?: ReadonlyMap<string, CICoordinatorRelationship>;
  serviceControls?: readonly CIServiceControl[];
  coordinatorAvailability?: ReadonlyMap<
    string,
    "watching" | "ready" | "available"
  >;
  adaptiveCoordinatorFilter?: boolean;
  showCoordinatorTrust?: boolean;
  trust?: CITrustContextState;
}

export function RepoActionsList({
  runs,
  repo,
  basePath,
  canRetry,
  title = "Actions",
  coordinatorRelationships = EMPTY_RELATIONSHIPS,
  serviceControls = EMPTY_SERVICE_CONTROLS,
  coordinatorAvailability,
  adaptiveCoordinatorFilter = false,
  showCoordinatorTrust = false,
  trust,
}: RepoActionsListProps) {
  const [coordinatorFilter, setCoordinatorFilter] = useState<string>(ALL);
  const [workflowFilter, setWorkflowFilter] = useState<string>(ALL);
  const [triggerFilter, setTriggerFilter] = useState<string>(ALL);

  const classifiedRuns = useMemo(
    () =>
      (runs ?? []).map((run) => ({
        run,
        maintainerLink: getCIRunMaintainerLink(
          run,
          repo?.confirmedMaintainers ?? [],
        ),
        serviceRequestedAtRun: wasCIServiceRequestedWhenRunStarted(
          run,
          serviceControls,
        ),
        relationship: getCICoordinatorRelationship(
          coordinatorRelationships,
          run.pubkey,
        ),
        trustResolution: trust
          ? getCIRunTrustResolution(
              trust,
              run,
              repo?.confirmedMaintainers ?? [],
              serviceControls,
            )
          : undefined,
      })),
    [
      coordinatorRelationships,
      repo?.confirmedMaintainers,
      runs,
      serviceControls,
      trust,
    ],
  );
  const coordinatorOptions = useMemo(() => {
    if (!coordinatorAvailability) return [];

    const runCounts = new Map<string, number>();
    for (const { run } of classifiedRuns) {
      runCounts.set(run.pubkey, (runCounts.get(run.pubkey) ?? 0) + 1);
    }

    const relationshipRank: Record<CICoordinatorRelationship["level"], number> =
      {
        requested: 0,
        "previously-requested": 1,
        unassociated: 2,
      };

    return [...runCounts]
      .map(([pubkey, runCount]) => ({
        pubkey,
        runCount,
        availability: coordinatorAvailability.get(pubkey),
        relationship: getCICoordinatorRelationship(
          coordinatorRelationships,
          pubkey,
        ),
      }))
      .sort(
        (a, b) =>
          Number(b.availability !== undefined) -
            Number(a.availability !== undefined) ||
          relationshipRank[a.relationship.level] -
            relationshipRank[b.relationship.level] ||
          b.runCount - a.runCount ||
          a.pubkey.localeCompare(b.pubkey),
      );
  }, [classifiedRuns, coordinatorAvailability, coordinatorRelationships]);
  const relatedRuns = useMemo(
    () =>
      classifiedRuns.filter(
        ({ relationship }) => relationship.level !== "unassociated",
      ),
    [classifiedRuns],
  );
  const unassociatedRuns = useMemo(
    () =>
      classifiedRuns.filter(
        ({ relationship }) => relationship.level === "unassociated",
      ),
    [classifiedRuns],
  );
  const unassociatedCoordinatorCount = useMemo(
    () => new Set(unassociatedRuns.map(({ run }) => run.pubkey)).size,
    [unassociatedRuns],
  );
  const relatedCoordinatorCount = useMemo(
    () => new Set(relatedRuns.map(({ run }) => run.pubkey)).size,
    [relatedRuns],
  );
  const requestedNowCoordinatorCount = useMemo(
    () =>
      new Set(
        classifiedRuns
          .filter(({ relationship }) => relationship.level === "requested")
          .map(({ run }) => run.pubkey),
      ).size,
    [classifiedRuns],
  );
  const requestedPreviouslyCoordinatorCount = useMemo(
    () =>
      new Set(
        classifiedRuns
          .filter(
            ({ relationship }) => relationship.level === "previously-requested",
          )
          .map(({ run }) => run.pubkey),
      ).size,
    [classifiedRuns],
  );
  const coordinatorVisibleRuns = useMemo(() => {
    switch (coordinatorFilter) {
      case ALL:
        return classifiedRuns;
      case RELATED:
        return classifiedRuns.filter(
          ({ relationship }) => relationship.level !== "unassociated",
        );
      case REQUESTED_NOW:
        return classifiedRuns.filter(
          ({ relationship }) => relationship.level === "requested",
        );
      case REQUESTED_PREVIOUSLY:
        return classifiedRuns.filter(
          ({ relationship }) => relationship.level === "previously-requested",
        );
      case UNASSOCIATED:
        return unassociatedRuns;
      default:
        return classifiedRuns.filter(
          ({ run }) => run.pubkey === coordinatorFilter,
        );
    }
  }, [classifiedRuns, coordinatorFilter, unassociatedRuns]);

  const workflows = useMemo(() => {
    const values = new Set<string>();
    for (const { run } of coordinatorVisibleRuns) {
      if (run.workflowPath) values.add(run.workflowPath);
    }
    return [...values].sort();
  }, [coordinatorVisibleRuns]);

  const triggers = useMemo(() => {
    const values = new Set<string>();
    for (const { run } of coordinatorVisibleRuns) {
      if (run.trigger) values.add(run.trigger);
    }
    return [...values].sort();
  }, [coordinatorVisibleRuns]);

  const hasActiveFilters =
    coordinatorFilter !== ALL ||
    workflowFilter !== ALL ||
    triggerFilter !== ALL;
  const filteredRuns = useMemo(() => {
    if (!runs) return undefined;
    return coordinatorVisibleRuns.filter(
      ({ run }) =>
        (workflowFilter === ALL || run.workflowPath === workflowFilter) &&
        (triggerFilter === ALL || run.trigger === triggerFilter),
    );
  }, [coordinatorVisibleRuns, runs, triggerFilter, workflowFilter]);

  const visibleUnconfirmedRuns = useMemo(() => {
    if (!repo || !filteredRuns) return [];
    return filteredRuns.filter(
      ({ run }) =>
        !hasAcceptedRepositoryReference(workflowRunRepoCoords(run), repo),
    );
  }, [filteredRuns, repo]);
  const unconfirmedRunKeys = useMemo(
    () => new Set(visibleUnconfirmedRuns.map(({ run }) => run.key)),
    [visibleUnconfirmedRuns],
  );
  const visibleAcceptedRuns = useMemo(
    () =>
      filteredRuns?.filter(({ run }) => !unconfirmedRunKeys.has(run.key)) ?? [],
    [filteredRuns, unconfirmedRunKeys],
  );
  const unconfirmedRepoCoords = useMemo(
    () =>
      visibleUnconfirmedRuns.flatMap(({ run }) => workflowRunRepoCoords(run)),
    [visibleUnconfirmedRuns],
  );

  const selectCoordinator = (pubkey: string) => {
    setCoordinatorFilter(pubkey);
    setWorkflowFilter(ALL);
    setTriggerFilter(ALL);
  };
  const selectedCoordinator = coordinatorOptions.find(
    ({ pubkey }) => pubkey === coordinatorFilter,
  );
  const viewingUnassociatedOnly =
    coordinatorFilter === UNASSOCIATED ||
    selectedCoordinator?.relationship.level === "unassociated" ||
    (coordinatorFilter === ALL && relatedCoordinatorCount === 0);

  return (
    <section aria-labelledby="repo-actions-title">
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center">
        <h2 id="repo-actions-title" className="shrink-0 text-lg font-semibold">
          {title}
        </h2>

        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {(coordinatorOptions.length > 1 ||
            (adaptiveCoordinatorFilter &&
              unassociatedCoordinatorCount > 0)) && (
            <Select value={coordinatorFilter} onValueChange={selectCoordinator}>
              <SelectTrigger
                className="h-9 w-full text-sm sm:w-[250px]"
                aria-label="Filter actions by coordinator"
              >
                <SelectValue placeholder="Coordinator" />
              </SelectTrigger>
              <SelectContent>
                {adaptiveCoordinatorFilter && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground">
                      Relationship
                    </SelectLabel>
                    <SelectItem value={ALL}>All coordinators</SelectItem>
                    {relatedCoordinatorCount > 0 && (
                      <SelectItem value={RELATED}>
                        Requested now or previously ({relatedCoordinatorCount})
                      </SelectItem>
                    )}
                    {requestedNowCoordinatorCount > 0 && (
                      <SelectItem value={REQUESTED_NOW}>
                        Requested now ({requestedNowCoordinatorCount})
                      </SelectItem>
                    )}
                    {requestedPreviouslyCoordinatorCount > 0 && (
                      <SelectItem value={REQUESTED_PREVIOUSLY}>
                        Requested previously (
                        {requestedPreviouslyCoordinatorCount})
                      </SelectItem>
                    )}
                    {unassociatedCoordinatorCount > 0 && (
                      <SelectItem value={UNASSOCIATED}>
                        Unassociated coordinators (
                        {unassociatedCoordinatorCount})
                      </SelectItem>
                    )}
                  </SelectGroup>
                )}

                {adaptiveCoordinatorFilter && <SelectSeparator />}

                <SelectGroup>
                  {adaptiveCoordinatorFilter && (
                    <SelectLabel className="text-xs text-muted-foreground">
                      Coordinator
                    </SelectLabel>
                  )}
                  {!adaptiveCoordinatorFilter && (
                    <SelectItem value={ALL}>All coordinators</SelectItem>
                  )}
                  {coordinatorOptions.map(
                    ({ pubkey, runCount, availability, relationship }) => (
                      <SelectItem
                        key={pubkey}
                        value={pubkey}
                        textValue={`${nip19.npubEncode(pubkey)} ${coordinatorAvailabilityLabel(availability)}`}
                      >
                        <span className="flex min-w-0 flex-col py-0.5">
                          <span className="truncate font-mono text-xs">
                            {nip19.npubEncode(pubkey).slice(0, 16)}…
                          </span>
                          <span className="truncate text-[10px] text-muted-foreground">
                            {coordinatorAvailabilityLabel(availability)} ·{" "}
                            {runCount} run{runCount === 1 ? "" : "s"}
                            {relationship.level === "requested"
                              ? " · requested now"
                              : relationship.level === "previously-requested"
                                ? " · requested previously"
                                : " · unassociated"}
                          </span>
                        </span>
                      </SelectItem>
                    ),
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          {workflows.length > 1 && (
            <Select value={workflowFilter} onValueChange={setWorkflowFilter}>
              <SelectTrigger className="h-9 w-full text-sm sm:w-[220px]">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Workflows</SelectItem>
                {workflows.map((workflow) => (
                  <SelectItem key={workflow} value={workflow}>
                    <span className="font-mono text-xs">{workflow}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {triggers.length > 1 && (
            <Select value={triggerFilter} onValueChange={setTriggerFilter}>
              <SelectTrigger className="h-9 w-[150px] text-sm">
                <SelectValue placeholder="Trigger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Triggers</SelectItem>
                {triggers.map((trigger) => (
                  <SelectItem key={trigger} value={trigger}>
                    {trigger}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCoordinatorFilter(ALL);
                setWorkflowFilter(ALL);
                setTriggerFilter(ALL);
              }}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Reset
            </Button>
          )}
        </div>
      </div>

      {adaptiveCoordinatorFilter &&
        viewingUnassociatedOnly &&
        unassociatedRuns.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-muted-foreground">
            <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <p>
              These coordinators have no current request or maintainer-requested
              run history. Their activity is shown for transparency, not as a
              maintainer endorsement.
            </p>
          </div>
        )}

      {!filteredRuns ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, index) => (
              <ActionRowSkeleton key={index} />
            ))}
          </ul>
        </div>
      ) : visibleAcceptedRuns.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-muted-foreground">
              {hasActiveFilters
                ? "No workflow runs match your filters."
                : "No workflow runs found for this repository yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <ul className="divide-y divide-border">
            {visibleAcceptedRuns.map(
              ({ run, maintainerLink, trustResolution }) => (
                <RepoActionRunRow
                  key={run.key}
                  run={run}
                  maintainerLink={maintainerLink}
                  trustResolution={trustResolution}
                  showCoordinatorTrust={
                    showCoordinatorTrust || adaptiveCoordinatorFilter
                  }
                  repo={repo}
                  basePath={basePath}
                  canRetry={canRetry}
                  trust={trust}
                />
              ),
            )}
          </ul>
        </div>
      )}

      {repo && visibleUnconfirmedRuns.length > 0 && (
        <section className="mt-6">
          <RepoItemAttributionWarning
            repo={repo}
            repoCoords={unconfirmedRepoCoords}
            itemLabel="workflow"
            pageSuffix="/actions"
            count={visibleUnconfirmedRuns.length}
            className="rounded-b-none shadow-none"
          />
          <div className="overflow-hidden rounded-b-lg border border-t-0 border-amber-500/40">
            <ul className="divide-y divide-border">
              {visibleUnconfirmedRuns.map(
                ({ run, maintainerLink, trustResolution }) => (
                  <RepoActionRunRow
                    key={run.key}
                    run={run}
                    maintainerLink={maintainerLink}
                    trustResolution={trustResolution}
                    showCoordinatorTrust={
                      showCoordinatorTrust || adaptiveCoordinatorFilter
                    }
                    repo={repo}
                    basePath={basePath}
                    canRetry={canRetry}
                    trust={trust}
                  />
                ),
              )}
            </ul>
          </div>
        </section>
      )}
    </section>
  );
}

function coordinatorAvailabilityLabel(
  availability: "watching" | "ready" | "available" | undefined,
): string {
  switch (availability) {
    case "watching":
      return "Watching";
    case "ready":
      return "Ready, not watching";
    case "available":
      return "Available, not watching";
    default:
      return "Offline";
  }
}

function RepoActionRunRow({
  run,
  maintainerLink,
  trustResolution,
  showCoordinatorTrust,
  repo,
  basePath,
  canRetry,
  trust,
}: {
  run: CIWorkflowRun;
  maintainerLink: CIRunMaintainerLink;
  trustResolution: CITrustResolution | undefined;
  showCoordinatorTrust: boolean;
  repo: ResolvedRepo | undefined;
  basePath: string;
  canRetry: boolean;
  trust: CITrustContextState | undefined;
}) {
  const repoCoords = workflowRunRepoCoords(run);
  const needsAttributionCheck =
    repo !== undefined && !hasAcceptedRepositoryReference(repoCoords, repo);
  const trustIndicator = trustResolution ? (
    <CITrustContextLabel
      resolution={trustResolution}
      visibility="exceptions-only"
    />
  ) : undefined;

  return (
    <CIRunRow
      run={run}
      canRetry={canRetry}
      maintainerRequestedOverride={
        showCoordinatorTrust ? false : maintainerLink !== undefined
      }
      trustIndicator={trustIndicator}
      providerTrust={trust}
      attributionIndicator={
        needsAttributionCheck ? (
          <RepoItemAttributionIndicator
            repo={repo}
            repoCoords={repoCoords}
            itemLabel="workflow"
            pageSuffix="/actions"
          />
        ) : undefined
      }
      triggerContext={
        <RunTriggerContext
          run={run}
          basePath={basePath}
          repoRelays={repo?.relays ?? []}
        />
      }
    />
  );
}

function RunTriggerContext({
  run,
  basePath,
  repoRelays,
}: {
  run: CIWorkflowRun;
  basePath: string;
  repoRelays: string[];
}) {
  if (run.prRootId) {
    const nevent = eventIdToNevent(run.prRootId, repoRelays.slice(0, 1));
    return (
      <Link
        to={`${basePath}/prs/${nevent}`}
        className="inline-flex items-center gap-1 transition-colors hover:text-foreground hover:underline"
      >
        <GitPullRequest className="h-3 w-3" />
        PR
      </Link>
    );
  }

  const ref = run.branchRef;
  if (!ref) return null;

  const isBranch = ref.startsWith("refs/heads/");
  const isTag = ref.startsWith("refs/tags/");
  if (!isBranch && !isTag) return null;

  const refName = isBranch
    ? ref.slice("refs/heads/".length)
    : ref.slice("refs/tags/".length);
  if (!refName) return null;

  return (
    <Link
      to={`${basePath}/commits/${refName}`}
      className="inline-flex max-w-32 items-center gap-1 transition-colors hover:text-foreground hover:underline"
    >
      <CITriggerRefBadge triggerRef={ref} />
    </Link>
  );
}

function ActionRowSkeleton() {
  return (
    <li className="flex items-center gap-2 px-4 py-2.5">
      <Skeleton className="h-4 w-4 rounded-full" />
      <Skeleton className="h-4 w-64" />
      <div className="ml-auto flex items-center gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
    </li>
  );
}
