import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  List,
  Loader2,
  Package,
  Plus,
  ShieldCheck,
  Tag,
} from "lucide-react";
import type {
  SoftwareApplication,
  SoftwareAsset,
  SoftwareRelease,
} from "@/casts/Software";
import { EventCardActions } from "@/components/EventCardActions";
import { CreateReleaseDialog } from "@/components/releases/CreateReleaseDialog";
import { UserLink } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useBlossomServers } from "@/hooks/useBlossomFallback";
import { useGitPool } from "@/hooks/useGitPool";
import { useSoftwareReleases } from "@/hooks/useSoftwareReleases";
import { useUnreadHighlight } from "@/hooks/useUnreadHighlight";
import { blossomBlobUrl } from "@/lib/blossom";
import { compareTagsNewestFirst } from "@/lib/refStatus";
import { eventIdToNevent } from "@/lib/routeUtils";
import { cn, safeFormat, safeFormatDistanceToNow } from "@/lib/utils";
import NotFound from "../NotFound";
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
        <Card key={index}>
          <CardHeader className="space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-36" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-4 w-72 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-12 w-full mt-5" />
          </CardContent>
        </Card>
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

function releaseNavigationLabel(
  release: SoftwareRelease,
  application: SoftwareApplication | undefined,
  showApplication: boolean,
): string {
  const version = displayVersion(release.version);
  if (!showApplication) return version;
  return `${application?.name ?? release.appId} ${version}`;
}

