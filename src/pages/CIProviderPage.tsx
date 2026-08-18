import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { format, formatDistanceToNow } from "date-fns";
import { nip19 } from "nostr-tools";
import {
  ArrowLeft,
  ArrowUpRight,
  Cpu,
  GitBranch,
  RadioTower,
} from "lucide-react";
import type { CIProviderAdvertisement } from "@/casts/CIProvider";
import { CITrustContextLabel } from "@/components/ci/CITrustContextLabel";
import { EventCardActions } from "@/components/EventCardActions";
import { UserAvatar } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCIProviderAdvertisement } from "@/hooks/useCIProviderAdvertisement";
import { useCICoordinatorAdvertisement } from "@/hooks/useCICoordinatorProfile";
import { useCITrustContext } from "@/hooks/useCITrustContext";
import { useLoadProfile } from "@/hooks/useLoadProfile";
import { useProfile } from "@/hooks/useProfile";
import { getCITrustResolution } from "@/lib/ciTrustContext";
import { decodePubkeyIdentifier } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import NotFound from "@/pages/NotFound";

export default function CIProviderPage() {
  const { providerIdentifier = "" } = useParams();
  const pubkey = decodePubkeyIdentifier(providerIdentifier);
  useLoadProfile(pubkey);
  const profile = useProfile(pubkey);
  const state = useCIProviderAdvertisement(pubkey);
  const coordinatorAdvertisement = useCICoordinatorAdvertisement(pubkey);
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
                  : coordinatorAdvertisement
                    ? "This key advertises a coordinator role; no provider advertisement was found."
                    : state.settled
                      ? "A CI identity with no current provider advertisement."
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
          <ProviderAdvertisementCard
            advertisement={advertisement}
            loading={!state.settled}
          />
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
}: {
  advertisement: CIProviderAdvertisement | undefined;
  loading: boolean;
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
            A Job Result shows that its signer acted as a provider for that job.
            It does not imply a persistent provider role, and this key has no
            current kind:19845 capability advertisement.
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
