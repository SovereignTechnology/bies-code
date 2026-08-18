import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { nip19 } from "nostr-tools";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Cpu,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  RadioTower,
  Sparkles,
} from "lucide-react";
import type { ResolvedRepo } from "@/lib/nip34";
import type { CIWorkflowRun } from "@/lib/ci";
import {
  getCICoordinatorRelationship,
  type CICoordinatorRelationship,
} from "@/lib/ciCoordinatorRelationship";
import type {
  CICoordinatorAvailability,
  CICoordinatorSummary,
} from "@/hooks/useCICoordinators";
import type {
  CIExecutionPolicy,
  CIRepositoryStatus,
  CIServiceControl,
} from "@/casts/CICoordinator";
import { runner } from "@/services/actions";
import { SetCIService } from "@/actions/nip34";
import { useToast } from "@/hooks/useToast";
import { UserAvatar, UserLink, UserName } from "@/components/UserAvatar";
import { EventCardActions } from "@/components/EventCardActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { CI_SECRETS_DECRYPTION_BUNKER_NAME } from "@/lib/ci";
import type {
  CIPendingSecretChange,
  SubmitCIRepositorySecretsResult,
} from "@/services/ci";
import {
  CITrustClassification,
  getCITrustResolution,
  type CITrustContextState,
} from "@/lib/ciTrustContext";
import { CICoordinatorLink } from "./CICoordinatorLink";
import { CISecretsDialog } from "./CISecretsDialog";
import { CITrustContextLabel } from "./CITrustContextLabel";

const availabilityPresentation: Record<
  CICoordinatorAvailability,
  { label: string; className: string; dot: string }
