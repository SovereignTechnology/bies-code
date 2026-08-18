import { useEffect, useMemo, useState } from "react";
import type { Filter, ProfileContent } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { IdentityStatus } from "applesauce-loaders/helpers";
import { combineLatest, of, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import { useActiveAccount } from "applesauce-react/hooks";
import { isValidCIJobResult } from "@/casts/CIJobResult";
import { isValidCIResult } from "@/casts/CIResult";
import { isValidCIRun } from "@/casts/CIRun";
import { isValidCIServiceControl } from "@/casts/CICoordinator";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import type { CICoordinatorState } from "@/hooks/useCICoordinators";
import {
  CI_EVENT_KINDS,
  CI_MANUAL_TRIGGER_KIND,
  CI_SERVICE_REQUEST_KIND,
  type CIWorkflowRun,
} from "@/lib/ci";
import type { CICoordinatorRelationship } from "@/lib/ciCoordinatorRelationship";
import {
  CITrustClassification,
  classifyCIDomainRelationship,
  settledCITrustResolution,
  type CITrustContextState,
  type CITrustEvidence,
} from "@/lib/ciTrustContext";
import { REPO_KIND, type ResolvedRepo } from "@/lib/nip34";
import { loadRelayQueryUntilSettled } from "@/lib/relayQuerySettlement";
import { standardizeNip05 } from "@/lib/routeUtils";
import { RepositoryListModel } from "@/models/RepositoryListModel";
import { dnsIdentityLoader, nip05WarmupReady, pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

const CONTACT_KINDS = [3, 10017] as const;
const IDENTITY_TIMEOUT_MS = 5_000;

interface VerifiedIdentity {
  nip05: string;
  localPart: string;
  domain: string;
  verified: boolean;
  failed: boolean;
}

interface SocialEvidenceState {
  settled: boolean;
  partial: boolean;
  evidence: ReadonlyMap<string, readonly CITrustEvidence[]>;
}

const SETTLED_EMPTY_SOCIAL: SocialEvidenceState = {
  settled: true,
  partial: false,
  evidence: new Map(),
};

function profileContent(
  event: NostrEvent | undefined,
): ProfileContent | undefined {
  if (!event) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProfileContent)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseNip05(value: string | undefined) {
  if (!value) return undefined;
  const standardized = standardizeNip05(value.trim().toLowerCase());
  const separator = standardized.indexOf("@");
  if (separator <= 0 || separator === standardized.length - 1) return undefined;
  return {
    nip05: standardized,
    localPart: standardized.slice(0, separator),
    domain: standardized.slice(separator + 1),
  };
}

async function resolveIdentity(
  rawNip05: string | undefined,
  pubkey: string,
): Promise<VerifiedIdentity | undefined> {
  const parsed = parseNip05(rawNip05);
  if (!parsed) return undefined;

  try {
    await nip05WarmupReady;
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(
        () => reject(new Error("identity-timeout")),
        IDENTITY_TIMEOUT_MS,
      );
    });
    const identity = await Promise.race([
      dnsIdentityLoader.loadIdentity(parsed.localPart, parsed.domain),
      timeout,
    ]);
    dnsIdentityLoader.identities.set(parsed.nip05, identity);
    return {
      ...parsed,
      verified:
        identity.status === IdentityStatus.Found && identity.pubkey === pubkey,
      failed: identity.status === IdentityStatus.Error,
    };
  } catch {
    return { ...parsed, verified: false, failed: true };
  }
}

