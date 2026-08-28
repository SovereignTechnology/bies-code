import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { UserLink } from "@/components/UserAvatar";
import { RepoGroupBadge } from "@/components/RepoBadge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  getRepoRelays,
  groupRequestedMaintainers,
  parseRepoCoordinate,
  type RequestedRepositoryGroup,
  type ResolvedRepo,
} from "@/lib/nip34";
import { repoToPath } from "@/lib/routeUtils";
import { cn } from "@/lib/utils";

type RepoItemLabel =
  | "issue"
  | "pull request"
  | "patch"
  | "pull request or patch"
  | "workflow";

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
    singular: "PR",
    plural: "PRs",
  },
  workflow: { singular: "workflow", plural: "workflows" },
};

function referencedRequestedMaintainers(
  repoCoords: Iterable<string>,
  repo: ResolvedRepo,
): string[] {
  const invited = new Set(repo.invitedMaintainers);
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
  const announcement = repo.discoveredAnnouncements.find(
    (event) => event.pubkey === pubkey,
  );
  const maintainerRelays = announcement ? getRepoRelays(announcement) : [];
  return maintainerRelays.length > 0 ? maintainerRelays : repo.relays;
}

function repositoryPagePath(
  repo: ResolvedRepo,
  pubkey: string,
  pageSuffix: string,
): string {
  return `${repoToPath(
    pubkey,
    repo.dTag,
    relayHintsForMaintainer(repo, pubkey),
  )}${pageSuffix}`;
}

function AlternateRepositoryControls({
  repo,
  groups,
  pageSuffix,
}: {
  repo: ResolvedRepo;
  groups: RequestedRepositoryGroup[];
  pageSuffix: string;
}) {
  return (
    <span className="ml-1 align-middle">
      {groups.map((group, index) => (
        <Fragment
          key={`${[...group.members].sort().join(",")}:${
            group.leadMaintainer ?? ""
          }:${[...group.referencedMaintainers].sort().join(",")}`}
        >
          {index > 0 && (index === groups.length - 1 ? " and " : ", ")}
          <RepoGroupBadge
            maintainers={group.members.map((pubkey) => ({
              pubkey,
              to: repositoryPagePath(repo, pubkey, pageSuffix),
            }))}
            repoName={repo.dTag}
            leadMaintainer={group.leadMaintainer}
            initialMaintainer={group.referencedMaintainers[0]}
          />
        </Fragment>
      ))}
    </span>
  );
}

function UserReferenceList({ pubkeys }: { pubkeys: string[] }) {
  return (
    <span className="inline align-middle">
      {pubkeys.map((pubkey, index) => (
        <span key={pubkey}>
          {index > 0 && (index === pubkeys.length - 1 ? " and " : ", ")}
          <UserLink
            pubkey={pubkey}
            avatarSize="xs"
            variant="inline"
            nameClassName="text-xs"
          />
        </span>
      ))}
    </span>
  );
}

function CurrentRepositoryBadge({
  repo,
  pageSuffix,
}: {
  repo: ResolvedRepo;
  pageSuffix: string;
}) {
  const leadMaintainer = repo.leadResolution.leadMaintainer;

  return (
    <RepoGroupBadge
      maintainers={repo.confirmedMaintainers.map((pubkey) => ({
        pubkey,
        to: repositoryPagePath(repo, pubkey, pageSuffix),
      }))}
      repoName={repo.dTag}
      leadMaintainer={leadMaintainer}
      initialMaintainer={repo.selectedMaintainer}
      className="mx-1 align-middle"
    />
  );
}

function useAlternateRepositoryGroups({
  repo,
  repoCoords,
}: Pick<RepoItemAttributionProps, "repo" | "repoCoords">) {
  const referencedMaintainers = useMemo(
    () => referencedRequestedMaintainers(repoCoords, repo),
    [repoCoords, repo],
  );
  return useMemo(
    () => groupRequestedMaintainers(repo, referencedMaintainers),
    [referencedMaintainers, repo],
  );
}

function AttributionTitle({
  repo,
  itemLabel,
  plural,
  groups,
  pageSuffix,
}: Pick<RepoItemAttributionProps, "repo" | "itemLabel"> & {
  plural: boolean;
  groups: RequestedRepositoryGroup[];
  pageSuffix: string;
}) {
  const labels = LABELS[itemLabel];
  const singleGroup = groups.length === 1 ? groups[0] : undefined;

  return (
    <span className="leading-snug">
      {plural ? labels.plural : labels.singular} sent only to{" "}
      {singleGroup ? (
        <AlternateRepositoryControls
          repo={repo}
          groups={[singleGroup]}
          pageSuffix={pageSuffix}
        />
      ) : (
        <>
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
            {repo.dTag}
          </code>{" "}
          repositories
        </>
      )}
      {singleGroup ? (
        <>
          .{" "}
          <span className="inline-flex flex-wrap items-center gap-1 align-middle">
            {singleGroup.requestingMaintainers.map((pubkey) => (
              <UserLink
                key={pubkey}
                pubkey={pubkey}
                avatarSize="xs"
                className="inline-flex text-foreground"
                nameClassName="text-xs"
              />
            ))}
          </span>{" "}
          sent{" "}
          <span className="inline-flex flex-wrap items-center gap-1 align-middle">
            {singleGroup.recipientMaintainers.map((pubkey) => (
              <UserLink
                key={pubkey}
                pubkey={pubkey}
                avatarSize="xs"
                className="inline-flex text-foreground"
                nameClassName="text-xs"
              />
            ))}
          </span>{" "}
          a request to join repositories with
          <CurrentRepositoryBadge repo={repo} pageSuffix={pageSuffix} />
        </>
      ) : (
        " with pending repository join requests"
      )}
    </span>
  );
}

