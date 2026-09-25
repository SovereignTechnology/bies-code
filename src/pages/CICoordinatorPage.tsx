import { ErrorRetryAction } from "@/components/ErrorRetryAction";
import { useMemo, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { format, formatDistanceToNow } from "date-fns";
import type { Observable } from "rxjs";
import { nip19 } from "nostr-tools";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cpu,
  GitBranch,
  Globe2,
  Inbox,
  KeyRound,
  RadioTower,
  Server,
} from "lucide-react";
import type {
  CICoordinatorAdvertisement,
  CIRepositoryStatus,
} from "@/casts/CICoordinator";
import { EventCardActions } from "@/components/EventCardActions";
import { RepoBadge } from "@/components/RepoBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { UserGroup } from "@/components/UserGroup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { use$ } from "@/hooks/use$";
import {
  useCICoordinatorProfile,
  type CICoordinatorProfileState,
} from "@/hooks/useCICoordinatorProfile";
import { useDnsIdentity } from "@/hooks/useDnsIdentity";
import { useEventStore } from "@/hooks/useEventStore";
import { useGraspServerInfo } from "@/hooks/useGraspServerInfo";
import { useLoadProfile } from "@/hooks/useLoadProfile";
import { useProfile } from "@/hooks/useProfile";
import { useDefaultRepoCoordPath } from "@/hooks/useRepoPath";
import { graspIdentityDomain } from "@/lib/grasp";
import { parseRepoCoordinate, type ResolvedRepo } from "@/lib/nip34";
import { decodePubkeyIdentifier, standardizeNip05 } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import { RepositoryModel } from "@/models/RepositoryModel";
import NotFound from "@/pages/NotFound";
import { CITrustContextLabel } from "@/components/ci/CITrustContextLabel";
import { useCITrustContext } from "@/hooks/useCITrustContext";
import { useCIRepositoryCoordinatorRelationship } from "@/hooks/useCIRepositoryCoordinatorRelationship";
import {
  useCICoordinatorViewerContext,
  type CICoordinatorViewerContext,
} from "@/hooks/useCICoordinatorViewerContext";
import {
  CITrustClassification,
  getCITrustResolution,
  settledCITrustResolution,
  type CITrustEvidence,
  type CITrustResolution,
} from "@/lib/ciTrustContext";

function humanize(value: string | undefined): string {
  return value?.replaceAll("-", " ") ?? "Not advertised";
}

function coordinatorRepoCoordinate(
  repo: ResolvedRepo,
  targetPubkeys: ReadonlySet<string>,
): string {
  return (
    repo.confirmedMaintainerCoordinates.find((coordinate) => {
      const parsed = parseRepoCoordinate(coordinate);
      return parsed ? targetPubkeys.has(parsed.pubkey) : false;
    }) ?? repo.selectedCoordinate
  );
}

function coordinatorProfileTrustResolution(
  context: CICoordinatorViewerContext,
  coordinatorSettled: boolean,
  coordinatorPartial: boolean,
): CITrustResolution {
  if (context.phase === "loading" || !coordinatorSettled) {
    return { phase: "loading" };
  }

  const evidence: CITrustEvidence[] = [];
  if (context.viewerRequestedRepositoryCount > 0) {
    evidence.unshift({
      kind: "maintainer-request",
      classification: CITrustClassification.MaintainerDirected,
      summary: "Requested on repositories you maintain",
      detail: `You currently request this coordinator on ${context.viewerRequestedRepositoryCount} ${context.viewerRequestedRepositoryCount === 1 ? "repository" : "repositories"} you maintain.`,
      scope: "current",
    });
  }
  if (context.viewerGraspRepositoryCount > 0 && context.verifiedGraspDomain) {
    evidence.push({
      kind: "repository-domain",
      classification: CITrustClassification.OperationallyAssociated,
      summary: "Listed by repositories you maintain",
      detail: `You list ${context.verifiedGraspDomain} as a GRASP service on ${context.viewerGraspRepositoryCount} ${context.viewerGraspRepositoryCount === 1 ? "repository" : "repositories"} you maintain.`,
      scope: "current",
    });
  }
  if (context.requestedByContactsRepositoryCount > 0) {
    evidence.push({
      kind: "contact-request",
      classification: CITrustClassification.SeenInYourNetwork,
      summary: "Requested on repositories in your network",
      detail: `${context.requestedByContacts.length} ${context.requestedByContacts.length === 1 ? "person you follow has" : "people you follow have"} signed a standing or run-specific request for this coordinator across ${context.requestedByContactsRepositoryCount} ${context.requestedByContactsRepositoryCount === 1 ? "repository" : "repositories"} they maintain. This does not establish authority or endorsement for repositories they do not maintain.`,
      scope: "historical",
    });
  }
  if (context.activeForContactsRepositoryCount > 0) {
    evidence.push({
      kind: "network-activity",
      classification: CITrustClassification.SeenInYourNetwork,
      summary: "CI activity in your network",
      detail: `Signed coordinator status or started CI activity was observed on ${context.activeForContactsRepositoryCount} ${context.activeForContactsRepositoryCount === 1 ? "repository" : "repositories"} maintained by ${context.activeForContacts.length} ${context.activeForContacts.length === 1 ? "person" : "people"} you follow. This does not mean they requested or endorsed it, and it does not establish authority for repositories they do not maintain.`,
      scope: "historical",
    });
  }

  return settledCITrustResolution(
    evidence,
    context.coverage === "partial" || coordinatorPartial
      ? "partial"
      : "complete",
  );
}

