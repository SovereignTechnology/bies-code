import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { eventIdToNevent } from "@/lib/routeUtils";
import { compactNumber } from "@/lib/utils";
import { useSeoMeta } from "@unhead/react";
import { useProfile } from "@/hooks/useProfile";
import { formatDistanceToNow } from "date-fns";
import { useRepoContext } from "./RepoContext";
import { UserAvatar, UserName } from "@/components/UserAvatar";
import { StatusIcon } from "@/components/StatusIcon";
import { StatusTabs } from "@/components/StatusTabs";
import { LabelBadge } from "@/components/LabelBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import type { MultiSelectOption } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, MessageCircle, Users, X, Zap } from "lucide-react";
import {
  hasAcceptedRepositoryReference,
  type IssueStatus,
  type ResolvedPRLite,
  type ResolvedRepo,
  type PRItemType,
} from "@/lib/nip34";
import { useCIForPR } from "@/hooks/useCI";
import { CIStatusIcon } from "@/components/ci/CIStatusIcon";
import { ciStatusLabel } from "@/lib/ci";
import {
  RepoItemAttributionIndicator,
  RepoItemAttributionWarning,
} from "@/components/RepoItemAttributionWarning";

const TYPE_OPTIONS: MultiSelectOption[] = [
  { value: "pr", label: "Pull Requests" },
  { value: "patch", label: "Patches" },
];

const DEFAULT_STATUS_FILTER: IssueStatus[] = ["open", "draft"];

