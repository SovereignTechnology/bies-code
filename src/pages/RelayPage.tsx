import { useErrorRetry, type ErrorRetryState } from "@/hooks/useErrorRetry";
import { ErrorRetryAction } from "@/components/ErrorRetryAction";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Filter } from "applesauce-core/helpers";
import type { RelayCountResponse as CountResponse } from "applesauce-relay";
import { nip19 } from "nostr-tools";
import { combineLatest, of, type Observable } from "rxjs";
import { catchError, map } from "rxjs/operators";
import {
  ArrowRight,
  CircleHelp,
  GitBranch,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  RadioTower,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { use$ } from "@/hooks/use$";
import { useCICoordinatorAdvertisement } from "@/hooks/useCICoordinatorProfile";
import { useDnsIdentity } from "@/hooks/useDnsIdentity";
import { useGraspServerInfo } from "@/hooks/useGraspServerInfo";
import {
  getGraspAccessSummary,
  type GraspAccessMode,
  type Nip11Document,
} from "@/lib/grasp";
import { ISSUE_KIND, PATCH_KIND, PR_KIND, REPO_KIND } from "@/lib/nip34";
import { decodePubkeyIdentifier, parseRelayUrl } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";
import { pool } from "@/services/nostr";
import NotFound from "./NotFound";
import RepositoriesPage from "./RepositoriesPage";

type CountValue = number | null | undefined;

interface GraspServiceCounts {
  repositories: CountValue;
  issues: CountValue;
  pullRequests: CountValue;
}

/**
 * Browse one relay as a service. GRASP-specific information lives here;
 * coordinator identity, capability, and activity remain on /coordinator.
 */
export default function RelayPage() {
  const { relaySegment } = useParams<{ relaySegment: string }>();

  if (!relaySegment) return <NotFound />;

  const relayUrl = parseRelayUrl(relaySegment);

  if (!relayUrl) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <div className="space-y-2 text-center">
          <p className="text-lg font-semibold">Invalid relay URL</p>
          <p className="text-sm text-muted-foreground">
            &ldquo;{relaySegment}&rdquo; could not be parsed as a relay address.
          </p>
        </div>
      </div>
    );
  }

  const relayLabel = relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "");

  return (
    <RepositoriesPage
      relayOverride={[relayUrl]}
      relayLabel={relayLabel}
      relayStatusBanner={
        <GraspServiceOverview relayUrl={relayUrl} domain={relayLabel} />
      }
    />
  );
}

function relayCount(
  relayUrl: string,
  filter: Filter,
): Observable<number | null> {
  return (
    pool.count([relayUrl], filter) as Observable<Record<string, CountResponse>>
  ).pipe(
    map((record) =>
      Object.values(record).reduce((sum, response) => sum + response.count, 0),
    ),
    catchError(() => of(null)),
  );
}

function useGraspServiceCounts(
  relayUrl: string,
  retryVersion: number,
): GraspServiceCounts | undefined {
  return use$(
    () =>
      combineLatest({
        repositories: relayCount(relayUrl, {
          kinds: [REPO_KIND],
        } as Filter),
        issues: relayCount(relayUrl, { kinds: [ISSUE_KIND] } as Filter),
        pullRequests: relayCount(relayUrl, {
          kinds: [PATCH_KIND, PR_KIND],
        } as Filter),
      }),
    [relayUrl, retryVersion],
  );
}

/**
 * Relay / GRASP service overview banner. Exported so the BIES Code homepage
 * (Index.tsx) can show it above this node's repository listing.
 */
