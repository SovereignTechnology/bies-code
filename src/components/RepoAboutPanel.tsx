import { useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { UserLink, UserAvatar, UserName } from "@/components/UserAvatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Globe,
  Copy,
  Check,
  Users,
  Tag,
  Radio,
  ExternalLink,
  GitBranch,
  Share2,
  Braces,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Server,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  graspCloneUrlNpub,
  computeMaintainerLeadership,
  getRepoRelays,
  getRepoUpstreams,
  groupRequestedMaintainers,
  REPO_KIND,
  type ResolvedRepo,
} from "@/lib/nip34";
import { RepoUpstreamSection } from "@/components/repo/RepoUpstreamSection";
import { GraspLogo } from "@/components/GraspLogo";
import type { NostrEvent } from "nostr-tools";
import { nip19 } from "nostr-tools";
import {
  getPointerForEvent,
  encodeDecodeResult,
  getSeenRelays,
  isAddressableKind,
  getReplaceableAddress,
} from "applesauce-core/helpers";
import { cn } from "@/lib/utils";
import { relayUrlToSegment, repoToPath } from "@/lib/routeUtils";
import { format } from "date-fns";
import { useRepoContext } from "@/pages/repo/RepoContext";
import { useActiveAccount } from "applesauce-react/hooks";
import { DeleteRepo } from "@/actions/nip34";
import { runner } from "@/services/actions";
import { useToast } from "@/hooks/useToast";
import { useNavigate } from "react-router-dom";
import { useUserPath } from "@/hooks/useUserPath";
import { normalizeUrl } from "@/lib/url";

// ---------------------------------------------------------------------------
// Helpers (shared)
// ---------------------------------------------------------------------------

function eventToNip19(event: NostrEvent): string {
  const relays = Array.from(getSeenRelays(event) ?? []).slice(0, 2);
  const pointer = getPointerForEvent(event, relays);
  return encodeDecodeResult(pointer);
}

function displayRelay(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
}

/** Returns true if the URL uses a web-compatible protocol (http/https). */
function isWebProtocol(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://");
}

/** Extract the hostname from an http(s) URL for compact display. */
function displayGitServerDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Shorten a URL for display: replace any NIP-19 substrings with a condensed
 * form, then truncate the overall string if still long.
 */
function shortenNip19InUrl(url: string): string {
  const shortened = url.replace(
    /\b(npub1|nsec1|note1|nevent1|naddr1|nprofile1)([0-9a-z]+)/g,
    (_, prefix: string, rest: string) => {
      const full = prefix + rest;
      if (full.length <= 16) return full;
      return full.slice(0, 10) + "…" + full.slice(-4);
    },
  );
  if (shortened.length > 60) {
    return shortened.slice(0, 57) + "…";
  }
  return shortened;
}

/** Returns true if a relay URL's hostname matches one of the Grasp server domains. */
function isGraspRelay(relayUrl: string, graspDomains: string[]): boolean {
  if (!graspDomains.length) return false;
  try {
    const hostname = new URL(relayUrl).hostname;
    return graspDomains.includes(hostname);
  } catch {
    return false;
  }
}

function npubToPubkey(npub: string): string | undefined {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === "npub") return decoded.data;
    return undefined;
  } catch {
    return undefined;
  }
}

function condenseNpub(npub: string): string {
  if (npub.length <= 12) return npub;
  return npub.slice(0, 8) + "…" + npub.slice(-2);
}

function condenseGraspUrl(url: string): string {
  const npub = graspCloneUrlNpub(url);
  if (!npub) return url;
  return url.replace(npub, condenseNpub(npub));
}

// ---------------------------------------------------------------------------
// GitServersSidebarSection — compact "Other Git Servers" block for sidebar
// ---------------------------------------------------------------------------

