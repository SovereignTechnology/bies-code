import { useComposerDraft } from "@/hooks/useComposerDraft";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { eventIdMatchesSearch, eventIdToNevent } from "@/lib/routeUtils";
import { compactNumber } from "@/lib/utils";
import { useSeoMeta } from "@unhead/react";
import { useProfile } from "@/hooks/useProfile";
import { formatDistanceToNow } from "date-fns";
import { useActiveAccount } from "applesauce-react/hooks";
import { useRepoContext } from "./RepoContext";
import { UserName } from "@/components/UserAvatar";
import { StatusIcon } from "@/components/StatusIcon";
import { StatusTabs } from "@/components/StatusTabs";
import { LabelBadge } from "@/components/LabelBadge";
import { CreateIssueForm } from "@/components/CreateIssueForm";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MultiSelect } from "@/components/ui/multi-select";
import type { MultiSelectOption } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  MessageCircle,
  Users,
  CircleDot,
  X,
  Plus,
  Zap,
} from "lucide-react";
import { UserAvatar } from "@/components/UserAvatar";
import {
  hasAcceptedRepositoryReference,
  type IssueStatus,
  type ResolvedIssueLite,
  type ResolvedRepo,
} from "@/lib/nip34";
import {
  RepoItemAttributionIndicator,
  RepoItemAttributionWarning,
} from "@/components/RepoItemAttributionWarning";

const DEFAULT_STATUS_FILTER: IssueStatus[] = ["open"];

