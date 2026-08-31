import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSeoMeta } from "@unhead/react";
import {
  AlertCircle,
  ArrowLeftRight,
  Check,
  ChevronDown,
  CircleCheck,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Info,
  Loader2,
  Tag,
} from "lucide-react";
import { useRepoContext } from "./RepoContext";
import { useProfile } from "@/hooks/useProfile";
import { useGitPool } from "@/hooks/useGitPool";
import type { GitRef } from "@/hooks/useGitExplorer";
import type {
  Commit,
  GitGraspPool,
  InfoRefsUploadPackResponse,
} from "@/lib/git-grasp-pool";
import { isNonHttpUrl } from "@/lib/git-grasp-pool";
import { CommitDiffView } from "@/components/CommitDiffView";
import {
  CommitList,
  CommitListEmpty,
  CommitListLoading,
} from "@/components/CommitList";
import { IncompatibleProtocolError } from "@/components/IncompatibleProtocolError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const MAX_DISPLAY_COMMITS = 200;
const MAX_GRAPH_COMMITS = 5000;

interface ResolvedComparisonRef {
  requested: string;
  commitId: string;
  fullName?: string;
  kind: "head" | "branch" | "tag" | "commit";
}

type ComparisonState =
  | { kind: "idle" | "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      mergeBaseId: string;
      headCommit: Commit;
      commits: Commit[];
      ahead: number;
      behind: number;
    };