function GitServersSidebarSection({ urls }: { urls: string[] }) {
  const webUrls = urls.filter(isWebProtocol);
  const unsupportedCount = urls.length - webUrls.length;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <Server className="h-3 w-3" />
        Other Git Servers
      </p>
      <div className="flex flex-wrap gap-1">
        {webUrls.map((url) => (
          <span
            key={url}
            title={url}
            className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground"
          >
            {displayGitServerDomain(url)}
          </span>
        ))}
        {unsupportedCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/60 italic cursor-default">
                +{unsupportedCount} unsupported protocol
                {unsupportedCount > 1 ? "s" : ""}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="space-y-0.5">
                {urls
                  .filter((u) => !isWebProtocol(u))
                  .map((u) => (
                    <p key={u} className="font-mono text-xs break-all">
                      {u}
                    </p>
                  ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function invitedRepositoryPath(
  repo: ResolvedRepo,
  pubkey: string,
  pageSuffix: string,
): string {
  const announcement = repo.announcements.find(
    (event) => event.pubkey === pubkey,
  );
  const announcementRelays = announcement ? getRepoRelays(announcement) : [];
  const relays =
    announcementRelays.length > 0 ? announcementRelays : repo.relays;
  return `${repoToPath(pubkey, repo.dTag, relays)}${pageSuffix}`;
}

function RequestedMaintainersSummary({
  repo,
  pageSuffix,
  compact,
}: {
  repo: ResolvedRepo;
  pageSuffix: string;
  compact?: boolean;
}) {
  const groups = useMemo(() => groupRequestedMaintainers(repo), [repo]);
  const confirmedMaintainers = new Set(repo.confirmedMaintainers);
  const invitations = groups.flatMap((group) =>
    group.recipientMaintainers.map((pubkey) => ({
      pubkey,
      requesters: Array.from(
        new Set(
          repo.maintainerEdges
            .filter(
              ({ from, to }) => to === pubkey && confirmedMaintainers.has(from),
            )
            .map(({ from }) => from),
        ),
      ),
      existingRepositoryPath: group.hasAnnouncement
        ? invitedRepositoryPath(repo, pubkey, pageSuffix)
        : undefined,
    })),
  );

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 pt-1">
      <p className="text-xs text-muted-foreground/70">
        Invited maintainer{invitations.length === 1 ? "" : "s"}
      </p>
      <div className="space-y-1.5">
        {invitations.map(({ pubkey, requesters, existingRepositoryPath }) => (
          <div
            key={pubkey}
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <UserLink
              pubkey={pubkey}
              avatarSize={compact ? "xs" : "sm"}
              nameClassName="text-xs text-foreground"
            />
            {existingRepositoryPath && (
              <span>
                (has{" "}
                <Link
                  to={existingRepositoryPath}
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  existing repository
                </Link>
                )
              </span>
            )}
            {requesters.length > 0 &&
              requesters.length < repo.confirmedMaintainers.length && (
                <>
                  <span>invited by</span>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {requesters.map((requester) => (
                      <UserLink
                        key={requester}
                        pubkey={requester}
                        avatarSize="xs"
                        className="inline-flex"
                        nameClassName="text-xs text-foreground"
                      />
                    ))}
                  </span>
                </>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export interface RepoAboutPanelProps {
  repo: ResolvedRepo;
  /**
   * "sidebar" — compact card layout used on the code page.
   * "full"    — expanded layout used on the /about page.
   */
  variant: "sidebar" | "full";
}

export function RepoAboutPanel({ repo, variant }: RepoAboutPanelProps) {
  const isSidebar = variant === "sidebar";

  // Build the nostr:// clone URL for ngit
  let npub: string | undefined;
  try {
    npub = nip19.npubEncode(repo.selectedMaintainer);
  } catch {
    npub = undefined;
  }

  // Prefer the NIP-05 address from the route (already verified by RepoLayoutNip05)
  // over npub for the clone URL identity segment.
  // Strip leading "_@" — bare domain is the canonical form for the URL.
  const { nip05: routeNip05 } = useRepoContext();
  const identitySegment = routeNip05
    ? routeNip05.startsWith("_@")
      ? routeNip05.slice(2)
      : routeNip05
    : npub;

  // Extract a bare domain relay hint from the first declared relay (strip wss:// / ws://)
  const relayHint = repo.relays[0]
    ? repo.relays[0].replace(/^wss?:\/\//, "").replace(/\/$/, "")
    : undefined;
  // Percent-encode the identifier per NIP-34 §nostr:// clone URL spec
  const encodedDTag = encodeURIComponent(repo.dTag);
  const nostrCloneUrl = identitySegment
    ? relayHint
      ? `nostr://${identitySegment}/${relayHint}/${encodedDTag}`
      : `nostr://${identitySegment}/${encodedDTag}`
    : undefined;
  const hasAnyCloneUrl =
    repo.graspCloneUrls.length > 0 || repo.additionalGitServerUrls.length > 0;

  if (isSidebar) {
    return (
      <SidebarVariant
        repo={repo}
        nostrCloneUrl={nostrCloneUrl}
        hasAnyCloneUrl={hasAnyCloneUrl}
      />
    );
  }

  return <FullVariant repo={repo} nostrCloneUrl={nostrCloneUrl} />;
}

// ---------------------------------------------------------------------------
// Sidebar variant — compact card
// ---------------------------------------------------------------------------

function SidebarVariant({
  repo,
  nostrCloneUrl,
  hasAnyCloneUrl,
}: {
  repo: ResolvedRepo;
  nostrCloneUrl: string | undefined;
  hasAnyCloneUrl: boolean;
}) {
  const { basePath: repoBasePath } = useRepoContext();
  const account = useActiveAccount();
  const aboutPath = `${repoBasePath}/about`;
  const editPath = `${repoBasePath}/settings`;
  const isMaintainer =
    account?.pubkey && account.pubkey === repo.selectedMaintainer;
  const selectedAnnouncement = repo.announcements.find(
    (a) => a.pubkey === repo.selectedMaintainer,
  );
  const upstreams = selectedAnnouncement
    ? getRepoUpstreams(selectedAnnouncement)
    : [];
  const isMultiAnnouncement = repo.announcements.length > 1;
  const maintainerLeadership = useMemo(
    () =>
      computeMaintainerLeadership(
        repo.confirmedMaintainers,
        repo.maintainerEdges,
      ),
    [repo.confirmedMaintainers, repo.maintainerEdges],
  );
  const [multiModalOpen, setMultiModalOpen] = useState(false);

  return (
    <div className="space-y-3 min-w-0">
      {/* Clone button */}
      {(nostrCloneUrl || hasAnyCloneUrl) && (
        <CloneDropdown
          nostrCloneUrl={nostrCloneUrl}
          graspCloneUrls={repo.graspCloneUrls}
          additionalGitServerUrls={repo.additionalGitServerUrls}
        />
      )}

      {/* About card */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        {/* Card header */}
        <div className="px-4 pt-3 pb-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            About
          </p>
        </div>

        <div className="px-4 pt-3 pb-4 space-y-4">
          {/* Description */}
          {repo.description && (
            <p className="text-sm text-muted-foreground leading-relaxed">
              {repo.description}
            </p>
          )}

          <RepoUpstreamSection upstreams={upstreams} compact />

          {/* Web URLs */}
          {repo.webUrls.length > 0 && (
            <div className="space-y-1">
              {repo.webUrls.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline min-w-0"
                  title={url}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{shortenNip19InUrl(url)}</span>
                </a>
              ))}
            </div>
          )}

          {/* Maintainers */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Maintainers
            </p>
            <div className="space-y-2">
              {repo.confirmedMaintainers.map((pk) => (
                <div key={pk} className="flex items-center gap-2">
                  <UserLink
                    pubkey={pk}
                    avatarSize="sm"
                    nameClassName="text-sm"
                  />
                  {pk === repo.selectedMaintainer &&
                    repo.confirmedMaintainers.length > 1 && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 h-4 text-primary border-primary/40"
                      >
                        selected
                      </Badge>
                    )}
                  {pk === maintainerLeadership.leadMaintainer && (
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-4 text-primary border-primary/40"
                    >
                      lead
                    </Badge>
                  )}
                </div>
              ))}
            </div>
            <RequestedMaintainersSummary repo={repo} pageSuffix="" compact />
          </div>

          {/* Topics */}
          {repo.labels.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Topics
              </p>
              <div className="flex flex-wrap gap-1.5">
                {repo.labels.map((label) => (
                  <Badge key={label} variant="secondary" className="text-xs">
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Grasp server relays */}
          {repo.relays.some((r) =>
            isGraspRelay(r, repo.graspServerDomains),
          ) && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <GraspLogo className="h-3 w-3 text-primary" />
                Grasp Servers
              </p>
              <div className="flex flex-wrap gap-1">
                {repo.relays
                  .filter((r) => isGraspRelay(r, repo.graspServerDomains))
                  .map((relay) => (
                    <Link
                      key={relay}
                      to={`/relay/${relayUrlToSegment(relay)}`}
                      title={relay}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      {displayRelay(relay)}
                    </Link>
                  ))}
              </div>
            </div>
          )}

          {/* Other relays (non-Grasp) */}
          {repo.relays.some(
            (r) => !isGraspRelay(r, repo.graspServerDomains),
          ) && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <Radio className="h-3 w-3" />
                {repo.relays.some((r) =>
                  isGraspRelay(r, repo.graspServerDomains),
                )
                  ? "Other Relays"
                  : "Relays"}
              </p>
              <div className="flex flex-wrap gap-1">
                {repo.relays
                  .filter((r) => !isGraspRelay(r, repo.graspServerDomains))
                  .map((relay) => (
                    <Link
                      key={relay}
                      to={`/relay/${relayUrlToSegment(relay)}`}
                      title={relay}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      {displayRelay(relay)}
                    </Link>
                  ))}
              </div>
            </div>
          )}

          {/* Other git servers */}
          {repo.additionalGitServerUrls.length > 0 && (
            <GitServersSidebarSection urls={repo.additionalGitServerUrls} />
          )}
        </div>

        {/* Footer: show more + announcement action buttons + edit */}
        <div className="px-4 pb-3 -mt-1 flex items-center justify-between">
          {aboutPath ? (
            <Link
              to={aboutPath}
              className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors inline-flex items-center gap-0.5"
            >
              Show more
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-0.5">
            {isMaintainer && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
                title="Edit settings"
                asChild
              >
                <Link to={editPath}>
                  <Pencil className="h-3 w-3" />
                </Link>
              </Button>
            )}
            {isMultiAnnouncement ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
                  title="View raw announcement events"
                  onClick={() => setMultiModalOpen(true)}
                >
                  <Braces className="h-3 w-3" />
                </Button>
                <MultiAnnouncementsModal
                  announcements={repo.announcements}
                  selectedMaintainer={repo.selectedMaintainer}
                  confirmedMaintainers={repo.confirmedMaintainers}
                  leadMaintainer={maintainerLeadership.leadMaintainer}
                  open={multiModalOpen}
                  onOpenChange={setMultiModalOpen}
                />
              </>
            ) : (
              selectedAnnouncement && (
                <AnnouncementEventActions event={selectedAnnouncement} />
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full variant — expanded /about page layout
// ---------------------------------------------------------------------------

function FullVariant({
  repo,
  nostrCloneUrl,
}: {
  repo: ResolvedRepo;
  nostrCloneUrl: string | undefined;
}) {
  const { basePath } = useRepoContext();
  const account = useActiveAccount();
  const isMaintainer =
    account?.pubkey && account.pubkey === repo.selectedMaintainer;
  const editPath = `${basePath}/settings`;

  // For union display: find which relays/clone URLs are from other reachable
  // repository announcements.
  const selectedAnnouncement = useMemo(
    () => repo.announcements.find((a) => a.pubkey === repo.selectedMaintainer),
    [repo],
  );
  const upstreams = useMemo(
    () => (selectedAnnouncement ? getRepoUpstreams(selectedAnnouncement) : []),
    [selectedAnnouncement],
  );
  const hasMultipleAnnouncements = repo.announcements.length > 1;
  const confirmedMaintainerSet = useMemo(
    () => new Set(repo.confirmedMaintainers),
    [repo.confirmedMaintainers],
  );
  const maintainerLeadership = useMemo(
    () =>
      computeMaintainerLeadership(
        repo.confirmedMaintainers,
        repo.maintainerEdges,
      ),
    [repo.confirmedMaintainers, repo.maintainerEdges],
  );

  // Relays in other reachable announcements but not in the selected
  // maintainer's announcement.
  const unionOnlyRelayUrls = useMemo((): Set<string> => {
    if (!hasMultipleAnnouncements || !selectedAnnouncement) return new Set();
    const myRelays = new Set(
      getRepoRelays(selectedAnnouncement).map(normalizeUrl),
    );
    return new Set(repo.relays.filter((r) => !myRelays.has(normalizeUrl(r))));
  }, [hasMultipleAnnouncements, selectedAnnouncement, repo.relays]);

  // Helper: get the contributor pubkey for a union relay/clone
  const getContributorPubkey = useCallback(
    (value: string, isClone: boolean): string => {
      const provenance = isClone
        ? repo.cloneUrlProvenance
        : repo.relayProvenance;
      return provenance.find((p) => p.value === value)?.pubkey ?? "";
    },
    [repo.cloneUrlProvenance, repo.relayProvenance],
  );

  return (
    <div className="space-y-6">
      {/* Description */}
      {repo.description && (
        <p className="text-sm text-foreground/80 leading-relaxed">
          {repo.description}
        </p>
      )}

      <RepoUpstreamSection upstreams={upstreams} />

      {/* Topics */}
      {repo.labels.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5" />
            Topics
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {repo.labels.map((label) => (
              <Badge key={label} variant="secondary" className="text-xs">
                {label}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Website */}
      {repo.webUrls.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5" />
            Website
          </h3>
          <div className="space-y-1">
            {repo.webUrls.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={url}
                className="flex items-center gap-2 text-sm text-primary hover:underline min-w-0"
              >
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{shortenNip19InUrl(url)}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Maintainers */}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Maintainers
        </h3>
        <div className="space-y-2.5">
          {repo.confirmedMaintainers.map((pk) => (
            <div key={pk} className="flex items-center gap-2">
              <UserLink pubkey={pk} avatarSize="md" nameClassName="text-sm" />
              {pk === repo.selectedMaintainer &&
                repo.confirmedMaintainers.length > 1 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 text-primary border-primary/40"
                  >
                    selected
                  </Badge>
                )}
              {pk === maintainerLeadership.leadMaintainer && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 text-primary border-primary/40"
                >
                  lead
                </Badge>
              )}
            </div>
          ))}
          {repo.requestedMaintainers.length > 0 && (
            <>
              <Separator />
              <RequestedMaintainersSummary repo={repo} pageSuffix="/about" />
            </>
          )}
        </div>
      </section>

      {/* Grasp Server relays */}
      {repo.relays.some((r) => isGraspRelay(r, repo.graspServerDomains)) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <GraspLogo className="h-3.5 w-3.5 text-primary" />
            Grasp Servers
          </h3>
          {/* Own announcement's Grasp relays */}
          {repo.relays.some(
            (r) =>
              isGraspRelay(r, repo.graspServerDomains) &&
              !unionOnlyRelayUrls.has(r),
          ) && (
            <div className="flex flex-wrap gap-1.5">
              {repo.relays
                .filter(
                  (r) =>
                    isGraspRelay(r, repo.graspServerDomains) &&
                    !unionOnlyRelayUrls.has(r),
                )
                .map((relay) => (
                  <Link
                    key={relay}
                    to={`/relay/${relayUrlToSegment(relay)}`}
                    title={relay}
                    className="text-xs font-mono bg-muted/50 px-2 py-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    {displayRelay(relay)}
                  </Link>
                ))}
            </div>
          )}
          {/* Union relays from accepted or invited repositories */}
          {repo.relays.some(
            (r) =>
              isGraspRelay(r, repo.graspServerDomains) &&
              unionOnlyRelayUrls.has(r),
          ) && (
            <UnionRelayGroup
              relays={repo.relays.filter(
                (r) =>
                  isGraspRelay(r, repo.graspServerDomains) &&
                  unionOnlyRelayUrls.has(r),
              )}
              getContributor={(r) => getContributorPubkey(r, false)}
              confirmedMaintainers={confirmedMaintainerSet}
            />
          )}
        </section>
      )}

      {/* Other Relays (non-Grasp) */}
      {repo.relays.some((r) => !isGraspRelay(r, repo.graspServerDomains)) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Radio className="h-3.5 w-3.5" />
            {repo.relays.some((r) => isGraspRelay(r, repo.graspServerDomains))
              ? "Other Relays"
              : "Relays"}
          </h3>
          {/* Own announcement's non-Grasp relays */}
          {repo.relays.some(
            (r) =>
              !isGraspRelay(r, repo.graspServerDomains) &&
              !unionOnlyRelayUrls.has(r),
          ) && (
            <div className="flex flex-wrap gap-1.5">
              {repo.relays
                .filter(
                  (r) =>
                    !isGraspRelay(r, repo.graspServerDomains) &&
                    !unionOnlyRelayUrls.has(r),
                )
                .map((relay) => (
                  <Link
                    key={relay}
                    to={`/relay/${relayUrlToSegment(relay)}`}
                    title={relay}
                    className="text-xs font-mono bg-muted/50 px-2 py-0.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    {displayRelay(relay)}
                  </Link>
                ))}
            </div>
          )}
          {/* Union relays from accepted or invited repositories */}
          {repo.relays.some(
            (r) =>
              !isGraspRelay(r, repo.graspServerDomains) &&
              unionOnlyRelayUrls.has(r),
          ) && (
            <UnionRelayGroup
              relays={repo.relays.filter(
                (r) =>
                  !isGraspRelay(r, repo.graspServerDomains) &&
                  unionOnlyRelayUrls.has(r),
              )}
              getContributor={(r) => getContributorPubkey(r, false)}
              confirmedMaintainers={confirmedMaintainerSet}
            />
          )}
        </section>
      )}

      {/* Clone — nostr:// address + server breakdown */}
      {(nostrCloneUrl || repo.cloneUrls.length > 0) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            Clone
          </h3>

          {/* nostr:// address — field style matching CloneDropdown */}
          {nostrCloneUrl && <NgitCloneField cloneUrl={nostrCloneUrl} />}

          {/* Git server URLs with explanatory heading */}
          {repo.cloneUrls.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 pt-1">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Raw git URLs
                </h4>
                <Tooltip>
                  <Popover>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          aria-label="About raw git URLs"
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Git servers act as relays
                    </TooltipContent>
                    <PopoverContent
                      className="w-72 text-xs text-muted-foreground leading-relaxed"
                      side="right"
                    >
                      <p>
                        Git servers act as relays — usable as read-only remotes
                        without ngit.
                      </p>
                    </PopoverContent>
                  </Popover>
                </Tooltip>
              </div>
              <CloneServerList
                graspCloneUrls={repo.graspCloneUrls}
                additionalGitServerUrls={repo.additionalGitServerUrls}
                getContributor={(url) => getContributorPubkey(url, true)}
                confirmedMaintainers={confirmedMaintainerSet}
                selectedMaintainer={repo.selectedMaintainer}
              />
            </>
          )}
        </section>
      )}

      {/* Bottom action bar: edit + share + raw event + delete */}
      {repo.announcements.length > 0 && (
        <FullVariantActionBar
          announcements={repo.announcements}
          selectedMaintainer={repo.selectedMaintainer}
          confirmedMaintainers={repo.confirmedMaintainers}
          leadMaintainer={maintainerLeadership.leadMaintainer}
          editPath={isMaintainer ? editPath : undefined}
          repoCoords={isMaintainer ? repo.allCoordinates : undefined}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NgitCloneField — field-style clone URL matching the CloneDropdown look
// ---------------------------------------------------------------------------

function NgitCloneField({ cloneUrl }: { cloneUrl: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [cloneUrl]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          ngit
          <span className="text-muted-foreground/70">(nostr git plugin)</span>
        </p>
        <a
          href="https://ngit.dev/install"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1"
        >
          Install ngit
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy nostr:// URL"
        className={cn(
          "w-full flex items-center gap-1.5 rounded-md border px-3 py-2 min-w-0 text-left transition-colors cursor-pointer",
          copied
            ? "border-green-500/60 bg-green-500/5"
            : "border-border bg-muted/50 hover:bg-muted hover:border-border/80",
        )}
      >
        <code
          className="flex-1 text-xs font-mono text-foreground/90 truncate min-w-0 select-none"
          title={cloneUrl}
        >
          {cloneUrl}
        </code>
        <span className="shrink-0 text-muted-foreground transition-colors p-0.5 rounded">
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CloneServerList — grouped grasp / git server rows
// ---------------------------------------------------------------------------

function CloneServerList({
  graspCloneUrls,
  additionalGitServerUrls,
  getContributor,
  confirmedMaintainers,
  selectedMaintainer,
}: {
  graspCloneUrls: string[];
  additionalGitServerUrls: string[];
  getContributor?: (url: string) => string;
  confirmedMaintainers?: ReadonlySet<string>;
  selectedMaintainer?: string;
}) {
  const hasGrasp = graspCloneUrls.length > 0;
  const hasAdditional = additionalGitServerUrls.length > 0;

  if (!hasGrasp && !hasAdditional) return null;

  return (
    <div className="space-y-3">
      {hasGrasp && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            <GraspLogo className="h-3 w-3 text-primary" />
            Grasp Servers
          </div>
          <div className="space-y-1">
            {graspCloneUrls.map((url) => (
              <CloneServerRow
                key={url}
                url={url}
                isGrasp
                sourceLabel={cloneServerSourceLabel(
                  url,
                  getContributor,
                  confirmedMaintainers,
                  selectedMaintainer,
                )}
              />
            ))}
          </div>
        </div>
      )}

      {hasAdditional && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            <Server className="h-3 w-3" />
            Other Git Servers
          </div>
          <div className="space-y-1">
            {additionalGitServerUrls.map((url) => (
              <CloneServerRow
                key={url}
                url={url}
                isGrasp={false}
                sourceLabel={cloneServerSourceLabel(
                  url,
                  getContributor,
                  confirmedMaintainers,
                  selectedMaintainer,
                )}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function cloneServerSourceLabel(
  url: string,
  getContributor?: (url: string) => string,
  confirmedMaintainers?: ReadonlySet<string>,
  selectedMaintainer?: string,
): string | undefined {
  const contributor = getContributor?.(url);
  if (!contributor || contributor === selectedMaintainer) return undefined;
  return confirmedMaintainers?.has(contributor)
    ? "accepted co-maintainer"
    : "invited repository";
}

function CloneServerRow({
  url,
  isGrasp,
  sourceLabel,
}: {
  url: string;
  isGrasp: boolean;
  sourceLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [url]);

  const npub = isGrasp ? (graspCloneUrlNpub(url) ?? undefined) : undefined;
  const pubkey = npub ? npubToPubkey(npub) : undefined;
  const displayUrl = isGrasp ? condenseGraspUrl(url) : url;

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 text-xs group transition-colors rounded border cursor-pointer",
        copied
          ? "border-green-500/60 bg-green-500/5"
          : "border-border/40 bg-muted/20 hover:bg-muted/50 hover:border-border/60",
      )}
      aria-label={`Copy clone URL: ${url}`}
    >
      <div className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
        <p
          className="font-mono text-[11px] break-all leading-snug text-foreground/80"
          title={url}
        >
          {displayUrl}
        </p>
        {sourceLabel && (
          <Badge
            variant="outline"
            className="h-4 shrink-0 px-1.5 font-sans text-[9px] font-normal text-muted-foreground"
          >
            {sourceLabel}
          </Badge>
        )}
        {isGrasp && (pubkey ?? npub) && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-popover px-1.5 py-0.5 shadow-sm whitespace-nowrap font-sans leading-none shrink-0">
            {pubkey ? (
              <>
                <UserAvatar
                  pubkey={pubkey}
                  size="sm"
                  className="h-3.5 w-3.5 text-[6px] shrink-0"
                />
                <UserName
                  pubkey={pubkey}
                  className="text-[10px] text-muted-foreground font-normal"
                />
              </>
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {condenseNpub(npub!)}
              </span>
            )}
          </span>
        )}
      </div>
      <span className="shrink-0 opacity-30 group-hover:opacity-100 transition-opacity text-muted-foreground">
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// AnnouncementEventRows — shared inner content used by both the modal and
// the collapsed section on the /about page.
// ---------------------------------------------------------------------------

function AnnouncementEventRows({
  announcements,
  selectedMaintainer,
  confirmedMaintainers,
  leadMaintainer,
}: {
  announcements: NostrEvent[];
  selectedMaintainer: string;
  confirmedMaintainers: string[];
  leadMaintainer?: string;
}) {
  const [jsonEvent, setJsonEvent] = useState<NostrEvent | null>(null);
  const isMulti = announcements.length > 1;
  const confirmed = new Set(confirmedMaintainers);

  // Sort freshest first
  const sorted = [...announcements].sort((a, b) => b.created_at - a.created_at);

  return (
    <>
      <div className="space-y-2">
        {isMulti && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            Repository data is combined across accepted maintainers and
            directionally authorized invited repositories. Infrastructure and
            metadata from invited repositories remain active inputs and are{" "}
            <span className="text-foreground font-medium">
              explicitly labelled below
            </span>
            .
          </p>
        )}

        {sorted.map((ev) => {
          const isSelected = ev.pubkey === selectedMaintainer;
          const isAccepted = confirmed.has(ev.pubkey);
          const isLead = ev.pubkey === leadMaintainer;
          const updatedAt = format(
            new Date(ev.created_at * 1000),
            "MMM d, yyyy 'at' h:mm a",
          );
          return (
            <div
              key={ev.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                {isMulti ? (
                  <UserLink
                    pubkey={ev.pubkey}
                    avatarSize="sm"
                    nameClassName="text-xs font-medium"
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {updatedAt}
                  </span>
                )}
                {isMulti && isSelected && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 shrink-0 text-primary border-primary/40"
                  >
                    selected
                  </Badge>
                )}
                {isMulti && !isSelected && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-4 shrink-0 px-1.5 text-[10px]",
                      isAccepted
                        ? "text-primary border-primary/40"
                        : "text-amber-700 border-amber-500/40 dark:text-amber-300",
                    )}
                  >
                    {isAccepted
                      ? "accepted co-maintainer"
                      : "invited repository"}
                  </Badge>
                )}
                {isMulti && isLead && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 shrink-0 text-primary border-primary/40"
                  >
                    lead
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isMulti && (
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                    {updatedAt}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1"
                  onClick={() => setJsonEvent(ev)}
                >
                  <Braces className="h-3 w-3" />
                  Raw event
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {jsonEvent && (
        <RawEventJsonDialog
          event={jsonEvent}
          open={!!jsonEvent}
          onOpenChange={(v) => {
            if (!v) setJsonEvent(null);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// FullVariantActionBar — share + raw event actions on the /about page
//
// Single announcement  → both share and raw event open modals directly
//                         (icon + label inline buttons, no expandable section)
// Multiple announcements → share opens the selected announcement's share modal;
//                          raw event keeps the collapsible section for all events
// ---------------------------------------------------------------------------

function FullVariantActionBar({
  announcements,
  selectedMaintainer,
  confirmedMaintainers,
  leadMaintainer,
  editPath,
  repoCoords,
}: {
  announcements: NostrEvent[];
  selectedMaintainer: string;
  confirmedMaintainers: string[];
  leadMaintainer?: string;
  editPath?: string;
  repoCoords?: string[];
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [rawSectionOpen, setRawSectionOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isSingle = announcements.length === 1;
  const selectedAnnouncement =
    announcements.find((a) => a.pubkey === selectedMaintainer) ??
    announcements[0];
  const nip19Id = eventToNip19(selectedAnnouncement);

  return (
    <div className="pt-2">
      <Separator className="mb-4" />

      <div className="flex items-center gap-3 flex-wrap">
        {/* Edit button — only shown for the maintainer */}
        {editPath && (
          <Link
            to={editPath}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit settings
          </Link>
        )}

        {/* Share button — always opens modal */}
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share links
        </button>

        {/* Raw event button */}
        {isSingle ? (
          <button
            type="button"
            onClick={() => setJsonOpen(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Braces className="h-3.5 w-3.5" />
            Raw announcement event
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setRawSectionOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {rawSectionOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            Raw announcement events ({announcements.length})
          </button>
        )}

        {/* Delete button — only shown for the maintainer */}
        {editPath && (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors ml-auto"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
      </div>

      {/* Multi-announcement expandable section */}
      {!isSingle && rawSectionOpen && (
        <div className="mt-3">
          <AnnouncementEventRows
            announcements={announcements}
            selectedMaintainer={selectedMaintainer}
            confirmedMaintainers={confirmedMaintainers}
            leadMaintainer={leadMaintainer}
          />
        </div>
      )}

      {/* Share modal */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Share links</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 pt-1">
            <CopyRow
              label="git.buildinelsalvador.com"
              value={`https://git.buildinelsalvador.com/${nip19Id}`}
            />
            <CopyRow label="event id" value={nip19Id} />
            <CopyRow label="ditto.pub" value={`https://ditto.pub/${nip19Id}`} />
            {isAddressableKind(selectedAnnouncement.kind) ? (
              <CopyRow
                label="coordinate"
                value={
                  getReplaceableAddress(selectedAnnouncement) ??
                  selectedAnnouncement.id
                }
              />
            ) : (
              <CopyRow label="hex event id" value={selectedAnnouncement.id} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Raw event JSON modal (single announcement only) */}
      {isSingle && (
        <RawEventJsonDialog
          event={selectedAnnouncement}
          open={jsonOpen}
          onOpenChange={setJsonOpen}
        />
      )}

      {/* Delete repo modal */}
      <DeleteRepoModal
        announcement={selectedAnnouncement}
        repoCoords={repoCoords}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeleteRepoModal — NIP-09 deletion for a repo announcement
// ---------------------------------------------------------------------------

function DeleteRepoModal({
  announcement,
  repoCoords,
  open,
  onOpenChange,
}: {
  announcement: NostrEvent;
  repoCoords?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const userPath = useUserPath(announcement.pubkey);
  const [mode, setMode] = useState<"version" | "repo">("version");
  const [reason, setReason] = useState("");
  const [deleting, setDeleting] = useState(false);

  const publishedAt = format(
    new Date(announcement.created_at * 1000),
    "MMM d, yyyy 'at' h:mm a",
  );

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runner.run(
        DeleteRepo,
        announcement,
        mode,
        repoCoords,
        reason.trim() || undefined,
      );
      toast({
        title:
          mode === "repo"
            ? "Repository deleted"
            : "Announcement version deleted",
        description:
          mode === "repo"
            ? "A deletion request has been published. Relays will remove all versions of this repository announcement."
            : "A deletion request has been published for this version of the announcement.",
      });
      onOpenChange(false);
      navigate(`${userPath}?tab=repositories`);
    } catch (err) {
      console.error("[DeleteRepoModal] failed to delete:", err);
      toast({
        title: "Delete failed",
        description:
          "Could not publish the deletion request. Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
      setReason("");
    }
  }, [
    deleting,
    announcement,
    mode,
    repoCoords,
    reason,
    toast,
    onOpenChange,
    navigate,
    userPath,
  ]);

  const handleOpenChange = useCallback(
    (v: boolean) => {
      if (!v) {
        setReason("");
        setMode("version");
      }
      onOpenChange(v);
    },
    [onOpenChange],
  );

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Delete repository announcement
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will publish a NIP-09 deletion request. Other clients and
            relays may honour it, but deletion cannot be guaranteed across all
            relays.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-1">
          {/* Scope selector */}
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "version" | "repo")}
            className="space-y-2"
          >
            <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 cursor-pointer has-[[data-state=checked]]:border-destructive/40 has-[[data-state=checked]]:bg-destructive/5 transition-colors">
              <RadioGroupItem
                value="version"
                id="delete-version"
                className="mt-0.5 shrink-0"
              />
              <Label
                htmlFor="delete-version"
                className="cursor-pointer space-y-0.5"
              >
                <span className="text-sm font-medium">Delete this version</span>
                <p className="text-xs text-muted-foreground font-normal">
                  Removes only the announcement published on{" "}
                  <span className="text-foreground">{publishedAt}</span> (event{" "}
                  <code className="font-mono text-[11px]">
                    {announcement.id.slice(0, 8)}…
                  </code>
                  ).
                </p>
              </Label>
            </div>

            <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 cursor-pointer has-[[data-state=checked]]:border-destructive/40 has-[[data-state=checked]]:bg-destructive/5 transition-colors">
              <RadioGroupItem
                value="repo"
                id="delete-repo"
                className="mt-0.5 shrink-0"
              />
              <Label
                htmlFor="delete-repo"
                className="cursor-pointer space-y-0.5"
              >
                <span className="text-sm font-medium text-destructive">
                  Delete entire repository
                </span>
                <p className="text-xs text-muted-foreground font-normal">
                  Requests deletion of{" "}
                  <span className="text-foreground font-medium">
                    all versions
                  </span>{" "}
                  of this repository announcement (kind:{REPO_KIND} `a` tag).
                  Relays will remove the entire announcement history.
                </p>
              </Label>
            </div>
          </RadioGroup>

          {/* Reason */}
          <div className="space-y-1.5">
            <Label htmlFor="delete-repo-reason" className="text-sm">
              Reason{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Textarea
              id="delete-repo-reason"
              rows={2}
              placeholder="e.g. repository moved to a different address"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleting
              ? "Deleting…"
              : mode === "repo"
                ? "Delete entire repository"
                : "Delete this version"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Announcement event actions (share + JSON modal) — single event
// ---------------------------------------------------------------------------

function AnnouncementEventActions({ event }: { event: NostrEvent }) {
  const [shareOpen, setShareOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const nip19Id = eventToNip19(event);

  return (
    <>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
          title="Share"
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
          title="View raw event JSON"
          onClick={() => setJsonOpen(true)}
        >
          <Braces className="h-3 w-3" />
        </Button>
      </div>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Share announcement</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 pt-1">
            <CopyRow
              label="git.buildinelsalvador.com"
              value={`https://git.buildinelsalvador.com/${nip19Id}`}
            />
            <CopyRow label="event id" value={nip19Id} />
            <CopyRow label="ditto.pub" value={`https://ditto.pub/${nip19Id}`} />
            {isAddressableKind(event.kind) ? (
              <CopyRow
                label="coordinate"
                value={getReplaceableAddress(event) ?? event.id}
              />
            ) : (
              <CopyRow label="hex event id" value={event.id} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <RawEventJsonDialog
        event={event}
        open={jsonOpen}
        onOpenChange={setJsonOpen}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// RawEventJsonDialog — reusable modal for viewing a raw event as JSON
// ---------------------------------------------------------------------------

function RawEventJsonDialog({
  event,
  open,
  onOpenChange,
}: {
  event: NostrEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Announcement event JSON</DialogTitle>
        </DialogHeader>
        <div className="overflow-auto rounded-md border bg-muted/40 p-4 min-h-0">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(event, null, 2)}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// MultiAnnouncementsModal — shown when {} is clicked with >1 announcement
// ---------------------------------------------------------------------------

function MultiAnnouncementsModal({
  announcements,
  selectedMaintainer,
  confirmedMaintainers,
  leadMaintainer,
  open,
  onOpenChange,
}: {
  announcements: NostrEvent[];
  selectedMaintainer: string;
  confirmedMaintainers: string[];
  leadMaintainer?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Braces className="h-4 w-4 text-muted-foreground" />
            Announcement events
          </DialogTitle>
        </DialogHeader>
        <div className="pt-1">
          <AnnouncementEventRows
            announcements={announcements}
            selectedMaintainer={selectedMaintainer}
            confirmedMaintainers={confirmedMaintainers}
            leadMaintainer={leadMaintainer}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CopyRow — labelled row with copy-on-click (share modal)
// ---------------------------------------------------------------------------

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "group grid w-full grid-cols-[6rem_1fr_1.5rem] items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors",
        "border hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        copied ? "border-green-500" : "border-border",
      )}
    >
      <span
        className={cn(
          "font-medium shrink-0",
          copied ? "text-green-600" : "text-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "font-mono truncate min-w-0",
          copied ? "text-green-600" : "text-muted-foreground",
        )}
      >
        {value}
      </span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CloneDropdown — prominent button that opens a popover (sidebar variant)
// ---------------------------------------------------------------------------

function CloneDropdown({
  nostrCloneUrl,
  graspCloneUrls,
  additionalGitServerUrls,
}: {
  nostrCloneUrl: string | undefined;
  graspCloneUrls: string[];
  additionalGitServerUrls: string[];
}) {
  const [open, setOpen] = useState(false);
  const [copiedNostrUrl, setCopiedNostrUrl] = useState(false);

  const handleCopyNostrUrl = async () => {
    if (!nostrCloneUrl) return;
    await navigator.clipboard.writeText(nostrCloneUrl);
    setCopiedNostrUrl(true);
    setTimeout(() => setCopiedNostrUrl(false), 2000);
  };

  const hasRawUrls =
    graspCloneUrls.length > 0 || additionalGitServerUrls.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="default"
          size="sm"
          className="w-full justify-between gap-2 bg-primary hover:bg-primary/90 text-primary-foreground border-0"
        >
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 shrink-0" />
            <span>Clone</span>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0 overflow-hidden"
        align="start"
        sideOffset={4}
      >
        {/* ngit section */}
        {nostrCloneUrl && (
          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-foreground">
                Clone with ngit
              </p>
              <a
                href="https://ngit.dev/install"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Install ngit
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {/* URL block — entire field is the copy button */}
            <button
              type="button"
              onClick={handleCopyNostrUrl}
              title="Copy nostr:// URL"
              className={cn(
                "w-full flex items-center gap-1.5 rounded-md border px-3 py-2 min-w-0 text-left transition-colors cursor-pointer",
                copiedNostrUrl
                  ? "border-green-500/60 bg-green-500/5"
                  : "border-border bg-muted/50 hover:bg-muted hover:border-border/80",
              )}
            >
              <code
                className="flex-1 text-xs font-mono text-foreground/90 truncate min-w-0 select-none"
                title={nostrCloneUrl}
              >
                {nostrCloneUrl}
              </code>
              <span className="shrink-0 text-muted-foreground p-0.5 rounded">
                {copiedNostrUrl ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </span>
            </button>
          </div>
        )}

        {/* Raw git URLs */}
        {hasRawUrls && (
          <>
            {nostrCloneUrl && <Separator />}
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold text-foreground">
                  Raw git URLs
                </p>
                <Tooltip>
                  <Popover>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          aria-label="About raw git URLs"
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Git servers act as relays
                    </TooltipContent>
                    <PopoverContent
                      className="w-72 text-xs text-muted-foreground leading-relaxed"
                      side="right"
                    >
                      <p>
                        Git servers act as relays — usable as read-only remotes
                        without ngit.
                      </p>
                    </PopoverContent>
                  </Popover>
                </Tooltip>
              </div>
              <CloneServerList
                graspCloneUrls={graspCloneUrls}
                additionalGitServerUrls={additionalGitServerUrls}
              />
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// UnionRelayGroup — shows relays contributed by other reachable repositories
// ---------------------------------------------------------------------------

function UnionRelayGroup({
  relays,
  getContributor,
  confirmedMaintainers,
}: {
  relays: string[];
  getContributor: (url: string) => string;
  confirmedMaintainers: ReadonlySet<string>;
}) {
  return (
    <div className="mt-1.5 space-y-1">
      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide flex items-center gap-1">
        <Users className="h-2.5 w-2.5" />
        Via recursive repository graph
      </p>
      <div className="flex flex-wrap gap-1.5">
        {relays.map((relay) => {
          const contributor = getContributor(relay);
          const sourceLabel = confirmedMaintainers.has(contributor)
            ? "accepted co-maintainer"
            : "invited repository";
          return (
            <div
              key={relay}
              className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 pl-1.5 pr-2 py-0.5"
              title={`${relay} — contributed by ${sourceLabel}`}
            >
              <Link
                to={`/relay/${relayUrlToSegment(relay)}`}
                className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                {displayRelay(relay)}
              </Link>
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] font-normal text-muted-foreground"
              >
                {sourceLabel}
              </Badge>
              {contributor && (
                <span className="text-[9px] text-muted-foreground/50 flex items-center gap-0.5">
                  via{" "}
                  <UserName
                    pubkey={contributor}
                    className="text-[9px] text-muted-foreground/50"
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
