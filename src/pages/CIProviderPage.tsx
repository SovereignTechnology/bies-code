import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { format, formatDistanceToNow } from "date-fns";
import { nip19 } from "nostr-tools";
import {
  ArrowLeft,
  ArrowUpRight,
  Clock3,
  Cpu,
  ExternalLink,
  GitBranch,
  RadioTower,
} from "lucide-react";
import type { CIProviderAdvertisement } from "@/casts/CIProvider";
import type { CIJobResultEvent } from "@/casts/CIJobResult";
import { CIStatusIcon } from "@/components/ci/CIStatusIcon";
import { CITrustContextLabel } from "@/components/ci/CITrustContextLabel";
import { EventCardActions } from "@/components/EventCardActions";
import { RepoBadge } from "@/components/RepoBadge";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCIProviderAdvertisement } from "@/hooks/useCIProviderAdvertisement";
import { useCICoordinatorAdvertisement } from "@/hooks/useCICoordinatorProfile";
import { useCIProviderJobs } from "@/hooks/useCIProviderJobs";
import { useCITrustContext } from "@/hooks/useCITrustContext";
import { useLoadProfile } from "@/hooks/useLoadProfile";
import { useProfile } from "@/hooks/useProfile";
import { useDefaultRepoCoordPath } from "@/hooks/useRepoPath";
import { ciStatusLabel } from "@/lib/ci";
import { getCITrustResolution } from "@/lib/ciTrustContext";
import { decodePubkeyIdentifier } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/NotFound";

