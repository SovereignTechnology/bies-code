import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, UsersRound } from "lucide-react";

import { UserLink } from "@/components/UserAvatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  getRepoRelays,
  parseRepoCoordinate,
  type ResolvedRepo,
} from "@/lib/nip34";
import { repoToPath } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";

type RepoItemLabel =
  | "issue"
  | "pull request"
  | "patch"
  | "pull request or patch";

interface RepoItemAttributionProps {
  repo: ResolvedRepo;
  repoCoords: Iterable<string>;
  itemLabel: RepoItemLabel;
}

const LABELS: Record<
  RepoItemLabel,
  { singular: string; plural: string; capitalized: string }
> = {
  issue: {
    singular: "issue",
    plural: "issues",
    capitalized: "Issue",
  },
  "pull request": {
    singular: "pull request",
    plural: "pull requests",
    capitalized: "Pull request",
  },
  patch: {
    singular: "patch",
    plural: "patches",
    capitalized: "Patch",
  },
  "pull request or patch": {
    singular: "pull request or patch",
    plural: "pull requests or patches",
    capitalized: "Pull request or patch",
  },
};

function referencedInvitedMaintainers(
  repoCoords: Iterable<string>,
  repo: ResolvedRepo,
): string[] {
  const invited = new Set(repo.requestedMaintainers);
  const referenced = new Set<string>();

  for (const coordinate of repoCoords) {
    const parsed = parseRepoCoordinate(coordinate);
    if (parsed?.identifier === repo.dTag && invited.has(parsed.pubkey)) {
      referenced.add(parsed.pubkey);
    }
  }

  return Array.from(referenced);
}

function relayHintsForMaintainer(repo: ResolvedRepo, pubkey: string): string[] {
  const announcement = repo.announcements.find(
    (event) => event.pubkey === pubkey,
  );
  const maintainerRelays = announcement ? getRepoRelays(announcement) : [];
  return maintainerRelays.length > 0 ? maintainerRelays : repo.relays;
}

function InlineMaintainers({ pubkeys }: { pubkeys: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 align-middle">
      {pubkeys.map((pubkey, index) => (
        <span key={pubkey} className="inline-flex items-center gap-1.5">
          {index > 0 && (
            <span className="text-muted-foreground">
              {index === pubkeys.length - 1 ? "and" : ","}
            </span>
          )}
          <UserLink
            pubkey={pubkey}
            avatarSize="xs"
            className="inline-flex text-foreground"
            nameClassName="text-sm"
          />
        </span>
      ))}
    </span>
  );
}

function AlternateRepositoryLinks({
  repo,
  maintainers,
  compact = false,
}: {
  repo: ResolvedRepo;
  maintainers: string[];
  compact?: boolean;
}) {
  if (maintainers.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", !compact && "pt-1")}>
      {maintainers.map((pubkey) => (
        <Button
          key={pubkey}
          asChild
          variant="outline"
          size="sm"
          className={cn(
            "h-auto border-amber-500/40 bg-background/80 px-2.5 py-1.5",
            compact && "text-xs",
          )}
        >
          <Link
            to={repoToPath(
              pubkey,
              repo.dTag,
              relayHintsForMaintainer(repo, pubkey),
            )}
          >
            <span>View</span>
            <UserLink
              pubkey={pubkey}
              avatarSize="xs"
              noLink
              className="mx-1"
              nameClassName="text-xs"
            />
            <span className="font-mono">/{repo.dTag}</span>
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      ))}
    </div>
  );
}

