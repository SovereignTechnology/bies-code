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
import RepoCoordinatorsPage from "./RepoCoordinatorsPage";
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
import { useRepositoryMembershipMutation } from "@/hooks/useRepositoryMembershipMutation";
import { hasUnsupportedAcceptanceRoleHistory } from "@/lib/repositoryMembershipMutation";
import type { RepositoryState } from "@/casts/RepositoryState";
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
import { Input } from "@/components/ui/input";
import { nip19 } from "nostr-tools";
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
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RepoContext, type RepoContextValue } from "./RepoContext";
import {
  getRepositoryPresentationCoordinates,
  hasAcceptedRepositoryReference,
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
import { getRepositoryLeadRedirectPath } from "@/lib/repositoryLeadRoute";
import { BehaviorSubject, EMPTY, merge } from "rxjs";
import { catchError } from "rxjs/operators";
import {
  ciRepositoryCoordinatorStatus$,
  repoCIActivity$,
} from "@/services/ciQueries";
import { useGitPool } from "@/hooks/useGitPool";
import { usePrivateGitRelays } from "@/hooks/usePrivateGitRelays";
import { BuzzRepositoryContext } from "@/contexts/BuzzRepositoryContext";
import { formatDistanceToNow } from "date-fns";

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
  const {
    resolved,
    repoSearch,
    announcementsFreshEose,
    announcementsSettled,
    privateProbe,
  } = useResolvedRepository(pubkey, repoId, relayHints, nip05Relays);
  const repo = resolved?.repo;
  const isPrivate = privateProbe?.status === "found" || !!repo?.isPrivate;
  const presentationRepoCoordinates = useMemo(
    () => (repo ? getRepositoryPresentationCoordinates(repo) : undefined),
    [repo],
  );

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
  usePrefetchNip05(isPrivate ? [] : (repo?.confirmedMembers ?? []));
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
  // fetched, not just the root events. Coordinates are fed in reactively so
  // a maintainer confirming later grows the live subscription with delta
  // REQs instead of restarting it.
  const coordKey = repo?.confirmedMemberCoordinates.join(",") ?? "";
  const supplementalCoords$ = useMemo(
    () => new BehaviorSubject<string[]>(repo?.confirmedMemberCoordinates ?? []),
    // Intentionally NOT keyed on the coordinates — they are fed in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extraRelaysForMaintainerMailboxCoverage],
  );
  useEffect(() => {
    if (repo?.confirmedMemberCoordinates.length)
      supplementalCoords$.next(repo.confirmedMemberCoordinates);
    // Content-keyed dep: pushes happen only when the coordinate set changes;
    // the loader additionally no-ops on unchanged lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplementalCoords$, coordKey]);
  const hasMemberCoords = !!repo?.confirmedMemberCoordinates.length;
  use$(() => {
    if (
      curationMode !== "outbox" ||
      isPrivate ||
      !extraRelaysForMaintainerMailboxCoverage ||
      !hasMemberCoords
    )
      return undefined;
    return nip34SupplementalRelayLoader(
      supplementalCoords$,
      extraRelaysForMaintainerMailboxCoverage,
    ).pipe(catchError(() => EMPTY));
  }, [
    curationMode,
    isPrivate,
    extraRelaysForMaintainerMailboxCoverage,
    hasMemberCoords,
    supplementalCoords$,
  ]);

  const relayHintsKey = relayHints.join(",");
  const confirmedMaintainersKey = repo?.confirmedMaintainers.join(",") ?? "";
  const queryOptions: RepoQueryOptions = useMemo(
    () => ({
      relayHints: isPrivate ? [] : relayHints,
      useItemAuthorRelays: false,
      maintainerPubkeys: repo?.confirmedMaintainers ?? [],
      privateRepository: isPrivate,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relayHintsKey, confirmedMaintainersKey, isPrivate],
  );

  const issues = useIssues(
    presentationRepoCoordinates,
    repoRelayGroup,
    queryOptions,
    repo?.roleHistory,
  );
  const prs = usePRs(
    presentationRepoCoordinates,
    repoRelayGroup,
    queryOptions,
    repo?.roleHistory,
  );

  const acceptedRepoCoordinates = useMemo(
    () => repo?.confirmedMemberCoordinates ?? [],
    [repo],
  );
  const selectedRepoCoordinate = repo?.selectedCoordinate;
  const acceptedAnnouncements = useMemo(
    () => repo?.confirmedAnnouncements ?? [],
    [repo],
  );

  // Whether the repo has any CI events (ngit-ci kinds 9841/9842) — drives
  // visibility of the Actions tab. Cheap limit-1 probe by #a across all
  // maintainer coordinates.
  const hasCI = useRepoHasCI(
    isPrivate ? undefined : repo?.confirmedMaintainerCoordinates,
    isPrivate ? undefined : repoRelayGroup,
  );

  // Pin the shared repository CI context for the lifetime of the layout once
  // the repository shows CI signals, so child pages and tab navigation attach
  // to one live set of queries instead of reopening them per mount. The
  // coordinator discovery query is already held open by useRepoHasCI above.
  const maintainerCoordKey =
    repo?.confirmedMaintainerCoordinates.join(",") ?? "";
  use$(() => {
    if (isPrivate || !hasCI || !repo?.confirmedMaintainerCoordinates.length)
      return undefined;
    return merge(
      repoCIActivity$(
        repo.confirmedMaintainerCoordinates,
        repo.selectedCoordinate,
      ),
      ciRepositoryCoordinatorStatus$(
        repo.confirmedMaintainerCoordinates,
        repo.selectedCoordinate,
        repo.confirmedMaintainers,
      ),
    );
  }, [isPrivate, hasCI, maintainerCoordKey, repo?.selectedCoordinate]);
  const releaseSummary = useRepoReleaseSummary(
    isPrivate ? undefined : repo?.confirmedMaintainerCoordinates,
    isPrivate ? undefined : repo?.confirmedMaintainers,
    isPrivate ? undefined : repoRelayGroup,
    !isReleasesTab && !isPrivate,
  );
  const hasReleases = releaseSummary.hasReleases;

  const [repoState, repoRelayEose, relayStateMap] = useRepositoryState(
    repo?.dTag,
    repo?.confirmedMaintainers,
    repoRelayGroup,
  );

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

  // Settings and maintainer-only controls are restricted to the reciprocal
  // confirmed component.
  const account = useActiveAccount();
  const canOpenSettings =
    !isPrivate && account?.pubkey && repo
      ? repo.confirmedMaintainers.includes(account.pubkey)
      : false;
  const showReleases =
    !isPrivate && (hasReleases || isReleasesTab || canOpenSettings);

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
    coordinatorIdentifier,
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
      | "action-coordinators"
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
    coordinatorIdentifier?: string;
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
      if (segments[1] === "coordinators") {
        return {
          subPage: "action-coordinators",
          coordinatorIdentifier: segments[2],
        };
      }
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
  const { pool: commitLinkPool, privateAccessError } = useGitPool(cloneUrls, {
    private: isPrivate,
  });

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
          announcementsSettled,
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
    () => ({
      cloneUrls,
      basePath,
      pool: commitLinkPool,
      privateRepository: isPrivate,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cloneUrls.join(","), basePath, commitLinkPool, isPrivate],
  );

  // Route at the first fresh announcement EOSE (both explicit and
  // legacy-inferred leads): the lead path is fail-closed on partial data, and
  // a grasp/index relay holding any maintainer's announcement for a repo
  // holds the whole group's, so the first fresh view is graph-complete in
  // practice. Keeping this after every hook invalidates stale decisions
  // across renders; a later correction is another replace-navigation.
  const leadRedirectPath = repo
    ? getRepositoryLeadRedirectPath({
        selectedPubkey: pubkey,
        dTag: repo.dTag,
        relayHints,
        pageSuffix: repoPageSuffix,
        search: location.search,
        hash: location.hash,
        leadResolution: repo.leadResolution,
        announcementsFreshEose,
      })
    : undefined;
  if (leadRedirectPath) {
    return <Navigate to={leadRedirectPath} replace state={location.state} />;
  }
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
                {repo.isBuzz && (
                  <Badge variant="secondary" className="shrink-0">
                    Basic Buzz support
                  </Badge>
                )}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isPrivate && (
                    <>
                      <RepoZapButton
                        targetAnnouncement={repo.confirmedAnnouncements.find(
                          (a) => a.pubkey === repo.selectedMaintainer,
                        )}
                        repoCoords={acceptedRepoCoordinates}
                      />
                      <FollowRepoButton repoCoord={selectedRepoCoordinate} />
                      <StarButton
                        targetAnnouncement={repo.confirmedAnnouncements.find(
                          (a) => a.pubkey === repo.selectedMaintainer,
                        )}
                        allAnnouncements={acceptedAnnouncements}
                        repoCoords={acceptedRepoCoordinates}
                      />
                    </>
                  )}
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
            <nav className="-mb-px flex w-full gap-0 sm:gap-1">
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
                {!isPrivate && (hasCI || isActionsTab) && (
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
              <div className="flex shrink-0 items-end pb-px md:hidden">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-2.5 text-sm font-medium border-b-2 transition-colors sm:px-3",
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
                    {!isPrivate && (hasCI || isActionsTab) && (
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

        {repo && announcementsSettled && (
          <RepositoryLifecycleNotice repo={repo} />
        )}

        {repo && announcementsSettled && repo.repositoryHealth.length > 0 && (
          <RepositoryHealthNotice
            repo={repo}
            accountPubkey={account?.pubkey}
            announcementsSettled={announcementsSettled}
            stateSettled={repoRelayEose}
            relayUrls={[
              ...new Set([
                ...repoRelayUrls,
                ...(extraRelaysForMaintainerMailboxCoverage?.relays.map(
                  ({ url }) => url,
                ) ?? []),
              ]),
            ]}
            repoState={repoState}
          />
        )}

        {repo && !isPrivate && (
          <RepoMaintainerRequestBanner
            repo={repo}
            pageSuffix={repoPageSuffix}
          />
        )}

        {repo && !isPrivate && account?.pubkey && (
          <MaintainerInvitationSafetyBanner
            repo={repo}
            accountPubkey={account.pubkey}
            announcementsSettled={announcementsSettled}
            stateSettled={repoRelayEose}
            repoState={repoState}
            relayUrls={[
              ...new Set([
                ...repoRelayUrls,
                ...(extraRelaysForMaintainerMailboxCoverage?.relays.map(
                  ({ url }) => url,
                ) ?? []),
              ]),
            ]}
          />
        )}

        {repo && isPrivate && privateAccessError && (
          <div
            className="container max-w-screen-xl px-4 pt-4 md:px-8"
            role="alert"
          >
            <div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{privateAccessError}</p>
            </div>
          </div>
        )}

        {/* Page content */}
        {ctxValue ? (
          <BuzzRepositoryContext.Provider value={repo?.isBuzz ?? false}>
            <GitCommitLinkContext.Provider value={gitCommitLinkCtxValue}>
              <RepoContext.Provider value={ctxValue}>
                {isPrivate &&
                (subPage === "actions" ||
                  subPage === "action-coordinators" ||
                  subPage === "releases" ||
                  subPage === "settings" ||
                  subPage === "edit") ? (
                  <PrivateFeatureUnavailable />
                ) : subPage === "code" ? (
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
                ) : subPage === "action-coordinators" ? (
                  <RepoCoordinatorsPage
                    coordinatorIdentifier={coordinatorIdentifier}
                  />
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
          </BuzzRepositoryContext.Provider>
        ) : privateProbe?.status === "unavailable" ? (
          <PrivateRepositoryUnavailable reason={privateProbe.error} />
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

function MaintainerInvitationSafetyBanner({
  repo,
  accountPubkey,
  announcementsSettled,
  stateSettled,
  relayUrls,
  repoState,
}: {
  repo: ResolvedRepo;
  accountPubkey: string;
  announcementsSettled: boolean;
  stateSettled: boolean;
  relayUrls: string[];
  repoState?: RepositoryState | null;
}) {
  const { enabled, deliveryBlocked, mutate, pendingIntent, failure } =
    useRepositoryMembershipMutation({
      repo,
      announcementsSettled,
      stateSettled,
      relayUrls,
      repoState,
    });
  const [accepted, setAccepted] = useState(false);
  const invited = repo.invitedMaintainers.includes(accountPubkey);
  const moderator = repo.confirmedModerators.includes(accountPubkey);
  if (!invited && !moderator) return null;

  const hasOwnAnnouncement = repo.discoveredAnnouncements.some(
    ({ pubkey }) => pubkey === accountPubkey,
  );
  const maintainerSelfDeferWarnings = repo.repositoryHealth.filter(
    ({ author, code, role }) =>
      author === accountPubkey &&
      code === "invalid-self-defer" &&
      (role === "M" || role === "m"),
  );
  const prospectiveAcceptanceAt = Math.floor(Date.now() / 1000);
  const repairableMaintainerSelfDefer =
    maintainerSelfDeferWarnings.length === 1 &&
    !hasUnsupportedAcceptanceRoleHistory(
      repo,
      accountPubkey,
      prospectiveAcceptanceAt,
    ) &&
    !maintainerSelfDeferWarnings[0].selfDefer?.hasPriorIntervals &&
    (!maintainerSelfDeferWarnings[0].selfDefer?.superseded ||
      maintainerSelfDeferWarnings[0].selfDefer.proposedEnd !== undefined)
      ? maintainerSelfDeferWarnings[0]
      : undefined;
  const unsupportedExistingAcceptance =
    invited && hasOwnAnnouncement && !repairableMaintainerSelfDefer;

  const inviters = Array.from(
    new Set(
      (invited ? repo.maintainerEdges : repo.moderatorEdges)
        .filter(({ to }) => to === accountPubkey)
        .map(({ from }) => from),
    ),
  );

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
                {invited
                  ? `You’re invited to maintain ${repo.name}`
                  : `You moderate ${repo.name}`}
              </p>
              {inviters.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
                  <span>{invited ? "Invited by" : "Assigned by"}</span>
                  {inviters.map((pubkey) => (
                    <UserLink
                      key={pubkey}
                      pubkey={pubkey}
                      avatarSize="xs"
                      nameClassName="text-sm"
                    />
                  ))}
                </div>
              )}
              {invited && repairableMaintainerSelfDefer && (
                <p className="text-sm text-muted-foreground">
                  {repairableMaintainerSelfDefer.selfDefer?.superseded
                    ? "Accepting closes your invalid interval at its signed successor boundary and opens the maintainer role at the acceptance time."
                    : "Accepting explicitly closes your invalid deferred interval and opens the new role at the same signed boundary."}
                </p>
              )}
              {unsupportedExistingAcceptance && (
                <p className="text-sm text-muted-foreground">
                  Your existing announcement needs separate role-history
                  reconciliation before GitWorkshop can accept this invitation.
                </p>
              )}
            </div>
          </div>
          <div className="max-w-md space-y-2">
            {enabled ? (
              <Button
                type="button"
                disabled={
                  !!pendingIntent ||
                  accepted ||
                  !announcementsSettled ||
                  !stateSettled ||
                  unsupportedExistingAcceptance
                }
                onClick={() => {
                  void mutate(invited ? { type: "accept" } : { type: "leave" })
                    .then(() => setAccepted(true))
                    .catch(() => undefined);
                }}
              >
                {pendingIntent?.type === (invited ? "accept" : "leave") && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {accepted
                  ? invited
                    ? "Acceptance published"
                    : "Moderator exit published"
                  : invited
                    ? "Accept invitation"
                    : "Leave moderator role"}
              </Button>
            ) : (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                {deliveryBlocked
                  ? "A signed membership replacement is already being delivered. Further membership changes stay disabled until that job settles."
                  : "Browser membership changes are temporarily unavailable while their safety checks are upgraded."}
              </p>
            )}
            {failure && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-mono text-amber-700 dark:text-amber-300">
                  {failure.code}
                </span>{" "}
                {failure.message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error / loading states
// ---------------------------------------------------------------------------

function PrivateRepositoryUnavailable({ reason }: { reason?: string }) {
  const { state, retry } = usePrivateGitRelays();
  return (
    <div className="container max-w-screen-md px-4 py-16 md:px-8">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
        <AlertCircle className="mx-auto h-8 w-8 text-amber-600 dark:text-amber-400" />
        <h2 className="mt-4 text-xl font-semibold">
          Private repository unavailable
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          {reason ??
            "Private discovery did not complete safely, so GitWorkshop did not try public relays."}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {state.status !== "logged-out" && (
            <Button
              type="button"
              variant="outline"
              onClick={retry}
              disabled={state.status === "loading"}
            >
              {state.status === "loading" && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              Retry now
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/settings">Review Private Git services</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function PrivateFeatureUnavailable() {
  return (
    <div className="container max-w-screen-md px-4 py-16 md:px-8">
      <div className="rounded-xl border border-dashed p-8 text-center">
        <h2 className="text-xl font-semibold">Unavailable for private repos</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          This feature is disabled until it can operate entirely through the
          repository&apos;s private service relays.
        </p>
      </div>
    </div>
  );
}

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

function lifecycleTime(createdAt: number | undefined): string | undefined {
  return createdAt === undefined
    ? undefined
    : formatDistanceToNow(new Date(createdAt * 1000), { addSuffix: true });
}

function RepositoryLifecycleNotice({ repo }: { repo: ResolvedRepo }) {
  if (
    repo.coordinateStatus !== "archived" &&
    repo.coordinateStatus !== "deleted" &&
    repo.coordinateStatus !== "restarted"
  ) {
    return null;
  }

  const when = lifecycleTime(repo.coordinateStatusChangedAt);
  const readOnly =
    repo.coordinateStatus === "archived" || repo.coordinateStatus === "deleted";

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/5" role="status">
      <div className="container flex max-w-screen-xl gap-3 px-4 py-4 md:px-8">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-x-1 text-foreground">
            <UserLink
              pubkey={repo.selectedMaintainer}
              avatarSize="xs"
              variant="inline"
            />
            {repo.coordinateStatus === "deleted" && (
              <span className="font-mono">/{repo.dTag}</span>
            )}
            <span>
              {repo.coordinateStatus === "deleted"
                ? "deleted this repository"
                : repo.coordinateStatus === "archived"
                  ? "archived this repository"
                  : "restarted this repository"}
              {when ? ` ${when}` : ""}.
            </span>
          </p>
          <p className="text-muted-foreground">
            {readOnly
              ? "Its last signed snapshot remains available here as a read-only archive."
              : "The current repository remains available, while earlier signed activity is retained as history from its previous lifecycle."}
          </p>
        </div>
      </div>
    </div>
  );
}

function dateTimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function RepositoryHealthNotice({
  repo,
  accountPubkey,
  announcementsSettled,
  stateSettled,
  relayUrls,
  repoState,
}: {
  repo: ResolvedRepo;
  accountPubkey?: string;
  announcementsSettled: boolean;
  stateSettled: boolean;
  relayUrls: string[];
  repoState?: RepositoryState | null;
}) {
  const selfDeferWarnings = repo.repositoryHealth.filter(
    ({ code }) => code === "invalid-self-defer",
  );
  const ownSelfDeferWarnings = selfDeferWarnings.filter(
    ({ author }) => author === accountPubkey,
  );
  const hasCurrentInvitation =
    !!accountPubkey && repo.invitedMaintainers.includes(accountPubkey);
  const ownMaintainerSelfDeferWarnings = ownSelfDeferWarnings.filter(
    ({ role }) => role === "M" || role === "m",
  );
  const acceptanceHasUnsupportedRoleHistory = accountPubkey
    ? hasUnsupportedAcceptanceRoleHistory(
        repo,
        accountPubkey,
        Math.floor(Date.now() / 1000),
      )
    : true;
  const acceptanceSelfDefer =
    hasCurrentInvitation &&
    !acceptanceHasUnsupportedRoleHistory &&
    ownMaintainerSelfDeferWarnings.length === 1
      ? ownMaintainerSelfDeferWarnings.find(
          ({ selfDefer }) =>
            !selfDefer?.hasPriorIntervals &&
            (!selfDefer?.superseded || selfDefer.proposedEnd !== undefined),
        )
      : undefined;
  const ownSelfDefer = acceptanceSelfDefer ?? ownSelfDeferWarnings[0];
  const invitationRepairsSelfDefer = !!acceptanceSelfDefer;
  const repairSelectionAmbiguous =
    !!ownSelfDefer &&
    ownSelfDeferWarnings.filter(({ role }) => role === ownSelfDefer.role)
      .length > 1;
  const superseded = ownSelfDefer?.selfDefer?.superseded ?? false;
  const proposedEnd = ownSelfDefer?.selfDefer?.proposedEnd;
  const mutation = useRepositoryMembershipMutation({
    repo,
    announcementsSettled,
    stateSettled,
    relayUrls,
    repoState,
  });
  const [chosenEnd, setChosenEnd] = useState(() =>
    dateTimeLocalValue(Math.floor(Date.now() / 1000)),
  );
  const [repairPublished, setRepairPublished] = useState(false);
  const chosenBoundary = Math.floor(new Date(chosenEnd).getTime() / 1000);
  const chosenBoundaryValid =
    Number.isSafeInteger(chosenBoundary) &&
    chosenBoundary >= (ownSelfDefer?.selfDefer?.lastValidStart ?? 0) &&
    chosenBoundary <= Math.floor(Date.now() / 1000);
  const repair = (
    repairIntent: { action: "continue" } | { action: "end"; boundary: number },
  ) => {
    if (!ownSelfDefer?.role) return;
    mutation.clearFailure();
    setRepairPublished(false);
    void mutation
      .mutate({
        type: "repair-self-defer",
        role: ownSelfDefer.role,
        repair: repairIntent,
      })
      .then(() => setRepairPublished(true))
      .catch(() => undefined);
  };
  const repairPending = mutation.pendingIntent?.type === "repair-self-defer";
  const hasOtherHealth = repo.repositoryHealth.some(
    ({ code }) => code !== "invalid-self-defer",
  );

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/5" role="alert">
      <div className="container flex max-w-screen-xl gap-3 px-4 py-4 md:px-8">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 space-y-1 text-sm">
          <p className="font-medium text-foreground">
            Repository announcement needs repair
          </p>
          <p className="text-muted-foreground">
            {selfDeferWarnings.length > 0
              ? "A self-authored role ends in defer, so its unresolved interval grants no authority."
              : "One or more maintainer role records are malformed or inconsistent."}{" "}
            {ownSelfDefer
              ? superseded
                ? invitationRepairsSelfDefer
                  ? "Your later signed active role remains authoritative. Accepting the current invitation will close the invalid interval at that signed boundary and open your maintainer role at the acceptance time."
                  : "Your later signed active role remains authoritative, so this warning does not block current writes."
                : invitationRepairsSelfDefer
                  ? "Only your role-dependent writes are blocked; accepting the current invitation explicitly closes this interval and opens the new role."
                  : "Only your role-dependent writes are blocked; choose how your signed role interval should end."
              : selfDeferWarnings.length > 0
                ? "Only the affected signer is gated; repository reads and other maintainers continue normally."
                : "Authority remains fail-closed until the affected history is repaired."}
          </p>
          {repairSelectionAmbiguous && (
            <p className="mt-2 text-muted-foreground">
              Multiple invalid self-{ownSelfDefer?.role} records prevent
              GitWorkshop from choosing which interval to repair.
            </p>
          )}
          {ownSelfDefer &&
            !invitationRepairsSelfDefer &&
            !repairSelectionAmbiguous &&
            proposedEnd !== undefined && (
              <div className="mt-3 space-y-2 rounded-lg border border-amber-500/30 bg-background/70 p-3">
                <p className="text-muted-foreground">
                  The later signed self-{ownSelfDefer.selfDefer?.successorRole}{" "}
                  role supplies an unambiguous boundary. Approving this changes
                  only the final value of the invalid self-{ownSelfDefer.role}{" "}
                  record from <code className="font-mono">defer</code> to{" "}
                  <code className="font-mono">{proposedEnd}</code>.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    !mutation.enabled ||
                    repairPending ||
                    repairPublished ||
                    !stateSettled
                  }
                  onClick={() =>
                    repair({ action: "end", boundary: proposedEnd })
                  }
                >
                  {repairPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {repairPublished
                    ? "Repair published"
                    : "Approve signed repair"}
                </Button>
              </div>
            )}
          {ownSelfDefer &&
            !invitationRepairsSelfDefer &&
            !repairSelectionAmbiguous &&
            proposedEnd === undefined && (
              <div className="mt-3 space-y-3 rounded-lg border border-amber-500/30 bg-background/70 p-3">
                {!superseded && (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-muted-foreground">
                      Continue the self-{ownSelfDefer.role} interval as active.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !mutation.enabled ||
                        repairPending ||
                        repairPublished ||
                        !stateSettled
                      }
                      onClick={() => repair({ action: "continue" })}
                    >
                      {repairPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Continue role
                    </Button>
                  </div>
                )}
                <div className="space-y-2 border-t border-amber-500/20 pt-3">
                  <label
                    htmlFor="self-defer-end"
                    className="text-muted-foreground"
                  >
                    Or choose the signed time when the interval ended
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="self-defer-end"
                      type="datetime-local"
                      value={chosenEnd}
                      min={dateTimeLocalValue(
                        ownSelfDefer.selfDefer?.lastValidStart ?? 0,
                      )}
                      max={dateTimeLocalValue(Math.floor(Date.now() / 1000))}
                      onChange={(event) => setChosenEnd(event.target.value)}
                      className="sm:max-w-xs"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        !mutation.enabled ||
                        repairPending ||
                        repairPublished ||
                        !stateSettled ||
                        !chosenBoundaryValid
                      }
                      onClick={() =>
                        repair({ action: "end", boundary: chosenBoundary })
                      }
                    >
                      End role at this time
                    </Button>
                  </div>
                </div>
              </div>
            )}
          {ownSelfDefer &&
            !invitationRepairsSelfDefer &&
            !repairSelectionAmbiguous &&
            mutation.failure && (
              <p className="mt-2 text-destructive">
                {mutation.failure.message}
              </p>
            )}
          {hasOtherHealth && selfDeferWarnings.length > 0 && (
            <p className="mt-2 text-muted-foreground">
              Other malformed or inconsistent records still require a separate
              repair.
            </p>
          )}
        </div>
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
        "inline-flex min-w-0 flex-1 items-center justify-center gap-1 px-1 py-2.5 text-sm font-medium border-b-2 transition-colors sm:flex-none sm:gap-2 sm:px-4",
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
          className="ml-0.5 h-5 min-w-[20px] shrink-0 px-1.5 text-[11px] font-medium sm:ml-1"
        >
          {count}
        </Badge>
      )}
    </Link>
  );
}