function ReleaseNavigation({
  releases,
  applicationByReleaseKey,
  showApplication,
  activeReleaseId,
  onSelectRelease,
}: {
  releases: SoftwareRelease[];
  applicationByReleaseKey: Map<string, SoftwareApplication>;
  showApplication: boolean;
  activeReleaseId: string;
  onSelectRelease: (releaseId: string) => void;
}) {
  const releaseListRef = useRef<HTMLElement>(null);
  const entries = releases.map((release) => ({
    id: release.event.id,
    label: releaseNavigationLabel(
      release,
      applicationByReleaseKey.get(release.applicationCoordinate),
      showApplication,
    ),
  }));
  const jumpToRelease = (releaseId: string) => {
    onSelectRelease(releaseId);
    requestAnimationFrame(() => {
      const target = document.getElementById(`release-${releaseId}`);
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    const list = releaseListRef.current;
    const activeLink = list?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (!list || !activeLink) return;

    const listRect = list.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    if (linkRect.top < listRect.top) {
      list.scrollTop -= listRect.top - linkRect.top;
    } else if (linkRect.bottom > listRect.bottom) {
      list.scrollTop += linkRect.bottom - listRect.bottom;
    }
  }, [activeReleaseId]);

  return (
    <>
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              <span className="flex min-w-0 items-center gap-2">
                <List className="h-4 w-4 shrink-0" />
                <span className="truncate">Jump to release</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {entries.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                asChild
                onSelect={() => jumpToRelease(entry.id)}
              >
                <Link
                  to={`#release-${entry.id}`}
                  className="min-w-0 cursor-pointer"
                  aria-current={
                    entry.id === activeReleaseId ? "location" : undefined
                  }
                >
                  <Tag className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">{entry.label}</span>
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <aside
        className="hidden self-start md:sticky md:top-24 md:flex md:max-h-[calc(100vh-7rem)] md:flex-col"
        aria-label="Release list"
      >
        <h2 className="mb-2 shrink-0 text-sm font-semibold">Release list</h2>
        <nav
          ref={releaseListRef}
          className="min-h-0 overflow-y-auto overscroll-contain pr-1"
        >
          <ul className="space-y-1">
            {entries.map((entry) => {
              const active = entry.id === activeReleaseId;
              return (
                <li key={entry.id}>
                  <Link
                    to={`#release-${entry.id}`}
                    onClick={() => onSelectRelease(entry.id)}
                    aria-current={active ? "location" : undefined}
                    className={cn(
                      "block border-l-2 px-3 py-2 text-sm break-words transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-pink-500 bg-accent font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    {entry.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
}

function AssetRow({
  asset,
  blossomServers,
}: {
  asset: SoftwareAsset;
  blossomServers: string[];
}) {
  const anchorId = asset.event.id.slice(0, 15);
  const { ref, highlight } = useUnreadHighlight(anchorId);
  const rowRef = ref as React.RefObject<HTMLDivElement>;
  const size = formatBytes(asset.size);
  const blossomDownloadUrl = blossomServers
    .map((server) => blossomBlobUrl(server, asset.sha256))
    .find((url): url is string => !!url);
  const downloadUrl = asset.downloadUrl ?? blossomDownloadUrl;
  const downloadable = !!downloadUrl;
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
          <ShieldCheck className="h-4 w-4 shrink-0" />
          <code
            className="relative top-px font-mono leading-4 break-all"
            title="SHA-256 checksum"
          >
            SHA-256 {asset.sha256}
          </code>
        </div>
      </div>
    </>
  );

  const contentClassName = cn(
    "flex min-w-0 flex-1 items-start gap-3",
    downloadable &&
      "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );

  return (
    <div
      id={anchorId}
      ref={rowRef}
      className={cn(
        "group/asset flex scroll-mt-24 items-start gap-2 px-4 py-3 transition-colors duration-700",
        downloadable && "transition-colors hover:bg-accent/50",
        highlight === "strong" && "bg-pink-500/10",
        highlight === "subtle" && "bg-pink-500/5",
      )}
    >
      {downloadUrl ? (
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={contentClassName}
          aria-label={`Download ${asset.filename}`}
        >
          {content}
        </a>
      ) : (
        <div className={contentClassName}>{content}</div>
      )}
      <EventCardActions event={asset.event} className="shrink-0" />
    </div>
  );
}

function ReleaseAssets({
  release,
  assetsById,
  settled,
  defaultOpen,
  blossomServers,
}: {
  release: SoftwareRelease;
  assetsById: Map<string, SoftwareAsset>;
  settled: boolean;
  defaultOpen: boolean;
  blossomServers: string[];
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
            if (asset) {
              return (
                <AssetRow
                  key={id}
                  asset={asset}
                  blossomServers={blossomServers}
                />
              );
            }
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
  blossomServers,
  releasePath,
}: {
  release: SoftwareRelease;
  application: SoftwareApplication | undefined;
  assetsById: Map<string, SoftwareAsset>;
  assetsSettled: boolean;
  latest: boolean;
  showApplication: boolean;
  blossomServers: string[];
  releasePath?: string;
}) {
  const location = useLocation();
  const relativeDate = safeFormatDistanceToNow(release.event.created_at, {
    addSuffix: true,
  });
  const exactDate = safeFormat(
    release.event.created_at,
    "MMM d, yyyy 'at' h:mm a",
  );
  const machineDate = dateTimeValue(release.event.created_at);
  const isPrerelease = release.channel !== "main";
  const hasTargetedAsset = release.assets.some(
    ({ id }) => location.hash === `#${id.slice(0, 15)}`,
  );

  return (
    <article
      id={`release-${release.event.id}`}
      tabIndex={-1}
      className="scroll-mt-24 last:min-h-[calc(100vh-6rem)] focus:outline-none"
    >
      <Card className={cn(latest && "border-emerald-500/40")}>
        <CardHeader className="p-5 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-xl leading-tight break-words">
              {releasePath ? (
                <Link
                  to={releasePath}
                  className="hover:text-pink-500 hover:underline"
                >
                  {application?.name ?? release.appId} {release.version}
                </Link>
              ) : (
                <>
                  {application?.name ?? release.appId} {release.version}
                </>
              )}
            </CardTitle>
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
            <EventCardActions
              event={release.event}
              className="ml-auto shrink-0"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
            <UserLink pubkey={release.pubkey} avatarSize="xs" />
            <span>released this</span>
            {relativeDate && machineDate && (
              <time dateTime={machineDate} title={exactDate ?? undefined}>
                {relativeDate}
              </time>
            )}
            <span aria-hidden="true">·</span>
            <span className="flex min-w-0 items-center gap-1">
              <Tag className="h-4 w-4 shrink-0" />
              <span className="font-mono break-all">
                {displayVersion(release.version)}
              </span>
            </span>
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
          defaultOpen={latest || hasTargetedAsset}
          blossomServers={blossomServers}
        />
      </Card>
    </article>
  );
}

export default function RepoReleasesPage({
  releaseId,
}: {
  releaseId?: string;
}) {
  const { basePath, cloneUrls, resolved, repoState } = useRepoContext();
  const account = useActiveAccount();
  const location = useLocation();
  const blossomServers = useBlossomServers();
  const [createReleaseOpen, setCreateReleaseOpen] = useState(false);
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
  const { poolState } = useGitPool(cloneUrls, {
    headRef: repoState?.headRef,
    knownHeadCommit: repoState?.headCommitId,
    stateRefs: repoState?.refs,
    stateCreatedAt: repoState?.event.created_at,
  });

  const gitTags = useMemo(
    () =>
      Object.entries(poolState.authoritativeRefs)
        .filter(([name]) => name.startsWith("refs/tags/"))
        .map(([name, ref]) => ({
          name: name.slice("refs/tags/".length),
          commitId: ref.commitId,
        }))
        .sort((a, b) => compareTagsNewestFirst(a.name, b.name)),
    [poolState.authoritativeRefs],
  );

  const applicationByReleaseKey = useMemo(
    () =>
      new Map(
        applications.map((application) => [
          application.coordinate,
          application,
        ]),
      ),
    [applications],
  );
  const publishableApplications = useMemo(
    () =>
      account
        ? applications.filter(
            (application) => application.pubkey === account.pubkey,
          )
        : [],
    [account, applications],
  );
  const canPublishRelease =
    !!account && !!repo?.maintainerSet.includes(account.pubkey);
  const releaseDiscoverySettled =
    applicationsSettled && releasesSettled && !poolState.loading;
  // Discovery can briefly become unsettled when live filters or Git refs
  // refresh. Once opened, keep the dialog mounted so its draft is not reset.
  const releaseFormReady = releaseDiscoverySettled || createReleaseOpen;

  const latestMainReleaseIds = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const release of releases) {
      if (release.channel !== "main") continue;
      const key = release.applicationCoordinate;
      if (seen.has(key)) continue;
      seen.add(key);
      ids.add(release.event.id);
    }
    return ids;
  }, [releases]);
  const releaseIds = useMemo(
    () => releases.map((release) => release.event.id),
    [releases],
  );
  const [visibleReleaseId, setVisibleReleaseId] = useState<string>();

  const selectedRelease = releaseId
    ? releases.find((release) => release.event.id === releaseId)
    : undefined;

  useSeoMeta({
    title:
      repo && selectedRelease
        ? `${displayVersion(selectedRelease.version)} - ${repo.name} - ngit`
        : repo
          ? `Releases - ${repo.name} - ngit`
          : "Releases - ngit",
    description: repo
      ? `Software releases and downloadable assets for ${repo.name}`
      : "Software releases and downloadable assets",
  });

  const loadingApplications = !applicationsSettled && applications.length === 0;
  const loadingReleases =
    applications.length > 0 && !releasesSettled && releases.length === 0;
  const requestedReleaseId = location.hash.startsWith("#release-")
    ? location.hash.slice("#release-".length)
    : undefined;
  const activeReleaseId =
    releases.find((release) => release.event.id === visibleReleaseId)?.event
      .id ??
    releases.find((release) => release.event.id === requestedReleaseId)?.event
      .id ??
    releases[0]?.event.id ??
    "";

  useEffect(() => {
    if (releaseId) return;
    if (releaseIds.length === 0) return;

    let frame: number | undefined;
    const updateVisibleRelease = () => {
      frame = undefined;
      const viewportTop = 96;
      let nextReleaseId = releaseIds[0];

      for (const releaseId of releaseIds) {
        const element = document.getElementById(`release-${releaseId}`);
        if (!element) continue;
        nextReleaseId = releaseId;
        if (element.getBoundingClientRect().bottom > viewportTop) break;
      }

      setVisibleReleaseId((current) =>
        current === nextReleaseId ? current : nextReleaseId,
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(updateVisibleRelease);
    };

    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [releaseId, releaseIds]);

  useEffect(() => {
    if (!location.hash || releases.length === 0) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({
        block: "start",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, releases.length]);

  if (releaseId) {
    if (loadingApplications || loadingReleases) {
      return (
        <div className="container max-w-screen-xl px-4 md:px-8 py-6">
          <ReleasePageSkeleton />
        </div>
      );
    }

    if (!selectedRelease) return <NotFound />;

    return (
      <div className="container max-w-screen-xl px-4 md:px-8 py-6 space-y-5">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to={`${basePath}/releases`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            All releases
          </Link>
        </Button>
        <ReleaseCard
          release={selectedRelease}
          application={applicationByReleaseKey.get(
            selectedRelease.applicationCoordinate,
          )}
          assetsById={assetsById}
          assetsSettled={assetsSettled}
          latest={latestMainReleaseIds.has(selectedRelease.event.id)}
          showApplication={applications.length > 1}
          blossomServers={blossomServers}
        />
      </div>
    );
  }

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
        {canPublishRelease && (
          <Button
            className="ml-auto"
            onClick={() => setCreateReleaseOpen(true)}
            disabled={!releaseFormReady}
          >
            {releaseFormReady ? (
              <Plus className="mr-2 h-4 w-4" />
            ) : (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            New release
          </Button>
        )}
      </div>

      {canPublishRelease && repo && releaseFormReady && (
        <CreateReleaseDialog
          open={createReleaseOpen}
          onOpenChange={setCreateReleaseOpen}
          applications={publishableApplications}
          existingReleases={releases}
          gitTags={gitTags}
          repoCoordinates={repo.allCoordinates}
          relayHint={repo.relays[0]}
        />
      )}

      {loadingApplications || loadingReleases ? (
        <ReleasePageSkeleton />
      ) : applications.length === 0 ? (
        <EmptyReleases hasApplication={false} />
      ) : releases.length === 0 ? (
        <EmptyReleases hasApplication />
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-6">
          <ReleaseNavigation
            releases={releases}
            applicationByReleaseKey={applicationByReleaseKey}
            showApplication={applications.length > 1}
            activeReleaseId={activeReleaseId}
            onSelectRelease={setVisibleReleaseId}
          />
          <div className="min-w-0 space-y-8">
            {releases.map((release) => (
              <ReleaseCard
                key={release.event.id}
                release={release}
                application={applicationByReleaseKey.get(
                  release.applicationCoordinate,
                )}
                assetsById={assetsById}
                assetsSettled={assetsSettled}
                latest={latestMainReleaseIds.has(release.event.id)}
                showApplication={applications.length > 1}
                blossomServers={blossomServers}
                releasePath={`${basePath}/releases/${eventIdToNevent(
                  release.event.id,
                  repo?.relays.slice(0, 1) ?? [],
                )}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