export default function RepoIssuesPage() {
  const { pubkey, repoId, resolved, issues, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const account = useActiveAccount();
  const repoOwnerProfile = useProfile(pubkey);
  const isReadOnlyRepository =
    repo?.coordinateStatus === "archived" ||
    repo?.coordinateStatus === "deleted" ||
    repo?.confirmedMemberCoordinates.length === 0;

  // New issue dialog
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const draftScope = `issue:30617:${pubkey}:${repoId}`;
  const { key: draftKey, hasDraft } = useComposerDraft(draftScope);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const closeIssue = () => {
    setOpenDraft(null);
    setDismissedDraft(draftKey);
  };

  // Restoring a draft opens the form once. Clearing its text while editing
  // must not close it; only an explicit dismissal should do that.
  if (hasDraft && dismissedDraft !== draftKey && openDraft !== draftKey) {
    setOpenDraft(draftKey);
  }

  // Filters — all multi-select; status defaults to open
  const [statusFilter, setStatusFilter] = useState<IssueStatus[]>(
    DEFAULT_STATUS_FILTER,
  );
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Status counts describe only work addressed to the accepted repository.
  const { statusCounts, unconfirmedStatusCounts } = useMemo(() => {
    const counts: Record<IssueStatus, number> = {
      open: 0,
      draft: 0,
      resolved: 0,
      closed: 0,
      deleted: 0,
    };
    const unconfirmedCounts: Record<IssueStatus, number> = {
      open: 0,
      draft: 0,
      resolved: 0,
      closed: 0,
      deleted: 0,
    };
    if (issues && repo) {
      for (const issue of issues) {
        if (hasAcceptedRepositoryReference(issue.repoCoords, repo)) {
          counts[issue.status]++;
        } else {
          unconfirmedCounts[issue.status]++;
        }
      }
    }
    return {
      statusCounts: counts,
      unconfirmedStatusCounts: unconfirmedCounts,
    };
  }, [issues, repo]);

  // Collect all unique labels and authors from resolved issues.
  const { allLabels, allAuthors } = useMemo(() => {
    if (!issues) return { allLabels: [], allAuthors: [] };
    const labels = new Set<string>();
    const authors = new Set<string>();
    for (const issue of issues) {
      issue.labels.forEach((l) => labels.add(l));
      authors.add(issue.pubkey);
    }
    return {
      allLabels: Array.from(labels).sort(),
      allAuthors: Array.from(authors),
    };
  }, [issues]);

  const labelOptions: MultiSelectOption[] = allLabels.map((l) => ({
    value: l,
    label: l,
  }));

  // Apply filters
  const { filteredIssues, idMatchesOutsideFilters } = useMemo(() => {
    if (!issues) {
      return { filteredIssues: undefined, idMatchesOutsideFilters: 0 };
    }
    let outsideFilterCount = 0;
    const filtered = issues.filter((issue) => {
      const matchesFacets =
        (statusFilter.length === 0 || statusFilter.includes(issue.status)) &&
        !(
          labelFilter.length > 0 &&
          !labelFilter.some((label) => issue.labels.includes(label))
        ) &&
        (!authorFilter || issue.pubkey === authorFilter);
      const matchesId = eventIdMatchesSearch(issue.id, searchQuery);

      if (matchesId) {
        if (!matchesFacets) outsideFilterCount++;
        return true;
      }
      if (!matchesFacets) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (
          !issue.currentSubject.toLowerCase().includes(q) &&
          !issue.originalSubject.toLowerCase().includes(q) &&
          !issue.content.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
    return {
      filteredIssues: filtered,
      idMatchesOutsideFilters: outsideFilterCount,
    };
  }, [issues, statusFilter, labelFilter, authorFilter, searchQuery]);

  const { visibleAcceptedIssues, visibleUnconfirmedIssues } = useMemo(() => {
    if (!filteredIssues || !repo) {
      return { visibleAcceptedIssues: [], visibleUnconfirmedIssues: [] };
    }
    const accepted: ResolvedIssueLite[] = [];
    const unconfirmed: ResolvedIssueLite[] = [];
    for (const issue of filteredIssues) {
      if (hasAcceptedRepositoryReference(issue.repoCoords, repo)) {
        accepted.push(issue);
      } else {
        unconfirmed.push(issue);
      }
    }
    return {
      visibleAcceptedIssues: accepted,
      visibleUnconfirmedIssues: unconfirmed,
    };
  }, [filteredIssues, repo]);

  // "Active" means filters differ from the default state
  const hasActiveFilters =
    statusFilter.length !== DEFAULT_STATUS_FILTER.length ||
    !DEFAULT_STATUS_FILTER.every((s) => statusFilter.includes(s)) ||
    labelFilter.length > 0 ||
    !!authorFilter ||
    searchQuery.trim().length > 0;

  const clearFilters = () => {
    setStatusFilter(DEFAULT_STATUS_FILTER);
    setLabelFilter([]);
    setAuthorFilter(null);
    setSearchQuery("");
  };

  useSeoMeta({
    title: repo ? `Issues - ${repo.name} - ngit` : "Repository Issues - ngit",
    description: repo?.description ?? "Browse issues for this repository",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name ?? repoId,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6">
      {/* New Issue Dialog */}
      {repo && !isReadOnlyRepository && (
        <Dialog
          open={openDraft === draftKey}
          onOpenChange={(open) =>
            open ? setOpenDraft(draftKey) : closeIssue()
          }
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CircleDot className="h-4 w-4 text-pink-500" />
                New Issue
              </DialogTitle>
              <DialogDescription>
                Submit a bug report, feature request, or question for{" "}
                <span className="font-medium text-foreground">{repo.name}</span>
                .
              </DialogDescription>
            </DialogHeader>
            <CreateIssueForm
              key={draftKey}
              draftScope={draftScope}
              repoCoords={repo.confirmedMemberCoordinates}
              onSuccess={closeIssue}
              onCancel={closeIssue}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Search + filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search issues or event ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-background/60"
          />
        </div>

        <div className="flex gap-2 flex-wrap items-center ml-auto">
          {allLabels.length > 0 && (
            <MultiSelect
              options={labelOptions}
              selected={labelFilter}
              onChange={setLabelFilter}
              placeholder="Label"
              className="w-[150px]"
            />
          )}

          {allAuthors.length > 1 && (
            <Select
              value={authorFilter ?? "__all__"}
              onValueChange={(v) => setAuthorFilter(v === "__all__" ? null : v)}
            >
              <SelectTrigger className="w-[160px] h-9 text-sm">
                <SelectValue placeholder="Author" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Authors</SelectItem>
                {allAuthors.map((pk) => (
                  <SelectItem key={pk} value={pk}>
                    <AuthorSelectLabel pubkey={pk} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-sm text-muted-foreground hover:text-foreground"
              onClick={clearFilters}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Reset
            </Button>
          )}
        </div>
      </div>

      {idMatchesOutsideFilters > 0 && (
        <p
          role="status"
          className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          Showing {idMatchesOutsideFilters} issue
          {idMatchesOutsideFilters === 1 ? "" : "s"} outside your current
          filters.
        </p>
      )}

      {/* Bordered container with status tabs header + list */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header bar: status tabs + new issue button */}
        <div className="flex items-center bg-muted/40 px-3 py-1.5 overflow-x-auto">
          <StatusTabs
            counts={statusCounts}
            secondaryCounts={unconfirmedStatusCounts}
            selected={statusFilter}
            onChange={(v) => setStatusFilter(v as IssueStatus[])}
            className="border-b-0 pb-0 mb-0 flex-1"
          />
          {account && repo && !isReadOnlyRepository && (
            <Button
              size="sm"
              className="gap-1.5 bg-pink-600 hover:bg-pink-700 text-white h-8 text-xs shrink-0 ml-2"
              onClick={() => setOpenDraft(draftKey)}
            >
              <Plus className="h-3.5 w-3.5" />
              New Issue
            </Button>
          )}
        </div>

        {/* Issue list */}
        {!filteredIssues ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <IssueSkeleton key={i} />
            ))}
          </ul>
        ) : visibleAcceptedIssues.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">
              {hasActiveFilters
                ? "No issues match your filters"
                : "No issues yet"}
            </p>
            <p className="text-muted-foreground/60 text-sm mt-1">
              {hasActiveFilters
                ? "Try adjusting your filters"
                : "Issues sent to this repository will appear here"}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visibleAcceptedIssues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                repoPath={basePath}
                repoRelays={repo?.relays ?? []}
                repo={repo}
              />
            ))}
          </ul>
        )}
      </div>

      {repo && visibleUnconfirmedIssues.length > 0 && (
        <section className="mt-6">
          <RepoItemAttributionWarning
            repo={repo}
            repoCoords={visibleUnconfirmedIssues.flatMap(
              (issue) => issue.repoCoords,
            )}
            itemLabel="issue"
            pageSuffix="/issues"
            count={visibleUnconfirmedIssues.length}
            className="rounded-b-none shadow-none"
          />
          <div className="overflow-hidden rounded-b-lg border border-t-0 border-amber-500/40">
            <ul className="divide-y divide-border">
              {visibleUnconfirmedIssues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  repoPath={basePath}
                  repoRelays={repo.relays}
                  repo={repo}
                />
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

function AuthorSelectLabel({ pubkey }: { pubkey: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <UserAvatar pubkey={pubkey} size="sm" />
      <UserName pubkey={pubkey} className="text-sm" />
    </div>
  );
}

function IssueRow({
  issue,
  repoPath,
  repoRelays,
  repo,
}: {
  issue: ResolvedIssueLite;
  repoPath: string;
  repoRelays: string[];
  repo: ResolvedRepo | undefined;
}) {
  const lastActive = formatDistanceToNow(
    new Date(issue.lastActivityAt * 1000),
    { addSuffix: true },
  );

  const nevent = eventIdToNevent(issue.id, repoRelays.slice(0, 1));
  const needsAttributionCheck =
    repo !== undefined &&
    !hasAcceptedRepositoryReference(issue.repoCoords, repo);

  return (
    <li className="group flex items-stretch hover:bg-accent/40 transition-colors">
      <Link
        to={`${repoPath}/issues/${nevent}`}
        className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-sm"
      >
        {/* Status icon */}
        <StatusIcon status={issue.status} className="mt-0.5" />

        {/* Title + metadata */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground group-hover:text-pink-600 dark:group-hover:text-pink-400 transition-colors line-clamp-1">
              {issue.currentSubject}
            </span>
            {issue.labels.map((label) => (
              <LabelBadge
                key={label}
                label={label}
                className="text-[10px] py-0 px-1.5 h-[18px]"
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <code className="font-mono text-[10px] text-muted-foreground/80">
              #{issue.id.slice(0, 8)}
            </code>
            <span className="text-muted-foreground/40">&middot;</span>
            <span>active {lastActive}</span>
            <span className="text-muted-foreground/40">&middot;</span>
            <UserAvatar
              pubkey={issue.pubkey}
              size="sm"
              className="h-4 w-4 text-[8px]"
            />
            <UserName
              pubkey={issue.pubkey}
              className="text-xs font-normal text-muted-foreground"
            />
          </div>
        </div>

        {/* Comment, zap & participant counts — right-aligned */}
        <div className="flex items-center gap-3 self-center text-xs text-muted-foreground shrink-0">
          {issue.commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <MessageCircle className="h-3 w-3" />
              {issue.commentCount}
            </span>
          )}
          {issue.zapTotal > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-500">
              <Zap className="h-3 w-3" />
              {compactNumber(issue.zapTotal)}
            </span>
          )}
          {issue.participantCount > 1 && (
            <span className="inline-flex items-center gap-0.5">
              <Users className="h-3 w-3" />
              {issue.participantCount}
            </span>
          )}
        </div>
      </Link>
      {needsAttributionCheck && (
        <div className="flex shrink-0 items-center pr-2">
          <RepoItemAttributionIndicator
            repo={repo}
            repoCoords={issue.repoCoords}
            itemLabel="issue"
            pageSuffix={`/issues/${nevent}`}
          />
        </div>
      )}
    </li>
  );
}

function IssueSkeleton() {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <Skeleton className="h-5 w-5 rounded-full shrink-0 mt-0.5" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </li>
  );
}
