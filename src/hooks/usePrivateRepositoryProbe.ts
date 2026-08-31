import { useMemo } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import { verifyEvent, type NostrEvent } from "nostr-tools";
import {
  catchError,
  firstValueFrom,
  from,
  of,
  startWith,
  timeout,
  toArray,
  type Observable,
} from "rxjs";

import { use$ } from "@/hooks/use$";
import { classifyPrivateGitServiceRelay } from "@/lib/grasp";
import {
  getRepoHistorySubjects,
  getRepoRoleSubjects,
  REPO_KIND,
  repoCoordinate,
  resolveChain,
  type ResolvedRepo,
} from "@/lib/nip34";
import { resilientRequest } from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { eventStore, pool } from "@/services/nostr";
import { privateGitRelayList$ } from "@/services/privateGitRelays";
import {
  installPrivateRepositoryRelays,
  markPrivateRelayEvent,
  markPrivateRepositoryCoordinate,
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
  return firstValueFrom(
    resilientRequest(pool, [relayUrl], filters, {
      retryCount: 1,
      paginate: false,
    }).pipe(onlyEvents(), toArray(), timeout(PRIVATE_PROBE_TIMEOUT_MS)),
  );
}

async function classifyUnlistedHints(
  hints: readonly string[],
  listedRelays: ReadonlySet<string>,
): Promise<PrivateRepositoryProbeState | undefined> {
  const unlisted = uniqueRelayUrls(hints).filter(
    (relay) => !listedRelays.has(relay),
  );
  if (unlisted.length === 0) return undefined;

  const classified = await Promise.allSettled(
    unlisted.map(async (relay) => ({
      relay,
      privateService: await classifyPrivateGitServiceRelay(relay),
    })),
  );
  const privateHint = classified.find(
    (result) => result.status === "fulfilled" && result.value.privateService,
  );
  if (privateHint?.status === "fulfilled") {
    return {
      status: "unavailable",
      relayUrls: [],
      error: `Add ${privateHint.value.relay} to Private Git services in Settings before opening this repository.`,
    };
  }
  if (classified.some((result) => result.status === "rejected")) {
    return {
      status: "unavailable",
      relayUrls: [],
      error:
        "A repository relay hint could not be classified safely. Public discovery was not attempted.",
    };
  }
  return undefined;
}

async function probePrivateRepository(
  pubkey: string,
  dTag: string,
  relayHints: readonly string[],
  accountPubkey: string | undefined,
  listStatus: string,
  listRelayUrls: readonly string[],
): Promise<PrivateRepositoryProbeState> {
  if (!accountPubkey) {
    const classified = await classifyUnlistedHints(relayHints, new Set());
    return (
      classified ?? {
        status: "absent",
        relayUrls: [],
      }
    );
  }
  if (listStatus === "loading") {
    return { status: "loading", relayUrls: [] };
  }
  if (listStatus !== "ready") {
    return {
      status: "unavailable",
      relayUrls: [],
      error:
        "Private Git service discovery is unavailable. Public repository discovery was not attempted.",
    };
  }

  const listedRelays = uniqueRelayUrls(listRelayUrls);
  const listedSet = new Set(listedRelays);
  const events = new Map<string, NostrEvent>();
  const pendingAuthors = new Set([pubkey]);
  const queriedAuthors = new Set<string>();
  const foundRelays = new Set<string>();

  while (pendingAuthors.size > 0 && listedRelays.length > 0) {
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
      listedRelays.map(async (relay) => ({
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
    const classified = await classifyUnlistedHints(relayHints, listedSet);
    return classified ?? { status: "absent", relayUrls: [] };
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
      listedRelays.map((relay) => requestRelay(relay, evidenceFilters)),
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
  const repositoryRelays = listedRelays.filter(
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
  const hintsKey = useMemo(
    () => uniqueRelayUrls(relayHints).join(","),
    [relayHints],
  );

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
        account?.pubkey,
        list.status,
        list.relayUrls,
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
  ]);
}
