import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { combineLatest, of, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import { useActiveAccount } from "applesauce-react/hooks";
import {
  CIServiceControl,
  type CIRepositoryStatus,
  isValidCIServiceControl,
} from "@/casts/CICoordinator";
import { isValidCIJobResult } from "@/casts/CIJobResult";
import { isValidCIResult } from "@/casts/CIResult";
import { isValidCIRun } from "@/casts/CIRun";
import { use$ } from "@/hooks/use$";
import { useDnsIdentity } from "@/hooks/useDnsIdentity";
import { useEventStore } from "@/hooks/useEventStore";
import {
  CI_EVENT_KINDS,
  CI_MANUAL_TRIGGER_KIND,
  CI_SERVICE_REQUEST_KIND,
  CI_SERVICE_STOP_KIND,
} from "@/lib/ci";
import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { loadRelayQueryUntilSettled } from "@/lib/relayQuerySettlement";
import { standardizeNip05 } from "@/lib/routeUtils";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import { pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

const CONTACT_KINDS = [3, 10017] as const;
const EMPTY_CONTROLS: readonly CIServiceControl[] = [];

export interface CICoordinatorContactContext {
  pubkey: string;
  repositoryCount: number;
}

export type CICoordinatorViewerContext =
  | { phase: "loading"; signedIn: boolean }
  | {
      phase: "settled";
      signedIn: boolean;
      coverage: "complete" | "partial";
      viewerRequestedRepositoryCount: number;
      viewerActiveRepositoryCount: number;
      viewerGraspRepositoryCount: number;
      verifiedGraspDomain: string | undefined;
      requestedByContacts: readonly CICoordinatorContactContext[];
      requestedByContactsRepositoryCount: number;
      activeForContacts: readonly CICoordinatorContactContext[];
      activeForContactsRepositoryCount: number;
    };

function eventTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(([tagName, value]) => tagName === name && !!value)
    .map(([, value]) => value);
}

function isLaterControl(a: CIServiceControl, b: CIServiceControl): boolean {
  if (a.event.created_at !== b.event.created_at) {
    return a.event.created_at > b.event.created_at;
  }
  return a.event.id.localeCompare(b.event.id) < 0;
}

function normalizedDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").split(":")[0];
}

function incrementContact(
  counts: Map<string, Set<string>>,
  pubkey: string,
  repository: ResolvedRepo,
) {
  const repositories = counts.get(pubkey) ?? new Set<string>();
  repositories.add(repository.selectedCoordinate);
  counts.set(pubkey, repositories);
}

function contactCounts(
  counts: ReadonlyMap<string, ReadonlySet<string>>,
): CICoordinatorContactContext[] {
  return [...counts]
    .map(([pubkey, repositories]) => ({
      pubkey,
      repositoryCount: repositories.size,
    }))
    .sort(
      (a, b) =>
        b.repositoryCount - a.repositoryCount ||
        a.pubkey.localeCompare(b.pubkey),
    );
}

function uniqueRepositoryCount(
  counts: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  return new Set(
    [...counts.values()].flatMap((repositories) => [...repositories]),
  ).size;
}

function isObservedStartedActivity(event: NostrEvent): boolean {
  if (isValidCIResult(event) || isValidCIJobResult(event)) return true;
  if (!isValidCIRun(event)) return false;
  return event.tags.some(
    ([name, value]) => name === "started_at" && /^\d+$/.test(value ?? ""),
  );
}

function isValidSocialManualTrigger(event: NostrEvent): boolean {
  return (
    event.kind === CI_MANUAL_TRIGGER_KIND &&
    event.content === "" &&
    eventTagValues(event, "p").some((pubkey) =>
      /^[0-9a-f]{64}$/.test(pubkey),
    ) &&
    eventTagValues(event, "a").some((coordinate) =>
      /^30617:[0-9a-f]{64}:.+$/.test(coordinate),
    )
  );
}

/**
 * Resolve viewer-relative repository evidence for a global coordinator page.
 * Every request is accepted only from a confirmed maintainer of the resolved
 * repository it references.
 */