function useVerifiedCIIdentities(pubkeys: readonly string[]): {
  settled: boolean;
  partial: boolean;
  identities: ReadonlyMap<string, VerifiedIdentity | undefined>;
} {
  const store = useEventStore();
  const pubkeyKey = [...pubkeys].sort().join(",");
  const lookup = use$(() => lookupRelays, []) ?? [];
  const indexes = use$(() => gitIndexRelays, []) ?? [];
  const relays = [...new Set([...lookup, ...indexes])];
  const relayKey = relays.join(",");
  const profileQuery = use$(() => {
    if (pubkeys.length === 0) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      relays,
      [{ kinds: [0], authors: [...pubkeys] } as Filter],
      store,
    );
  }, [pubkeyKey, relayKey, store]);

  const profileRevision = use$(() => {
    if (pubkeys.length === 0) return of("");
    return combineLatest(
      pubkeys.map((pubkey) => store.replaceable(0, pubkey)),
    ).pipe(map((events) => events.map((event) => event?.id ?? "").join(",")));
  }, [pubkeyKey, store]);

  const [state, setState] = useState<{
    key: string;
    settled: boolean;
    partial: boolean;
    identities: ReadonlyMap<string, VerifiedIdentity | undefined>;
  }>({
    key: "",
    settled: pubkeys.length === 0,
    partial: false,
    identities: new Map(),
  });
  const resolutionKey = `${pubkeyKey}|${profileRevision ?? ""}|${profileQuery?.settled ?? false}`;

  useEffect(() => {
    if (pubkeys.length === 0) {
      setState({
        key: resolutionKey,
        settled: true,
        partial: false,
        identities: new Map(),
      });
      return;
    }
    if (!profileQuery?.settled) {
      setState({
        key: resolutionKey,
        settled: false,
        partial: false,
        identities: new Map(),
      });
      return;
    }

    let disposed = false;
    setState((current) => ({ ...current, key: resolutionKey, settled: false }));
    void Promise.all(
      pubkeys.map(async (pubkey) => {
        const profile = profileContent(store.getReplaceable(0, pubkey));
        const identity = await resolveIdentity(profile?.nip05, pubkey);
        return [pubkey, identity] as const;
      }),
    ).then((entries) => {
      if (disposed) return;
      const identities = new Map(entries);
      setState({
        key: resolutionKey,
        settled: true,
        partial:
          ((profileQuery.failedRelayCount > 0 ||
            profileQuery.relayCount === 0) &&
            pubkeys.some((pubkey) => !store.getReplaceable(0, pubkey))) ||
          entries.some(([, identity]) => identity?.failed),
        identities,
      });
    });
    return () => {
      disposed = true;
    };
  }, [profileQuery, pubkeyKey, profileRevision, pubkeys, resolutionKey, store]);

  if (state.key !== resolutionKey) {
    return { settled: false, partial: false, identities: new Map() };
  }
  return state;
}

function eventTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(([tagName, value]) => tagName === name && !!value)
    .map(([, value]) => value);
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

