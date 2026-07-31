import { lazy, Suspense, useMemo } from "react";
import { useSeoMeta } from "@unhead/react";
import { ChevronDown, Download, Package, ShieldCheck, Tag } from "lucide-react";
import type {
  SoftwareApplication,
  SoftwareAsset,
  SoftwareRelease,
} from "@/casts/Software";
import { UserLink } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { useSoftwareReleases } from "@/hooks/useSoftwareReleases";
import { cn, safeFormat, safeFormatDistanceToNow } from "@/lib/utils";
import { useRepoContext } from "./RepoContext";

const MarkdownContent = lazy(() => import("@/components/MarkdownContent"));

function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function displayVersion(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

function dateTimeValue(timestamp: number): string | undefined {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function ReleasePageSkeleton() {
  return (
    <div className="space-y-6" aria-label="Loading releases">
      {Array.from({ length: 2 }).map((_, index) => (
        <div
          key={index}
          className="grid gap-3 md:grid-cols-[11rem_minmax(0,1fr)]"
        >
          <div className="space-y-2 pt-1">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Card>
            <CardHeader className="space-y-3">
              <Skeleton className="h-6 w-36" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-12 w-full mt-5" />
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}

function EmptyReleases({ hasApplication }: { hasApplication: boolean }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-12 px-8 text-center">
        <Package className="h-9 w-9 text-muted-foreground mx-auto mb-3" />
        <p className="font-medium mb-1">
          {hasApplication ? "No releases yet" : "No application linked"}
        </p>
        <p className="text-muted-foreground max-w-md mx-auto">
          {hasApplication
            ? "No releases were found on this repository’s relays or Zapstore."
            : "Releases appear here when a maintainer links a NIP-82 software application to this repository."}
        </p>
      </CardContent>
    </Card>
  );
}

function AssetRow({ asset }: { asset: SoftwareAsset }) {
  const size = formatBytes(asset.size);
  const downloadable = !!asset.downloadUrl;
  const content = (
    <>
      {downloadable ? (
        <Download className="h-4 w-4 shrink-0 text-muted-foreground group-hover/asset:text-pink-500" />
      ) : (
        <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={cn(
              "font-medium break-all",
              downloadable && "group-hover/asset:text-pink-500",
            )}
          >
            {asset.filename}
          </span>
          {size && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {size}
            </span>
          )}
        </div>
        {asset.platforms.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {asset.platforms.map((platform) => (
              <Badge
                key={platform}
                variant="secondary"
                className="h-5 px-1.5 text-[11px] font-normal"
              >
                {platform}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-start gap-1.5 mt-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <code className="font-mono break-all" title="SHA-256 checksum">
            SHA-256 {asset.sha256}
          </code>
        </div>
      </div>
    </>
  );

  const className = cn(
    "group/asset flex items-start gap-3 px-4 py-3",
    downloadable &&
      "transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
  );

  if (!asset.downloadUrl) {
    return <div className={className}>{content}</div>;
  }

  return (
    <a
      href={asset.downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      aria-label={`Download ${asset.filename}`}
    >
      {content}
    </a>
  );
}

function ReleaseAssets({
  release,
  assetsById,
  settled,
  defaultOpen,
}: {
  release: SoftwareRelease;
  assetsById: Map<string, SoftwareAsset>;
  settled: boolean;
  defaultOpen: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-t">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-3 text-left text-sm font-medium hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <Package className="h-4 w-4 text-muted-foreground" />
        Assets
        <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-[11px]">
          {release.assets.length}
        </Badge>
        <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">
          {release.assets.map(({ id }) => {
            const asset = assetsById.get(id);
            if (asset) return <AssetRow key={id} asset={asset} />;
            if (!settled) {
              return (
                <div key={id} className="flex items-center gap-3 px-4 py-4">
                  <Skeleton className="h-4 w-4" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48 max-w-full" />
                    <Skeleton className="h-3 w-72 max-w-full" />
                  </div>
                </div>
              );
            }
            return (
              <div key={id} className="px-4 py-3 text-sm text-muted-foreground">
                Asset metadata is unavailable from the repository relays and
                Zapstore.
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReleaseCard({
  release,
  application,
  assetsById,
  assetsSettled,
  latest,
  showApplication,
}: {
  release: SoftwareRelease;
  application: SoftwareApplication | undefined;
  assetsById: Map<string, SoftwareAsset>;
  assetsSettled: boolean;
  latest: boolean;
  showApplication: boolean;
}) {
  const relativeDate = safeFormatDistanceToNow(release.event.created_at, {
    addSuffix: true,
  });
  const exactDate = safeFormat(
    release.event.created_at,
    "MMM d, yyyy 'at' h:mm a",
  );
  const machineDate = dateTimeValue(release.event.created_at);
  const isPrerelease = release.channel !== "main";

  return (
    <article className="grid gap-3 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="min-w-0 pt-1 md:text-right">
        <div className="flex items-center gap-2 md:justify-end">
          <Tag className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-sm font-semibold break-all">
            {displayVersion(release.version)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2 md:justify-end">
          {latest && (
            <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
              Latest
            </Badge>
          )}
          {isPrerelease && (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-amber-700 dark:text-amber-300"
            >
              {release.channel}
            </Badge>
          )}
          {showApplication && application && (
            <Badge variant="secondary">{application.name}</Badge>
          )}
        </div>
      </div>

      <Card className={cn(latest && "border-emerald-500/40")}>
        <CardHeader className="p-5 pb-4">
          <CardTitle className="text-xl leading-tight break-words">
            {application?.name ?? release.appId} {release.version}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
            <UserLink pubkey={release.pubkey} avatarSize="xs" />
            <span>released this</span>
            {relativeDate && machineDate && (
              <time dateTime={machineDate} title={exactDate ?? undefined}>
                {relativeDate}
              </time>
            )}
          </div>
        </CardHeader>

        <CardContent className="p-5 pt-0">
          {release.notes.trim() ? (
            <Suspense
              fallback={
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              }
            >
              <MarkdownContent
                content={release.notes}
                className="markdown-content text-base"
              />
            </Suspense>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              No release notes provided.
            </p>
          )}
        </CardContent>

        <ReleaseAssets
          release={release}
          assetsById={assetsById}
          settled={assetsSettled}
          defaultOpen={latest}
        />
      </Card>
    </article>
  );
}

export default function RepoReleasesPage() {
  const { resolved } = useRepoContext();
  const repo = resolved?.repo;
  const {
    applications,
    releases,
    assetsById,
    applicationsSettled,
    releasesSettled,
    assetsSettled,
  } = useSoftwareReleases(
    repo?.allCoordinates,
    repo?.maintainerSet,
    resolved?.repoRelayGroup,
  );

  const applicationByReleaseKey = useMemo(
    () =>
      new Map(
        applications.map((application) => [
          `${application.pubkey}:${application.appId}`,
          application,
        ]),
      ),
    [applications],
  );

  const latestMainReleaseIds = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const release of releases) {
      if (release.channel !== "main") continue;
      const key = `${release.pubkey}:${release.appId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ids.add(release.event.id);
    }
    return ids;
  }, [releases]);

  useSeoMeta({
    title: repo ? `Releases - ${repo.name} - ngit` : "Releases - ngit",
    description: repo
      ? `Software releases and downloadable assets for ${repo.name}`
      : "Software releases and downloadable assets",
  });

  const loadingApplications = !applicationsSettled && applications.length === 0;
  const loadingReleases =
    applications.length > 0 && !releasesSettled && releases.length === 0;

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Releases</h1>
        {releases.length > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {releases.length}
          </Badge>
        )}
      </div>

      {loadingApplications || loadingReleases ? (
        <ReleasePageSkeleton />
      ) : applications.length === 0 ? (
        <EmptyReleases hasApplication={false} />
      ) : releases.length === 0 ? (
        <EmptyReleases hasApplication />
      ) : (
        <div className="space-y-8">
          {releases.map((release) => (
            <ReleaseCard
              key={release.event.id}
              release={release}
              application={applicationByReleaseKey.get(
                `${release.pubkey}:${release.appId}`,
              )}
              assetsById={assetsById}
              assetsSettled={assetsSettled}
              latest={latestMainReleaseIds.has(release.event.id)}
              showApplication={applications.length > 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