export function GraspServiceOverview({
  relayUrl,
  domain,
}: {
  relayUrl: string;
  domain: string;
}) {
  const relay = useMemo(() => pool.relay(relayUrl), [relayUrl]);
  const connected = use$(() => relay.connected$, [relay]);
  const [countsVersion, setCountsVersion] = useState(0);
  const counts = useGraspServiceCounts(relayUrl, countsVersion);
  const countsRecovery = useErrorRetry({
    resourceKey: relayUrl,
    failed: !!counts && Object.values(counts).some((value) => value === null),
    busy: !counts,
    onRetry: () => setCountsVersion((version) => version + 1),
  });
  const server = useGraspServerInfo(domain);
  const rootIdentity = useDnsIdentity(`_@${domain}`);
  const operatorPubkey =
    server?.status === "found" && server.document.pubkey
      ? decodePubkeyIdentifier(server.document.pubkey)
      : undefined;
  const linkedOperatorPubkey =
    rootIdentity.status === "found" && rootIdentity.pubkey === operatorPubkey
      ? operatorPubkey
      : undefined;
  const coordinator = useCICoordinatorAdvertisement(linkedOperatorPubkey);
  const now = Math.floor(Date.now() / 1000);
  const coordinatorIsLive =
    coordinator.advertisement !== undefined &&
    coordinator.advertisement.expiration > now;
  const isGraspService =
    server?.status === "found" &&
    (server.document.supported_grasps?.length ?? 0) > 0;
  const linkIsLoading =
    server?.status === "loading" ||
    rootIdentity.status === "loading" ||
    (linkedOperatorPubkey !== undefined && !coordinator.settled);

  return (
    <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-secondary/[0.06] via-background to-primary/[0.05] shadow-sm">
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Server className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">
                  {isGraspService ? "GRASP service" : "Relay service"}
                </h2>
                <ConnectionBadge connected={connected} />
              </div>
              {server?.status === "loading" ? (
                <Skeleton className="mt-2 h-4 w-72 max-w-full" />
              ) : (
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                  {server?.status === "found"
                    ? (server.document.description ??
                      "Git hosting and repository collaboration over a Nostr relay.")
                    : "Browse repository announcements observed on this relay."}
                </p>
              )}
            </div>
          </div>

          {linkIsLoading ? (
            <Skeleton className="h-9 w-36 shrink-0" />
          ) : coordinatorIsLive && linkedOperatorPubkey ? (
            <Button asChild variant="outline" className="shrink-0 gap-2">
              <Link
                to={`/coordinator/${nip19.npubEncode(linkedOperatorPubkey)}?grasp=${encodeURIComponent(domain)}`}
              >
                CI coordinator
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          ) : null}
        </div>

        {server?.status === "error" && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
            GRASP metadata is unavailable: {server.message}
            <ErrorRetryAction recovery={server.recovery} />
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <AccessCard
            document={server?.status === "found" ? server.document : undefined}
          />
          <ServiceCountsCard counts={counts} recovery={countsRecovery} />
          <ProtocolCard
            document={server?.status === "found" ? server.document : undefined}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionBadge({ connected }: { connected: boolean | undefined }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal",
        connected
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {connected ? (
        <Wifi className="h-3 w-3" />
      ) : (
        <WifiOff className="h-3 w-3" />
      )}
      {connected === undefined
        ? "Connecting…"
        : connected
          ? "Connected"
          : "Disconnected"}
    </Badge>
  );
}

const accessPresentation: Record<
  GraspAccessMode,
  { icon: typeof ShieldCheck; className: string }
> = {
  public: {
    icon: ShieldCheck,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  curated: {
    icon: KeyRound,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  private: {
    icon: LockKeyhole,
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  unknown: {
    icon: CircleHelp,
    className: "bg-muted text-muted-foreground",
  },
};

function AccessCard({ document }: { document: Nip11Document | undefined }) {
  if (!document) return <OverviewSkeleton />;
  const access = getGraspAccessSummary(document);
  const presentation = accessPresentation[access.mode];
  const Icon = presentation.icon;

  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-4">
      <div
        className={cn(
          "mb-3 flex h-8 w-8 items-center justify-center rounded-lg",
          presentation.className,
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-sm font-semibold">{access.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {access.description}
      </p>
      {access.criteria && access.mode !== "public" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Published policy: {access.criteria}
        </p>
      )}
    </div>
  );
}

function ServiceCountsCard({
  counts,
  recovery,
}: {
  counts: GraspServiceCounts | undefined;
  recovery: ErrorRetryState;
}) {
  const stats = [
    {
      label: "Repositories",
      value: counts?.repositories,
      icon: GitBranch,
    },
    { label: "Issues", value: counts?.issues, icon: RadioTower },
    {
      label: "Pull requests",
      value: counts?.pullRequests,
      icon: GitPullRequest,
    },
  ];

  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-4">
      <p className="text-sm font-semibold">Hosted collaboration</p>
      <dl className="mt-3 space-y-2.5">
        {stats.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex items-center gap-2 text-xs">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            <dt className="flex-1 text-muted-foreground">{label}</dt>
            <dd className="font-mono font-medium tabular-nums">
              {value === undefined
                ? "…"
                : value === null
                  ? "Unavailable"
                  : value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      {counts && Object.values(counts).some((value) => value === null) && (
        <ErrorRetryAction recovery={recovery} />
      )}
    </div>
  );
}

function ProtocolCard({ document }: { document: Nip11Document | undefined }) {
  if (!document) return <OverviewSkeleton />;
  const grasps = document.supported_grasps ?? [];

  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-4">
      <p className="text-sm font-semibold">Service protocol</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {grasps.length > 0 ? (
          grasps.map((grasp) => (
            <Badge
              key={grasp}
              variant="secondary"
              className="font-mono text-[10px]"
            >
              {grasp}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">
            No GRASP capabilities advertised
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {document.version ? `Version ${document.version}` : "Version unknown"}
        {document.supported_nips?.length
          ? ` · ${document.supported_nips.length} NIPs`
          : ""}
      </p>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-background/70 p-4">
      <Skeleton className="h-8 w-8 rounded-lg" />
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}
