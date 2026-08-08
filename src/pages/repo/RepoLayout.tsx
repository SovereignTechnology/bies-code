import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useLocation } from "react-router-dom";
import { useActiveAccount } from "applesauce-react/hooks";
import { useResolvedRepository } from "@/hooks/useResolvedRepository";
import RepoIssuesPage from "./RepoIssuesPage";
import RepoPRsPage from "./RepoPRsPage";
import RepoCodePage from "./RepoCodePage";
import RepoAboutPage from "./RepoAboutPage";
import RepoSettingsPage from "./RepoSettingsPage";
import RepoCommitsPage from "./RepoCommitsPage";
import RepoCommitPage from "./RepoCommitPage";
import RepoBranchesPage from "./RepoBranchesPage";
import RepoTagsPage from "./RepoTagsPage";
import RepoComparePage from "./RepoComparePage";
import RepoActionsPage from "./RepoActionsPage";
import RepoReleasesPage from "./RepoReleasesPage";
import IssuePage from "@/pages/IssuePage";
import PRPage from "@/pages/PRPage";
import { useIssues } from "@/hooks/useIssues";
import { usePRs } from "@/hooks/usePRs";
import { useRepoHasCI } from "@/hooks/useCI";
import { useRepoReleaseSummary } from "@/hooks/useSoftwareReleases";
import { usePrefetchNip05 } from "@/hooks/usePrefetchNip05";
import { useDnsIdentity } from "@/hooks/useDnsIdentity";
import { useRepositoryState } from "@/hooks/useRepositoryState";
import type { RepositoryState } from "@/casts/RepositoryState";
import { useGraspServers, type GraspServer } from "@/hooks/useGraspServers";
import { useMaintainerAcceptanceJob } from "@/hooks/useMaintainerAcceptanceJob";
import { use$ } from "@/hooks/use$";
import { useProfile } from "@/hooks/useProfile";
import { useLoadProfile } from "@/hooks/useLoadProfile";
import { useUserPath } from "@/hooks/useUserPath";
import { UserAvatar, UserLink } from "@/components/UserAvatar";
import { RepoMaintainerRequestBanner } from "@/components/RepoItemAttributionWarning";
import { EventSearchStatus } from "@/components/EventSearchStatus";
import { nip34SupplementalRelayLoader } from "@/services/nostr";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { nip19, type EventTemplate, type NostrEvent } from "nostr-tools";
import {
  ArrowLeft,
  CircleDot,
  GitPullRequest,
  AlertCircle,
  Loader2,
  Code2,
  Info,
  MoreHorizontal,
  Settings,
  Workflow,
  Package,
  UserPlus,
  CheckCircle2,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RepoContext, type RepoContextValue } from "./RepoContext";
import {
  getRepoCloneUrls,
  graspCloneUrlDomain,
  hasAcceptedRepositoryReference,
  repoCoordinate,
  type RepoQueryOptions,
  type ResolvedRepo,
} from "@/lib/nip34";
import { relayCurationMode } from "@/services/settings";
import { cn } from "@/lib/utils";
import { StarButton } from "@/components/StarButton";
import { FollowRepoButton } from "@/components/FollowRepoButton";
import { RepoZapButton } from "@/components/RepoZapButton";
import {
  parseRepoRoute,
  decodeEventIdentifier,
  isEventIdentifier,
  repoToPath,
} from "@/lib/routeUtils";
import {
  GitCommitLinkContext,
  type GitCommitLinkContextValue,
} from "@/components/CommitLinkContext";
import { RepoRelaysContext } from "@/contexts/RepoRelaysContext";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import { EMPTY } from "rxjs";
import { catchError } from "rxjs/operators";
import { useToast } from "@/hooks/useToast";
import { GraspServerSelector } from "@/components/GraspServerSelector";
import {
  selectGraspDomainsWithBackfill,
  validateGraspServer,
} from "@/lib/grasp";
import { DEFAULT_GRASP_SERVERS } from "@/services/settings";
import {
  maintainerAcceptanceKey,
  runMaintainerAcceptanceDelivery,
  saveMaintainerAcceptanceJob,
  type MaintainerAcceptanceJob,
} from "@/services/maintainerAcceptance";
import {
  buildMaintainerAcceptanceTemplate,
  classifyInvitationState,
  getAcceptanceMaintainerSelection,
} from "@/lib/repositoryInvitation";
// ---------------------------------------------------------------------------
// RepoLayout
// ---------------------------------------------------------------------------

export default function RepoLayout() {
  // The splat param (*) captures everything after the leading /
  const { "*": splat } = useParams<{ "*": string }>();
  const location = useLocation();

  // Use location.pathname rather than the decoded wildcard param when parsing
  // the route. This preserves a literal percent sequence in a d-tag (for
  // example `%2F` is emitted as `%252F`) and guarantees identifiers are
  // decoded exactly once by parseRepoRoute.
  const parsed = useMemo(
    () => parseRepoRoute(location.pathname.slice(1)),
    [location.pathname],
  );

  // If the path doesn't parse as a repo route at all, show not-found immediately
  if (!parsed) {
    return <RouteNotFound splat={splat ?? ""} />;
  }

  if (parsed.type === "npub") {
    return (
      <RepoLayoutResolved
        pubkey={parsed.pubkey}
        repoId={parsed.repoId}
        relayHints={parsed.relayHints}
        location={location}
      />
    );
  }

  // nip05 — needs async resolution
  return (
    <RepoLayoutNip05
      nip05={parsed.nip05}
      repoId={parsed.repoId}
      relayHints={parsed.relayHints}
      location={location}
    />
  );
}

// ---------------------------------------------------------------------------
// NIP-05 resolver wrapper
// ---------------------------------------------------------------------------