export default function CICoordinatorPage() {
  const { coordinatorIdentifier = "" } = useParams();
  const [searchParams] = useSearchParams();
  const rawGraspDomainHint = searchParams.get("grasp");
  const graspDomainHint = useMemo(
    () =>
      rawGraspDomainHint ? graspIdentityDomain(rawGraspDomainHint) : undefined,
    [rawGraspDomainHint],
  );
  const pubkey = decodePubkeyIdentifier(coordinatorIdentifier);
  useLoadProfile(pubkey);
  const profile = useProfile(pubkey);
  const state = useCICoordinatorProfile(pubkey);
  const viewerContext = useCICoordinatorViewerContext(
    pubkey ?? "",
    state?.activeStatuses,
    profile?.nip05,
  );
  const profileTrust = coordinatorProfileTrustResolution(
    viewerContext,
    state?.settled === true,
    state?.partial === true,
  );
  const now = Math.floor(Date.now() / 1000);
  const advertisementIsLive =
    state?.advertisement !== undefined && state.advertisement.expiration > now;
  const readinessIsLive =
    advertisementIsLive &&
    state?.readiness !== undefined &&
    state.readiness.expiration > now;
  const readinessPubkeys = useMemo(
    () => (readinessIsLive ? (state?.readiness?.repositoryPubkeys ?? []) : []),
    [readinessIsLive, state?.readiness],
  );
  const targetedRepositories = state?.targetedRepositories;
  const targetCoordinates = useMemo(() => {
    if (!readinessIsLive || !state?.readiness) return [];
    const activeCoordinates = new Set(
      state.activeStatuses.flatMap((status) => status.repositoryCoordinates),
    );
    const activeRepositories = new Set(
      (targetedRepositories ?? [])
        .filter((repo) =>
          repo.confirmedMaintainerCoordinates.some((coordinate) =>
            activeCoordinates.has(coordinate),
          ),
        )
        .map((repo) => repo.selectedCoordinate),
    );
    const targetPubkeys = new Set(readinessPubkeys);
    const coordinates = [
      ...state.readiness.repositoryCoordinates,
      ...(targetedRepositories ?? []).map((repo) =>
        coordinatorRepoCoordinate(repo, targetPubkeys),
      ),
    ];
    return [...new Set(coordinates)].filter((coordinate) => {
      if (activeCoordinates.has(coordinate)) return false;
      const repository = targetedRepositories?.find((repo) =>
        repo.confirmedMaintainerCoordinates.includes(coordinate),
      );
      return (
        !repository || !activeRepositories.has(repository.selectedCoordinate)
      );
    });
  }, [readinessIsLive, readinessPubkeys, state, targetedRepositories]);

  const npub = pubkey ? nip19.npubEncode(pubkey) : undefined;
  const displayName =
    profile?.displayName ??
    profile?.name ??
    (npub ? `${npub.slice(0, 16)}…` : "");

  useSeoMeta({
    title: displayName
      ? `${displayName} CI coordinator - BIES Code`
      : "CI coordinator - BIES Code",
    description:
      "CI coordinator capabilities, repository activity, readiness targets, relays, and GRASP identity",
    ogImage: profile?.picture ?? "/og-image.png",
    ogImageAlt: displayName || "CI coordinator",
    twitterCard: profile?.picture ? "summary" : "summary_large_image",
  });

  if (!pubkey) return <NotFound />;

  return (
    <div className="min-h-full">
      <header className="relative isolate overflow-hidden border-b border-border/50">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.08] via-background to-secondary/[0.08]" />
        <div className="absolute -right-24 -top-32 -z-10 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
        <div className="container max-w-screen-xl px-4 py-8 md:px-8 md:py-10">
          <Link
            to="/"
            className="mb-7 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All repositories
          </Link>

          <div className="flex flex-col gap-6 md:flex-row md:items-end">
            <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
              <div className="relative shrink-0">
                <UserAvatar
                  pubkey={pubkey}
                  size="xl"
                  className="ring-4 ring-background shadow-lg"
                />
                <span
                  className={cn(
                    "absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-background",
                    advertisementIsLive ? "bg-emerald-500" : "bg-amber-500",
                  )}
                  aria-label={advertisementIsLive ? "Online" : "Offline"}
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="w-full min-w-0 truncate text-2xl font-bold tracking-tight sm:w-auto sm:text-3xl md:text-4xl">
                    {displayName}
                  </h1>
                  <Badge
                    variant="outline"
                    className={cn(
                      "gap-1.5 font-normal",
                      advertisementIsLive
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        advertisementIsLive ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {advertisementIsLive
                      ? "Live coordinator"
                      : "Offline coordinator"}
                  </Badge>
                  <CITrustContextLabel resolution={profileTrust} />
                </div>
                <p className="mt-2 text-lg text-muted-foreground">
                  Signed CI service capabilities and repository activity.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                  {profile?.nip05 && (
                    <span className="font-medium text-primary">
                      {profile.nip05.startsWith("_@")
                        ? profile.nip05.slice(2)
                        : profile.nip05}
                    </span>
                  )}
                  <Link
                    to={`/${npub}`}
                    className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Nostr profile
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            </div>

            <CoordinatorStats
              state={state}
              targetCount={targetCoordinates.length}
            />
          </div>
        </div>
      </header>

      <div className="container max-w-screen-xl px-4 py-8 md:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(19rem,0.85fr)]">
          <div className="min-w-0 space-y-6">
            <CoordinatorAdvertisementCard
              advertisement={state?.advertisement}
              loading={state === undefined}
            />

            <RepositorySection
              coordinatorPubkey={pubkey}
              title="Acting now"
              description="Live repository status claims found on the coordinator's outboxes or targeted repository relays."
              icon={<RadioTower className="h-5 w-5 text-emerald-500" />}
              statuses={state?.activeStatuses}
              loading={state === undefined}
              emptyMessage={
                state?.outboxes.length
                  ? "No unexpired acting claims were found in the coordinator's outboxes or targeted repository relays."
                  : "No unexpired acting claims were found on targeted repository relays. The coordinator has not published a NIP-65 outbox yet."
              }
            />

            <RepositorySection
              coordinatorPubkey={pubkey}
              title="Ready to serve"
              description="Repositories targeted by the live request-readiness list, excluding those already acting."
              icon={<GitBranch className="h-5 w-5 text-violet-500" />}
              coordinates={targetCoordinates}
              loading={
                state === undefined ||
                ((readinessPubkeys.length > 0 ||
                  (readinessIsLive &&
                    (state?.readiness?.repositoryCoordinates.length ?? 0) >
                      0)) &&
                  targetedRepositories === undefined)
              }
              emptyMessage="This coordinator is not currently targeting any additional repositories."
            />

            <RepositorySection
              coordinatorPubkey={pubkey}
              title="Previously reported"
              description="Expired acting claims found on coordinator outboxes or targeted repository relays."
              icon={<Clock3 className="h-5 w-5 text-amber-500" />}
              statuses={state?.historicalStatuses}
              historical
              loading={state === undefined}
              emptyMessage="No earlier repository status claims were found."
            />
          </div>

          <aside className="min-w-0 space-y-6">
            <CoordinatorInfrastructureCard
              pubkey={pubkey}
              state={state}
              nip05={profile?.nip05}
              graspDomainHint={graspDomainHint}
            />
            <CoordinatorTrustContextCard
              resolution={profileTrust}
              context={viewerContext}
              coordinatorSettled={state?.settled === true}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function CoordinatorStats({
  state,
  targetCount,
}: {
  state: CICoordinatorProfileState | undefined;
  targetCount: number;
}) {
  const stats = [
    { label: "Acting", value: state?.activeStatuses.length },
    { label: "Ready", value: state ? targetCount : undefined },
    { label: "Previous", value: state?.historicalStatuses.length },
  ];
  return (
    <dl className="grid w-full grid-cols-3 overflow-hidden rounded-xl border border-border/70 bg-background/75 shadow-sm backdrop-blur-sm md:w-auto">
      {stats.map(({ label, value }, index) => (
        <div
          key={label}
          className={cn(
            "min-w-24 px-4 py-3 text-center",
            index > 0 && "border-l border-border/70",
          )}
        >
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </dt>
          <dd className="mt-0.5 text-xl font-semibold tabular-nums">
            {value === undefined ? (
              <Skeleton className="mx-auto h-7 w-7" />
            ) : (
              value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CoordinatorTrustContextCard({
  resolution,
  context,
  coordinatorSettled,
}: {
  resolution: CITrustResolution;
  context: CICoordinatorViewerContext;
  coordinatorSettled: boolean;
}) {
  if (
    resolution.phase === "loading" ||
    context.phase === "loading" ||
    !coordinatorSettled
  ) {
    return (
      <Card className="border-dashed">
        <CardContent
          className="space-y-3 p-5"
          aria-label="Loading CI trust context"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  const hasRepositoryEvidence =
    context.viewerRequestedRepositoryCount > 0 ||
    context.viewerActiveRepositoryCount > 0 ||
    context.viewerGraspRepositoryCount > 0 ||
    context.requestedByContacts.length > 0 ||
    context.activeForContacts.length > 0;

  return (
    <Card className="border-dashed">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">CI trust context</h2>
          <CITrustContextLabel resolution={resolution} />
        </div>

        {!context.signedIn ? (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Log in to compare this coordinator with repositories you maintain
            and with signed requests from people you follow.
          </p>
        ) : hasRepositoryEvidence ? (
          <div className="mt-4 space-y-3 text-sm">
            {(context.viewerRequestedRepositoryCount > 0 ||
              context.viewerActiveRepositoryCount > 0 ||
              context.viewerGraspRepositoryCount > 0) && (
              <ul className="space-y-2">
                {context.viewerRequestedRepositoryCount > 0 && (
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>
                      Requested on{" "}
                      <strong className="font-semibold text-foreground">
                        {context.viewerRequestedRepositoryCount}
                      </strong>{" "}
                      of your repositories.
                    </span>
                  </li>
                )}
                {context.viewerActiveRepositoryCount > 0 && (
                  <li className="flex items-start gap-2">
                    <RadioTower className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>
                      Running against{" "}
                      <strong className="font-semibold text-foreground">
                        {context.viewerActiveRepositoryCount}
                      </strong>{" "}
                      of your repositories.
                    </span>
                  </li>
                )}
                {context.viewerGraspRepositoryCount > 0 &&
                  context.verifiedGraspDomain && (
                    <li className="flex items-start gap-2">
                      <Server className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>
                        You list{" "}
                        <span className="font-medium text-foreground">
                          {context.verifiedGraspDomain}
                        </span>{" "}
                        on{" "}
                        <strong className="font-semibold text-foreground">
                          {context.viewerGraspRepositoryCount}
                        </strong>{" "}
                        {context.viewerGraspRepositoryCount === 1
                          ? "repository"
                          : "repositories"}
                        .
                      </span>
                    </li>
                  )}
              </ul>
            )}

            {context.requestedByContacts.length > 0 && (
              <p className="border-t border-border/60 pt-3 leading-relaxed text-muted-foreground">
                Requested by{" "}
                <UserGroup
                  pubkeys={context.requestedByContacts.map(
                    ({ pubkey }) => pubkey,
                  )}
                />{" "}
                on{" "}
                <strong className="font-semibold text-foreground">
                  {context.requestedByContactsRepositoryCount}
                </strong>{" "}
                {context.requestedByContactsRepositoryCount === 1
                  ? "repository"
                  : "repositories"}
                .
              </p>
            )}

            {context.activeForContacts.length > 0 && (
              <p className="border-t border-border/60 pt-3 leading-relaxed text-muted-foreground">
                Used by{" "}
                <UserGroup
                  pubkeys={context.activeForContacts.map(
                    ({ pubkey }) => pubkey,
                  )}
                />{" "}
                on{" "}
                <strong className="font-semibold text-foreground">
                  {context.activeForContactsRepositoryCount}
                </strong>{" "}
                {context.activeForContactsRepositoryCount === 1
                  ? "repository"
                  : "repositories"}
                .
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            No repository-scoped use was found among repositories you maintain
            or those maintained by people you follow.
          </p>
        )}

        {context.coverage === "partial" && (
          <p className="mt-3 border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
            Some relay or identity queries could not be completed. Known
            evidence is shown, but this context may be incomplete.
          </p>
        )}
        <p className="mt-3 border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
          Requested means signed maintainer direction. Used means signed
          coordinator activity; it is not itself a request or endorsement.
        </p>
      </CardContent>
    </Card>
  );
}

function CoordinatorAdvertisementCard({
  advertisement,
  loading,
}: {
  advertisement: CICoordinatorAdvertisement | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </CardContent>
      </Card>
    );
  }
  if (!advertisement) {
    return (
      <Card className="border-dashed">
        <CardContent className="px-6 py-10 text-center">
          <RadioTower className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <h2 className="font-semibold">No coordinator advertisement found</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            This identity has repository CI history, but no structurally valid
            coordinator advertisement was found on the configured Git index
            relays.
          </p>
        </CardContent>
      </Card>
    );
  }

  const expires = formatDistanceToNow(
    new Date(advertisement.expiration * 1000),
    {
      addSuffix: true,
    },
  );
  const details = [
    ["Admission", humanize(advertisement.admissionPolicy)],
    ["Execution", humanize(advertisement.executionPolicy)],
    ["Billing", humanize(advertisement.billingPolicy)],
    ["Expires", expires],
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Cpu className="h-5 w-5 text-primary" />
            Coordinator advertisement
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {advertisement.software ?? "Unknown software"}
            {advertisement.version ? ` · v${advertisement.version}` : ""}
          </p>
        </div>
        <EventCardActions event={advertisement.event} />
      </CardHeader>
      <CardContent className="space-y-6 p-5 sm:p-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </dt>
              <dd
                className="mt-1 text-sm font-medium capitalize"
                title={
                  label === "Expires"
                    ? format(
                        new Date(advertisement.expiration * 1000),
                        "MMM d, yyyy 'at' h:mm a",
                      )
                    : undefined
                }
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>

        <div>
          <p className="mb-2 text-sm font-medium">Runner capabilities</p>
          <div className="flex flex-wrap gap-2">
            {advertisement.runnerFamilies.map((family) => (
              <Badge key={family} variant="secondary" className="font-mono">
                {family}
              </Badge>
            ))}
            {advertisement.runnerSelectors.map((selector) => (
              <Badge
                key={selector}
                variant="outline"
                className="font-mono font-normal"
              >
                {selector}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            {advertisement.secretsRecipient
              ? `Accepts encrypted repository secrets through ${advertisement.secretsRecipient.relays.length} dedicated inbox ${advertisement.secretsRecipient.relays.length === 1 ? "relay" : "relays"}.`
              : "Does not advertise encrypted repository-secret delivery."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function RepositorySection({
  coordinatorPubkey,
  title,
  description,
  icon,
  coordinates,
  statuses,
  historical = false,
  loading,
  emptyMessage,
}: {
  coordinatorPubkey: string;
  title: string;
  description: string;
  icon: ReactNode;
  coordinates?: readonly string[];
  statuses?: readonly CIRepositoryStatus[];
  historical?: boolean;
  loading: boolean;
  emptyMessage: string;
}) {
  const entries: Array<{
    coordinate: string;
    status?: CIRepositoryStatus;
  }> =
    statuses?.map((status) => ({
      coordinate: status.selectedCoordinate,
      status,
    })) ??
    coordinates?.map((coordinate) => ({ coordinate })) ??
    [];

  return (
    <section
      aria-labelledby={`coordinator-${title.toLowerCase().replaceAll(" ", "-")}`}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div>
          <h2
            id={`coordinator-${title.toLowerCase().replaceAll(" ", "-")}`}
            className="text-xl font-semibold tracking-tight"
          >
            {title}
            {!loading && (
              <>
                {" "}
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {entries.length}
                </span>
              </>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {loading ? (
        <div className="space-y-2">
          <RepositorySkeleton />
          <RepositorySkeleton />
        </div>
      ) : entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map(({ coordinate, status }) => (
            <CoordinatorRepositoryRow
              key={`${coordinate}:${status?.event.id ?? "target"}`}
              coordinatorPubkey={coordinatorPubkey}
              coordinate={coordinate}
              status={status}
              historical={historical}
            />
          ))}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="px-6 py-8 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function CoordinatorRepositoryRow({
  coordinatorPubkey,
  coordinate,
  status,
  historical,
}: {
  coordinatorPubkey: string;
  coordinate: string;
  status?: CIRepositoryStatus;
  historical: boolean;
}) {
  const parsed = parseRepoCoordinate(coordinate);
  const store = useEventStore();
  const repo = use$(() => {
    if (!parsed) return undefined;
    return store.model(
      RepositoryModel,
      parsed.pubkey,
      parsed.identifier,
    ) as unknown as Observable<ResolvedRepo | undefined>;
  }, [parsed?.pubkey, parsed?.identifier, store]);
  const repoPath = useDefaultRepoCoordPath(coordinate);
  const relationshipState = useCIRepositoryCoordinatorRelationship(
    repo,
    coordinatorPubkey,
  );
  const relationships = useMemo(
    () =>
      new Map([[coordinatorPubkey, relationshipState.relationship] as const]),
    [coordinatorPubkey, relationshipState.relationship],
  );
  const trust = useCITrustContext({
    repo,
    coordinatorRelationships: relationships,
    repositoryRelationshipState: relationshipState,
    extraIdentities: [coordinatorPubkey],
  });

  return (
    <Card className="transition-colors hover:border-primary/25">
      <CardContent className="p-4 sm:p-5">
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {repoPath ? (
                <Link
                  to={repoPath}
                  className="min-w-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RepoBadge coord={coordinate} repoName={repo?.name} asSpan />
                </Link>
              ) : (
                <RepoBadge coord={coordinate} repoName={repo?.name} asSpan />
              )}
              <Badge
                variant="outline"
                className={cn(
                  "h-5 text-[10px] font-normal",
                  status
                    ? historical
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
                )}
              >
                {status
                  ? historical
                    ? "Previously acting"
                    : "Acting"
                  : "Targeted"}
              </Badge>
              <CITrustContextLabel
                resolution={
                  repo
                    ? getCITrustResolution(trust, coordinatorPubkey)
                    : { phase: "loading" }
                }
              />
            </div>
            {repo?.description && (
              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                {repo.description}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {repo && (
                <span>
                  {repo.confirmedMaintainers.length} confirmed maintainer
                  {repo.confirmedMaintainers.length === 1 ? "" : "s"}
                </span>
              )}
              {status && (
                <span>
                  Reported{" "}
                  {formatDistanceToNow(
                    new Date(status.event.created_at * 1000),
                    { addSuffix: true },
                  )}
                </span>
              )}
              {status?.workflowPaths.map((path) => (
                <code
                  key={path}
                  className="max-w-full truncate rounded bg-muted px-1.5 py-0.5"
                >
                  {path}
                </code>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {status && <EventCardActions event={status.event} />}
            {repoPath && (
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <Link to={repoPath}>
                  Open repo
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RepositorySkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-4/5" />
      </CardContent>
    </Card>
  );
}

function CoordinatorInfrastructureCard({
  pubkey,
  state,
  nip05,
  graspDomainHint,
}: {
  pubkey: string;
  state: CICoordinatorProfileState | undefined;
  nip05: string | undefined;
  graspDomainHint: string | undefined;
}) {
  const standardizedNip05 = nip05 ? standardizeNip05(nip05) : undefined;
  const publishedDomain = standardizedNip05?.split("@")[1];
  const domain = graspDomainHint ?? publishedDomain;
  const identityName = graspDomainHint
    ? `_@${graspDomainHint}`
    : standardizedNip05;
  const identity = useDnsIdentity(identityName);
  const identityMatches =
    identity.status === "found" && identity.pubkey === pubkey;
  const server = useGraspServerInfo(identityMatches ? domain : undefined);
  const serverOperatorPubkey =
    server?.status === "found" && server.document.pubkey
      ? decodePubkeyIdentifier(server.document.pubkey)
      : undefined;
  const operatorMatches =
    server?.status === "found" && serverOperatorPubkey === pubkey;
  const operatorMismatch =
    server?.status === "found" &&
    !!serverOperatorPubkey &&
    serverOperatorPubkey !== pubkey;
  const isGraspService =
    server?.status === "found" &&
    (server.document.supported_grasps?.length ?? 0) > 0;
  const linkedGraspService = operatorMatches && isGraspService;

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Server className="h-5 w-5 text-violet-500" />
          Coordinator infrastructure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Globe2 className="h-4 w-4 text-muted-foreground" />
            Linked GRASP service
          </div>
          {!identityName ? (
            <p className="text-sm text-muted-foreground">
              No linked service domain is available yet.
            </p>
          ) : identity.status === "loading" ? (
            <Skeleton className="h-16 w-full" />
          ) : !identityMatches ? (
            <InfrastructureNotice
              tone="warning"
              title="Identity does not match"
            >
              {identityName} does not currently resolve to this coordinator key.
              {identity.status === "error" && (
                <ErrorRetryAction recovery={identity.recovery} />
              )}
            </InfrastructureNotice>
          ) : (
            <div className="space-y-2">
              {server?.status === "loading" && (
                <Skeleton className="h-16 w-full" />
              )}
              {server?.status === "error" && (
                <InfrastructureNotice tone="warning" title="NIP-11 unavailable">
                  {server.message}
                  <ErrorRetryAction recovery={server.recovery} />
                </InfrastructureNotice>
              )}
              {server?.status === "found" && (
                <div className="space-y-2">
                  <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
                    <div className="flex items-start gap-2">
                      {linkedGraspService ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      ) : (
                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {linkedGraspService
                            ? domain
                            : operatorMismatch
                              ? "NIP-11 operator key differs"
                              : operatorMatches
                                ? "No GRASP capabilities advertised"
                                : "NIP-11 has no operator key"}
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          {linkedGraspService
                            ? "NIP-05 resolves to this coordinator and the service names the same operator key."
                            : operatorMismatch
                              ? `${domain} names a different operator key.`
                              : operatorMatches
                                ? `${domain} identifies this key but does not advertise a GRASP service.`
                                : `${domain} does not publish an operator key that can link these pages.`}
                        </p>
                      </div>
                    </div>
                  </div>
                  {linkedGraspService && domain && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="w-full gap-2"
                    >
                      <Link to={`/relay/${domain}`}>
                        Open GRASP service
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <RelayGroup
          icon={<RadioTower className="h-4 w-4 text-muted-foreground" />}
          title="NIP-65 outbox"
          relays={state?.outboxes}
          loading={state === undefined}
          emptyMessage={
            state?.hasRelayList
              ? "No write relays advertised."
              : "No relay list found yet."
          }
        />
        <RelayGroup
          icon={<Inbox className="h-4 w-4 text-muted-foreground" />}
          title="NIP-65 inbox"
          relays={state?.inboxes}
          loading={state === undefined}
          emptyMessage={
            state?.hasRelayList
              ? "No read relays advertised."
              : "No relay list found yet."
          }
        />
      </CardContent>
    </Card>
  );
}

function InfrastructureNotice({
  tone,
  title,
  children,
}: {
  tone: "warning";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10",
      )}
    >
      <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
        {title}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
        {children}
      </p>
    </div>
  );
}

function RelayGroup({
  icon,
  title,
  relays,
  loading,
  emptyMessage,
}: {
  icon: ReactNode;
  title: string;
  relays: readonly string[] | undefined;
  loading: boolean;
  emptyMessage: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      {loading ? (
        <Skeleton className="h-12 w-full" />
      ) : relays && relays.length > 0 ? (
        <ul className="space-y-1.5">
          {relays.map((relay) => (
            <li
              key={relay}
              className="truncate rounded-md bg-muted/50 px-2.5 py-2 font-mono text-xs"
              title={relay}
            >
              {relay}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      )}
    </div>
  );
}