function useCISocialEvidence(
  identities: readonly string[],
): SocialEvidenceState {
  const store = useEventStore();
  const account = useActiveAccount();
  const accountPubkey = account?.pubkey;
  const identityKey = [...identities].sort().join(",");
  const lookup = use$(() => lookupRelays, []) ?? [];
  const indexes = use$(() => gitIndexRelays, []) ?? [];
  const contactRelays = [...new Set([...lookup, ...indexes])];
  const contactRelayKey = contactRelays.join(",");

  const contactsQuery = use$(() => {
    if (!accountPubkey || identities.length === 0) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      contactRelays,
      [{ kinds: [...CONTACT_KINDS], authors: [accountPubkey] } as Filter],
      store,
    );
  }, [accountPubkey, contactRelayKey, identityKey, store]);

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
  const followKey = [...(follows ?? [])].sort().join(",");
  const indexKey = indexes.join(",");

  const directReposQuery = use$(() => {
    if (!accountPubkey || identities.length === 0 || !contactsQuery?.settled) {
      return of({
        settled: false,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    if (!follows?.length) {
      return of({
        settled: true,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    return loadRelayQueryUntilSettled(
      pool,
      indexes,
      [{ kinds: [REPO_KIND], authors: follows } as Filter],
      store,
      { paginate: true },
    );
  }, [
    accountPubkey,
    contactsQuery?.settled,
    followKey,
    identityKey,
    indexKey,
    store,
  ]);

  const directRepoEvents = use$(() => {
    if (!follows?.length) return of([] as NostrEvent[]);
    return store.timeline([
      { kinds: [REPO_KIND], authors: follows } as Filter,
    ]) as Observable<NostrEvent[]>;
  }, [followKey, store]);
  const repoDTags = [
    ...new Set(
      (directRepoEvents ?? []).flatMap((event) => eventTagValues(event, "d")),
    ),
  ];
  const repoDTagKey = [...repoDTags].sort().join(",");

  const graphQuery = use$(() => {
    if (!directReposQuery?.settled) {
      return of({
        settled: false,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    if (repoDTags.length === 0) {
      return of({
        settled: true,
        relayCount: indexes.length,
        failedRelayCount: 0,
      });
    }
    return loadRelayQueryUntilSettled(
      pool,
      indexes,
      [{ kinds: [REPO_KIND], "#d": repoDTags } as Filter],
      store,
      { paginate: true },
    );
  }, [directReposQuery?.settled, indexKey, repoDTagKey, store]);

  const socialRepositories = use$(() => {
    if (!follows?.length) return of([] as ResolvedRepo[]);
    const followed = new Set(follows);
    return (
      store.model(RepositoryListModel) as unknown as Observable<ResolvedRepo[]>
    ).pipe(
      map((repositories) =>
        repositories.filter((repository) =>
          repository.confirmedMaintainers.some((pubkey) =>
            followed.has(pubkey),
          ),
        ),
      ),
    );
  }, [followKey, store]);
  const socialCoordinates = [
    ...new Set(
      (socialRepositories ?? []).flatMap((repo) => repo.allCoordinates),
    ),
  ];
  const socialRelays = [
    ...new Set([
      ...(socialRepositories ?? []).flatMap((repo) => repo.relays),
      ...indexes,
    ]),
  ];
  const socialCoordinateKey = [...socialCoordinates].sort().join(",");
  const socialRelayKey = [...socialRelays].sort().join(",");

  const activityQuery = use$(() => {
    if (!graphQuery?.settled) {
      return of({
        settled: false,
        relayCount: socialRelays.length,
        failedRelayCount: 0,
      });
    }
    if (identities.length === 0 || socialCoordinates.length === 0) {
      return of({
        settled: true,
        relayCount: socialRelays.length,
        failedRelayCount: 0,
      });
    }
    const filters: Filter[] = [
      {
        kinds: [...CI_EVENT_KINDS],
        authors: [...identities],
        "#a": socialCoordinates,
      } as Filter,
    ];
    if (follows?.length) {
      filters.push({
        kinds: [CI_MANUAL_TRIGGER_KIND, CI_SERVICE_REQUEST_KIND],
        authors: follows,
        "#p": [...identities],
        "#a": socialCoordinates,
      } as Filter);
    }
    return loadRelayQueryUntilSettled(pool, socialRelays, filters, store, {
      paginate: true,
    });
  }, [
    activityQueryDependency(identityKey, socialCoordinateKey, socialRelayKey),
    followKey,
    graphQuery?.settled,
    store,
  ]);

  const evidence = use$(() => {
    if (identities.length === 0 || socialCoordinates.length === 0) {
      return of(new Map<string, readonly CITrustEvidence[]>());
    }
    const followed = new Set(follows ?? []);
    const coordinateSet = new Set(socialCoordinates);
    return store
      .timeline([
        {
          kinds: [
            ...CI_EVENT_KINDS,
            CI_MANUAL_TRIGGER_KIND,
            CI_SERVICE_REQUEST_KIND,
          ],
          "#a": socialCoordinates,
        } as Filter,
      ])
      .pipe(
        map((events) => {
          const requests = new Map<string, Set<string>>();
          const activity = new Map<string, Set<string>>();
          for (const event of events as NostrEvent[]) {
            const matchingCoordinates = eventTagValues(event, "a").filter(
              (coord) => coordinateSet.has(coord),
            );
            if (matchingCoordinates.length === 0) continue;
            const matchingRepositories = (socialRepositories ?? []).filter(
              (repository) =>
                repository.allCoordinates.some((coord) =>
                  matchingCoordinates.includes(coord),
                ),
            );
            if (
              followed.has(event.pubkey) &&
              matchingRepositories.some((repository) =>
                repository.confirmedMaintainers.includes(event.pubkey),
              ) &&
              (isValidCIServiceControl(event) ||
                isValidSocialManualTrigger(event))
            ) {
              for (const target of eventTagValues(event, "p")) {
                if (!identities.includes(target)) continue;
                const authors = requests.get(target) ?? new Set<string>();
                authors.add(event.pubkey);
                requests.set(target, authors);
              }
            } else if (
              identities.includes(event.pubkey) &&
              isObservedStartedActivity(event)
            ) {
              const maintainers =
                activity.get(event.pubkey) ?? new Set<string>();
              for (const repository of matchingRepositories) {
                for (const maintainer of repository.confirmedMaintainers) {
                  if (followed.has(maintainer)) maintainers.add(maintainer);
                }
              }
              activity.set(event.pubkey, maintainers);
            }
          }

          return new Map(
            identities.map((pubkey) => {
              const items: CITrustEvidence[] = [];
              const requesters = requests.get(pubkey);
              if (requesters?.size) {
                items.push({
                  kind: "contact-request",
                  classification: CITrustClassification.SociallyCorroborated,
                  summary: "Requested by people you follow",
                  detail: `${requesters.size} ${requesters.size === 1 ? "person you follow has" : "people you follow have"} signed a CI request addressed to this identity for a repository they maintain.`,
                  scope: "historical",
                });
              }
              const maintainers = activity.get(pubkey);
              if (maintainers?.size) {
                items.push({
                  kind: "social-activity",
                  classification: CITrustClassification.SociallyCorroborated,
                  summary: "Used near your follow graph",
                  detail: `Started or completed CI activity was observed on repositories maintained by ${maintainers.size} ${maintainers.size === 1 ? "person" : "people"} you follow. This does not mean they requested or endorsed it.`,
                  scope: "historical",
                });
              }
              return [pubkey, items] as const;
            }),
          );
        }),
      );
  }, [followKey, identityKey, socialCoordinateKey, store]);

  if (!accountPubkey || identities.length === 0) return SETTLED_EMPTY_SOCIAL;
  const settled =
    !!contactsQuery?.settled &&
    !!directReposQuery?.settled &&
    !!graphQuery?.settled &&
    !!activityQuery?.settled;
  const queryStates = [
    contactsQuery,
    directReposQuery,
    graphQuery,
    activityQuery,
  ];
  return {
    settled,
    partial: queryStates.some(
      (query) =>
        !!query &&
        (query.failedRelayCount > 0 ||
          (query.relayCount === 0 &&
            follows !== undefined &&
            follows.length > 0)),
    ),
    evidence: evidence ?? new Map(),
  };
}

function activityQueryDependency(
  identityKey: string,
  coordinateKey: string,
  relayKey: string,
): string {
  return `${identityKey}|${coordinateKey}|${relayKey}`;
}

function relationshipEvidence(
  relationship: CICoordinatorRelationship | undefined,
): CITrustEvidence[] {
  if (!relationship) return [];
  if (relationship.level === "requested") {
    return [
      {
        kind: "maintainer-request",
        classification: CITrustClassification.MaintainerDirected,
        summary: "Requested by repository maintainers",
        detail:
          "A confirmed repository maintainer currently asks this coordinator to run CI for this repository.",
        scope: "current",
      },
    ];
  }
  if (relationship.level === "previously-requested") {
    return [
      {
        kind: "historical-maintainer-request",
        classification: CITrustClassification.OperationallyAssociated,
        summary: "Previously requested by maintainers",
        detail:
          "Repository maintainers requested this coordinator in the past, but there is no active standing request now.",
        scope: "historical",
      },
    ];
  }
  return [];
}

function domainEvidence(
  identity: VerifiedIdentity | undefined,
  repositoryDomains: readonly string[],
): CITrustEvidence[] {
  if (!identity?.verified) return [];
  const match = classifyCIDomainRelationship(
    identity.domain,
    repositoryDomains,
  );
  if (!match.relationship || !match.repositoryDomain) return [];
  const displayIdentity =
    identity.localPart === "_" ? identity.domain : identity.nip05;
  return [
    match.relationship === "exact"
      ? {
          kind: "repository-domain",
          classification: CITrustClassification.OperationallyAssociated,
          summary: "Uses repository-listed infrastructure",
          detail: `${displayIdentity} is a verified NIP-05 identity on ${match.repositoryDomain}, a GRASP domain listed by the resolved repository graph.`,
          scope: "current",
        }
      : {
          kind: "repository-subdomain",
          classification: CITrustClassification.OperationallyAssociated,
          summary: "Related repository infrastructure",
          detail: `${displayIdentity} is verified on a parent or child domain of repository-listed ${match.repositoryDomain}. Subdomains may have separate operators, so this is weaker evidence than an exact match.`,
          scope: "current",
        },
  ];
}

export function useCITrustContext({
  repo,
  runs = [],
  coordinatorRelationships,
  coordinatorState,
  repositoryRelationshipState,
  extraIdentities = [],
}: {
  repo?: ResolvedRepo;
  runs?: readonly CIWorkflowRun[];
  coordinatorRelationships?: ReadonlyMap<string, CICoordinatorRelationship>;
  coordinatorState?: CICoordinatorState;
  repositoryRelationshipState?: { settled: boolean; partial: boolean };
  extraIdentities?: readonly string[];
}): CITrustContextState {
  const identityKey = [
    ...new Set([
      ...extraIdentities,
      ...runs.flatMap((run) => [
        run.pubkey,
        ...run.jobs.map((job) => job.result.pubkey),
      ]),
      ...(coordinatorState?.coordinators.map(({ pubkey }) => pubkey) ?? []),
      ...(coordinatorRelationships?.keys() ?? []),
    ]),
  ]
    .sort()
    .join(",");
  const identityPubkeys = useMemo(
    () => (identityKey ? identityKey.split(",") : []),
    [identityKey],
  );
  const verified = useVerifiedCIIdentities(identityPubkeys);
  const social = useCISocialEvidence(identityPubkeys);
  const relationshipQueryState =
    coordinatorState ?? repositoryRelationshipState;
  const relationshipsSettled = repo
    ? relationshipQueryState?.settled === true
    : true;
  const settled = relationshipsSettled && verified.settled && social.settled;
  const partial =
    verified.partial ||
    social.partial ||
    (repo ? relationshipQueryState?.partial === true : false);

  return useMemo(() => {
    if (!settled) {
      return {
        phase: "loading",
        resolutions: new Map(),
        coverage: partial ? "partial" : "complete",
      };
    }

    const evidenceByPubkey = new Map<string, CITrustEvidence[]>();
    for (const pubkey of identityPubkeys) {
      evidenceByPubkey.set(pubkey, [
        ...relationshipEvidence(coordinatorRelationships?.get(pubkey)),
        ...domainEvidence(
          verified.identities.get(pubkey),
          repo?.graspServerDomains ?? [],
        ),
        ...(social.evidence.get(pubkey) ?? []),
      ]);
    }

    const coverage = partial ? "partial" : "complete";
    return {
      phase: "settled",
      coverage,
      resolutions: new Map(
        identityPubkeys.map((pubkey) => [
          pubkey,
          settledCITrustResolution(
            evidenceByPubkey.get(pubkey) ?? [],
            coverage,
          ),
        ]),
      ),
    };
  }, [
    coordinatorRelationships,
    identityPubkeys,
    partial,
    repo?.graspServerDomains,
    settled,
    social.evidence,
    verified.identities,
  ]);
}