function RepoLayoutNip05({
  nip05,
  repoId,
  relayHints,
  location,
}: {
  nip05: string;
  repoId: string;
  relayHints: string[];
  location: ReturnType<typeof useLocation>;
}) {
  const identity = useDnsIdentity(nip05);

  if (identity.status === "loading") {
    return <Nip05LoadingState nip05={nip05} />;
  }

  if (identity.status === "not-found") {
    return <Nip05NotFoundError nip05={nip05} />;
  }

  if (identity.status === "error") {
    return <Nip05ResolveError nip05={nip05} reason={identity.reason} />;
  }

  return (
    <RepoLayoutResolved
      pubkey={identity.pubkey}
      repoId={repoId}
      nip05Relays={identity.relays}
      relayHints={relayHints}
      location={location}
      nip05={nip05}
    />
  );
}

// ---------------------------------------------------------------------------
// Core layout (pubkey already known)
// ---------------------------------------------------------------------------

function RepoLayoutResolved({
  pubkey,
  repoId,
  nip05Relays,
  relayHints,
  location,
  nip05,
}: {
  pubkey: string;
  repoId: string;
  /** Relay hints from NIP-05 identity resolution (shown as their own group). */
  nip05Relays?: string[];
  relayHints: string[];
  location: ReturnType<typeof useLocation>;
  nip05?: string;
}) {
  const { resolved, repoSearch } = useResolvedRepository(
    pubkey,
    repoId,
    relayHints,
    nip05Relays,
  );
  const repo = resolved?.repo;

  // Build an encoded base path for intra-repository links. Route wildcard
  // values are decoded by React Router, including `%2F` inside a repository
  // identifier, so always rebuild links from the resolved route values.
  const basePath = useMemo(() => {
    return repoToPath(pubkey, repoId, relayHints, nip05);
  }, [pubkey, repoId, relayHints, nip05]);
  const isReleasesTab = location.pathname.startsWith(`${basePath}/releases`);

  // Delay showing the repo search status page so the skeleton shows first.
  // Timer starts on mount (keyed to pubkey+repoId) and is never reset by
  // transient relay group changes mid-search.
  const [repoSearchDelayElapsed, setRepoSearchDelayElapsed] = useState(false);
  useEffect(() => {
    setRepoSearchDelayElapsed(false);
    const timer = setTimeout(() => setRepoSearchDelayElapsed(true), 1500);
    return () => clearTimeout(timer);
  }, [pubkey, repoId]);

  // Prefetch NIP-05 identities for all maintainers so useRepoPath can resolve
  // them synchronously from the IDB cache on subsequent visits.
  usePrefetchNip05(repo?.maintainerSet ?? []);
  const repoRelayGroup = resolved?.repoRelayGroup;
  const extraRelaysForMaintainerMailboxCoverage =
    resolved?.extraRelaysForMaintainerMailboxCoverage;

  // Reactive relay URL list for RepoRelaysContext — updates as outbox relays
  // are discovered so any ZapModal rendered under this layout uses the current
  // full set when building the zap request's relays tag.
  const repoRelayUrls =
    use$(() => relayGroupUrls$(repoRelayGroup), [repoRelayGroup]) ?? [];

  // Respect the user's relay curation preference.
  const curationMode = use$(relayCurationMode);

  // In outbox mode, also subscribe to the extra maintainer mailbox relays so
  // issues and PRs published only to those relays are discovered. Uses
  // nip34SupplementalRelayLoader which — unlike a plain subscription — also
  // calls nip34ListLoader for each newly found item, ensuring status events
  // (1630-1633) and other essentials on author/maintainer outbox relays are
  // fetched, not just the root events.
  const coordKey = repo?.allCoordinates?.join(",") ?? "";
  use$(() => {
    if (
      curationMode !== "outbox" ||
      !extraRelaysForMaintainerMailboxCoverage ||
      !repo?.allCoordinates?.length
    )
      return undefined;
    return nip34SupplementalRelayLoader(
      repo.allCoordinates,
      extraRelaysForMaintainerMailboxCoverage,
    ).pipe(catchError(() => EMPTY));
  }, [curationMode, extraRelaysForMaintainerMailboxCoverage, coordKey]);

  const queryOptions: RepoQueryOptions = useMemo(
    () => ({
      relayHints,
      useItemAuthorRelays: false,
      maintainerPubkeys: repo?.maintainerSet ?? [],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relayHints.join(","), repo?.maintainerSet?.join(","), curationMode],
  );

  const issues = useIssues(repo?.allCoordinates, repoRelayGroup, queryOptions);
  const prs = usePRs(repo?.allCoordinates, repoRelayGroup, queryOptions);

  const acceptedRepoCoordinates = useMemo(
    () =>
      repo?.confirmedMaintainers.map((maintainer) =>
        repoCoordinate(maintainer, repo.dTag),
      ) ?? [],
    [repo],
  );
  const selectedRepoCoordinate = repo?.selectedCoordinate;
  const acceptedAnnouncements = useMemo(
    () =>
      repo?.announcements.filter((announcement) =>
        repo.confirmedMaintainers.includes(announcement.pubkey),
      ) ?? [],
    [repo],
  );

  // Whether the repo has any CI events (ngit-ci kinds 9841/9842) — drives
  // visibility of the Actions tab. Cheap limit-1 probe by #a across all
  // maintainer coordinates.
  const hasCI = useRepoHasCI(repo?.allCoordinates, repoRelayGroup);
  const releaseSummary = useRepoReleaseSummary(
    repo?.allCoordinates,
    repo?.maintainerSet,
    repoRelayGroup,
    !isReleasesTab,
  );
  const hasReleases = releaseSummary.hasReleases;

  const [repoState, repoRelayEose, relayStateMap, repoStateEvents] =
    useRepositoryState(repo?.dTag, repo?.maintainerSet, repoRelayGroup);

  // Count open issues for the tab badge
  const openIssueCount = useMemo(() => {
    if (!issues || !repo) return undefined;
    return issues.filter(
      (issue) =>
        issue.status === "open" &&
        hasAcceptedRepositoryReference(issue.repoCoords, repo),
    ).length;
  }, [issues, repo]);

  // Count open PRs for the tab badge
  const openPRCount = useMemo(() => {
    if (!prs || !repo) return undefined;
    return prs.filter(
      (pr) =>
        pr.status === "open" &&
        hasAcceptedRepositoryReference(pr.repoCoords, repo),
    ).length;
  }, [prs, repo]);

  // Every recursively reachable maintainer can enter Settings. The settings
  // page redirects maintainers with announcements to their own coordinate and
  // sends invitees without one through acceptance first.
  const account = useActiveAccount();
  const {
    servers: accountGraspServers,
    isFromUserList: accountGraspServersFromUserList,
    isLoading: accountGraspServersLoading,
  } = useGraspServers(account?.pubkey);
  const canOpenSettings =
    account?.pubkey && repo
      ? repo.maintainerSet.includes(account.pubkey)
      : false;
  const showReleases = hasReleases || isReleasesTab || canOpenSettings;

  const repoPageSuffix = useMemo(() => {
    if (location.pathname.startsWith(basePath)) {
      return location.pathname.slice(basePath.length);
    }

    // Incoming raw-hex and legacy identity routes may not equal the canonical
    // npub/NIP-05 basePath. Locate the repo segment from the parsed relay shape
    // without searching decoded repo IDs for reserved sub-page words.
    const rawSegments = location.pathname.slice(1).split("/").filter(Boolean);
    let repoSegmentIndex = relayHints.length > 0 ? 2 : 1;
    if (relayHints.length > 0) {
      let relaySegment = rawSegments[1] ?? "";
      try {
        relaySegment = decodeURIComponent(relaySegment);
      } catch {
        // Keep the raw segment when it is not valid percent-encoding.
      }
      if (relaySegment === "ws:" || relaySegment === "wss:") {
        repoSegmentIndex = 3;
      }
    }
    const suffix = rawSegments.slice(repoSegmentIndex + 1).join("/");
    return suffix ? `/${suffix}` : "";
  }, [basePath, location.pathname, relayHints.length]);

  const isCodeTab =
    location.pathname.startsWith(`${basePath}/tree`) ||
    location.pathname === basePath ||
    location.pathname === `${basePath}/`;
  const isIssuesTab = location.pathname.startsWith(`${basePath}/issues`);
  const isPRsTab = location.pathname.startsWith(`${basePath}/prs`);
  const isActionsTab = location.pathname.startsWith(`${basePath}/actions`);
  const isAboutTab = location.pathname.startsWith(`${basePath}/about`);
  const isSettingsTab = location.pathname.startsWith(`${basePath}/settings`);
  // Determine which sub-page to render from the repository suffix.
  const {
    subPage,
    issueId,
    prId,
    treeRefAndPath,
    commitId,
    commitsRef,
    compareBaseRef,
    compareHeadRef,
    prCommitId,
    releaseId,
    releaseView,
  } = useMemo((): {
    subPage:
      | "code"
      | "issues"
      | "issue"
      | "prs"
      | "pr"
      | "pr-commit"
      | "commits"
      | "commit"
      | "branches"
      | "tags"
      | "compare"
      | "actions"
      | "releases"
      | "about"
      | "edit"
      | "settings";
    issueId?: string;
    prId?: string;
    /** Everything after /tree/ — ref resolution happens inside useGitExplorer */
    treeRefAndPath?: string;
    commitId?: string;
    commitsRef?: string;
    compareBaseRef?: string;
    compareHeadRef?: string;
    prCommitId?: string;
    releaseId?: string;
    releaseView?: "releases" | "applications";
  } => {
    const segments = repoPageSuffix
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });

    // Only the first segment after the resolved repository path selects a
    // sub-page. Reserved words inside refs and file paths are ordinary data.
    if (segments[0] === "compare") {
      const comparison = segments.slice(1).join("/");
      const delimiter = comparison.indexOf("...");
      if (delimiter === -1) {
        return {
          subPage: "compare",
          compareBaseRef: comparison || undefined,
        };
      }
      return {
        subPage: "compare",
        compareBaseRef: comparison.slice(0, delimiter) || undefined,
        compareHeadRef: comparison.slice(delimiter + 3) || undefined,
      };
    }

    if (segments[0] === "tree") {
      // Pass everything after "tree" as a single string; useGitExplorer will
      // resolve the ref via longest-prefix matching against known git refs.
      const refAndPath = segments.slice(1).join("/");
      return { subPage: "code", treeRefAndPath: refAndPath || undefined };
    }

    if (segments[0] === "prs") {
      const prsIdx = 0;
      if (segments.length > prsIdx + 1) {
        const rawSegment = segments[prsIdx + 1];
        // Accept both raw hex IDs (legacy) and nevent1/note1 identifiers
        const prId = isEventIdentifier(rawSegment)
          ? decodeEventIdentifier(rawSegment)
          : rawSegment;

        // prs/<id>/commit/<hash|nevent1|note1> — commit detail scoped to a PR
        const prCommitIdx = segments.indexOf("commit", prsIdx + 2);
        if (prCommitIdx !== -1) {
          const rawCommitSeg = segments[prCommitIdx + 1];
          // Accept nevent1/note1 (decode to event ID) or raw hex (pass through).
          // Raw hex may be either a git commit hash or a Nostr event ID —
          // PRPage's patchMatch handles both.
          const prCommitId = isEventIdentifier(rawCommitSeg)
            ? decodeEventIdentifier(rawCommitSeg)
            : rawCommitSeg;
          return {
            subPage: "pr-commit",
            prId,
            prCommitId,
          };
        }

        // prs/<id>/commits — commits list scoped to a PR (renders PRPage
        // with the commits tab pre-selected via context)
        const prCommitsIdx = segments.indexOf("commits", prsIdx + 2);
        if (prCommitsIdx !== -1) {
          return { subPage: "pr", prId };
        }

        return { subPage: "pr", prId };
      }
      return { subPage: "prs" };
    }

    if (segments[0] === "commit") {
      return { subPage: "commit", commitId: segments[1] };
    }

    if (segments[0] === "commits") {
      return {
        subPage: "commits",
        commitsRef: segments.slice(1).join("/") || undefined,
      };
    }

    if (segments[0] === "branches") {
      return { subPage: "branches" };
    }

    if (segments[0] === "tags") {
      return { subPage: "tags" };
    }

    if (segments[0] === "actions") {
      return { subPage: "actions" };
    }

    if (segments[0] === "releases") {
      const releasesIdx = 0;
      const applicationsRoute = segments[releasesIdx + 1] === "apps";
      const rawSegment = segments[releasesIdx + (applicationsRoute ? 2 : 1)];
      if (rawSegment) {
        return {
          subPage: "releases",
          releaseView: applicationsRoute ? "applications" : "releases",
          releaseId: isEventIdentifier(rawSegment)
            ? (decodeEventIdentifier(rawSegment) ?? rawSegment)
            : rawSegment,
        };
      }
      return {
        subPage: "releases",
        releaseView: applicationsRoute ? "applications" : "releases",
      };
    }

    if (segments[0] === "issues") {
      const issuesIdx = 0;
      if (segments.length > issuesIdx + 1) {
        const rawSegment = segments[issuesIdx + 1];
        // Accept both raw hex IDs (legacy) and nevent1/note1 identifiers
        const issueId = isEventIdentifier(rawSegment)
          ? decodeEventIdentifier(rawSegment)
          : rawSegment;
        return { subPage: "issue", issueId };
      }
      return { subPage: "issues" };
    }

    if (segments[0] === "edit") {
      return { subPage: "edit" };
    }

    if (segments[0] === "about") {
      return { subPage: "about" };
    }

    if (segments[0] === "settings") {
      return { subPage: "settings" };
    }

    return { subPage: "code" };
  }, [repoPageSuffix]);

  const cloneUrls = repo?.cloneUrls ?? [];

  // The PR base path: basePath + /prs/<prId> — used for PR sub-route links.
  const prBasePath = useMemo(() => {
    if (!prId) return undefined;
    const segments = repoPageSuffix.split("/").filter(Boolean);
    const prIdSegment = segments[1];
    return segments[0] !== "prs" || !prIdSegment
      ? undefined
      : `${basePath}/prs/${prIdSegment}`;
  }, [basePath, repoPageSuffix, prId]);

  const ctxValue: RepoContextValue | null =
    pubkey && repoId && resolved
      ? {
          pubkey,
          repoId,
          resolved,
          repoSearch,
          issues,
          prs,
          queryOptions,
          nip05,
          issueId,
          prId,
          cloneUrls,
          repoState,
          repoRelayEose,
          relayStateMap,
          treeRefAndPath,
          commitId,
          commitsRef,
          compareBaseRef,
          compareHeadRef,
          prCommitId,
          prBasePath,
          basePath,
          releaseSummary,
        }
      : null;

  // Build the git commit link context — provides cloneUrls + basePath to
  // CommentContent / MarkdownContent for linkifying commit hash mentions.
  const gitCommitLinkCtxValue: GitCommitLinkContextValue = useMemo(
    () => ({ cloneUrls, basePath }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cloneUrls.join(","), basePath],
  );

  return (
    <RepoRelaysContext.Provider value={repoRelayUrls}>
      <div className="min-h-full">
        {/* Repo header */}
        <div className="relative isolate border-b border-border/40">
          <div className="absolute inset-0 -z-10 bg-gradient-to-br from-pink-500/5 via-transparent to-pink-500/5" />

          <div className="container max-w-screen-xl px-4 md:px-8 pt-6 pb-0">
            {repo ? (
              <div className="flex items-center justify-between gap-3 mb-4 min-w-0 overflow-hidden">
                <RepoBreadcrumb
                  pubkey={pubkey}
                  repoName={repo.name}
                  basePath={basePath}
                  nip05={nip05}
                />
                <div className="flex items-center gap-2 flex-shrink-0">
                  <RepoZapButton
                    targetAnnouncement={repo.announcements.find(
                      (a) => a.pubkey === repo.selectedMaintainer,
                    )}
                    repoCoords={acceptedRepoCoordinates}
                  />
                  <FollowRepoButton repoCoord={selectedRepoCoordinate} />
                  <StarButton
                    targetAnnouncement={repo.announcements.find(
                      (a) => a.pubkey === repo.selectedMaintainer,
                    )}
                    allAnnouncements={acceptedAnnouncements}
                    repoCoords={acceptedRepoCoordinates}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 mb-4">
                <Skeleton className="h-5 w-24" />
                <span className="text-muted-foreground">/</span>
                <Skeleton className="h-5 w-32" />
              </div>
            )}

            {/* Tab navigation */}
            <nav className="flex gap-1 -mb-px">
              {/* Primary tabs — always visible */}
              <TabLink
                to={basePath}
                active={isCodeTab}
                icon={<Code2 className="h-4 w-4" />}
                label="Code"
              />
              <TabLink
                to={`${basePath}/issues`}
                active={isIssuesTab}
                icon={<CircleDot className="h-4 w-4" />}
                label="Issues"
                count={openIssueCount}
              />
              <TabLink
                to={`${basePath}/prs`}
                active={isPRsTab}
                icon={<GitPullRequest className="h-4 w-4" />}
                label="PRs"
                count={openPRCount}
              />

              {/* Secondary tabs — visible on md+ screens */}
              <div className="hidden md:flex gap-1">
                {(hasCI || isActionsTab) && (
                  <TabLink
                    to={`${basePath}/actions`}
                    active={isActionsTab}
                    icon={<Workflow className="h-4 w-4" />}
                    label="Actions"
                  />
                )}
                {showReleases && (
                  <TabLink
                    to={`${basePath}/releases`}
                    active={isReleasesTab}
                    icon={<Package className="h-4 w-4" />}
                    label="Releases"
                  />
                )}
                <TabLink
                  to={`${basePath}/about`}
                  active={isAboutTab}
                  icon={<Info className="h-4 w-4" />}
                  label="About"
                />
                {canOpenSettings && (
                  <TabLink
                    to={`${basePath}/settings`}
                    active={isSettingsTab}
                    icon={<Settings className="h-4 w-4" />}
                    label="Settings"
                  />
                )}
              </div>

              {/* "More" dropdown — mobile only */}
              <div className="md:hidden flex items-end pb-px">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors",
                        isAboutTab ||
                          isSettingsTab ||
                          isActionsTab ||
                          isReleasesTab
                          ? "border-pink-500 text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                      )}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">More</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {(hasCI || isActionsTab) && (
                      <DropdownMenuItem asChild>
                        <Link
                          to={`${basePath}/actions`}
                          className="flex items-center gap-2"
                        >
                          <Workflow className="h-4 w-4" />
                          Actions
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {showReleases && (
                      <DropdownMenuItem asChild>
                        <Link
                          to={`${basePath}/releases`}
                          className="flex items-center gap-2"
                        >
                          <Package className="h-4 w-4" />
                          Releases
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem asChild>
                      <Link
                        to={`${basePath}/about`}
                        className="flex items-center gap-2"
                      >
                        <Info className="h-4 w-4" />
                        About
                      </Link>
                    </DropdownMenuItem>
                    {canOpenSettings && (
                      <DropdownMenuItem asChild>
                        <Link
                          to={`${basePath}/settings`}
                          className="flex items-center gap-2"
                        >
                          <Settings className="h-4 w-4" />
                          Settings
                        </Link>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </nav>
          </div>
        </div>

        {repo && (
          <RepoMaintainerRequestBanner
            repo={repo}
            pageSuffix={repoPageSuffix}
          />
        )}

        {repo && account?.pubkey && (
          <MaintainerInvitationBanner
            repo={repo}
            accountPubkey={account.pubkey}
            signer={account.signer}
            graspServers={accountGraspServers}
            graspServersFromUserList={accountGraspServersFromUserList}
            ownState={repoStateEvents?.find(
              (state) => state.publisherPubkey === account.pubkey,
            )}
            stateCheckComplete={repoRelayEose && !accountGraspServersLoading}
            canonicalState={repoState}
            openAcceptanceInitially={
              isSettingsTab &&
              !repo.announcements.some(
                (announcement) => announcement.pubkey === account.pubkey,
              )
            }
          />
        )}

        {/* Page content */}
        {ctxValue ? (
          <GitCommitLinkContext.Provider value={gitCommitLinkCtxValue}>
            <RepoContext.Provider value={ctxValue}>
              {subPage === "code" ? (
                <RepoCodePage />
              ) : subPage === "commits" ? (
                <RepoCommitsPage />
              ) : subPage === "commit" ? (
                <RepoCommitPage />
              ) : subPage === "branches" ? (
                <RepoBranchesPage />
              ) : subPage === "tags" ? (
                <RepoTagsPage />
              ) : subPage === "compare" ? (
                <RepoComparePage />
              ) : subPage === "actions" ? (
                <RepoActionsPage />
              ) : subPage === "releases" ? (
                <RepoReleasesPage
                  eventId={releaseId}
                  view={releaseView ?? "releases"}
                />
              ) : subPage === "issue" ? (
                <IssuePage />
              ) : subPage === "issues" ? (
                <RepoIssuesPage />
              ) : subPage === "pr" ? (
                <PRPage />
              ) : subPage === "pr-commit" ? (
                <PRPage />
              ) : subPage === "prs" ? (
                <RepoPRsPage />
              ) : subPage === "about" ? (
                <RepoAboutPage />
              ) : subPage === "edit" ? (
                <Navigate to={`${basePath}/settings`} replace />
              ) : subPage === "settings" ? (
                <RepoSettingsPage />
              ) : null}
            </RepoContext.Provider>
          </GitCommitLinkContext.Provider>
        ) : repoSearch &&
          (repoSearch.concludedNotFound ||
            repoSearch.deleted ||
            repoSearch.vanished ||
            (Object.keys(repoSearch.relayStatuses).length > 0 &&
              repoSearchDelayElapsed)) &&
          !repoSearch.found ? (
          <EventSearchStatus
            search={repoSearch}
            itemLabel="Repository"
            backPath="/"
            backLabel="Back to repositories"
            searchMoreActive={true}
          />
        ) : subPage === "issue" ||
          subPage === "pr" ||
          subPage === "pr-commit" ? (
          /* Show an issue/PR-shaped skeleton while the repo context resolves,
           so the transition to the real page feels seamless. */
          <>
            <div className="border-b border-border/40">
              <div className="container max-w-screen-xl px-4 md:px-8 pt-6 pb-4">
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <Skeleton className="h-6 w-16 rounded-full" />
                    <Skeleton className="h-7 w-96" />
                  </div>
                  <div className="flex gap-3">
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </RepoRelaysContext.Provider>
  );
}

function getDefaultPersonalInfrastructure(
  accountPubkey: string,
  dTag: string,
  graspServers: GraspServer[],
): { cloneUrls: string[]; relayUrls: string[] } {
  const npub = nip19.npubEncode(accountPubkey);
  const encodedDTag = encodeURIComponent(dTag);
  return {
    cloneUrls: graspServers.map(
      ({ domain }) => `https://${domain}/${npub}/${encodedDTag}.git`,
    ),
    relayUrls: graspServers.map(({ wsUrl }) => wsUrl),
  };
}

function getAnnouncementGraspDomains(
  announcement: NostrEvent | undefined,
): string[] {
  if (!announcement) return [];
  return Array.from(
    new Set(
      getRepoCloneUrls(announcement)
        .map(graspCloneUrlDomain)
        .filter((domain): domain is string => !!domain),
    ),
  );
}

function getInvitationDefaultGraspDomains(
  repo: ResolvedRepo,
  ownAnnouncement: NostrEvent | undefined,
  graspServers: GraspServer[],
  graspServersFromUserList: boolean,
): string[] {
  return selectGraspDomainsWithBackfill(
    [
      getAnnouncementGraspDomains(ownAnnouncement),
      graspServersFromUserList
        ? graspServers.map((server) => server.domain)
        : [],
      repo.graspServerDomains,
    ],
    DEFAULT_GRASP_SERVERS,
  );
}

function MaintainerInvitationBanner({
  repo,
  accountPubkey,
  signer,
  graspServers,
  graspServersFromUserList,
  ownState,
  stateCheckComplete,
  canonicalState,
  openAcceptanceInitially,
}: {
  repo: ResolvedRepo;
  accountPubkey: string;
  signer: {
    signEvent(template: EventTemplate): Promise<NostrEvent>;
  };
  graspServers: GraspServer[];
  graspServersFromUserList: boolean;
  ownState: RepositoryState | undefined;
  stateCheckComplete: boolean;
  canonicalState: RepositoryState | null | undefined;
  openAcceptanceInitially: boolean;
}) {
  const isRequested = repo.requestedMaintainers.includes(accountPubkey);
  const acceptanceJob = useMaintainerAcceptanceJob(
    accountPubkey,
    repo.selectedMaintainer,
    repo.dTag,
  );
  const ownAnnouncement = repo.announcements.find(
    (announcement) => announcement.pubkey === accountPubkey,
  );
  const inviters = Array.from(
    new Set(
      repo.maintainerEdges
        .filter(({ to }) => to === accountPubkey)
        .map(({ from }) => from),
    ),
  );
  const acceptanceSelection = getAcceptanceMaintainerSelection(
    repo,
    accountPubkey,
  );
  const stateDecision = classifyInvitationState(
    canonicalState,
    ownState,
    accountPubkey,
  );

  if (!isRequested && !acceptanceJob) return null;

  return (
    <div className="border-b border-pink-500/20 bg-gradient-to-r from-pink-500/10 via-background to-violet-500/10">
      <div className="container max-w-screen-xl px-4 py-4 md:px-8">
        <div className="flex flex-col gap-4 rounded-xl border border-pink-500/30 bg-background/80 p-4 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pink-500/15 text-pink-600 dark:text-pink-400">
              <UserPlus className="h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="font-semibold">
                You’re invited to maintain {repo.name}
              </p>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                {inviters.length > 0 ? (
                  <>
                    <span>Invited by</span>
                    {inviters.map((pubkey) => (
                      <UserLink
                        key={pubkey}
                        pubkey={pubkey}
                        avatarSize="xs"
                        nameClassName="text-sm"
                      />
                    ))}
                  </>
                ) : (
                  <span>Select how you want to join the maintainer group.</span>
                )}
              </div>
            </div>
          </div>

          {acceptanceJob ? (
            <MaintainerAcceptanceProgress job={acceptanceJob} />
          ) : !stateCheckComplete ? (
            <Button type="button" disabled className="w-full sm:w-auto">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Checking repository state and infrastructure…
            </Button>
          ) : stateDecision.blocked ? (
            <div className="max-w-md rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                Use ngit CLI to accept this invitation
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                The repository owner has a newer state that would replace or
                remove refs from your repository. Interactive ref selection and
                combining is deferred to a future update.
              </p>
            </div>
          ) : (
            <MaintainerAcceptanceControls
              key={`${repo.selectedMaintainer}:${acceptanceSelection.options.join(
                ",",
              )}:${acceptanceSelection.defaults.join(",")}`}
              repo={repo}
              ownAnnouncement={ownAnnouncement}
              accountPubkey={accountPubkey}
              signer={signer}
              graspServers={graspServers}
              graspServersFromUserList={graspServersFromUserList}
              canonicalState={canonicalState}
              openInitially={openAcceptanceInitially}
              {...acceptanceSelection}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MaintainerAcceptanceProgress({
  job,
}: {
  job: MaintainerAcceptanceJob;
}) {
  const { toast } = useToast();
  const readyCount = job.syncedCloneUrls.length;
  const allReady =
    job.cloneUrls.length > 0 && readyCount === job.cloneUrls.length;
  const allDelivered = job.relayUrls.every((url) =>
    job.deliveredRelayUrls.includes(url),
  );
  const pendingWork =
    !allReady || !allDelivered || !job.broadcastReceived || !job.completedAt;

  const retry = async () => {
    try {
      const result = await runMaintainerAcceptanceDelivery(job.key);
      if (result?.phase === "delivery-error") {
        toast({
          title: "Some GRASP servers still did not accept the announcement",
          description: "Check the failed servers and retry.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Could not retry invitation delivery",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  if (job.phase === "delivery-error") {
    const failedTargets = Object.keys(job.relayErrors);
    return (
      <div className="flex w-full shrink-0 flex-col gap-2 rounded-lg border border-destructive/30 bg-background/80 px-3 py-2 text-sm sm:w-auto sm:min-w-80">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="font-medium">Invitation delivery incomplete</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {job.deliveredRelayUrls.length}/{job.relayUrls.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {failedTargets.length} selected destination
          {failedTargets.length === 1 ? "" : "s"} still need the announcement.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={retry}>
          Retry delivery
        </Button>
      </div>
    );
  }

  const synced = job.phase === "synced";
  return (
    <div className="flex w-full shrink-0 items-center gap-2 rounded-lg border bg-background/80 px-3 py-2 text-sm sm:w-auto sm:min-w-72">
      {synced ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-pink-500" />
      )}
      <span className="font-medium">
        {synced
          ? allReady
            ? "Invitation accepted · GRASP servers in sync"
            : "Invitation accepted · GRASP server synced"
          : job.phase === "publishing"
            ? "Accepting invitation · publishing announcement"
            : "Invitation accepted · syncing GRASP servers"}
      </span>
      {job.phase !== "publishing" && (
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {synced && pendingWork && (
            <Loader2 className="h-3 w-3 animate-spin opacity-60" />
          )}
          {readyCount}/{job.cloneUrls.length}
        </span>
      )}
    </div>
  );
}

function MaintainerAcceptanceControls({
  repo,
  ownAnnouncement,
  accountPubkey,
  signer,
  graspServers,
  graspServersFromUserList,
  canonicalState,
  options,
  defaults,
  leadMaintainer,
  openInitially,
}: {
  repo: ResolvedRepo;
  ownAnnouncement: NostrEvent | undefined;
  accountPubkey: string;
  signer: {
    signEvent(template: EventTemplate): Promise<NostrEvent>;
  };
  graspServers: GraspServer[];
  graspServersFromUserList: boolean;
  canonicalState: RepositoryState | null | undefined;
  options: string[];
  defaults: string[];
  leadMaintainer?: string;
  openInitially: boolean;
}) {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(openInitially);
  const [publishing, setPublishing] = useState(false);
  const [selectedMaintainers, setSelectedMaintainers] =
    useState<string[]>(defaults);
  const [selectedDomains, setSelectedDomains] = useState<string[]>(() =>
    getInvitationDefaultGraspDomains(
      repo,
      ownAnnouncement,
      graspServers,
      graspServersFromUserList,
    ),
  );
  useEffect(() => {
    if (openInitially) setDialogOpen(true);
  }, [openInitially]);
  const selectedGraspServers = useMemo<GraspServer[]>(
    () =>
      selectedDomains.map(
        (domain) =>
          graspServers.find((server) => server.domain === domain) ?? {
            domain,
            wsUrl: `wss://${domain}`,
          },
      ),
    [graspServers, selectedDomains],
  );
  const { cloneUrls, relayUrls } = useMemo(
    () =>
      getDefaultPersonalInfrastructure(
        accountPubkey,
        repo.dTag,
        selectedGraspServers,
      ),
    [accountPubkey, repo.dTag, selectedGraspServers],
  );

  const accept = async () => {
    if (
      publishing ||
      selectedMaintainers.length === 0 ||
      selectedGraspServers.length === 0
    ) {
      return;
    }
    setPublishing(true);
    try {
      const validationResults = await Promise.all(
        selectedDomains.map(async (domain) => ({
          domain,
          error: await validateGraspServer(domain, {
            requiredGrasps: ["GRASP-01", "GRASP-02"],
          }),
        })),
      );
      const invalidServers = validationResults.filter(({ error }) => !!error);
      if (invalidServers.length > 0) {
        throw new Error(
          invalidServers
            .map(({ domain, error }) => `${domain}: ${error}`)
            .join("; "),
        );
      }

      const announcement = await signer.signEvent(
        buildMaintainerAcceptanceTemplate(
          repo,
          ownAnnouncement,
          accountPubkey,
          selectedMaintainers,
          selectedGraspServers,
        ),
      );
      setDialogOpen(false);
      const key = maintainerAcceptanceKey(
        accountPubkey,
        repo.selectedMaintainer,
        repo.dTag,
      );
      const now = Date.now();
      saveMaintainerAcceptanceJob({
        key,
        accountPubkey,
        invitationAnchor: repo.selectedMaintainer,
        dTag: repo.dTag,
        announcement,
        cloneUrls,
        relayUrls,
        deliveredRelayUrls: [],
        syncedCloneUrls: [],
        relayErrors: {},
        deliveryAttempt: 0,
        broadcastReceived: false,
        phase: "publishing",
        stateRefs: canonicalState?.refs ?? [],
        knownHeadCommit: canonicalState?.headCommitId,
        stateCreatedAt: canonicalState?.event.created_at,
        createdAt: now,
        updatedAt: now,
      });
      const result = await runMaintainerAcceptanceDelivery(key);
      const startedSyncing = (result?.deliveredRelayUrls.length ?? 0) > 0;

      toast({
        title: startedSyncing
          ? "Invitation accepted"
          : "Invitation accepted, but delivery needs attention",
        description: startedSyncing
          ? "Your GRASP servers are syncing the repository."
          : "Retry the GRASP servers that did not accept your announcement.",
        variant: startedSyncing ? "default" : "destructive",
      });
    } catch (error) {
      setPublishing(false);
      toast({
        title: "Could not accept invitation",
        description:
          error instanceof Error ? error.message : "Publishing failed.",
        variant: "destructive",
      });
    }
  };

  const toggleMaintainer = (pubkey: string, checked: boolean) => {
    setSelectedMaintainers((current) =>
      checked
        ? Array.from(new Set([...current, pubkey]))
        : current.filter((candidate) => candidate !== pubkey),
    );
  };

  return (
    <>
      <Button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="w-full shrink-0 bg-pink-600 text-white hover:bg-pink-700 sm:w-auto"
      >
        <CheckCircle2 className="mr-2 h-4 w-4" />
        Accept invitation
      </Button>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!publishing) setDialogOpen(open);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Accept invitation</DialogTitle>
            <DialogDescription>
              Choose where to host your copy of {repo.name}.
            </DialogDescription>
          </DialogHeader>

          <section className="space-y-3">
            <div>
              <h3 className="font-medium">Your GRASP servers</h3>
              <p className="text-sm text-muted-foreground">
                Where to store the data
              </p>
            </div>
            <GraspServerSelector
              selectedDomains={selectedDomains}
              onSelectedDomainsChange={setSelectedDomains}
              resolvedServers={graspServers}
              isFromUserList={graspServersFromUserList}
              additionalDomains={repo.graspServerDomains}
              currentDomains={getAnnouncementGraspDomains(ownAnnouncement)}
              requiredGrasps={["GRASP-01", "GRASP-02"]}
              disabled={publishing}
              showTitle={false}
            />
          </section>

          {options.length > 1 && (
            <section className="space-y-3 border-t pt-4">
              <h3 className="flex items-center gap-2 font-medium">
                <Users className="h-4 w-4" />
                Select lead maintainer(s)
              </h3>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {options.map((pubkey) => {
                  const checked = selectedMaintainers.includes(pubkey);
                  return (
                    <label
                      key={pubkey}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={publishing}
                        onCheckedChange={(value) =>
                          toggleMaintainer(pubkey, value === true)
                        }
                      />
                      <UserLink
                        pubkey={pubkey}
                        avatarSize="xs"
                        nameClassName="text-sm"
                        className="min-w-0 flex-1"
                        noLink
                      />
                      {pubkey === leadMaintainer && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px] text-pink-600 dark:text-pink-400"
                        >
                          lead
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={publishing}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={accept}
              disabled={
                publishing ||
                selectedMaintainers.length === 0 ||
                selectedDomains.length === 0
              }
              className="bg-pink-600 text-white hover:bg-pink-700"
            >
              {publishing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {publishing ? "Accepting…" : "Accept invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Error / loading states
// ---------------------------------------------------------------------------

function Nip05LoadingState({ nip05 }: { nip05: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(id);
  }, []);
  return (
    <div
      className={`min-h-full flex items-center justify-center transition-opacity duration-500 ${visible ? "opacity-100" : "opacity-0"}`}
    >
      <div className="text-center space-y-4 max-w-md px-4">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-pink-500/10">
            <Loader2 className="h-8 w-8 text-pink-500 animate-spin" />
          </div>
        </div>
        <h2 className="text-xl font-semibold">Resolving identity</h2>
        <p className="text-muted-foreground text-sm">
          Looking up <span className="font-mono text-foreground">{nip05}</span>…
        </p>
      </div>
    </div>
  );
}

function Nip05NotFoundError({ nip05 }: { nip05: string }) {
  return (
    <div className="min-h-full flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md px-4">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-destructive/10">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Identity not found</h2>
          <p className="text-muted-foreground">
            The NIP-05 address{" "}
            <span className="font-mono text-foreground">{nip05}</span> could not
            be found. Make sure the address is correct and the domain's{" "}
            <span className="font-mono text-sm">/.well-known/nostr.json</span>{" "}
            is reachable.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to repositories
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Nip05ResolveError({
  nip05,
  reason,
}: {
  nip05: string;
  reason: "timeout" | "network" | "unknown";
}) {
  const detail =
    reason === "timeout"
      ? "The lookup timed out. The domain may be slow or unreachable."
      : reason === "network"
        ? "A network error occurred. Check your connection and that the domain's /.well-known/nostr.json is accessible."
        : "An unexpected error occurred while looking up the NIP-05 address.";

  return (
    <div className="min-h-full flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md px-4">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-destructive/10">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Failed to resolve identity</h2>
          <p className="text-muted-foreground">
            Could not look up{" "}
            <span className="font-mono text-foreground">{nip05}</span>.
          </p>
          <p className="text-sm text-muted-foreground">{detail}</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to repositories
          </Link>
        </Button>
      </div>
    </div>
  );
}

function RouteNotFound({ splat }: { splat: string }) {
  return (
    <div className="min-h-full flex items-center justify-center">
      <div className="text-center space-y-6 max-w-md px-4">
        <div className="flex justify-center">
          <div className="p-4 rounded-full bg-muted">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Page not found</h2>
          <p className="text-muted-foreground">
            <span className="font-mono text-foreground">/{splat}</span> doesn't
            match a known repository URL format.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to repositories
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo breadcrumb: <username> / <repo-name>
// ---------------------------------------------------------------------------

function RepoBreadcrumb({
  pubkey,
  repoName,
  basePath,
  nip05,
}: {
  pubkey: string;
  repoName: string;
  basePath: string;
  nip05?: string;
}) {
  useLoadProfile(pubkey);
  const profile = useProfile(pubkey);
  const userPath = useUserPath(pubkey);
  const npub = nip19.npubEncode(pubkey);
  const nip05Local = nip05?.split("@")[0];
  const nip05Domain = nip05?.split("@")[1];
  const nip05Label = nip05Local === "_" ? nip05Domain : nip05Local;
  const username =
    profile?.displayName ??
    profile?.name ??
    nip05Label ??
    npub.slice(0, 12) + "…";

  return (
    <div className="flex items-center gap-2 min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 text-muted-foreground min-w-0 shrink">
        <UserAvatar
          pubkey={pubkey}
          size="sm"
          className="flex-shrink-0"
          linkToProfile
        />
        <Link
          to={userPath}
          className="hover:text-foreground transition-colors truncate"
        >
          <span className="text-base font-medium truncate">{username}</span>
        </Link>
      </div>
      <span className="text-muted-foreground font-normal flex-shrink-0">/</span>
      <Link
        to={basePath}
        className="text-base font-semibold text-foreground hover:text-pink-500 transition-colors truncate min-w-0 shrink"
      >
        {repoName}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab link
// ---------------------------------------------------------------------------

function TabLink({
  to,
  active,
  icon,
  label,
  count,
}: {
  to: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-pink-500 text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 && (
        <Badge
          variant="secondary"
          className="ml-1 h-5 min-w-[20px] px-1.5 text-[11px] font-medium"
        >
          {count}
        </Badge>
      )}
    </Link>
  );
}
