import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight } from "lucide-react";

import { UserLink } from "@/components/UserAvatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  computeMaintainerLeadership,
  getRepoRelays,
  parseRepoCoordinate,
  resolveChain,
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
  pageSuffix: string;
}

const LABELS: Record<RepoItemLabel, { singular: string; plural: string }> = {
  issue: { singular: "issue", plural: "issues" },
  "pull request": { singular: "PR", plural: "PRs" },
  patch: { singular: "patch", plural: "patches" },
  "pull request or patch": {
    singular: "PR or patch",
    plural: "PRs or patches",
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

/**
 * If every referenced invitee belongs to one reciprocally accepted alternate
 * repository, use that repository's unique lead as its canonical link.
 */
function repositoryLinkMaintainers(
  referencedMaintainers: string[],
  repo: ResolvedRepo,
): string[] {
  if (referencedMaintainers.length <= 1) return referencedMaintainers;

  const alternateRepo = resolveChain(
    repo.announcements,
    referencedMaintainers[0],
    repo.dTag,
  );
  if (
    !alternateRepo ||
    !referencedMaintainers.every((pubkey) =>
      alternateRepo.confirmedMaintainers.includes(pubkey),
    )
  ) {
    return referencedMaintainers;
  }

  const lead = computeMaintainerLeadership(
    alternateRepo.confirmedMaintainers,
    alternateRepo.maintainerEdges,
  ).leadMaintainer;
  return lead ? [lead] : referencedMaintainers;
}

function relayHintsForMaintainer(repo: ResolvedRepo, pubkey: string): string[] {
  const announcement = repo.announcements.find(
    (event) => event.pubkey === pubkey,
  );
  const maintainerRelays = announcement ? getRepoRelays(announcement) : [];
  return maintainerRelays.length > 0 ? maintainerRelays : repo.relays;
}

function RepositoryReferenceLinks({
  repo,
  maintainers,
  pageSuffix,
}: {
  repo: ResolvedRepo;
  maintainers: string[];
  pageSuffix: string;
}) {
  if (maintainers.length === 0) return null;

  return (
    <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
      {maintainers.map((pubkey) => (
        <Button
          key={pubkey}
          asChild
          variant="outline"
          size="sm"
          className="h-auto border-amber-500/40 bg-background/80 px-2 py-1 text-xs"
        >
          <Link
            to={`${repoToPath(
              pubkey,
              repo.dTag,
              relayHintsForMaintainer(repo, pubkey),
            )}${pageSuffix}`}
          >
            <UserLink
              pubkey={pubkey}
              avatarSize="xs"
              noLink
              className="mr-1"
              nameClassName="text-xs"
            />
            <span className="font-mono">/{repo.dTag}</span>
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      ))}
    </span>
  );
}

function AttributionMessage({
  repo,
  repoCoords,
  itemLabel,
  pageSuffix,
  count,
}: RepoItemAttributionProps & { count?: number }) {
  const referencedMaintainers = useMemo(
    () => referencedInvitedMaintainers(repoCoords, repo),
    [repoCoords, repo],
  );
  const linkMaintainers = useMemo(
    () => repositoryLinkMaintainers(referencedMaintainers, repo),
    [referencedMaintainers, repo],
  );
  const labels = LABELS[itemLabel];
  const isListWarning = count !== undefined;
  const plural = isListWarning && count > 1;
  const subject = isListWarning
    ? `${count} visible ${plural ? labels.plural : labels.singular}`
    : `This ${labels.singular}`;

  return (
    <p className="leading-relaxed">
      {subject} {plural ? "were" : "was"} not sent to{" "}
      <UserLink
        pubkey={repo.selectedMaintainer}
        avatarSize="xs"
        className="inline-flex text-foreground"
        nameClassName="text-sm"
      />
      {referencedMaintainers.length > 0 ? (
        <>
          , but to {referencedMaintainers.length}{" "}
          {referencedMaintainers.length === 1 ? "user" : "users"} whom they
          invited as{" "}
          {referencedMaintainers.length === 1 ? "a maintainer" : "maintainers"}{" "}
          and who {referencedMaintainers.length === 1 ? "hasn’t" : "haven’t"}{" "}
          responded. Consider switching:
          <RepositoryReferenceLinks
            repo={repo}
            maintainers={linkMaintainers}
            pageSuffix={pageSuffix}
          />
          .
        </>
      ) : (
        <> but only to unaccepted repository coordinates.</>
      )}
    </p>
  );
}

export function RepoItemAttributionWarning({
  repo,
  repoCoords,
  itemLabel,
  pageSuffix,
  count,
  title = "Check repository attribution",
  className,
}: RepoItemAttributionProps & {
  count?: number;
  title?: string;
  className?: string;
}) {
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
      <AlertDescription className="text-muted-foreground">
        <AttributionMessage
          repo={repo}
          repoCoords={repoCoords}
          itemLabel={itemLabel}
          pageSuffix={pageSuffix}
          count={count}
        />
      </AlertDescription>
    </Alert>
  );
}

export function RepoItemAttributionIndicator({
  repo,
  repoCoords,
  itemLabel,
  pageSuffix,
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
          aria-label={`${labels.singular} needs an attribution check`}
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
          Check repository attribution
        </div>
        <div className="text-sm text-muted-foreground">
          <AttributionMessage
            repo={repo}
            repoCoords={repoCoords}
            itemLabel={itemLabel}
            pageSuffix={pageSuffix}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
