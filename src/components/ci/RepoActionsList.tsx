import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  GitBranch,
  GitPullRequest,
  Search,
  Tag,
  Users,
  X,
} from "lucide-react";
import { nip19 } from "nostr-tools";
import {
  CI_RUN_OUTCOME_LABELS,
  ciRunOutcome,
  ciRunRequester,
  ciWorkflowName,
  getWorkflowTiming,
  workflowRunRepoCoords,
  type CIRunOutcome,
  type CIWorkflowRun,
} from "@/lib/ci";
import {
  getCICoordinatorRelationship,
  getCIRunMaintainerLink,
  type CICoordinatorRelationship,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserLink } from "@/components/UserAvatar";
import { useProfilesForPubkeys } from "@/hooks/useProfilesForPubkeys";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { CITrustContextLabel } from "./CITrustContextLabel";
import { CIRunListRow } from "./CIRunListRow";

const ALL = "__all__";
const RELATED = "__related__";
const REQUESTED_NOW = "__requested_now__";
const REQUESTED_PREVIOUSLY = "__requested_previously__";
const UNASSOCIATED = "__unassociated__";
const PULL_REQUESTS = "__pull_requests__";
const REQUESTER_PREFIX = "requester:";
const COORDINATOR_PREFIX = "coordinator:";
const OUTCOME_ORDER: CIRunOutcome[] = [
  "running",
  "queued",
  "success",
  "failure",
  "cancelled",
];
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
  trust,
}: RepoActionsListProps) {
  const [coordinatorFilter, setCoordinatorFilter] = useState<string>(ALL);
  const [workflowFilter, setWorkflowFilter] = useState<string>(ALL);
  const [triggerFilter, setTriggerFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [branchFilter, setBranchFilter] = useState<string>(ALL);
  const [actorFilter, setActorFilter] = useState<string>(ALL);
  const [query, setQuery] = useState("");

  const classifiedRuns = useMemo(
    () =>
      (runs ?? []).map((run) => ({
        run,
        // Only name requesters the repository confirms as maintainers; the
        // quote itself is coordinator-supplied.
        requester: getCIRunMaintainerLink(run, repo?.confirmedMaintainers ?? [])
          ? ciRunRequester(run)
          : undefined,
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

  const statuses = useMemo(() => {
    const values = new Set(
      coordinatorVisibleRuns.map(({ run }) => ciRunOutcome(run)),
    );
    return OUTCOME_ORDER.filter((outcome) => values.has(outcome));
  }, [coordinatorVisibleRuns]);

  const branches = useMemo(() => {
    const values = new Map<string, "branch" | "tag" | "pr">();
    for (const { run } of coordinatorVisibleRuns) {
      const key = runBranchKey(run);
      if (!key) continue;
      values.set(
        key,
        key === PULL_REQUESTS
          ? "pr"
          : run.branchRef?.startsWith("refs/tags/")
            ? "tag"
            : "branch",
      );
    }
    return [...values]
      .map(([value, kind]) => ({ value, kind }))
      .sort(
        (a, b) =>
          Number(a.value === PULL_REQUESTS) -
            Number(b.value === PULL_REQUESTS) || a.value.localeCompare(b.value),
      );
  }, [coordinatorVisibleRuns]);

  // "Triggered by" covers maintainers who requested a run and the
  // coordinators that ran it; values are prefixed to keep the roles apart.
  const actors = useMemo(() => {
    const requesters = new Set<string>();
    const coordinators = new Set<string>();
    for (const { run, requester } of coordinatorVisibleRuns) {
      if (requester) requesters.add(requester);
      coordinators.add(run.pubkey);
    }
    return {
      requesters: [...requesters].sort(),
      coordinators: [...coordinators].sort(),
    };
  }, [coordinatorVisibleRuns]);

  const searchPubkeys = useMemo(
    () => [...new Set([...actors.requesters, ...actors.coordinators])],
    [actors],
  );
  const profiles = useProfilesForPubkeys(searchPubkeys);
  const shortName = (pubkey: string) =>
    profiles.get(pubkey)?.display_name ||
    profiles.get(pubkey)?.name ||
    `${nip19.npubEncode(pubkey).slice(0, 12)}…`;

  const normalizedQuery = query.trim().toLowerCase();
  const hasActiveFilters =
    coordinatorFilter !== ALL ||
    workflowFilter !== ALL ||
    triggerFilter !== ALL ||
    statusFilter !== ALL ||
    branchFilter !== ALL ||
    actorFilter !== ALL ||
    normalizedQuery !== "";
  const filteredRuns = useMemo(() => {
    if (!runs) return undefined;
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const pubkeyText = (pubkey: string | undefined) => {
      if (!pubkey) return "";
      const profile = profiles.get(pubkey);
      return [
        pubkey,
        nip19.npubEncode(pubkey),
        profile?.display_name,
        profile?.name,
        profile?.nip05,
      ]
        .filter(Boolean)
        .join(" ");
    };
    return coordinatorVisibleRuns
      .filter(({ run, requester }) => {
        if (workflowFilter !== ALL && run.workflowPath !== workflowFilter)
          return false;
        if (triggerFilter !== ALL && run.trigger !== triggerFilter)
          return false;
        if (statusFilter !== ALL && ciRunOutcome(run) !== statusFilter)
          return false;
        if (branchFilter !== ALL && runBranchKey(run) !== branchFilter)
          return false;
        if (
          actorFilter !== ALL &&
          actorFilter !== `${REQUESTER_PREFIX}${requester}` &&
          actorFilter !== `${COORDINATOR_PREFIX}${run.pubkey}`
        )
          return false;
        if (terms.length === 0) return true;

        const haystack = [
          ciWorkflowName(run.workflowPath),
          run.workflowPath,
          run.commitId,
          run.branchRef,
          run.prRootId ? "pr pull request" : undefined,
          run.trigger,
          CI_RUN_OUTCOME_LABELS[ciRunOutcome(run)],
          run.runner,
          run.platform,
          pubkeyText(requester),
          pubkeyText(run.pubkey),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => runStartedAt(b.run) - runStartedAt(a.run));
  }, [
    actorFilter,
    branchFilter,
    coordinatorVisibleRuns,
    normalizedQuery,
    profiles,
    runs,
    statusFilter,
    triggerFilter,
    workflowFilter,
  ]);

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

  const resetDependentFilters = () => {
    setWorkflowFilter(ALL);
    setTriggerFilter(ALL);
    setStatusFilter(ALL);
    setBranchFilter(ALL);
    setActorFilter(ALL);
  };
  const selectCoordinator = (pubkey: string) => {
    setCoordinatorFilter(pubkey);
    resetDependentFilters();
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
      <h2 id="repo-actions-title" className="mb-3 text-lg font-semibold">
        {title}
      </h2>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col gap-2 border-b border-border px-3 py-3 lg:flex-row lg:items-center lg:gap-3 lg:px-4">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Search
              className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="sr-only">Search workflow runs</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search runs, commits, branches, actors…"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <div className="-mx-1 flex flex-wrap items-center gap-0.5">
            <FilterMenu
              label="Workflow"
              value={workflowFilter}
              onChange={setWorkflowFilter}
              options={workflows.map((workflow) => ({
                value: workflow,
                label: (
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{ciWorkflowName(workflow)}</span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {workflow}
                    </span>
                  </span>
                ),
                selectedLabel: ciWorkflowName(workflow),
              }))}
            />
            <FilterMenu
              label="Trigger"
              value={triggerFilter}
              onChange={setTriggerFilter}
              options={triggers.map((trigger) => ({
                value: trigger,
                label: trigger,
              }))}
            />
            <FilterMenu
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={statuses.map((outcome) => ({
                value: outcome,
                label: CI_RUN_OUTCOME_LABELS[outcome],
              }))}
            />
            <FilterMenu
              label="Branch"
              value={branchFilter}
              onChange={setBranchFilter}
              options={branches.map(({ value, kind }) => {
                const Icon =
                  kind === "pr"
                    ? GitPullRequest
                    : kind === "tag"
                      ? Tag
                      : GitBranch;
                const text = value === PULL_REQUESTS ? "Pull requests" : value;
                return {
                  value,
                  label: (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{text}</span>
                    </span>
                  ),
                  selectedLabel: text,
                };
              })}
            />
            <FilterMenu
              label="Triggered by"
              value={actorFilter}
              onChange={setActorFilter}
              options={[
                ...actors.requesters.map((pubkey) => ({
                  value: `${REQUESTER_PREFIX}${pubkey}`,
                  group: "Maintainers",
                  label: <UserLink pubkey={pubkey} avatarSize="xs" noLink />,
                  selectedLabel: shortName(pubkey),
                })),
                ...actors.coordinators.map((pubkey) => ({
                  value: `${COORDINATOR_PREFIX}${pubkey}`,
                  group: "Coordinators",
                  label: <UserLink pubkey={pubkey} avatarSize="xs" noLink />,
                  selectedLabel: shortName(pubkey),
                })),
              ]}
            />

            {(coordinatorOptions.length > 1 ||
              (adaptiveCoordinatorFilter &&
                unassociatedCoordinatorCount > 0)) && (
              <Select
                value={coordinatorFilter}
                onValueChange={selectCoordinator}
              >
                <SelectTrigger
                  className="h-9 w-auto gap-1 border-0 bg-transparent px-2.5 text-sm text-muted-foreground shadow-none hover:bg-muted hover:text-foreground focus:ring-0 focus:ring-offset-0 data-[state=open]:bg-muted"
                  aria-label="Filter actions by coordinator"
                >
                  {coordinatorFilter === ALL ? (
                    "Coordinator"
                  ) : (
                    <span className="text-foreground">Coordinator ✓</span>
                  )}
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
                          Requested now or previously ({relatedCoordinatorCount}
                          )
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

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2.5 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setCoordinatorFilter(ALL);
                  resetDependentFilters();
                  setQuery("");
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
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/[0.06] px-4 py-2 text-xs text-muted-foreground">
              <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <p>
                These coordinators have no current request or
                maintainer-requested run history. Their activity is shown for
                transparency, not as a maintainer endorsement.
              </p>
            </div>
          )}

        {!filteredRuns ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, index) => (
              <ActionRowSkeleton key={index} />
            ))}
          </ul>
        ) : visibleAcceptedRuns.length === 0 ? (
          <p className="mx-auto max-w-sm px-8 py-14 text-center text-muted-foreground">
            {hasActiveFilters
              ? "No workflow runs match your filters."
              : "No workflow runs found for this repository yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visibleAcceptedRuns.map(({ run, requester, trustResolution }) => (
              <RepoActionRunRow
                key={run.key}
                run={run}
                requester={requester}
                trustResolution={trustResolution}
                repo={repo}
                basePath={basePath}
                canRetry={canRetry}
                trust={trust}
              />
            ))}
          </ul>
        )}
      </div>

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
          <div className="overflow-hidden rounded-b-xl border border-t-0 border-amber-500/40 bg-card">
            <ul className="divide-y divide-border">
              {visibleUnconfirmedRuns.map(
                ({ run, requester, trustResolution }) => (
                  <RepoActionRunRow
                    key={run.key}
                    run={run}
                    requester={requester}
                    trustResolution={trustResolution}
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
  requester,
  trustResolution,
  repo,
  basePath,
  canRetry,
  trust,
}: {
  run: CIWorkflowRun;
  requester: string | undefined;
  trustResolution: CITrustResolution | undefined;
  repo: ResolvedRepo | undefined;
  basePath: string;
  canRetry: boolean;
  trust: CITrustContextState | undefined;
}) {
  const repoCoords = workflowRunRepoCoords(run);
  const needsAttributionCheck =
    repo !== undefined && !hasAcceptedRepositoryReference(repoCoords, repo);

  return (
    <CIRunListRow
      run={run}
      requester={requester}
      canRetry={canRetry}
      trustIndicator={
        trustResolution ? (
          <CITrustContextLabel
            resolution={trustResolution}
            visibility="exceptions-only"
          />
        ) : undefined
      }
      expandedTrustResolution={trustResolution}
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
      refContext={
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
  const pillClassName =
    "inline-flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 text-sm font-medium text-sky-600 transition-colors hover:border-sky-500/50 hover:bg-sky-500/10 dark:text-sky-400";

  if (run.prRootId) {
    const nevent = eventIdToNevent(run.prRootId, repoRelays.slice(0, 1));
    return (
      <Link to={`${basePath}/prs/${nevent}`} className={pillClassName}>
        <GitPullRequest className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
  const Icon = isBranch ? GitBranch : Tag;

  return (
    <Link
      to={`${basePath}/commits/${refName}`}
      className={pillClassName}
      aria-label={`${isBranch ? "Branch" : "Tag"}: ${refName}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{refName}</span>
    </Link>
  );
}

/** When a run started (or was queued), falling back to its latest event. */
function runStartedAt(run: CIWorkflowRun): number {
  const { queuedAt, startedAt } = getWorkflowTiming(run);
  return startedAt ?? queuedAt ?? run.createdAt;
}

/** Branch-filter key for a run: the branch/tag name, or all PR runs. */
function runBranchKey(run: CIWorkflowRun): string | undefined {
  if (run.prRootId) return PULL_REQUESTS;
  const ref = run.branchRef;
  if (ref?.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref?.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return undefined;
}

interface FilterOption {
  value: string;
  label: ReactNode;
  /** Consecutive options sharing a group render under one heading. */
  group?: string;
  /** Plain text shown on the trigger once selected (defaults to label). */
  selectedLabel?: string;
}

function FilterMenu({
  label,
  value,
  onChange,
  options,
  emptyLabel = "Nothing to filter yet",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  emptyLabel?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const active = value !== ALL;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-9 max-w-56 gap-1 px-2.5 text-sm font-normal text-muted-foreground hover:text-foreground data-[state=open]:bg-muted",
            active && "bg-muted text-foreground",
          )}
        >
          <span className="truncate">
            {active && selected
              ? `${label}: ${selected.selectedLabel ?? String(selected.label)}`
              : label}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-60 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Filter by {label.toLowerCase()}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value={ALL}>All</DropdownMenuRadioItem>
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group && option.group !== options[index - 1]?.group && (
                <DropdownMenuLabel className="pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {option.group}
                </DropdownMenuLabel>
              )}
              <DropdownMenuRadioItem value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
        {options.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {emptyLabel}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionRowSkeleton() {
  return (
    <li className="flex items-center gap-4 px-5 py-4">
      <Skeleton className="h-5 w-5 rounded-full" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="ml-auto hidden items-center gap-5 md:flex">
        <Skeleton className="h-8 w-20 rounded-md" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
    </li>
  );
}