export default function RepoPRsPage() {
  const { pubkey, repoId, resolved, prs, basePath } = useRepoContext();
  const repo = resolved?.repo;
  const repoOwnerProfile = useProfile(pubkey);

  // Filters — all multi-select; status defaults to open+draft
  const [statusFilter, setStatusFilter] = useState<IssueStatus[]>(
    DEFAULT_STATUS_FILTER,
  );
  const [typeFilter, setTypeFilter] = useState<PRItemType[]>([]);
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
    if (prs && repo) {
      for (const pr of prs) {
        if (hasAcceptedRepositoryReference(pr.repoCoords, repo)) {
          counts[pr.status]++;
        } else {
          unconfirmedCounts[pr.status]++;
        }
      }
    }
    return {
      statusCounts: counts,
      unconfirmedStatusCounts: unconfirmedCounts,
    };
  }, [prs, repo]);

  // Collect all unique labels and authors from resolved PRs.
  const { allLabels, allAuthors } = useMemo(() => {
    if (!prs) return { allLabels: [], allAuthors: [] };
    const labels = new Set<string>();
    const authors = new Set<string>();
    for (const pr of prs) {
      pr.labels.forEach((l) => labels.add(l));
      authors.add(pr.pubkey);
    }
    return {
      allLabels: Array.from(labels).sort(),
      allAuthors: Array.from(authors),
    };
  }, [prs]);

  const labelOptions: MultiSelectOption[] = allLabels.map((l) => ({
    value: l,
    label: l,
  }));

  // Apply filters
  const filteredPRs = useMemo(() => {
    if (!prs) return undefined;
    return prs.filter((pr) => {
      if (statusFilter.length > 0 && !statusFilter.includes(pr.status))
        return false;
      if (typeFilter.length > 0 && !typeFilter.includes(pr.itemType))
        return false;
      if (
        labelFilter.length > 0 &&
        !labelFilter.some((l) => pr.labels.includes(l))
      )
        return false;
      if (authorFilter && pr.pubkey !== authorFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (
          !pr.currentSubject.toLowerCase().includes(q) &&
          !pr.originalSubject.toLowerCase().includes(q) &&
          !pr.content.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [prs, statusFilter, typeFilter, labelFilter, authorFilter, searchQuery]);

  const { visibleAcceptedItems, visibleUnconfirmedItems } = useMemo(() => {
    if (!filteredPRs || !repo) {
      return { visibleAcceptedItems: [], visibleUnconfirmedItems: [] };
    }
    const accepted: ResolvedPRLite[] = [];
    const unconfirmed: ResolvedPRLite[] = [];
    for (const pr of filteredPRs) {
      if (hasAcceptedRepositoryReference(pr.repoCoords, repo)) {
        accepted.push(pr);
      } else {
        unconfirmed.push(pr);
      }
    }
    return {
      visibleAcceptedItems: accepted,
      visibleUnconfirmedItems: unconfirmed,
    };
  }, [filteredPRs, repo]);

  // "Active" means filters differ from the default state
  const hasActiveFilters =
    statusFilter.length !== DEFAULT_STATUS_FILTER.length ||
    !DEFAULT_STATUS_FILTER.every((s) => statusFilter.includes(s)) ||
    typeFilter.length > 0 ||
    labelFilter.length > 0 ||
    !!authorFilter ||
    searchQuery.trim().length > 0;

  const clearFilters = () => {
    setStatusFilter(DEFAULT_STATUS_FILTER);
    setTypeFilter([]);
    setLabelFilter([]);
    setAuthorFilter(null);
    setSearchQuery("");
  };

  useSeoMeta({
    title: repo ? `PRs - ${repo.name} - BIES Code` : "Pull Requests - BIES Code",
    description:
      repo?.description ?? "Browse pull requests for this repository",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name ?? repoId,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  return (
    <div className="container max-w-screen-xl px-4 md:px-8 py-6">
      {/* Search + filters */}
      <div className="flex flex-col md:flex-row gap-3 mb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search PRs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-background/60"
          />
        </div>

        <div className="flex gap-2 flex-wrap items-center ml-auto">
          <MultiSelect
            options={TYPE_OPTIONS}
            selected={typeFilter}
            onChange={(v) => setTypeFilter(v as PRItemType[])}
            placeholder="Type"
            className="w-[140px]"
          />

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

      {/* Bordered container with status tabs header + list */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header bar: status tabs */}
        <div className="flex items-center bg-muted/40 px-3 py-1.5 overflow-x-auto">
          <StatusTabs
            counts={statusCounts}
            secondaryCounts={unconfirmedStatusCounts}
            selected={statusFilter}
            onChange={(v) => setStatusFilter(v as IssueStatus[])}
            variant="pr"
            className="border-b-0 pb-0 mb-0 flex-1"
          />
        </div>

        {/* PR list */}
        {!filteredPRs ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <PRSkeleton key={i} />
            ))}
          </ul>
        ) : visibleAcceptedItems.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-muted-foreground">
              {hasActiveFilters ? "No PRs match your filters" : "No PRs yet"}
            </p>
            <p className="text-muted-foreground/60 text-sm mt-1">
              {hasActiveFilters
                ? "Try adjusting your filters"
                : "PRs and patches sent to this repository will appear here"}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visibleAcceptedItems.map((pr) => (
              <PRRow
                key={pr.id}
                pr={pr}
                repoPath={basePath}
                repoRelays={repo?.relays ?? []}
                repo={repo}
              />
            ))}
          </ul>
        )}
      </div>

      {repo && visibleUnconfirmedItems.length > 0 && (
        <section className="mt-6">
          <RepoItemAttributionWarning
            repo={repo}
            repoCoords={visibleUnconfirmedItems.flatMap((pr) => pr.repoCoords)}
            itemLabel="pull request or patch"
            pageSuffix="/prs"
            count={visibleUnconfirmedItems.length}
            className="rounded-b-none shadow-none"
          />
          <div className="overflow-hidden rounded-b-lg border border-t-0 border-amber-500/40">
            <ul className="divide-y divide-border">
              {visibleUnconfirmedItems.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
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

function PRRow({
  pr,
  repoPath,
  repoRelays,
  repo,
}: {
  pr: ResolvedPRLite;
  repoPath: string;
  repoRelays: string[];
  repo: ResolvedRepo | undefined;
}) {
  const lastActive = formatDistanceToNow(new Date(pr.lastActivityAt * 1000), {
    addSuffix: true,
  });

  // CI check rollup for the most recent commit with CI activity. Store-read
  // only — kind:9842 results ride along with the #E comments loader and
  // kind:9841 running markers with the repo-level #a meta subscription.
  const ci = useCIForPR(pr.id);

  const nevent = eventIdToNevent(pr.id, repoRelays.slice(0, 1));
  const needsAttributionCheck =
    repo !== undefined && !hasAcceptedRepositoryReference(pr.repoCoords, repo);

  return (
    <li className="group flex items-stretch hover:bg-accent/40 transition-colors">
      <Link
        to={`${repoPath}/prs/${nevent}`}
        className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-sm"
      >
        {/* Status icon — variant reflects PR vs patch */}
        <StatusIcon
          status={pr.status}
          variant={pr.itemType === "patch" ? "patch" : "pr"}
          className="mt-0.5"
        />

        {/* Title + metadata */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
              {pr.currentSubject}
            </span>
            {ci?.status && (
              <span
                title={`Checks: ${ciStatusLabel(ci.status).toLowerCase()}`}
                className="inline-flex shrink-0"
              >
                <CIStatusIcon status={ci.status} className="h-3.5 w-3.5" />
              </span>
            )}
            {pr.labels.map((label) => (
              <LabelBadge
                key={label}
                label={label}
                className="text-[10px] py-0 px-1.5 h-[18px]"
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <code className="font-mono text-[10px] text-muted-foreground/80">
              #{pr.id.slice(0, 8)}
            </code>
            <span className="text-muted-foreground/40">&middot;</span>
            <span>active {lastActive}</span>
            <span className="text-muted-foreground/40">&middot;</span>
            <UserAvatar
              pubkey={pr.pubkey}
              size="sm"
              className="h-4 w-4 text-[8px]"
            />
            <UserName
              pubkey={pr.pubkey}
              className="text-xs font-normal text-muted-foreground"
            />
          </div>
        </div>

        {/* Comment, zap & participant counts — right-aligned */}
        <div className="flex items-center gap-3 self-center text-xs text-muted-foreground shrink-0">
          {pr.commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <MessageCircle className="h-3 w-3" />
              {pr.commentCount}
            </span>
          )}
          {pr.zapTotal > 0 && (
            <span className="inline-flex items-center gap-0.5 text-amber-500">
              <Zap className="h-3 w-3" />
              {compactNumber(pr.zapTotal)}
            </span>
          )}
          {pr.participantCount > 1 && (
            <span className="inline-flex items-center gap-0.5">
              <Users className="h-3 w-3" />
              {pr.participantCount}
            </span>
          )}
        </div>
      </Link>
      {needsAttributionCheck && (
        <div className="flex shrink-0 items-center pr-2">
          <RepoItemAttributionIndicator
            repo={repo}
            repoCoords={pr.repoCoords}
            itemLabel={pr.itemType === "patch" ? "patch" : "pull request"}
            pageSuffix={`/prs/${nevent}`}
          />
        </div>
      )}
    </li>
  );
}

function PRSkeleton() {
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
