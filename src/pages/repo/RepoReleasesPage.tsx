import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Globe,
  Download,
  List,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  ShieldCheck,
  Tag,
  KeyRound,
} from "lucide-react";
import type {
  SoftwareApplication,
  SoftwareAsset,
  SoftwareRelease,
} from "@/casts/Software";
import { EventCardActions } from "@/components/EventCardActions";
import { ImageGallery } from "@/components/ImageGallery";
import { RepoBadge } from "@/components/RepoBadge";
import { CreateReleaseDialog } from "@/components/releases/CreateReleaseDialog";
import { CreateSoftwareApplicationDialog } from "@/components/releases/CreateSoftwareApplicationDialog";
import { LinkSoftwareApplicationDialog } from "@/components/releases/LinkSoftwareApplicationDialog";
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
import {
  useAccountSoftwareApplications,
  useSoftwareReleases,
} from "@/hooks/useSoftwareReleases";
import { useUnreadHighlight } from "@/hooks/useUnreadHighlight";
import { blossomBlobUrl } from "@/lib/blossom";
import { parseRepoCoordinate } from "@/lib/nip34";
import { compareTagsNewestFirst } from "@/lib/refStatus";
import { parseUpstreamInput } from "@/lib/repoUpstreamInput";
import { eventIdToNevent, repoToPath } from "@/lib/routeUtils";
import { cn, safeFormat, safeFormatDistanceToNow } from "@/lib/utils";
import NotFound from "../NotFound";
import { useRepoContext } from "./RepoContext";

const MarkdownContent = lazy(() => import("@/components/MarkdownContent"));
const RELEASE_RENDER_BATCH = 20;

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

function externalHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
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
  hasMore,
  onLoadMore,
}: {
  releases: SoftwareRelease[];
  applicationByReleaseKey: Map<string, SoftwareApplication>;
  showApplication: boolean;
  activeReleaseId: string;
  onSelectRelease: (releaseId: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const location = useLocation();
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
                  to={`${location.search}#release-${entry.id}`}
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
            {hasMore && (
              <DropdownMenuItem
                onSelect={onLoadMore}
                className="justify-center"
              >
                <MoreHorizontal className="mr-2 h-4 w-4" />
                Load more releases
              </DropdownMenuItem>
            )}
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
                    to={`${location.search}#release-${entry.id}`}
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
            {hasMore && (
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-muted-foreground"
                  onClick={onLoadMore}
                  aria-label="Load more releases"
                  title="Load more releases"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </li>
            )}
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
  blossomServers,
  releasePath,
  applicationPath,
}: {
  release: SoftwareRelease;
  application: SoftwareApplication | undefined;
  assetsById: Map<string, SoftwareAsset>;
  assetsSettled: boolean;
  latest: boolean;
  blossomServers: string[];
  releasePath?: string;
  applicationPath?: string;
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
              {applicationPath && application ? (
                <Link
                  to={applicationPath}
                  className="hover:text-pink-500 hover:underline"
                >
                  {application.name}
                </Link>
              ) : (
                <span>{application?.name ?? release.appId}</span>
              )}{" "}
              {releasePath ? (
                <Link
                  to={releasePath}
                  className="hover:text-pink-500 hover:underline"
                >
                  {release.version}
                </Link>
              ) : (
                <span>{release.version}</span>
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

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function SoftwareApplicationPage({
  application,
  releases,
  assetsById,
  assetsSettled,
  latestMainReleaseIds,
  blossomServers,
  basePath,
  relayHints,
  onEdit,
  showPublisherControlNotice,
}: {
  application: SoftwareApplication;
  releases: SoftwareRelease[];
  assetsById: Map<string, SoftwareAsset>;
  assetsSettled: boolean;
  latestMainReleaseIds: Set<string>;
  blossomServers: string[];
  basePath: string;
  relayHints: string[];
  onEdit?: () => void;
  showPublisherControlNotice?: boolean;
}) {
  const repositoryUrl = externalHttpUrl(application.repository);
  const sourceUpstream = application.repository
    ? parseUpstreamInput(application.repository).upstream
    : undefined;
  const sourceRepositoryCoordinate = sourceUpstream?.repository;
  const sourceRepository = parseRepoCoordinate(sourceRepositoryCoordinate);
  const [renderedReleaseCount, setRenderedReleaseCount] =
    useState(RELEASE_RENDER_BATCH);
  const renderedReleases = releases.slice(0, renderedReleaseCount);
  const hasMoreReleases = renderedReleases.length < releases.length;

  useEffect(() => {
    setRenderedReleaseCount(RELEASE_RENDER_BATCH);
  }, [application.coordinate]);

  return (
    <div className="container max-w-screen-xl space-y-8 px-4 py-6 md:px-8">
      <Button variant="ghost" size="sm" asChild className="-ml-3">
        <Link to={`${basePath}/releases/apps`}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          All applications
        </Link>
      </Button>

      <section className="space-y-6">
        <div className="flex items-start gap-4">
          {application.icon ? (
            <img
              src={application.icon}
              alt=""
              className="h-20 w-20 shrink-0 rounded-xl border bg-muted object-cover shadow-sm"
            />
          ) : (
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border bg-muted">
              <Package className="h-9 w-9 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h1 className="text-3xl font-semibold tracking-tight break-words">
                  {application.name}
                </h1>
                {application.summary && (
                  <p className="mt-2 text-lg text-muted-foreground">
                    {application.summary}
                  </p>
                )}
              </div>
              <EventCardActions
                event={application.event}
                className="shrink-0"
                onEdit={onEdit}
                editTitle="Edit application"
              />
            </div>
            {(application.topics.length > 0 ||
              application.platforms.length > 0) && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {application.platforms.map((platform) => (
                  <Badge key={platform} variant="secondary">
                    {platform}
                  </Badge>
                ))}
                {application.topics.map((topic) => (
                  <Badge key={topic} variant="outline">
                    {topic}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        {showPublisherControlNotice && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
            <p className="text-muted-foreground">
              <UserLink
                pubkey={application.pubkey}
                avatarSize="xs"
                variant="inline"
              />{" "}
              controls this application. Only its publisher can edit it or
              publish releases and software assets; repository maintainer access
              does not grant that authority.
            </p>
          </div>
        )}

        {application.images.length > 0 && (
          <ImageGallery>
            {(openGallery) => {
              const slides = application.images.map((src, index) => ({
                src,
                alt: `${application.name} screenshot ${index + 1}`,
              }));
              return (
                <div
                  className="flex snap-x gap-4 overflow-x-auto pb-3"
                  aria-label={`${application.name} screenshots`}
                >
                  {slides.map((slide, index) => (
                    <button
                      key={`${slide.src}-${index}`}
                      type="button"
                      onClick={() => openGallery(slides, index)}
                      className="block shrink-0 snap-start cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`View ${slide.alt}`}
                    >
                      <img
                        src={slide.src}
                        alt={slide.alt}
                        className="h-80 w-auto max-w-lg rounded-xl border bg-muted object-contain"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              );
            }}
          </ImageGallery>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card>
            <CardHeader>
              <CardTitle>About this application</CardTitle>
            </CardHeader>
            <CardContent>
              {application.description.trim() ? (
                <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                  <MarkdownContent
                    content={application.description}
                    className="markdown-content text-base"
                  />
                </Suspense>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No application description provided.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Technical details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <DetailRow label="Publisher">
                  <UserLink pubkey={application.pubkey} avatarSize="xs" />
                </DetailRow>
                <DetailRow label="App ID">
                  <code className="font-mono text-xs break-all">
                    {application.appId}
                  </code>
                </DetailRow>
                {application.license && (
                  <DetailRow label="License">{application.license}</DetailRow>
                )}
                {application.website && (
                  <DetailRow label="Website">
                    <a
                      href={application.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-pink-600 hover:underline dark:text-pink-400"
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Visit website
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </DetailRow>
                )}
                {application.repository && (
                  <DetailRow label="Source">
                    {sourceRepository && sourceRepositoryCoordinate ? (
                      <RepoBadge
                        coord={sourceRepositoryCoordinate}
                        className="max-w-full overflow-hidden [&>span]:min-w-0 [&>span]:truncate"
                        to={repoToPath(
                          sourceRepository.pubkey,
                          sourceRepository.identifier,
                          sourceUpstream?.relayHint
                            ? [sourceUpstream.relayHint]
                            : [],
                        )}
                      />
                    ) : repositoryUrl ? (
                      <a
                        href={repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-pink-600 hover:underline dark:text-pink-400"
                      >
                        View repository
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <code className="font-mono text-xs break-all">
                        {application.repository}
                      </code>
                    )}
                  </DetailRow>
                )}
              </dl>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold">Releases</h2>
          <Badge variant="secondary">{releases.length}</Badge>
        </div>
        {releases.length === 0 ? (
          <EmptyReleases hasApplication />
        ) : (
          <div className="space-y-8">
            {renderedReleases.map((release) => (
              <ReleaseCard
                key={release.event.id}
                release={release}
                application={application}
                assetsById={assetsById}
                assetsSettled={assetsSettled}
                latest={latestMainReleaseIds.has(release.event.id)}
                blossomServers={blossomServers}
                releasePath={`${basePath}/releases/${eventIdToNevent(
                  release.event.id,
                  relayHints,
                )}`}
              />
            ))}
            {hasMoreReleases && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() =>
                  setRenderedReleaseCount((count) =>
                    Math.min(count + RELEASE_RENDER_BATCH, releases.length),
                  )
                }
              >
                Load more releases
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function SoftwareApplicationsIndex({
  applications,
  releases,
  basePath,
  relayHints,
  canPublish,
  accountApplicationCount,
  onCreate,
  onEdit,
  onBrowseApplications,
}: {
  applications: SoftwareApplication[];
  releases: SoftwareRelease[];
  basePath: string;
  relayHints: string[];
  canPublish: boolean;
  accountApplicationCount?: number;
  onCreate: () => void;
  onEdit: (application: SoftwareApplication) => void;
  onBrowseApplications: () => void;
}) {
  const account = useActiveAccount();

  return (
    <div className="container max-w-screen-xl space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to={`${basePath}/releases`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Releases
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">Applications</h1>
        {applications.length > 0 && (
          <Badge variant="secondary">{applications.length}</Badge>
        )}
        {canPublish && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={onBrowseApplications}>
              All your applications
              {accountApplicationCount !== undefined && (
                <Badge
                  variant="secondary"
                  className="ml-2 h-5 min-w-5 justify-center px-1.5 text-[11px]"
                >
                  {accountApplicationCount}
                </Badge>
              )}
            </Button>
            <Button onClick={onCreate}>
              <Plus className="mr-2 h-4 w-4" />
              New application
            </Button>
          </div>
        )}
      </div>

      {applications.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="px-8 py-12 text-center">
            <Package className="mx-auto mb-3 h-9 w-9 text-muted-foreground" />
            <p className="font-medium">No applications linked</p>
            <p className="mx-auto mt-1 max-w-md text-muted-foreground">
              Add the product this repository builds, or link an application you
              already publish.
            </p>
            {canPublish && (
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={onBrowseApplications}>
                  All your applications
                </Button>
                <Button onClick={onCreate}>
                  <Plus className="mr-2 h-4 w-4" />
                  New application
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {applications.map((application) => {
            const releaseCount = releases.filter(
              (release) =>
                release.applicationCoordinate === application.coordinate,
            ).length;
            const applicationPath = `${basePath}/releases/apps/${eventIdToNevent(
              application.event.id,
              relayHints,
            )}`;
            return (
              <Card key={application.coordinate}>
                <CardContent className="flex items-start gap-4 p-5">
                  {application.icon ? (
                    <img
                      src={application.icon}
                      alt=""
                      className="h-16 w-16 shrink-0 rounded-xl border bg-muted object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border bg-muted">
                      <Package className="h-7 w-7 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <Link
                          to={applicationPath}
                          className="text-lg font-semibold hover:text-pink-500 hover:underline"
                        >
                          {application.name}
                        </Link>
                        <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                          {application.appId}
                        </p>
                      </div>
                      <EventCardActions
                        event={application.event}
                        className="shrink-0"
                        onEdit={
                          application.pubkey === account?.pubkey
                            ? () => onEdit(application)
                            : undefined
                        }
                        editTitle="Edit application"
                      />
                    </div>
                    {application.summary && (
                      <p className="mt-3 text-sm text-muted-foreground">
                        {application.summary}
                      </p>
                    )}
                    <p className="mt-3 text-sm text-muted-foreground">
                      {releaseCount}{" "}
                      {releaseCount === 1 ? "release" : "releases"}
                    </p>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Publisher:{" "}
                      <UserLink
                        pubkey={application.pubkey}
                        avatarSize="xs"
                        variant="inline"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RepoReleasesPage({
  eventId,
  view,
}: {
  eventId?: string;
  view: "releases" | "applications";
}) {
  const { basePath, cloneUrls, resolved, repoState } = useRepoContext();
  const account = useActiveAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const blossomServers = useBlossomServers();
  const [createReleaseOpen, setCreateReleaseOpen] = useState(false);
  const [createApplicationOpen, setCreateApplicationOpen] = useState(false);
  const [linkApplicationOpen, setLinkApplicationOpen] = useState(false);
  const [editingApplication, setEditingApplication] =
    useState<SoftwareApplication>();
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
  const canPublishRelease =
    !!account && !!repo?.maintainerSet.includes(account.pubkey);
  const {
    applications: accountApplications,
    settled: accountApplicationsSettled,
  } = useAccountSoftwareApplications(
    canPublishRelease ? account?.pubkey : undefined,
    resolved?.repoRelayGroup,
  );
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
  const requestedApplicationCoordinate = searchParams.get("application");
  const filteredApplication = useMemo(
    () =>
      applications.find(
        (application) =>
          application.coordinate === requestedApplicationCoordinate,
      ),
    [applications, requestedApplicationCoordinate],
  );
  const visibleReleases = useMemo(
    () =>
      filteredApplication
        ? releases.filter(
            (release) =>
              release.applicationCoordinate === filteredApplication.coordinate,
          )
        : releases,
    [filteredApplication, releases],
  );
  const [renderedReleaseCount, setRenderedReleaseCount] =
    useState(RELEASE_RENDER_BATCH);
  const renderedReleases = useMemo(
    () => visibleReleases.slice(0, renderedReleaseCount),
    [renderedReleaseCount, visibleReleases],
  );
  const hasMoreReleases = renderedReleases.length < visibleReleases.length;
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreReleases = useCallback(() => {
    setRenderedReleaseCount((count) =>
      Math.min(count + RELEASE_RENDER_BATCH, visibleReleases.length),
    );
  }, [visibleReleases.length]);
  const releaseIds = useMemo(
    () => renderedReleases.map((release) => release.event.id),
    [renderedReleases],
  );
  const [visibleReleaseId, setVisibleReleaseId] = useState<string>();

  const selectedRelease =
    eventId && view === "releases"
      ? releases.find((release) => release.event.id === eventId)
      : undefined;
  const selectedApplication =
    eventId && view === "applications"
      ? (applications.find((application) => application.event.id === eventId) ??
        (editingApplication?.event.id === eventId
          ? editingApplication
          : undefined))
      : undefined;

  useSeoMeta({
    title:
      repo && selectedApplication
        ? `${selectedApplication.name} - ${repo.name} - ngit`
        : repo && selectedRelease
          ? `${displayVersion(selectedRelease.version)} - ${repo.name} - ngit`
          : repo && view === "applications"
            ? `Applications - ${repo.name} - ngit`
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
    renderedReleases.find((release) => release.event.id === visibleReleaseId)
      ?.event.id ??
    renderedReleases.find((release) => release.event.id === requestedReleaseId)
      ?.event.id ??
    renderedReleases[0]?.event.id ??
    "";

  useEffect(() => {
    setRenderedReleaseCount(RELEASE_RENDER_BATCH);
  }, [filteredApplication?.coordinate]);

  useEffect(() => {
    if (!requestedReleaseId) return;
    const requestedIndex = visibleReleases.findIndex(
      (release) => release.event.id === requestedReleaseId,
    );
    if (requestedIndex < renderedReleaseCount) return;
    setRenderedReleaseCount(
      Math.ceil((requestedIndex + 1) / RELEASE_RENDER_BATCH) *
        RELEASE_RENDER_BATCH,
    );
  }, [renderedReleaseCount, requestedReleaseId, visibleReleases]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || !hasMoreReleases) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreReleases();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreReleases, loadMoreReleases]);

  useEffect(() => {
    if (eventId) return;
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
  }, [eventId, releaseIds]);

  useEffect(() => {
    if (!location.hash || renderedReleases.length === 0) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(location.hash.slice(1))?.scrollIntoView({
        block: "start",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, renderedReleases.length]);

  if (view === "applications" && !eventId) {
    if (loadingApplications || loadingReleases) {
      return (
        <div className="container max-w-screen-xl px-4 py-6 md:px-8">
          <ReleasePageSkeleton />
        </div>
      );
    }

    return (
      <>
        <SoftwareApplicationsIndex
          applications={applications}
          releases={releases}
          basePath={basePath}
          relayHints={repo?.relays.slice(0, 1) ?? []}
          canPublish={canPublishRelease}
          accountApplicationCount={
            accountApplicationsSettled ? accountApplications.length : undefined
          }
          onCreate={() => setCreateApplicationOpen(true)}
          onEdit={setEditingApplication}
          onBrowseApplications={() => setLinkApplicationOpen(true)}
        />
        {repo && (
          <CreateSoftwareApplicationDialog
            open={createApplicationOpen}
            onOpenChange={setCreateApplicationOpen}
            existingApplications={applications}
            repoCoordinates={repo.allCoordinates}
            maintainerPubkeys={repo.maintainerSet}
            relayHint={repo.relays[0]}
          />
        )}
        {repo && editingApplication && (
          <CreateSoftwareApplicationDialog
            open
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setEditingApplication(undefined);
            }}
            existingApplications={applications}
            repoCoordinates={repo.allCoordinates}
            maintainerPubkeys={repo.maintainerSet}
            relayHint={repo.relays[0]}
            application={editingApplication}
            onPublished={() => setEditingApplication(undefined)}
          />
        )}
        {repo && (
          <LinkSoftwareApplicationDialog
            open={linkApplicationOpen}
            onOpenChange={setLinkApplicationOpen}
            applications={accountApplications}
            settled={accountApplicationsSettled}
            repoCoordinates={repo.allCoordinates}
            relayHint={repo.relays[0]}
          />
        )}
      </>
    );
  }

  if (eventId) {
    if (
      !selectedRelease &&
      !selectedApplication &&
      (!applicationsSettled || !releasesSettled)
    ) {
      return (
        <div className="container max-w-screen-xl px-4 md:px-8 py-6">
          <ReleasePageSkeleton />
        </div>
      );
    }

    if (selectedApplication) {
      return (
        <>
          <SoftwareApplicationPage
            application={selectedApplication}
            releases={releases.filter(
              (release) =>
                release.applicationCoordinate ===
                selectedApplication.coordinate,
            )}
            assetsById={assetsById}
            assetsSettled={assetsSettled}
            latestMainReleaseIds={latestMainReleaseIds}
            blossomServers={blossomServers}
            basePath={basePath}
            relayHints={repo?.relays.slice(0, 1) ?? []}
            onEdit={
              selectedApplication.pubkey === account?.pubkey
                ? () => setEditingApplication(selectedApplication)
                : undefined
            }
            showPublisherControlNotice={
              canPublishRelease &&
              selectedApplication.pubkey !== account?.pubkey
            }
          />
          {repo && editingApplication && (
            <CreateSoftwareApplicationDialog
              open
              onOpenChange={(nextOpen) => {
                if (!nextOpen) setEditingApplication(undefined);
              }}
              existingApplications={applications}
              repoCoordinates={repo.allCoordinates}
              maintainerPubkeys={repo.maintainerSet}
              relayHint={repo.relays[0]}
              application={editingApplication}
              onPublished={(application) => {
                setEditingApplication(undefined);
                navigate(
                  `${basePath}/releases/apps/${eventIdToNevent(
                    application.event.id,
                    repo.relays.slice(0, 1),
                  )}`,
                  { replace: true },
                );
              }}
            />
          )}
        </>
      );
    }

    if (!selectedRelease) return <NotFound />;
    const releaseApplication = applicationByReleaseKey.get(
      selectedRelease.applicationCoordinate,
    );

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
          application={releaseApplication}
          assetsById={assetsById}
          assetsSettled={assetsSettled}
          latest={latestMainReleaseIds.has(selectedRelease.event.id)}
          blossomServers={blossomServers}
          applicationPath={
            releaseApplication
              ? `${basePath}/releases/apps/${eventIdToNevent(
                  releaseApplication.event.id,
                  repo?.relays.slice(0, 1) ?? [],
                )}`
              : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Package className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Releases</h1>
        {visibleReleases.length > 0 && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {visibleReleases.length}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to={`${basePath}/releases/apps`}>
              Applications
              <Badge
                variant="secondary"
                className="ml-2 h-5 min-w-5 justify-center px-1.5 text-[11px]"
              >
                {applications.length}
              </Badge>
            </Link>
          </Button>
          {canPublishRelease && (
            <Button
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
      </div>

      {canPublishRelease && repo && releaseFormReady && (
        <CreateReleaseDialog
          open={createReleaseOpen}
          onOpenChange={setCreateReleaseOpen}
          applications={applications}
          existingReleases={releases}
          gitTags={gitTags}
          repoCoordinates={repo.allCoordinates}
          maintainerPubkeys={repo.maintainerSet}
          relayHint={repo.relays[0]}
        />
      )}

      {applications.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <span className="mr-1 text-sm font-medium text-muted-foreground">
            Apps in repo:
          </span>
          <Button
            type="button"
            size="sm"
            variant={filteredApplication ? "ghost" : "secondary"}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("application");
              setSearchParams(next, { replace: true });
              setVisibleReleaseId(undefined);
            }}
          >
            All
          </Button>
          {applications.map((application) => (
            <Button
              key={application.coordinate}
              type="button"
              size="sm"
              variant={
                filteredApplication?.coordinate === application.coordinate
                  ? "secondary"
                  : "ghost"
              }
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set("application", application.coordinate);
                setSearchParams(next, { replace: true });
                setVisibleReleaseId(undefined);
              }}
            >
              {application.name}
            </Button>
          ))}
        </div>
      )}

      {loadingApplications || loadingReleases ? (
        <ReleasePageSkeleton />
      ) : applications.length === 0 ? (
        <EmptyReleases hasApplication={false} />
      ) : visibleReleases.length === 0 ? (
        <EmptyReleases hasApplication />
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-6">
          <ReleaseNavigation
            releases={renderedReleases}
            applicationByReleaseKey={applicationByReleaseKey}
            showApplication={applications.length > 1}
            activeReleaseId={activeReleaseId}
            onSelectRelease={setVisibleReleaseId}
            hasMore={hasMoreReleases}
            onLoadMore={loadMoreReleases}
          />
          <div className="min-w-0 space-y-8">
            {renderedReleases.map((release) => {
              const application = applicationByReleaseKey.get(
                release.applicationCoordinate,
              );
              return (
                <ReleaseCard
                  key={release.event.id}
                  release={release}
                  application={application}
                  assetsById={assetsById}
                  assetsSettled={assetsSettled}
                  latest={latestMainReleaseIds.has(release.event.id)}
                  blossomServers={blossomServers}
                  releasePath={`${basePath}/releases/${eventIdToNevent(
                    release.event.id,
                    repo?.relays.slice(0, 1) ?? [],
                  )}`}
                  applicationPath={
                    application
                      ? `${basePath}/releases/apps/${eventIdToNevent(
                          application.event.id,
                          repo?.relays.slice(0, 1) ?? [],
                        )}`
                      : undefined
                  }
                />
              );
            })}
            {hasMoreReleases && (
              <div
                ref={loadMoreSentinelRef}
                className="h-px"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