export default function CIProviderPage() {
  const { providerIdentifier = "" } = useParams();
  const [searchParams] = useSearchParams();
  const pubkey = decodePubkeyIdentifier(providerIdentifier);
  useLoadProfile(pubkey);
  const profile = useProfile(pubkey);
  const state = useCIProviderAdvertisement(pubkey);
  const coordinatorState = useCICoordinatorAdvertisement(pubkey);
  const coordinatorAdvertisement = coordinatorState.advertisement;
  const relayHints = searchParams.getAll("relay");
  const providerJobs = useCIProviderJobs(pubkey, relayHints);
  const trust = useCITrustContext({
    extraIdentities: pubkey ? [pubkey] : [],
  });
  const advertisement = state.advertisement;
  const npub = pubkey ? nip19.npubEncode(pubkey) : undefined;
  const displayName =
    profile?.displayName ??
    profile?.name ??
    (npub ? `${npub.slice(0, 16)}…` : "CI identity");
  const now = Math.floor(Date.now() / 1000);
  const providerIsLive = advertisement?.isLive === true;
  const coordinatorIsLive =
    coordinatorAdvertisement !== undefined &&
    coordinatorAdvertisement.expiration > now;
  const hasAdvertisedRole = !!advertisement || !!coordinatorAdvertisement;
  const hasLiveRole = providerIsLive || coordinatorIsLive;
  const hasObservedProviderRole = providerJobs.jobs.length > 0;
  const rolesSettled =
    state.settled && coordinatorState.settled && providerJobs.settled;

  useSeoMeta({
    title: `${displayName} CI identity - ngit`,
    description:
      "CI identity, observed signed roles, capabilities, and trust context",
    ogImage: profile?.picture ?? "/og-image.png",
    ogImageAlt: displayName,
    twitterCard: profile?.picture ? "summary" : "summary_large_image",
  });

  if (!pubkey || !npub) return <NotFound />;

  return (
    <div className="min-h-full">
      <header className="relative isolate overflow-hidden border-b border-border/50">
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-violet-500/[0.08] via-background to-pink-500/[0.08]" />
        <div className="container max-w-screen-xl px-4 py-8 md:px-8 md:py-10">
          <Link
            to="/"
            className="mb-7 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            All repositories
          </Link>

          <div className="flex min-w-0 items-start gap-4 sm:gap-5">
            <div className="relative shrink-0">
              <UserAvatar
                pubkey={pubkey}
                size="xl"
                className="ring-4 ring-background shadow-lg"
              />
              {hasAdvertisedRole && (
                <span
                  className={cn(
                    "absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-background",
                    hasLiveRole ? "bg-emerald-500" : "bg-amber-500",
                  )}
                  aria-label={
                    hasLiveRole
                      ? "At least one advertised CI role is live"
                      : "Advertised CI roles are offline"
                  }
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="w-full min-w-0 truncate text-2xl font-bold tracking-tight sm:w-auto sm:text-3xl md:text-4xl">
                  {displayName}
                </h1>
                {advertisement && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        providerIsLive ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {providerIsLive ? "Live provider" : "Offline provider"}
                  </Badge>
                )}
                {!advertisement && hasObservedProviderRole && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                    Observed provider
                  </Badge>
                )}
                {coordinatorAdvertisement && (
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        coordinatorIsLive ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {coordinatorIsLive
                      ? "Live coordinator"
                      : "Offline coordinator"}
                  </Badge>
                )}
                <CITrustContextLabel
                  resolution={getCITrustResolution(trust, pubkey)}
                />
              </div>
              <p className="mt-2 text-lg text-muted-foreground">
                {advertisement
                  ? "Signed provider capabilities and execution identity."
                  : hasObservedProviderRole
                    ? "Signed Job Results show that this key executed CI jobs; no current provider advertisement was found."
                    : coordinatorAdvertisement
                      ? "A signed coordinator advertisement was found; no provider advertisement or observed Job Result was found."
                      : rolesSettled
                        ? "No signed provider or coordinator role evidence was found on the available relays."
                        : "Resolving signed CI roles and capabilities."}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {profile?.nip05 && (
                  <span className="font-medium text-pink-600 dark:text-pink-400">
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
                {coordinatorAdvertisement && (
                  <Link
                    to={`/coordinator/${npub}`}
                    className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Coordinator profile
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="container max-w-screen-xl px-4 py-8 md:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(19rem,0.9fr)]">
          <div className="min-w-0 space-y-6">
            <ProviderAdvertisementCard
              advertisement={advertisement}
              loading={!state.settled}
              hasObservedJobs={hasObservedProviderRole}
            />
            <ProviderJobsCard state={providerJobs} />
          </div>
          <aside className="space-y-6">
            <Card className="border-dashed">
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">CI trust context</h2>
                  <CITrustContextLabel
                    resolution={getCITrustResolution(trust, pubkey)}
                  />
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  This global view uses verified identity and viewer-relative
                  social history. A repository view can additionally show an
                  accepted result from an independently contextual coordinator.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  A provider signs the direct execution claim. Trust context
                  does not guarantee the job output or make the provider a
                  repository maintainer.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ProviderAdvertisementCard({
  advertisement,
  loading,
  hasObservedJobs,
}: {
  advertisement: CIProviderAdvertisement | undefined;
  loading: boolean;
  hasObservedJobs: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-4 p-6">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  if (!advertisement) {
    return (
      <Card className="border-dashed">
        <CardContent className="px-6 py-12 text-center">
          <Cpu className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="font-semibold">No provider advertisement found</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            {hasObservedJobs
              ? "The signed Job Results below show that this key acted as a provider for those jobs. They do not imply a persistent provider role, and this key has no current kind:19845 capability advertisement."
              : "A Job Result would show that its signer acted as a provider for that job. This key has no current kind:19845 capability advertisement."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <RadioTower className="h-5 w-5 text-violet-500" />
            Provider advertisement
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Published{" "}
            {formatDistanceToNow(advertisement.event.created_at * 1000, {
              addSuffix: true,
            })}
            . Expires{" "}
            {format(advertisement.expiration * 1000, "MMM d, yyyy 'at' h:mm a")}
            .
          </p>
        </div>
        <EventCardActions event={advertisement.event} />
      </CardHeader>
      <CardContent className="space-y-5">
        <CapabilityList
          title="Runner families"
          values={advertisement.runnerFamilies}
          icon={<Cpu className="h-4 w-4" />}
        />
        <CapabilityList
          title="Runner selectors"
          values={advertisement.runnerSelectors}
          icon={<GitBranch className="h-4 w-4" />}
        />
      </CardContent>
    </Card>
  );
}

function ProviderJobsCard({
  state,
}: {
  state: ReturnType<typeof useCIProviderJobs>;
}) {
  if (!state.settled && state.jobs.length === 0) {
    return (
      <Card>
        <CardContent
          className="space-y-3 p-6"
          aria-label="Loading provider job history"
        >
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (state.jobs.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="px-6 py-10 text-center">
          <Clock3 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <h2 className="font-semibold">No Job Results found</h2>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            No signed kind:9841 Job Results from this key were found on its
            available relay hints or configured Git index relays.
          </p>
          {state.partial && (
            <p className="mx-auto mt-2 max-w-lg text-xs text-muted-foreground">
              Some relay queries could not be completed, so this history may be
              incomplete.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const visibleJobs = state.jobs.slice(0, 25);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <Clock3 className="h-5 w-5 text-violet-500" />
          Observed job results
          <Badge variant="secondary" className="font-normal">
            {state.jobs.length}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Recent jobs this key claims to have executed. Each row links the
          signed result to its repository context when available.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {visibleJobs.map((job) => (
          <ProviderJobRow key={job.event.id} job={job} />
        ))}
        {state.jobs.length > visibleJobs.length && (
          <p className="pt-2 text-center text-xs text-muted-foreground">
            Showing the latest {visibleJobs.length} of {state.jobs.length} Job
            Results found.
          </p>
        )}
        {state.partial && (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Some relay queries could not be completed; additional jobs may exist
            elsewhere.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProviderJobRow({ job }: { job: CIJobResultEvent }) {
  const coordinate = job.repoCoord ?? "";
  const repoPath = useDefaultRepoCoordPath(coordinate);
  const title = job.name ?? job.jobId;

  return (
    <div className="rounded-lg border border-border/70 p-3 sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <CIStatusIcon status={job.status} className="mt-0.5 h-4 w-4" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-medium">
              {title}
            </span>
            <span className="text-xs text-muted-foreground">
              {ciStatusLabel(job.status)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {coordinate &&
              (repoPath ? (
                <Link
                  to={repoPath}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RepoBadge coord={coordinate} asSpan />
                </Link>
              ) : (
                <RepoBadge coord={coordinate} asSpan />
              ))}
            {job.workflowPath && (
              <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5">
                {job.workflowPath}
              </code>
            )}
            {job.commitId && (
              <span className="font-mono">{job.commitId.slice(0, 8)}</span>
            )}
            <span>
              {formatDistanceToNow(job.event.created_at * 1000, {
                addSuffix: true,
              })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.logUrl && (
            <a
              href={job.logUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open full job log"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <EventCardActions event={job.event} />
        </div>
      </div>
    </div>
  );
}

function CapabilityList({
  title,
  values,
  icon,
}: {
  title: string;
  values: readonly string[];
  icon: ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.map((value) => (
          <Badge key={value} variant="secondary" className="font-mono">
            {value}
          </Badge>
        ))}
      </div>
    </section>
  );
}