function AttributionMessage({
  repo,
  repoCoords,
  itemLabel,
  count,
  compact = false,
}: RepoItemAttributionProps & {
  count?: number;
  compact?: boolean;
}) {
  const referencedMaintainers = useMemo(
    () => referencedInvitedMaintainers(repoCoords, repo),
    [repoCoords, repo],
  );
  const labels = LABELS[itemLabel];
  const plural = count !== undefined && count > 1;
  const subject = plural ? `These ${labels.plural}` : `This ${labels.singular}`;

  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <p>
        {subject} {plural ? "do" : "does"} not list{" "}
        <UserLink
          pubkey={repo.selectedMaintainer}
          avatarSize="xs"
          className="inline-flex text-foreground"
          nameClassName="text-sm"
        />{" "}
        or another accepted maintainer for{" "}
        <span className="font-medium text-foreground">{repo.dTag}</span>.
      </p>

      {referencedMaintainers.length > 0 ? (
        <p>
          {plural ? "They list" : "It lists"}{" "}
          <InlineMaintainers pubkeys={referencedMaintainers} />, who{" "}
          {referencedMaintainers.length === 1 ? "is" : "are"} in{" "}
          <UserLink
            pubkey={repo.selectedMaintainer}
            avatarSize="xs"
            className="inline-flex text-foreground"
            nameClassName="text-sm"
          />
          ’s maintainer graph but{" "}
          {referencedMaintainers.length === 1 ? "hasn’t" : "haven’t"} accepted
          the invitation.
        </p>
      ) : (
        <p>
          {plural ? "They reference" : "It references"} only repository
          coordinates outside the accepted maintainer group.
        </p>
      )}

      {referencedMaintainers.length > 0 && (
        <>
          <p className={cn(compact && "text-xs")}>
            If you trust that attribution, view the repository through{" "}
            {referencedMaintainers.length === 1
              ? "that maintainer"
              : "one of those maintainers"}
            .
          </p>
          <AlternateRepositoryLinks
            repo={repo}
            maintainers={referencedMaintainers}
            compact={compact}
          />
        </>
      )}
    </div>
  );
}

export function RepoItemAttributionWarning({
  repo,
  repoCoords,
  itemLabel,
  count,
  className,
}: RepoItemAttributionProps & {
  count?: number;
  className?: string;
}) {
  const labels = LABELS[itemLabel];
  const title =
    count === undefined
      ? `${labels.capitalized} needs an attribution check`
      : `${count} ${count === 1 ? labels.singular : labels.plural} need an attribution check`;
  const selectedRepoPath = repoToPath(
    repo.selectedMaintainer,
    repo.dTag,
    relayHintsForMaintainer(repo, repo.selectedMaintainer),
  );

  return (
    <Alert
      className={cn(
        "border-amber-500/50 bg-gradient-to-r from-amber-500/10 via-background to-orange-500/10 text-foreground shadow-sm [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle className="text-amber-950 dark:text-amber-100">
        {title}
      </AlertTitle>
      <AlertDescription className="space-y-3 text-muted-foreground">
        <AttributionMessage
          repo={repo}
          repoCoords={repoCoords}
          itemLabel={itemLabel}
          count={count}
        />
        <div className="flex flex-col gap-3 border-t border-amber-500/20 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs">
            To accept, an invited maintainer must publish this repository and
            list an accepted maintainer. Otherwise, remove the invitation.
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 border-amber-500/50 bg-background/80"
          >
            <Link to={`${selectedRepoPath}/about`}>
              <UsersRound className="mr-2 h-4 w-4" />
              Review maintainers
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function RepoItemAttributionIndicator({
  repo,
  repoCoords,
  itemLabel,
}: RepoItemAttributionProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const pinnedOpen = useRef(false);
  const labels = LABELS[itemLabel];

  const cancelClose = () => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  };

  const scheduleClose = () => {
    if (pinnedOpen.current) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  useEffect(
    () => () => {
      if (closeTimer.current !== undefined) {
        clearTimeout(closeTimer.current);
      }
    },
    [],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) pinnedOpen.current = false;
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${labels.capitalized} needs an attribution check`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-500/15 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:text-amber-400 dark:hover:text-amber-300"
          onClick={() => {
            pinnedOpen.current = !pinnedOpen.current;
            setOpen(pinnedOpen.current);
          }}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          onFocus={() => {
            cancelClose();
            setOpen(true);
          }}
        >
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-[min(24rem,calc(100vw-2rem))] border-amber-500/40 bg-popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <div className="mb-2 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Attribution check
        </div>
        <div className="text-sm text-muted-foreground">
          <AttributionMessage
            repo={repo}
            repoCoords={repoCoords}
            itemLabel={itemLabel}
            compact
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