function AttributionSwitching({
  repo,
  groups,
  pageSuffix,
}: {
  repo: ResolvedRepo;
  groups: RequestedRepositoryGroup[];
  pageSuffix: string;
}) {
  return (
    <p className="leading-relaxed">
      Consider switching:
      <AlternateRepositoryControls
        repo={repo}
        groups={groups}
        pageSuffix={pageSuffix}
      />
      .
    </p>
  );
}

export function RepoMaintainerRequestBanner({
  repo,
  pageSuffix,
}: {
  repo: ResolvedRepo;
  pageSuffix: string;
}) {
  const requestedGroups = useMemo(
    () =>
      groupRequestedMaintainers(repo).filter((group) => group.hasAnnouncement),
    [repo],
  );
  const { requestingMaintainers, recipientMaintainers } = useMemo(() => {
    const expectedRequesters = new Set(
      requestedGroups.flatMap((group) => group.requestingMaintainers),
    );
    const expectedRecipients = new Set(
      requestedGroups.flatMap((group) => group.recipientMaintainers),
    );
    const requestEdges = repo.maintainerEdges.filter(
      ({ from, to }) =>
        expectedRequesters.has(from) && expectedRecipients.has(to),
    );
    return {
      requestingMaintainers: Array.from(
        new Set(
          requestEdges.length > 0
            ? requestEdges.map(({ from }) => from)
            : expectedRequesters,
        ),
      ),
      recipientMaintainers: Array.from(
        new Set(
          requestEdges.length > 0
            ? requestEdges.map(({ to }) => to)
            : expectedRecipients,
        ),
      ),
    };
  }, [repo.maintainerEdges, requestedGroups]);

  if (requestedGroups.length === 0) return null;

  return (
    <div className="bg-amber-500/10 dark:bg-amber-400/10">
      <div className="container flex max-w-screen-xl items-start gap-3 px-4 py-3 md:px-8">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0">
          <p className="font-medium leading-snug text-amber-950 dark:text-amber-100">
            <UserReferenceList pubkeys={requestingMaintainers} /> sent{" "}
            <UserReferenceList pubkeys={recipientMaintainers} /> a request to
            join this repository with
            <AlternateRepositoryControls
              repo={repo}
              groups={requestedGroups}
              pageSuffix={pageSuffix}
            />
            .
          </p>
          <p className="mt-1 text-sm text-amber-950/70 dark:text-amber-100/70">
            The request is awaiting{" "}
            {recipientMaintainers.length === 1 ? "a response" : "responses"}.
            The latest state across{" "}
            {requestedGroups.length === 1
              ? "both repositories"
              : "all repositories"}{" "}
            is shown.
          </p>
        </div>
      </div>
    </div>
  );
}

export function RepoItemAttributionWarning({
  repo,
  repoCoords,
  itemLabel,
  pageSuffix,
  count,
  className,
}: RepoItemAttributionProps & {
  count?: number;
  className?: string;
}) {
  const alternateGroups = useAlternateRepositoryGroups({ repo, repoCoords });

  return (
    <Alert
      className={cn(
        "border-amber-500/50 bg-gradient-to-r from-amber-500/10 via-background to-orange-500/10 text-foreground shadow-sm [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400",
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle className="text-amber-950 dark:text-amber-100">
        <AttributionTitle
          repo={repo}
          itemLabel={itemLabel}
          plural={count !== undefined}
          groups={alternateGroups}
          pageSuffix={pageSuffix}
        />
      </AlertTitle>
      {alternateGroups.length > 1 && (
        <AlertDescription className="text-muted-foreground">
          <AttributionSwitching
            repo={repo}
            groups={alternateGroups}
            pageSuffix={pageSuffix}
          />
        </AlertDescription>
      )}
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
  const alternateGroups = useAlternateRepositoryGroups({ repo, repoCoords });

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
        <div
          className={cn(
            "flex items-center gap-2 font-medium text-amber-900 dark:text-amber-100",
            alternateGroups.length > 1 && "mb-2",
          )}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <AttributionTitle
            repo={repo}
            itemLabel={itemLabel}
            plural={false}
            groups={alternateGroups}
            pageSuffix={pageSuffix}
          />
        </div>
        {alternateGroups.length > 1 && (
          <div className="text-sm text-muted-foreground">
            <AttributionSwitching
              repo={repo}
              groups={alternateGroups}
              pageSuffix={pageSuffix}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
