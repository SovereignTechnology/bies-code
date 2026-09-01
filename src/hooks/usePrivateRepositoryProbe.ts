import { useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import {
  catchError,
  distinctUntilChanged,
  from,
  map,
  of,
  startWith,
  type Observable,
} from "rxjs";

import { use$ } from "@/hooks/use$";
import { classifyPrivateGitServiceRelay } from "@/lib/grasp";
import {
  getRepoIsPrivate,
  getRepoRelays,
  getRepoHistorySubjects,
  getRepoRoleSubjects,
  REPO_KIND,
  repoCoordinate,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import { requestRelaySnapshot } from "@/lib/relaySnapshot";
import { normalizeUrl } from "@/lib/url";
import { eventStore, pool } from "@/services/nostr";
import { privateGitRelayList$ } from "@/services/privateGitRelays";
import {
  getPrivateRepositoryRelays,
  installPrivateRepositoryRelays,
  installPrivateServiceRelayHint,
  isPrivateRepositoryCoordinate,
  markPrivateRelayEvent,
  markPrivateRepositoryCoordinate,
  privateRepositoryScopeRevision$,
} from "@/services/privateRepositoryScope";

const PRIVATE_PROBE_TIMEOUT_MS = 8_000;

export type PrivateRepositoryProbeStatus =
  | "loading"
  | "absent"
  | "found"
  | "unavailable";

export interface PrivateRepositoryProbeState {
  status: PrivateRepositoryProbeStatus;
  relayUrls: string[];
  repo?: ResolvedRepo;
  error?: string;
}

function uniqueRelayUrls(relays: readonly string[]): string[] {
  return [...new Set(relays.map(normalizeUrl))].sort();
}

async function requestRelay(
  relayUrl: string,
  filters: Filter[],
): Promise<NostrEvent[]> {
  const snapshot = await requestRelaySnapshot(
    pool,
    relayUrl,
    filters,
    PRIVATE_PROBE_TIMEOUT_MS,
  );
  if (!snapshot.complete) {
    throw new Error(
      `Private repository relay ${relayUrl} did not complete its response safely`,
    );
  }
  return snapshot.events;
}

async function discoverPrivateHintRelays(
  hints: readonly string[],
  listedRelays: ReadonlySet<string>,
): Promise<string[]> {
  const unlisted = uniqueRelayUrls(hints).filter(
    (relay) => !listedRelays.has(relay),
  );
  if (unlisted.length === 0) return [];

  const classified = await Promise.allSettled(
    unlisted.map(async (relay) => ({
      relay,
      privateService: await classifyPrivateGitServiceRelay(relay),
    })),
  );
  return classified.flatMap((result) =>
    result.status === "fulfilled" && result.value.privateService
      ? [result.value.relay]
      : [],
  );
}

async function probePrivateRepository(
  pubkey: string,
  dTag: string,
  relayHints: readonly string[],
  accountId: string | undefined,
  accountPubkey: string | undefined,
  listGeneration: number,
  listStatus: string,
  listRelayUrls: readonly string[],
  listError: string | undefined,
  knownAnnouncement: NostrEvent | undefined,
): Promise<PrivateRepositoryProbeState> {
  const validKnownAnnouncement =
    knownAnnouncement &&
    verifyEvent(knownAnnouncement) &&
    knownAnnouncement.kind === REPO_KIND &&
    knownAnnouncement.pubkey === pubkey &&
    knownAnnouncement.tags.some(
      ([name, value]) => name === "d" && value === dTag,
    )
      ? knownAnnouncement
      : undefined;
  const cachedAnnouncements = validKnownAnnouncement
    ? eventStore
        .getByFilters({ kinds: [REPO_KIND], "#d": [dTag] } as Filter)
        .filter((event) => verifyEvent(event))
    : [];
  const cachedResolved = validKnownAnnouncement
    ? (resolveChain(cachedAnnouncements, pubkey, dTag) ??
      resolveChain([validKnownAnnouncement], pubkey, dTag))
    : undefined;
  const knownIsPrivate =
    !!validKnownAnnouncement &&
    (getRepoIsPrivate(validKnownAnnouncement) || !!cachedResolved?.isPrivate);
  const coordinate = repoCoordinate(pubkey, dTag);
  const installedRepositoryRelays =
    getPrivateRepositoryRelays(coordinate) ?? [];
  const knownPrivateInScope =
    isPrivateRepositoryCoordinate(coordinate) ||
    installedRepositoryRelays.length > 0;

  // A verified public announcement already made this coordinate public. It
  // must remain readable from the EventStore even when the optional encrypted
  // private-service list is temporarily unavailable, unless this page session
  // has already positively established that the coordinate is private.
  if (validKnownAnnouncement && !knownIsPrivate && !knownPrivateInScope) {
    return { status: "absent", relayUrls: [] };
  }

  if (!accountPubkey) {
    if (knownIsPrivate || knownPrivateInScope) {
      return {
        status: "unavailable",
        relayUrls: [],
        error: "Log in to open this private repository.",
      };
    }
    const privateHints = await discoverPrivateHintRelays(relayHints, new Set());
    return privateHints.length > 0
      ? {
          status: "unavailable",
          relayUrls: [],
          error: "Log in to open a repository on a private Git service.",
        }
      : { status: "absent", relayUrls: [] };
  }

  const listedRelays =
    listStatus === "ready" ? uniqueRelayUrls(listRelayUrls) : [];
  const listedSet = new Set(listedRelays);
  const privateHintRelays = await discoverPrivateHintRelays(
    relayHints,
    listedSet,
  );
  for (const relay of privateHintRelays) {
    if (
      !accountId ||
      !installPrivateServiceRelayHint(
        accountId,
        accountPubkey,
        listGeneration,
        relay,
      )
    ) {
      throw new Error(
        "The active account changed during private repository discovery",
      );
    }
  }

  if (validKnownAnnouncement) {
    const resolved = cachedResolved;
    if (!resolved) {
      return {
        status: "unavailable",
        relayUrls: [],
        error:
          "The cached private repository announcement could not be resolved safely.",
      };
    }
    const repositoryRelays = uniqueRelayUrls([
      ...resolved.relays,
      ...getRepoRelays(validKnownAnnouncement),
    ]);
    if (repositoryRelays.length === 0) {
      return {
        status: "unavailable",
        relayUrls: [],
        error: "The private repository does not declare a repository relay.",
      };
    }
    for (const relay of repositoryRelays) {
      if (
        !accountId ||
        !installPrivateServiceRelayHint(
          accountId,
          accountPubkey,
          listGeneration,
          relay,
        )
      ) {
        throw new Error(
          "The active account changed during private repository discovery",
        );
      }
    }
    for (const coordinate of resolved.confirmedMemberCoordinates) {
      markPrivateRepositoryCoordinate(coordinate);
    }
    markPrivateRepositoryCoordinate(repoCoordinate(pubkey, dTag));
    for (const event of resolved.discoveredAnnouncements) {
      markPrivateRelayEvent(event);
    }
    installPrivateRepositoryRelays(
      [...resolved.confirmedMemberCoordinates, repoCoordinate(pubkey, dTag)],
      repositoryRelays,
    );
    return {
      status: "found",
      relayUrls: repositoryRelays,
      repo: { ...resolved, isPrivate: true },
    };
  }

  const discoveryRelays = uniqueRelayUrls([
    ...listedRelays,
    ...privateHintRelays,
    ...(knownPrivateInScope ? installedRepositoryRelays : []),
  ]);
  if (discoveryRelays.length === 0) {
    if (listStatus === "loading") {
      return { status: "loading", relayUrls: [] };
    }
    if (listStatus === "ready" || !knownPrivateInScope) {
      return { status: "absent", relayUrls: [] };
    }
    return {
      status: "unavailable",
      relayUrls: [],
      error:
        listError ??
        "Private Git service discovery is unavailable. Public repository discovery was not attempted.",
    };
  }
  const events = new Map<string, NostrEvent>();
  const pendingAuthors = new Set([pubkey]);
  const queriedAuthors = new Set<string>();
  const foundRelays = new Set<string>();

  while (pendingAuthors.size > 0 && discoveryRelays.length > 0) {
    const authors = [...pendingAuthors].filter(
      (author) => !queriedAuthors.has(author),
    );
    pendingAuthors.clear();
    if (authors.length === 0) break;
    authors.forEach((author) => queriedAuthors.add(author));

    const filter = {
      kinds: [REPO_KIND],
      authors,
      "#d": [dTag],
    } as Filter;
    const responses = await Promise.all(
      discoveryRelays.map(async (relay) => ({
        relay,
        events: await requestRelay(relay, [filter]),
      })),
    );
    for (const response of responses) {
      const announcements = response.events.filter(
        (event) =>
          verifyEvent(event) &&
          event.kind === REPO_KIND &&
          authors.includes(event.pubkey) &&
          event.tags.some(([name, value]) => name === "d" && value === dTag),
      );
      if (announcements.length > 0) foundRelays.add(response.relay);
      for (const event of announcements) {
        events.set(event.id, event);
        for (const subject of [
          ...getRepoRoleSubjects(event),
          ...getRepoHistorySubjects(event),
        ]) {
          if (!queriedAuthors.has(subject)) pendingAuthors.add(subject);
        }
      }
    }
  }

  if (events.size === 0) {
    if (listStatus === "ready") return { status: "absent", relayUrls: [] };
    if (!knownPrivateInScope && privateHintRelays.length === 0) {
      return { status: "absent", relayUrls: [] };
    }
    return listStatus === "loading"
      ? { status: "loading", relayUrls: [] }
      : {
          status: "unavailable",
          relayUrls: [],
          error:
            listError ??
            "The route hints did not contain this repository, and private-list discovery is unavailable. Public discovery was not attempted.",
        };
  }

  const announcements = [...events.values()];
  const authors = [...new Set(announcements.map((event) => event.pubkey))];
  const eventIds = announcements.map((event) => event.id);
  const evidenceFilters: Filter[] = [
    {
      kinds: [5],
      authors,
      "#a": authors.map((author) => repoCoordinate(author, dTag)),
    } as Filter,
    {
      kinds: [5],
      authors,
      "#e": eventIds,
    } as Filter,
  ];
  const evidence = (
    await Promise.all(
      discoveryRelays.map((relay) => requestRelay(relay, evidenceFilters)),
    )
  )
    .flat()
    .filter(
      (event) =>
        verifyEvent(event) &&
        event.kind === 5 &&
        authors.includes(event.pubkey),
    );
  const resolved = resolveChain([...announcements, ...evidence], pubkey, dTag);
  if (!resolved) {
    return {
      status: "unavailable",
      relayUrls: [],
      error:
        "The private repository announcement could not be resolved safely.",
    };
  }

  for (const coordinate of resolved.confirmedMemberCoordinates) {
    markPrivateRepositoryCoordinate(coordinate);
  }
  markPrivateRepositoryCoordinate(repoCoordinate(pubkey, dTag));
  for (const event of [...announcements, ...evidence]) {
    markPrivateRelayEvent(event);
    eventStore.add(event);
  }

  const declaredRelays = new Set(resolved.relays.map(normalizeUrl));
  const repositoryRelays = discoveryRelays.filter(
    (relay) => foundRelays.has(relay) || declaredRelays.has(relay),
  );
  if (repositoryRelays.length === 0) {
    return {
      status: "unavailable",
      relayUrls: [],
      error: "The private repository has no admitted repository relay.",
    };
  }
  installPrivateRepositoryRelays(
    [...resolved.confirmedMemberCoordinates, repoCoordinate(pubkey, dTag)],
    repositoryRelays,
  );
  return {
    status: "found",
    relayUrls: repositoryRelays,
    // Discovery through an explicitly encrypted private-service list is itself
    // private intent, even if a malformed legacy announcement omitted its tag.
    repo: { ...resolved, isPrivate: true },
  };
}

/** Resolve private services completely before ordinary repository discovery. */
export function usePrivateRepositoryProbe(
  pubkey: string | undefined,
  dTag: string | undefined,
  relayHints: readonly string[],
): PrivateRepositoryProbeState | undefined {
  const account = useActiveAccount();
  const list = use$(privateGitRelayList$);
  const privateScopeRevision = use$(privateRepositoryScopeRevision$);
  const hintsKey = useMemo(
    () => uniqueRelayUrls(relayHints).join(","),
    [relayHints],
  );

  // React to announcements inserted by any loader. A synchronous
  // getReplaceable read alone leaves the probe stale after an event arrives.
  const knownAnnouncement = use$(() => {
    if (!pubkey || !dTag) return undefined;
    return eventStore
      .timeline([
        {
          kinds: [REPO_KIND],
          authors: [pubkey],
          "#d": [dTag],
        } as Filter,
      ])
      .pipe(
        map(() => eventStore.getReplaceable(REPO_KIND, pubkey, dTag)),
        distinctUntilChanged((previous, next) => previous?.id === next?.id),
      );
  }, [pubkey, dTag]);

  return use$(() => {
    if (!pubkey || !dTag) return undefined;
    if (account && list.pubkey !== account.pubkey) {
      return of<PrivateRepositoryProbeState>({
        status: "loading",
        relayUrls: [],
      });
    }
    return from(
      probePrivateRepository(
        pubkey,
        dTag,
        relayHints,
        account?.id,
        account?.pubkey,
        list.generation,
        list.status,
        list.relayUrls,
        list.error,
        knownAnnouncement,
      ),
    ).pipe(
      startWith<PrivateRepositoryProbeState>({
        status: "loading",
        relayUrls: [],
      }),
      catchError((error) =>
        of<PrivateRepositoryProbeState>({
          status: "unavailable",
          relayUrls: [],
          error:
            error instanceof Error
              ? error.message
              : "Private repository discovery did not complete safely.",
        }),
      ),
    ) as Observable<PrivateRepositoryProbeState>;
  }, [
    pubkey,
    dTag,
    hintsKey,
    account?.id,
    account?.pubkey,
    list.generation,
    list.status,
    list.sourceEvent?.id,
    privateScopeRevision,
    knownAnnouncement?.id,
  ]);
}