export function useCICoordinatorViewerContext(
  coordinatorPubkey: string,
  activeStatuses: readonly CIRepositoryStatus[] | undefined,
  nip05: string | undefined,
): CICoordinatorViewerContext {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const account = useActiveAccount();
  const accountPubkey = account?.pubkey;
  const indexes = use$(() => gitIndexRelays, []) ?? [];
  const lookup = use$(() => lookupRelays, []) ?? [];
  const discoveryRelays = [...new Set([...lookup, ...indexes])];
  const discoveryRelayKey = discoveryRelays.join(",");

  const contactsQuery = use$(() => {
    if (!accountPubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      discoveryRelays,
      [{ kinds: [...CONTACT_KINDS], authors: [accountPubkey] } as Filter],
      store,
    );
  }, [accountPubkey, discoveryRelayKey, store]);

  const follows = use$(() => {
    if (!accountPubkey) return of([] as string[]);
    return combineLatest([
      store.replaceable(3, accountPubkey),
      store.replaceable(10017, accountPubkey),
    ]).pipe(
      map(([contacts, gitAuthors]) => [
        ...new Set(
          [contacts, gitAuthors]
            .filter((event): event is NostrEvent => !!event)
            .flatMap((event) => eventTagValues(event, "p")),
        ),
      ]),
    );
  }, [accountPubkey, store]);
  const people = accountPubkey
    ? [...new Set([accountPubkey, ...(follows ?? [])])]
    : [];
  const peopleKey = [...people].sort().join(",");
  const indexKey = indexes.join(",");

  const directRepositoriesQuery = use$(() => {
    if (!accountPubkey || !contactsQuery?.settled) {
      return of({
        settled: false,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    return loadRelayQueryUntilSettled(
      pool,
      indexes,
      [{ kinds: [REPO_KIND], authors: people } as Filter],
      store,
      { paginate: true },
    );
  }, [accountPubkey, contactsQuery?.settled, indexKey, peopleKey, store]);

  const directRepositoryEvents = use$(() => {
    if (people.length === 0) return of([] as NostrEvent[]);
    return store.timeline([
      { kinds: [REPO_KIND], authors: people } as Filter,
    ]) as Observable<NostrEvent[]>;
  }, [peopleKey, store]);
  const repositoryDTags = [
    ...new Set(
      (directRepositoryEvents ?? []).flatMap((event) =>
        eventTagValues(event, "d"),
      ),
    ),
  ];
  const repositoryDTagKey = [...repositoryDTags].sort().join(",");

  const repositoryGraphQuery = use$(() => {
    if (!directRepositoriesQuery?.settled) {
      return of({
        settled: false,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    if (repositoryDTags.length === 0) {
      return of({
        settled: true,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    return loadRelayQueryUntilSettled(
      pool,
      indexes,
      [{ kinds: [REPO_KIND], "#d": repositoryDTags } as Filter],
      store,
      { paginate: true },
    );
  }, [directRepositoriesQuery?.settled, indexKey, repositoryDTagKey, store]);

  const repositories = use$(() => {
    if (!accountPubkey) return of([] as ResolvedRepo[]);
    const peopleSet = new Set(people);
    return (
      store.model(RepositoryListModel) as unknown as Observable<ResolvedRepo[]>
    ).pipe(
      map((items) =>
        items.filter((repo) =>
          repo.confirmedMaintainers.some((pubkey) => peopleSet.has(pubkey)),
        ),
      ),
    );
  }, [accountPubkey, peopleKey, store]);
  const repositoryCoordinates = [
    ...new Set((repositories ?? []).flatMap((repo) => repo.allCoordinates)),
  ];
  const repositoryRelays = [
    ...new Set([
      ...(repositories ?? []).flatMap((repo) => repo.relays),
      ...indexes,
    ]),
  ];
  const coordinateKey = [...repositoryCoordinates].sort().join(",");
  const repositoryRelayKey = [...repositoryRelays].sort().join(",");

  const contextEventsQuery = use$(() => {
    if (!repositoryGraphQuery?.settled || repositories === undefined) {
      return of({
        settled: false,
        relayCount: repositoryRelays.length,
        failedRelayCount: 0,
      });
    }
    if (repositoryCoordinates.length === 0) {
      return of({
        settled: true,
        relayCount: repositoryRelays.length,
        failedRelayCount: 0,
      });
    }
    return loadRelayQueryUntilSettled(
      pool,
      repositoryRelays,
      [
        {
          kinds: [
            CI_SERVICE_REQUEST_KIND,
            CI_SERVICE_STOP_KIND,
            CI_MANUAL_TRIGGER_KIND,
          ],
          authors: people,
          "#a": repositoryCoordinates,
          "#p": [coordinatorPubkey],
        } as Filter,
        {
          kinds: [...CI_EVENT_KINDS],
          authors: [coordinatorPubkey],
          "#a": repositoryCoordinates,
        } as Filter,
      ],
      store,
      { paginate: true },
    );
  }, [
    coordinatorPubkey,
    coordinateKey,
    peopleKey,
    repositories !== undefined,
    repositoryGraphQuery?.settled,
    repositoryRelayKey,
    store,
  ]);

  const controls =
    use$(() => {
      if (repositoryCoordinates.length === 0 || people.length === 0) {
        return of([] as CIServiceControl[]);
      }
      return store
        .timeline([
          {
            kinds: [CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND],
            authors: people,
            "#a": repositoryCoordinates,
            "#p": [coordinatorPubkey],
          } as Filter,
        ])
        .pipe(
          map((events) =>
            (events as NostrEvent[]).flatMap((event) =>
              isValidCIServiceControl(event)
                ? [new CIServiceControl(event, castStore)]
                : [],
            ),
          ),
        );
    }, [coordinatorPubkey, coordinateKey, peopleKey, store]) ?? EMPTY_CONTROLS;

  const observedActivity =
    use$(() => {
      if (repositoryCoordinates.length === 0) {
        return of([] as NostrEvent[]);
      }
      return store
        .timeline([
          {
            kinds: [...CI_EVENT_KINDS],
            authors: [coordinatorPubkey],
            "#a": repositoryCoordinates,
          } as Filter,
        ])
        .pipe(
          map((events) =>
            (events as NostrEvent[]).filter(isObservedStartedActivity),
          ),
        );
    }, [coordinatorPubkey, coordinateKey, store]) ?? [];

  const contactManualTriggers =
    use$(() => {
      if (repositoryCoordinates.length === 0 || !follows?.length) {
        return of([] as NostrEvent[]);
      }
      return store
        .timeline([
          {
            kinds: [CI_MANUAL_TRIGGER_KIND],
            authors: follows,
            "#a": repositoryCoordinates,
            "#p": [coordinatorPubkey],
          } as Filter,
        ])
        .pipe(
          map((events) =>
            (events as NostrEvent[]).filter(isValidSocialManualTrigger),
          ),
        );
    }, [coordinatorPubkey, coordinateKey, peopleKey, store]) ?? [];

  const standardizedNip05 = nip05 ? standardizeNip05(nip05) : undefined;
  const identity = useDnsIdentity(standardizedNip05);
  const identitySettled = !standardizedNip05 || identity.status !== "loading";
  const identityDomain = standardizedNip05?.split("@")[1];
  const verifiedGraspDomain =
    identity.status === "found" &&
    identity.pubkey === coordinatorPubkey &&
    identityDomain
      ? normalizedDomain(identityDomain)
      : undefined;

  if (!accountPubkey) {
    return {
      phase: "settled",
      signedIn: false,
      coverage: "complete",
      viewerRequestedRepositoryCount: 0,
      viewerActiveRepositoryCount: 0,
      viewerGraspRepositoryCount: 0,
      verifiedGraspDomain,
      requestedByContacts: [],
      requestedByContactsRepositoryCount: 0,
      activeForContacts: [],
      activeForContactsRepositoryCount: 0,
    };
  }

  const settled =
    contactsQuery?.settled === true &&
    directRepositoriesQuery?.settled === true &&
    repositoryGraphQuery?.settled === true &&
    repositories !== undefined &&
    contextEventsQuery?.settled === true &&
    identitySettled;
  if (!settled) return { phase: "loading", signedIn: true };

  const followed = new Set(follows ?? []);
  const ownRepositories = (repositories ?? []).filter((repo) =>
    repo.confirmedMaintainers.includes(accountPubkey),
  );
  const latestControls = new Map<string, CIServiceControl>();
  for (const control of controls) {
    const repository = (repositories ?? []).find(
      (repo) =>
        repo.allCoordinates.includes(control.repositoryCoordinate) &&
        repo.confirmedMaintainers.includes(control.event.pubkey),
    );
    if (!repository) continue;
    const current = latestControls.get(repository.selectedCoordinate);
    if (!current || isLaterControl(control, current)) {
      latestControls.set(repository.selectedCoordinate, control);
    }
  }

  const viewerRequestedRepositories = new Set<string>();
  const requestedByContacts = new Map<string, Set<string>>();
  for (const [coordinate, control] of latestControls) {
    if (!control.isRequest) continue;
    const repository = (repositories ?? []).find(
      (repo) => repo.selectedCoordinate === coordinate,
    );
    if (!repository) continue;
    if (control.event.pubkey === accountPubkey) {
      viewerRequestedRepositories.add(coordinate);
    } else if (followed.has(control.event.pubkey)) {
      incrementContact(requestedByContacts, control.event.pubkey, repository);
    }
  }
  for (const trigger of contactManualTriggers) {
    for (const coordinate of eventTagValues(trigger, "a")) {
      const repository = (repositories ?? []).find(
        (repo) =>
          repo.allCoordinates.includes(coordinate) &&
          repo.confirmedMaintainers.includes(trigger.pubkey),
      );
      if (repository && followed.has(trigger.pubkey)) {
        incrementContact(requestedByContacts, trigger.pubkey, repository);
      }
    }
  }

  const activeRepositoryCoordinates = new Set<string>();
  for (const status of activeStatuses ?? []) {
    for (const coordinate of status.repositoryCoordinates) {
      activeRepositoryCoordinates.add(coordinate);
    }
  }
  const socialActivityCoordinates = new Set(activeRepositoryCoordinates);
  for (const event of observedActivity) {
    for (const coordinate of eventTagValues(event, "a")) {
      socialActivityCoordinates.add(coordinate);
    }
  }
  const activeForContacts = new Map<string, Set<string>>();
  const activeViewerRepositories = new Set<string>();
  for (const repository of repositories ?? []) {
    if (
      !repository.allCoordinates.some((coordinate) =>
        socialActivityCoordinates.has(coordinate),
      )
    ) {
      continue;
    }
    if (
      repository.confirmedMaintainers.includes(accountPubkey) &&
      repository.allCoordinates.some((coordinate) =>
        activeRepositoryCoordinates.has(coordinate),
      )
    ) {
      activeViewerRepositories.add(repository.selectedCoordinate);
    }
    for (const maintainer of repository.confirmedMaintainers) {
      if (followed.has(maintainer)) {
        incrementContact(activeForContacts, maintainer, repository);
      }
    }
  }

  const viewerGraspRepositoryCount = verifiedGraspDomain
    ? ownRepositories.filter((repo) =>
        repo.graspServerDomains.some(
          (domain) => normalizedDomain(domain) === verifiedGraspDomain,
        ),
      ).length
    : 0;
  const queryStates = [
    contactsQuery,
    directRepositoriesQuery,
    repositoryGraphQuery,
    contextEventsQuery,
  ];

  return {
    phase: "settled",
    signedIn: true,
    coverage:
      queryStates.some(
        (query) =>
          !!query && (query.failedRelayCount > 0 || query.relayCount === 0),
      ) ||
      (standardizedNip05 !== undefined && identity.status === "error")
        ? "partial"
        : "complete",
    viewerRequestedRepositoryCount: viewerRequestedRepositories.size,
    viewerActiveRepositoryCount: activeViewerRepositories.size,
    viewerGraspRepositoryCount,
    verifiedGraspDomain,
    requestedByContacts: contactCounts(requestedByContacts),
    requestedByContactsRepositoryCount:
      uniqueRepositoryCount(requestedByContacts),
    activeForContacts: contactCounts(activeForContacts),
    activeForContactsRepositoryCount: uniqueRepositoryCount(activeForContacts),
  };
}