> = {
  watching: {
    label: "Watching",
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  ready: {
    label: "Ready for this repo",
    className:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  available: {
    label: "Available, not watching",
    className: "border-border bg-muted/60 text-muted-foreground",
    dot: "bg-sky-500",
  },
};

function billingLabel(summary: CICoordinatorSummary): string | undefined {
  switch (summary.advertisement.billingPolicy) {
    case "not-required":
      return "No billing required";
    case "out-of-band":
      return "Billing handled out of band";
    default:
      return undefined;
  }
}

function coordinatorPath(basePath: string, pubkey: string): string {
  return `${basePath}/actions/coordinators/${nip19.npubEncode(pubkey)}`;
}

function isPendingSecretChangeConfirmed(
  change: CIPendingSecretChange,
  status: CIRepositoryStatus,
): boolean {
  if (
    status.event.id === change.baselineStatusId ||
    status.event.created_at < change.createdAt
  ) {
    return false;
  }

  const item = status.secrets.find(({ name }) => name === change.name);
  if (change.operation === "remove") return item === undefined;
  return (
    item?.sourcePubkey === change.author &&
    item.createdAt !== undefined &&
    item.createdAt >= change.createdAt
  );
}

export function CICoordinatorSummaryBar({
  coordinators,
  runs,
  basePath,
  relationships,
}: {
  coordinators: CICoordinatorSummary[] | undefined;
  runs: CIWorkflowRun[] | undefined;
  basePath: string;
  relationships: ReadonlyMap<string, CICoordinatorRelationship>;
}) {
  const watchingCount =
    coordinators?.filter(({ availability }) => availability === "watching")
      .length ?? 0;
  const readyCount =
    coordinators?.filter(({ availability }) => availability === "ready")
      .length ?? 0;
  const availableCount =
    coordinators?.filter(({ availability }) => availability === "available")
      .length ?? 0;
  const liveCoordinatorPubkeys = new Set(
    coordinators?.map(({ pubkey }) => pubkey) ?? [],
  );
  const requestedCount = [...relationships.values()].filter(
    ({ level }) => level === "requested",
  ).length;
  const previouslyRequestedCount = [...relationships.values()].filter(
    ({ level }) => level === "previously-requested",
  ).length;
  const knownCoordinatorPubkeys = new Set([
    ...liveCoordinatorPubkeys,
    ...relationships.keys(),
    ...(runs?.map(({ pubkey }) => pubkey) ?? []),
  ]);
  const knownCoordinatorCount = knownCoordinatorPubkeys.size;
  const offlineCount = [...knownCoordinatorPubkeys].filter(
    (pubkey) => !liveCoordinatorPubkeys.has(pubkey),
  ).length;
  const relevantCoordinators =
    coordinators?.filter(
      ({ availability, pubkey }) =>
        availability !== "available" ||
        getCICoordinatorRelationship(relationships, pubkey).level !==
          "unassociated",
    ) ?? [];
  const previewCoordinators = (
    relevantCoordinators.length > 0
      ? relevantCoordinators
      : (coordinators ?? [])
  ).slice(0, 3);

  return (
    <section className="mb-5" aria-labelledby="ci-coordinators-title">
      <Card className="overflow-hidden">
        <CardContent className="flex min-h-16 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-500/20 to-violet-500/20 text-pink-500">
              <RadioTower className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2
                  id="ci-coordinators-title"
                  className="text-sm font-semibold"
                >
                  CI coordinators
                </h2>
                {coordinators === undefined ? (
                  <span className="h-4 w-24 animate-pulse rounded bg-muted" />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {knownCoordinatorCount}{" "}
                    {knownCoordinatorCount === 1
                      ? "coordinator"
                      : "coordinators"}
                  </span>
                )}
              </div>
              {coordinators !== undefined &&
                (coordinators.length > 0 ||
                  offlineCount > 0 ||
                  requestedCount > 0 ||
                  previouslyRequestedCount > 0) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {watchingCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {watchingCount} watching
                      </span>
                    )}
                    {readyCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                        {readyCount} ready
                      </span>
                    )}
                    {availableCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                        {availableCount} available
                      </span>
                    )}
                    {offlineCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        {offlineCount} offline
                      </span>
                    )}
                    {requestedCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        {requestedCount} of {knownCoordinatorCount} requested by
                        maintainers
                      </span>
                    )}
                    {previouslyRequestedCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        {previouslyRequestedCount} of {knownCoordinatorCount}{" "}
                        previously requested by maintainers
                      </span>
                    )}
                  </div>
                )}
            </div>
          </div>

          <div className="flex items-center gap-3 sm:ml-auto">
            {previewCoordinators.length > 0 && (
              <div className="hidden -space-x-2 sm:flex" aria-hidden="true">
                {previewCoordinators.map(({ pubkey }) => (
                  <span
                    key={pubkey}
                    className="rounded-full bg-background p-0.5 ring-1 ring-border"
                  >
                    <UserAvatar
                      pubkey={pubkey}
                      size="sm"
                      noHoverCard
                      showFollowIndicator={false}
                    />
                  </span>
                ))}
              </div>
            )}
            <Button asChild variant="ghost" size="sm" className="ml-auto gap-1">
              <Link to={`${basePath}/actions/coordinators`}>
                View coordinators
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