function parseRefs(
  info: InfoRefsUploadPackResponse | null,
  defaultBranch: string | null,
): GitRef[] {
  if (!info) return [];

  return Object.entries(info.refs)
    .filter(([name]) => !name.endsWith("^{}"))
    .flatMap(([fullName, rawHash]): GitRef[] => {
      const isBranch = fullName.startsWith("refs/heads/");
      const isTag = fullName.startsWith("refs/tags/");
      if (!isBranch && !isTag) return [];

      const name = fullName.replace(/^refs\/(?:heads|tags)\//, "");
      const peeledHash = isTag ? info.refs[`${fullName}^{}`] : undefined;
      return [
        {
          name,
          hash: peeledHash ?? rawHash,
          isBranch,
          isTag,
          isDefault: isBranch && name === defaultBranch,
          rawTagOid: peeledHash && peeledHash !== rawHash ? rawHash : undefined,
        },
      ];
    })
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      if (left.isBranch !== right.isBranch) return left.isBranch ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function resolveComparisonRef(
  requested: string | undefined,
  info: InfoRefsUploadPackResponse | null,
  authoritativeHead: string | undefined,
): ResolvedComparisonRef | null {
  if (!requested || !info) return null;

  if (requested === "HEAD") {
    const headRef = info.symrefs.HEAD;
    const commitId =
      (headRef ? info.refs[headRef] : undefined) ?? authoritativeHead;
    return commitId
      ? { requested, commitId, fullName: headRef, kind: "head" }
      : null;
  }

  if (/^[0-9a-f]{40}$/i.test(requested)) {
    return { requested, commitId: requested, kind: "commit" };
  }

  const candidates = requested.startsWith("refs/")
    ? [requested]
    : [`refs/heads/${requested}`, `refs/tags/${requested}`];

  for (const fullName of candidates) {
    const rawHash = info.refs[fullName];
    if (!rawHash) continue;
    const isTag = fullName.startsWith("refs/tags/");
    const isBranch = fullName.startsWith("refs/heads/");
    if (!isTag && !isBranch) continue;
    return {
      requested,
      commitId: isTag ? (info.refs[`${fullName}^{}`] ?? rawHash) : rawHash,
      fullName,
      kind: isTag ? "tag" : "branch",
    };
  }

  return null;
}

function comparisonPath(basePath: string, base: string, head: string): string {
  return `${basePath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
}

function comparisonSummary(
  base: string,
  head: string,
  ahead: number,
  behind: number,
): string {
  if (ahead === 0 && behind === 0) {
    return "These refs point to the same commit.";
  }
  if (behind === 0) {
    return `${head} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${base}.`;
  }
  if (ahead === 0) {
    return `${head} is ${behind} commit${behind === 1 ? "" : "s"} behind ${base}.`;
  }
  return `${head} is ${ahead} ahead and ${behind} behind ${base}.`;
}

function pickerValue(ref: GitRef, refs: GitRef[]): string {
  const isAmbiguous = refs.some(
    (candidate) =>
      candidate.name === ref.name && candidate.isBranch !== ref.isBranch,
  );
  if (ref.name !== "HEAD" && !isAmbiguous) return ref.name;
  return `${ref.isBranch ? "refs/heads" : "refs/tags"}/${ref.name}`;
}

function isPickerValueSelected(
  ref: GitRef,
  refs: GitRef[],
  selectedValue: string,
): boolean {
  if (pickerValue(ref, refs) === selectedValue) return true;
  // An unqualified ambiguous ref resolves to a branch before a tag.
  return selectedValue !== "HEAD" && ref.isBranch && ref.name === selectedValue;
}

function CompareRefPicker({
  label,
  value,
  refs,
  defaultBranch,
  loading,
  onChange,
}: {
  label: "base" | "compare";
  value: string;
  refs: GitRef[];
  defaultBranch: string | null;
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const branches = refs.filter((ref) => ref.isBranch);
  const tags = refs.filter((ref) => ref.isTag);
  const selected = refs.find((ref) => isPickerValueSelected(ref, refs, value));
  const displayValue = selected?.name ?? value;
  const SelectedIcon =
    value === "HEAD" || selected?.isBranch
      ? GitBranch
      : selected?.isTag
        ? Tag
        : GitCommitHorizontal;

  const select = (nextValue: string) => {
    setOpen(false);
    if (nextValue !== value) onChange(nextValue);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-10 w-full justify-between gap-3 bg-background px-3 font-normal sm:w-64"
          disabled={loading}
          aria-label={`Choose ${label} ref`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">
              {label}:
            </span>
            <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono text-sm">{displayValue}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <Command>
          <CommandInput placeholder="Find a branch or tag…" />
          <CommandList>
            <CommandEmpty>No matching refs found.</CommandEmpty>
            <CommandGroup heading="Default">
              <CommandItem value="HEAD default" onSelect={() => select("HEAD")}>
                <GitBranch className="mr-2 h-4 w-4" />
                <span className="font-mono">HEAD</span>
                {defaultBranch && (
                  <span className="ml-2 truncate text-xs text-muted-foreground">
                    {defaultBranch}
                  </span>
                )}
                <Check
                  className={cn(
                    "ml-auto h-4 w-4",
                    value === "HEAD" ? "opacity-100" : "opacity-0",
                  )}
                />
              </CommandItem>
            </CommandGroup>
            {branches.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Branches">
                  {branches.map((ref) => (
                    <CompareRefItem
                      key={`branch:${ref.name}`}
                      refItem={ref}
                      refs={refs}
                      selectedValue={value}
                      onSelect={select}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
            {tags.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Tags">
                  {tags.map((ref) => (
                    <CompareRefItem
                      key={`tag:${ref.name}`}
                      refItem={ref}
                      refs={refs}
                      selectedValue={value}
                      onSelect={select}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CompareRefItem({
  refItem,
  refs,
  selectedValue,
  onSelect,
}: {
  refItem: GitRef;
  refs: GitRef[];
  selectedValue: string;
  onSelect: (value: string) => void;
}) {
  const value = pickerValue(refItem, refs);
  const Icon = refItem.isBranch ? GitBranch : Tag;
  return (
    <CommandItem
      value={`${refItem.isBranch ? "branch" : "tag"} ${refItem.name}`}
      onSelect={() => onSelect(value)}
    >
      <Icon className="mr-2 h-4 w-4" />
      <span className="truncate font-mono">{refItem.name}</span>
      {refItem.isDefault && (
        <Badge variant="secondary" className="ml-2 px-1.5 text-[10px]">
          default
        </Badge>
      )}
      <Check
        className={cn(
          "ml-auto h-4 w-4",
          isPickerValueSelected(refItem, refs, selectedValue)
            ? "opacity-100"
            : "opacity-0",
        )}
      />
    </CommandItem>
  );
}

function ComparisonLoading() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Loader2 className="h-5 w-5 text-pink-500 motion-safe:animate-spin" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-36" />
          </div>
        </CardContent>
      </Card>
      <CommitListLoading count={5} />
    </div>
  );
}

function useComparison(
  pool: GitGraspPool | null,
  base: ResolvedComparisonRef | null,
  head: ResolvedComparisonRef | null,
): ComparisonState {
  const [state, setState] = useState<ComparisonState>({ kind: "idle" });
  const baseCommitId = base?.commitId;
  const headCommitId = head?.commitId;
  const baseRequested = base?.requested;
  const headRequested = head?.requested;
  const baseFullName = base?.fullName;
  const headFullName = head?.fullName;
  const baseKind = base?.kind;
  const headKind = head?.kind;

  useEffect(() => {
    if (!pool || !baseCommitId || !headCommitId) {
      setState({ kind: "idle" });
      return;
    }

    const abort = new AbortController();
    setState({ kind: "loading" });

    async function load() {
      if (
        !pool ||
        !baseCommitId ||
        !headCommitId ||
        !baseRequested ||
        !headRequested
      )
        return;

      // HEAD is verified eagerly by the pool. Other refs are resolved lazily
      // so a Git-server descendant can supersede a stale signed state ref.
      await Promise.all([
        baseFullName && (baseKind === "branch" || baseKind === "tag")
          ? pool.resolveRef(baseFullName)
          : Promise.resolve(null),
        headFullName && (headKind === "branch" || headKind === "tag")
          ? pool.resolveRef(headFullName)
          : Promise.resolve(null),
      ]);
      if (abort.signal.aborted) return;

      const refreshedInfo = pool.getEffectiveInfoRefs();
      const effectiveBase = resolveComparisonRef(
        baseRequested,
        refreshedInfo,
        baseKind === "head" ? baseCommitId : undefined,
      );
      const effectiveHead = resolveComparisonRef(
        headRequested,
        refreshedInfo,
        headKind === "head" ? headCommitId : undefined,
      );
      if (!effectiveBase || !effectiveHead) {
        setState({
          kind: "error",
          message: "One of the selected refs is no longer available.",
        });
        return;
      }

      const comparison = await pool.compareCommits(
        effectiveBase.commitId,
        effectiveHead.commitId,
        abort.signal,
        undefined,
        MAX_GRAPH_COMMITS,
      );
      if (abort.signal.aborted) return;
      if (!comparison) {
        setState({
          kind: "error",
          message: `No common ancestor was found within ${MAX_GRAPH_COMMITS.toLocaleString()} commits.`,
        });
        return;
      }

      setState({
        kind: "ready",
        mergeBaseId: comparison.mergeBaseId,
        headCommit: comparison.headCommit,
        commits: comparison.headOnlyCommits.slice(0, MAX_DISPLAY_COMMITS),
        ahead: comparison.headOnlyCommits.length,
        behind: comparison.baseOnlyCommits.length,
      });
    }

    void load().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not compare these refs.",
      });
    });

    return () => abort.abort();
  }, [
    pool,
    baseCommitId,
    headCommitId,
    baseRequested,
    headRequested,
    baseFullName,
    headFullName,
    baseKind,
    headKind,
  ]);

  return state;
}

export default function RepoComparePage() {
  const {
    cloneUrls,
    repoState,
    resolved,
    pubkey,
    repoId,
    basePath,
    compareBaseRef,
    compareHeadRef,
  } = useRepoContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const repo = resolved?.repo;
  const repoOwnerProfile = useProfile(pubkey);
  const [fileCount, setFileCount] = useState<number>();
  const [diffLoading, setDiffLoading] = useState(true);
  const baseValue = compareBaseRef ?? "";
  const headValue = compareHeadRef ?? "";

  const { pool, poolState } = useGitPool(cloneUrls, {
    private: repo?.isPrivate,
    headRef: repoState?.headRef,
    knownHeadCommit: repoState?.headCommitId,
    stateRefs: repoState?.refs,
    stateCreatedAt: repoState ? repoState.event.created_at : undefined,
  });

  const sourceParam = searchParams.get("source");
  useEffect(() => {
    if (pool && sourceParam) pool.setViewSource(sourceParam);
  }, [pool, sourceParam]);

  const info = pool?.getEffectiveInfoRefs() ?? null;
  const refs = useMemo(
    () => parseRefs(info, poolState.defaultBranch),
    [info, poolState.defaultBranch],
  );
  const base = resolveComparisonRef(
    compareBaseRef,
    info,
    poolState.authoritativeHead?.commitId,
  );
  const head = resolveComparisonRef(
    compareHeadRef,
    info,
    poolState.authoritativeHead?.commitId,
  );
  const comparison = useComparison(pool, base, head);

  useEffect(() => {
    setFileCount(undefined);
    setDiffLoading(true);
  }, [base?.commitId, head?.commitId]);

  useSeoMeta({
    title: repo
      ? `${compareBaseRef ?? "Base"}...${compareHeadRef ?? "Head"} - ${repo.name} - ngit`
      : "Compare changes - ngit",
    description: repo
      ? `Compare Git refs in ${repo.name}`
      : "Compare repository changes",
    ogImage: repoOwnerProfile?.picture ?? "/og-image.png",
    ogImageAlt: repo?.name ?? repoId,
    twitterCard: repoOwnerProfile?.picture ? "summary" : "summary_large_image",
  });

  const navigateToComparison = useCallback(
    (nextBase: string, nextHead: string) => {
      const query = searchParams.toString();
      navigate(
        `${comparisonPath(basePath, nextBase, nextHead)}${query ? `?${query}` : ""}`,
      );
    },
    [basePath, navigate, searchParams],
  );

  if (cloneUrls.length === 0) {
    return (
      <div className="container max-w-screen-xl px-4 py-6 md:px-8">
        <Card className="border-dashed">
          <CardContent className="px-8 py-12 text-center">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-muted-foreground">
              This repository has no clone URLs configured.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (cloneUrls.every(isNonHttpUrl)) {
    return (
      <div className="container max-w-screen-xl px-4 py-6 md:px-8">
        <IncompatibleProtocolError
          cloneUrls={cloneUrls}
          context="comparison"
          pubkey={pubkey}
          repoId={repoId}
        />
      </div>
    );
  }

  const refsLoading = !info && !poolState.error;
  const hasMalformedComparison = !baseValue || !headValue;
  const unavailableMessage =
    !refsLoading && !info
      ? (poolState.error ?? "Could not reach any configured Git source.")
      : undefined;
  const missingRef =
    !refsLoading && info
      ? !base
        ? baseValue
        : !head
          ? headValue
          : undefined
      : undefined;
  const showDiffLoadingNotice =
    !hasMalformedComparison &&
    !unavailableMessage &&
    !missingRef &&
    comparison.kind !== "error" &&
    diffLoading;

  return (
    <main className="container max-w-screen-xl space-y-5 px-4 py-6 md:px-8">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500/15 to-violet-500/15 text-pink-600 dark:text-pink-400">
            <GitCompareArrows className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Comparing changes
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose two refs to inspect their commits and file changes.
            </p>
          </div>
        </div>
        {showDiffLoadingNotice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Diff generation runs in your browser. If you expect a large diff,
              it may take a while.
            </p>
          </div>
        )}
      </div>

      <Card className="overflow-hidden border-border/60 bg-gradient-to-br from-muted/40 via-background to-pink-500/[0.04]">
        <CardContent className="p-4 sm:p-5">
          {hasMalformedComparison ? (
            <div className="flex items-start gap-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Choose both refs to compare.</p>
                <p className="mt-1 text-muted-foreground">
                  Use a URL in the form <code>/compare/base...head</code>.
                </p>
              </div>
            </div>
          ) : refsLoading ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Skeleton className="h-10 w-full sm:w-64" />
              <Skeleton className="mx-auto h-9 w-9 rounded-md sm:mx-0" />
              <Skeleton className="h-10 w-full sm:w-64" />
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <CompareRefPicker
                label="base"
                value={baseValue}
                refs={refs}
                defaultBranch={poolState.defaultBranch}
                loading={refsLoading}
                onChange={(nextBase) =>
                  navigateToComparison(nextBase, headValue)
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mx-auto shrink-0 text-muted-foreground sm:mx-0"
                onClick={() => navigateToComparison(headValue, baseValue)}
                aria-label="Swap base and compare refs"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </Button>
              <CompareRefPicker
                label="compare"
                value={headValue}
                refs={refs}
                defaultBranch={poolState.defaultBranch}
                loading={refsLoading}
                onChange={(nextHead) =>
                  navigateToComparison(baseValue, nextHead)
                }
              />
            </div>
          )}
        </CardContent>
      </Card>

      {unavailableMessage && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">
                Git sources unavailable
              </p>
              <p className="mt-1 text-muted-foreground">{unavailableMessage}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {missingRef && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Ref not found</p>
              <p className="mt-1 text-muted-foreground">
                <code className="font-mono text-foreground">{missingRef}</code>{" "}
                is not available from the configured Git sources.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!hasMalformedComparison &&
        !unavailableMessage &&
        !missingRef &&
        comparison.kind === "loading" && <ComparisonLoading />}

      {!hasMalformedComparison &&
        !unavailableMessage &&
        !missingRef &&
        comparison.kind === "error" && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-start gap-3 p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium text-destructive">
                  Could not compare these refs
                </p>
                <p className="mt-1 text-muted-foreground">
                  {comparison.message}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

      {!hasMalformedComparison &&
        !unavailableMessage &&
        !missingRef &&
        comparison.kind === "ready" &&
        base &&
        head &&
        pool && (
          <>
            <Card className="overflow-hidden border-emerald-500/30">
              <CardContent className="flex flex-col gap-4 p-4 text-sm sm:flex-row sm:items-center">
                <div className="flex min-w-0 items-start gap-3">
                  <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                  <div className="min-w-0">
                    <p className="font-medium">Comparison ready</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {comparisonSummary(
                        baseValue,
                        headValue,
                        comparison.ahead,
                        comparison.behind,
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">
                  <Badge variant="secondary">
                    {comparison.ahead} commit
                    {comparison.ahead === 1 ? "" : "s"}
                  </Badge>
                  <Badge variant="secondary">
                    {fileCount === undefined ? "…" : fileCount} file
                    {fileCount === 1 ? "" : "s"} changed
                  </Badge>
                  <Badge variant="outline" className="font-mono font-normal">
                    base {comparison.mergeBaseId.slice(0, 8)}
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <Tabs defaultValue="files" className="min-w-0">
              <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:min-w-80">
                <TabsTrigger value="files" className="gap-2">
                  <FileDiff className="h-4 w-4" />
                  Files changed
                  {fileCount !== undefined && (
                    <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">
                      {fileCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="commits" className="gap-2">
                  <GitCommitHorizontal className="h-4 w-4" />
                  Commits
                  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">
                    {comparison.ahead}
                  </span>
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="files"
                forceMount
                className="mt-4 min-w-0 data-[state=inactive]:hidden"
              >
                <CommitDiffView
                  tipCommitId={comparison.headCommit.hash}
                  baseCommitId={comparison.mergeBaseId}
                  pool={pool}
                  onFileCountChange={setFileCount}
                  onLoadingChange={setDiffLoading}
                />
              </TabsContent>
              <TabsContent value="commits" className="mt-4">
                {comparison.commits.length > 0 ? (
                  <>
                    {comparison.ahead > comparison.commits.length && (
                      <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground">
                        Showing the newest {comparison.commits.length} of{" "}
                        {comparison.ahead} commits in this comparison.
                      </div>
                    )}
                    <CommitList
                      commits={comparison.commits}
                      basePath={basePath}
                    />
                  </>
                ) : (
                  <CommitListEmpty message="No commits between these refs." />
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
    </main>
  );
}