export function CICoordinatorDirectory({
  coordinators,
  runs,
  basePath,
  relationships,
  trust,
}: {
  coordinators: CICoordinatorSummary[] | undefined;
  runs: CIWorkflowRun[] | undefined;
  basePath: string;
  relationships: ReadonlyMap<string, CICoordinatorRelationship>;
  trust: CITrustContextState;
}) {
  const entries = useMemo(() => {
    if (!coordinators || !runs) return undefined;

    const summaries = new Map(
      coordinators.map((summary) => [summary.pubkey, summary]),
    );
    const runCounts = new Map<string, number>();
    for (const run of runs) {
      runCounts.set(run.pubkey, (runCounts.get(run.pubkey) ?? 0) + 1);
    }

    const pubkeys = new Set([
      ...summaries.keys(),
      ...runCounts.keys(),
      ...relationships.keys(),
    ]);
    return [...pubkeys]
      .map((pubkey) => ({
        pubkey,
        summary: summaries.get(pubkey),
        runCount: runCounts.get(pubkey) ?? 0,
      }))
      .sort(
        (a, b) =>
          Number(!!b.summary) - Number(!!a.summary) ||
          b.runCount - a.runCount ||
          a.pubkey.localeCompare(b.pubkey),
      );
  }, [coordinators, relationships, runs]);

  if (entries === undefined) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <CoordinatorSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="px-6 py-10 text-center">
          <RadioTower className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No live or historical CI coordinators were found for this
            repository.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <ul className="divide-y divide-border">
        {entries.map(({ pubkey, summary, runCount }) => {
          const presentation = summary
            ? availabilityPresentation[summary.availability]
            : undefined;
          const trustResolution = getCITrustResolution(trust, pubkey);
          const trustLabel =
            trustResolution.phase === "settled" &&
            trustResolution.classification ===
              CITrustClassification.MaintainerDirected
              ? "Maintainer requested"
              : undefined;
          return (
            <li
              key={pubkey}
              className="group flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 sm:pl-5 sm:pr-4"
            >
              <Link
                to={coordinatorPath(basePath, pubkey)}
                className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <UserAvatar pubkey={pubkey} size="md" noHoverCard />
              </Link>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    to={coordinatorPath(basePath, pubkey)}
                    className="min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <UserName pubkey={pubkey} noHoverCard />
                  </Link>
                  <CITrustContextLabel
                    resolution={trustResolution}
                    displayLabel={trustLabel}
                  />
                  {summary?.advertisement.version && (
                    <span className="text-[10px] text-muted-foreground">
                      v{summary.advertisement.version}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {presentation ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-5 gap-1.5 px-1.5 text-[10px] font-normal",
                        presentation.className,
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          presentation.dot,
                        )}
                      />
                      {presentation.label}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="h-5 gap-1.5 border-amber-500/30 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      Offline
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground sm:hidden">
                    {runCount} run{runCount === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {runCount} run{runCount === 1 ? "" : "s"}
                {summary && (
                  <>
                    {" · "}
                    {summary.advertisement.runnerSelectors.length} runner
                    {summary.advertisement.runnerSelectors.length === 1
                      ? " profile"
                      : " profiles"}
                  </>
                )}
              </span>
              <Link
                to={coordinatorPath(basePath, pubkey)}
                aria-label="Open coordinator"
                className="shrink-0 rounded p-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CICoordinatorDetailsCard({
  summary,
  repo,
  isMaintainer,
  relationship,
  controls,
  trust,
}: {
  summary: CICoordinatorSummary;
  repo: ResolvedRepo;
  isMaintainer: boolean;
  relationship: CICoordinatorRelationship;
  controls: readonly CIServiceControl[];
  trust: CITrustContextState;
}) {
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [pendingSecretChanges, setPendingSecretChanges] = useState<
    CIPendingSecretChange[]
  >([]);
  const pendingSecretChangeKey = pendingSecretChanges
    .map(({ eventId, name, operation }) => `${eventId}:${name}:${operation}`)
    .join("\u0000");
  const presentation = availabilityPresentation[summary.availability];
  const effectiveFamilies =
    summary.repositoryStatus?.runnerFamilies ??
    summary.advertisement.runnerFamilies;
  const effectiveSelectors =
    summary.repositoryStatus?.runnerSelectors ??
    summary.advertisement.runnerSelectors;
  const acceptsSecretUpdates = !!summary.advertisement.secretsRecipient;

  const billing = billingLabel(summary);
  const workflowPaths = summary.repositoryStatus?.workflowPaths ?? [];
  const fullInventory = summary.repositoryStatus?.secrets ?? [];
  const hasBunkerBinding = fullInventory.some(
    ({ name }) => name === CI_SECRETS_DECRYPTION_BUNKER_NAME,
  );
  const inventory = fullInventory
    .filter(({ name }) => name !== CI_SECRETS_DECRYPTION_BUNKER_NAME)
    .sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    const status = summary.repositoryStatus;
    if (!status) return;
    setPendingSecretChanges((current) => {
      const pending = current.filter(
        (change) => !isPendingSecretChangeConfirmed(change, status),
      );
      return pending.length === current.length ? current : pending;
    });
  }, [pendingSecretChangeKey, summary.repositoryStatus]);

  const recordPendingSecretChanges = useCallback(
    (
      result: SubmitCIRepositorySecretsResult,
      baselineStatusId: string | undefined,
    ) => {
      const submitted: CIPendingSecretChange[] = [
        ...result.setNames.map((name) => ({
          eventId: result.eventId,
          author: result.author,
          createdAt: result.createdAt,
          baselineStatusId,
          name,
          operation: "set" as const,
        })),
        ...result.removeNames.map((name) => ({
          eventId: result.eventId,
          author: result.author,
          createdAt: result.createdAt,
          baselineStatusId,
          name,
          operation: "remove" as const,
        })),
      ];
      const submittedNames = new Set(submitted.map(({ name }) => name));
      setPendingSecretChanges((current) => [
        ...current.filter(({ name }) => !submittedNames.has(name)),
        ...submitted,
      ]);
    },
    [],
  );

  return (
    <>
      <Card className="overflow-hidden">
        <CardContent className="divide-y divide-border/60 p-0">
          <div className="flex min-w-0 items-start gap-3 p-4 sm:p-5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CICoordinatorLink
                  pubkey={summary.pubkey}
                  avatarSize="md"
                  nameClassName="max-w-48 truncate"
                />
                <CITrustContextLabel
                  resolution={getCITrustResolution(trust, summary.pubkey)}
                />
                {summary.advertisement.version && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    v{summary.advertisement.version}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("gap-1.5 font-normal", presentation.className)}
                >
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", presentation.dot)}
                    aria-hidden="true"
                  />
                  {presentation.label}
                </Badge>
              </div>
            </div>
            <EventCardActions event={summary.advertisement.event} />
          </div>

          <div className="p-4 sm:p-5">
            <CIServiceControlPanel
              coordinatorPubkey={summary.pubkey}
              controls={controls}
              repo={repo}
              isMaintainer={isMaintainer}
              executionPolicy={summary.advertisement.executionPolicy}
              relationship={relationship}
              availability={summary.availability}
              trust={trust}
            />
          </div>

          <div className="space-y-5 p-4 sm:p-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                Runner capabilities
              </div>
              <div className="flex flex-wrap gap-1.5">
                {effectiveFamilies.map((family) => (
                  <Badge
                    key={`family-${family}`}
                    variant="secondary"
                    className="font-mono text-[10px]"
                  >
                    {family}
                  </Badge>
                ))}
                {effectiveSelectors.map((selector) => (
                  <Badge
                    key={`selector-${selector}`}
                    variant="outline"
                    className="font-mono text-[10px] font-normal"
                  >
                    {selector}
                  </Badge>
                ))}
              </div>
            </div>

            {billing && (
              <div className="flex items-start gap-2 text-xs">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>{billing}</span>
              </div>
            )}

            {workflowPaths.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Watching workflows</p>
                <ul className="space-y-1">
                  {workflowPaths.map((path) => (
                    <li key={path} className="min-w-0">
                      <code
                        className="block truncate text-[10px] text-muted-foreground"
                        title={path}
                      >
                        {path}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">
                {isMaintainer
                  ? `Secrets in use${inventory.length > 0 ? ` (${inventory.length})` : ""}`
                  : inventory.length > 0
                    ? "Uses secrets"
                    : "Secrets in use"}
              </p>
              {hasBunkerBinding && (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-violet-500/30 bg-violet-500/10 px-1.5 text-[9px] font-normal text-violet-700 dark:text-violet-300"
                >
                  <LockKeyhole className="h-2.5 w-2.5" />
                  Bunker binding reported
                </Badge>
              )}
              {pendingSecretChanges.length > 0 && (
                <Badge
                  variant="outline"
                  className="h-5 gap-1 border-amber-500/30 bg-amber-500/10 px-1.5 text-[9px] font-normal text-amber-800 dark:text-amber-200"
                >
                  <Clock3 className="h-2.5 w-2.5" />
                  {pendingSecretChanges.length} pending
                </Badge>
              )}
            </div>
            {isMaintainer && inventory.length > 0 ? (
              <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {inventory.map(({ name, sealed }) => (
                  <li key={name} className="flex min-w-0 items-baseline gap-2">
                    <span
                      className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60"
                      aria-hidden="true"
                    />
                    <code className="min-w-0 break-all text-[10px] text-muted-foreground">
                      {name}
                    </code>
                    {sealed && (
                      <LockKeyhole
                        className="h-3 w-3 shrink-0 self-center text-violet-500"
                        aria-label="Bunker-sealed"
                      />
                    )}
                  </li>
                ))}
              </ul>
            ) : inventory.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No active secrets are reported for this repository.
              </p>
            ) : null}
            {isMaintainer && pendingSecretChanges.length > 0 && (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5"
                aria-live="polite"
              >
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
                <div>
                  <p className="text-[11px] font-medium text-amber-900 dark:text-amber-100">
                    Delivered to inbox relays; awaiting coordinator status
                  </p>
                  <p className="mt-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                    {pendingSecretChanges
                      .map(
                        ({ name, operation }) =>
                          `${operation === "set" ? "Set" : "Remove"} ${
                            name === CI_SECRETS_DECRYPTION_BUNKER_NAME
                              ? "decryption bunker"
                              : name
                          }`,
                      )
                      .join(" · ")}
                  </p>
                </div>
              </div>
            )}
          </div>

          {isMaintainer && (
            <div
              className={cn(
                "flex flex-col gap-3 border-l-2 p-4 pl-3 sm:flex-row sm:items-start sm:p-5 sm:pl-4",
                acceptsSecretUpdates ? "border-l-border" : "border-l-amber-500",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <KeyRound
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    acceptsSecretUpdates
                      ? "text-muted-foreground"
                      : "text-amber-600 dark:text-amber-400",
                  )}
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    Secret updates via Nostr{" "}
                    {acceptsSecretUpdates ? "available" : "unavailable"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {acceptsSecretUpdates
                      ? "Relay delivery is shown as pending until coordinator repository status reports the change."
                      : "Update secrets in the coordinator directly."}
                  </p>
                </div>
              </div>
              {acceptsSecretUpdates && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 sm:ml-auto"
                  onClick={() => setSecretDialogOpen(true)}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Manage secrets
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {secretDialogOpen && (
        <CISecretsDialog
          open
          onOpenChange={setSecretDialogOpen}
          coordinator={summary}
          repo={repo}
          pendingChanges={pendingSecretChanges}
          trust={trust}
          onSubmitted={recordPendingSecretChanges}
        />
      )}
    </>
  );
}

export function CIServiceControlPanel({
  coordinatorPubkey,
  controls,
  repo,
  isMaintainer,
  executionPolicy,
  relationship,
  availability,
  trust,
}: {
  coordinatorPubkey: string;
  controls: readonly CIServiceControl[];
  repo: ResolvedRepo;
  isMaintainer: boolean;
  executionPolicy: CIExecutionPolicy | undefined;
  relationship: CICoordinatorRelationship;
  availability: CICoordinatorAvailability | undefined;
  trust: CITrustContextState;
}) {
  const [updatingService, setUpdatingService] = useState(false);
  const [showAllControls, setShowAllControls] = useState(false);
  const { toast } = useToast();
  const latestControl = controls[0];
  const isRequested = latestControl?.isRequest ?? false;
  const visibleControls = showAllControls ? controls : controls.slice(0, 3);

  const updateService = useCallback(async () => {
    const enabled = !isRequested;
    setUpdatingService(true);
    try {
      await runner.run(
        SetCIService,
        enabled,
        repo.selectedCoordinate,
        coordinatorPubkey,
        repo.relays[0],
      );
      toast({
        title: enabled
          ? "Coordinator service requested"
          : "Service request stopped",
        description: enabled
          ? "The signed Service Request is being delivered to the repository and coordinator relays."
          : "The signed Service Stop applies to future workflow handoffs.",
      });
    } catch (error) {
      toast({
        title: enabled
          ? "Could not request coordinator service"
          : "Could not stop the service request",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setUpdatingService(false);
    }
  }, [coordinatorPubkey, isRequested, repo, toast]);

  const hasStoppedRequest = !!latestControl && !latestControl.isRequest;
  const onlyManualRequests =
    controls.length === 0 &&
    relationship.manualRunCount > 0 &&
    relationship.serviceRunCount === 0;
  const isOperatorConfigured = availability === "watching" && !isRequested;
  const canRecogniseExistingService =
    isOperatorConfigured && executionPolicy === "automatic";
  const trustTitle = isRequested
    ? "Maintainer requested"
    : hasStoppedRequest
      ? "Maintainer request stopped"
      : isOperatorConfigured
        ? "Operator configured"
        : onlyManualRequests
          ? "Manual runs requested"
          : relationship.level === "previously-requested"
            ? "Requested in the past"
            : "Not maintainer requested";
  const trustDescription = isRequested
    ? "Repository maintainers chose this coordinator. Runs made while this request is active appear without a warning."
    : hasStoppedRequest
      ? `The maintainer request was stopped. ${isOperatorConfigured ? "The coordinator still chooses to run CI here; " : ""}only runs that maintainers start individually now count as maintainer-requested.`
      : onlyManualRequests
        ? `Maintainers started ${relationship.manualRunCount} individual ${relationship.manualRunCount === 1 ? "run" : "runs"}, but have not asked this coordinator to run CI automatically. Only those individual runs count as maintainer-requested.`
        : relationship.serviceRunCount > 0
          ? `${relationship.serviceRunCount} earlier ${relationship.serviceRunCount === 1 ? "run happened" : "runs happened"} while maintainers had asked this coordinator to run CI automatically. There is no current request.`
          : isOperatorConfigured
            ? "The coordinator chooses to run CI for this repository without a maintainer request. Only runs that maintainers start individually count as maintainer-requested."
            : "Maintainers have not asked this coordinator to run CI automatically. Only runs they start individually count as maintainer-requested.";
  const requestLabel = canRecogniseExistingService
    ? "Recognise coordinator"
    : "Request coordinator service";
  const requestPrompt = canRecogniseExistingService
    ? "Did a maintainer arrange this? Recognise it so visitors can distinguish it from unsolicited CI."
    : "Request this service so visitors can see that repository maintainers chose it.";
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{trustTitle}</h2>
            <CITrustContextLabel
              resolution={getCITrustResolution(trust, coordinatorPubkey)}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {trustDescription}
          </p>
        </div>
      </div>

      {isMaintainer && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          {!isRequested && (
            <p className="text-xs text-muted-foreground sm:flex-1">
              {requestPrompt}
            </p>
          )}
          <Button
            type="button"
            variant={isRequested ? "outline" : "default"}
            size="sm"
            className="gap-1.5 sm:ml-auto sm:shrink-0"
            disabled={updatingService}
            onClick={() => void updateService()}
          >
            {updatingService ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isRequested ? (
              <CircleStop className="h-3.5 w-3.5" />
            ) : canRecogniseExistingService ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {isRequested ? "Stop service request" : requestLabel}
          </Button>
        </div>
      )}

      {controls.length > 0 && (
        <details className="group mt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            Request history ({controls.length})
          </summary>
          <div className="mt-2 space-y-2">
            <ol className="divide-y divide-border/60 border-y border-border/60">
              {visibleControls.map((control, index) => {
                const createdAt = new Date(control.event.created_at * 1000);
                return (
                  <li
                    key={control.event.id}
                    className="flex min-w-0 items-center gap-3 py-2.5"
                  >
                    <span
                      className={cn(
                        "flex h-7 w-5 shrink-0 items-center justify-center",
                        control.isRequest
                          ? "text-violet-600 dark:text-violet-300"
                          : "text-muted-foreground",
                      )}
                    >
                      {control.isRequest ? (
                        <Play className="h-3.5 w-3.5" />
                      ) : (
                        <CircleStop className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-medium">
                          {control.isRequest
                            ? "Coordinator service requested"
                            : "Service request stopped"}
                        </span>
                        {index === 0 && (
                          <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                            Latest
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
                        <UserLink
                          pubkey={control.event.pubkey}
                          avatarSize="xs"
                          nameClassName="max-w-24 truncate text-[10px] font-normal"
                        />
                        <span aria-hidden="true">·</span>
                        <time
                          dateTime={createdAt.toISOString()}
                          title={format(createdAt, "MMM d, yyyy 'at' h:mm a")}
                        >
                          {formatDistanceToNow(createdAt, { addSuffix: true })}
                        </time>
                      </div>
                    </div>
                    <EventCardActions event={control.event} />
                  </li>
                );
              })}
            </ol>

            {controls.length > 3 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs text-muted-foreground"
                onClick={() => setShowAllControls((current) => !current)}
              >
                {showAllControls
                  ? "Show recent controls"
                  : `Show all ${controls.length} controls`}
              </Button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function CoordinatorSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-16 animate-pulse rounded-xl border bg-muted/30",
        className,
      )}
      aria-hidden="true"
    />
  );
}
