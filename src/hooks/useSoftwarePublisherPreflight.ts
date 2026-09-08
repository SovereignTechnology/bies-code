/**
 * Page-owned warm evidence for NIP-82 publisher writes.
 *
 * One stable subscription covers every application coordinate and every
 * deletion authored by the active publisher. Release versions use a separate
 * exact-coordinate lease while that candidate is being prepared; the limited
 * release feed is never treated as absence evidence.
 *
 * See docs/replaceable-preflight.md, "Software-publication adoption decision".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CastRefEventStore } from "applesauce-common/casts/cast";
import { mapEventsToStore } from "applesauce-core";
import type { IEventStore } from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers";
import { MailboxesModel } from "applesauce-core/models";
import { onlyEvents } from "applesauce-relay";
import type { RelayGroup } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";
import {
  combineLatest,
  firstValueFrom,
  merge,
  Observable,
  of,
  race,
  timer,
  type Subscription,
} from "rxjs";
import {
  distinctUntilChanged,
  ignoreElements,
  map,
  shareReplay,
  skip,
  startWith,
  take,
} from "rxjs/operators";

import {
  isValidSoftwareApplication,
  SoftwareApplication,
  SOFTWARE_APPLICATION_KIND,
  SOFTWARE_RELEASE_KIND,
} from "@/casts/Software";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  createRelaySubscriptionCoverage,
  type RelaySubscriptionCoverage,
} from "@/lib/relaySubscriptionCoverage";
import { resilientSubscription } from "@/lib/resilientSubscription";
import { normalizeUrl } from "@/lib/url";
import { relayGroupUrls$ } from "@/models/RepositoryRelayGroup";
import { cacheRequest } from "@/services/cache";
import { pool } from "@/services/nostr";
import { fallbackRelays, lookupRelays } from "@/services/settings";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";

export const ZAPSTORE_RELAY_URL = "wss://relay.zapstore.dev";

const CACHE_HYDRATION_TIMEOUT_MS = 1_000;
const SOFTWARE_COVERAGE_SETTLEMENT_TIMEOUT_MS =
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS;

type MailboxDiscovery = "known" | "checking" | "unavailable";

interface SoftwarePublisherRelayScope {
  outboxes: string[];
  fallbacks: string[];
  distributionRelays: string[];
  relays: string[];
  mailboxDiscovery: MailboxDiscovery;
}

interface CoverageAssessment {
  met: boolean;
  possible: boolean;
  summary: string;
}

export interface SoftwareApplicationSnapshot {
  event: NostrEvent | undefined;
  outboxes: string[];
  relays: string[];
}

export interface SoftwarePublisherPreflight {
  readonly pubkey: string;
  readonly scope$: Observable<SoftwarePublisherRelayScope>;
  readonly coverage: RelaySubscriptionCoverage;
  executeApplication<T>(
    appId: string,
    expectedEventId: string | null,
    action: (snapshot: SoftwareApplicationSnapshot) => Promise<T>,
  ): Promise<T>;
}

export interface AccountSoftwareApplications {
  applications: SoftwareApplication[];
  settled: boolean;
  preflight: SoftwarePublisherPreflight | undefined;
}

export interface SoftwareReleaseCandidatePreflight {
  candidateReady: boolean;
  assertAvailable(): Promise<void>;
}

function uniqueRelayUrls(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeUrl))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isInFlight(
  coverage: RelaySubscriptionCoverage,
  relay: string,
): boolean {
  const phase = coverage.get(relay)?.phase;
  return phase === undefined || phase === "initial" || phase === "catching-up";
}

function meetsTwoThirdsThreshold(covered: number, total: number): boolean {
  if (total === 0) return false;
  return covered >= Math.max(1, Math.min(3, Math.ceil((total * 2) / 3)));
}

function assessMailboxDiscovery(
  pubkey: string,
  configuredLookups: readonly string[],
  hasMailboxEvent: boolean,
): MailboxDiscovery {
  if (hasMailboxEvent) return "known";
  const coverage = userIdentityCoverage.get(pubkey);
  if (!coverage) return "checking";

  const lookups = uniqueRelayUrls(configuredLookups);
  const covered = lookups.filter((relay) => coverage.isCovered(relay)).length;
  if (meetsTwoThirdsThreshold(covered, lookups.length)) return "known";
  const possible =
    covered + lookups.filter((relay) => isInFlight(coverage, relay)).length;
  return meetsTwoThirdsThreshold(possible, lookups.length)
    ? "checking"
    : "unavailable";
}

function meetsSoftwareCoverageThreshold(
  coveredOutboxes: number,
  totalOutboxes: number,
  coveredFallbacks: number,
  totalFallbacks: number,
  coveredDistributionRelays: number,
): boolean {
  if (totalOutboxes === 0) {
    return meetsTwoThirdsThreshold(coveredFallbacks, totalFallbacks);
  }
  if (coveredOutboxes === 0) return false;
  if (coveredOutboxes === 1) return coveredDistributionRelays >= 2;
  return coveredOutboxes >= 3 || coveredOutboxes / totalOutboxes >= 0.5;
}

function phaseSummary(
  coverage: RelaySubscriptionCoverage,
  relays: readonly string[],
): string {
  const counts = new Map<string, number>();
  for (const relay of relays) {
    const phase = coverage.get(relay)?.phase ?? "not-checked";
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return [...counts].map(([phase, count]) => `${count} ${phase}`).join(", ");
}

function assessCoverage(
  scope: SoftwarePublisherRelayScope,
  coverage: RelaySubscriptionCoverage,
): CoverageAssessment {
  if (scope.mailboxDiscovery !== "known") {
    return {
      met: false,
      possible: scope.mailboxDiscovery === "checking",
      summary:
        scope.mailboxDiscovery === "checking"
          ? "mailbox discovery is still checking user-index relays"
          : "mailbox discovery could not confirm the publisher's outbox frontier",
    };
  }

  const coveredOutboxes = scope.outboxes.filter((relay) =>
    coverage.isCovered(relay),
  ).length;
  const coveredFallbacks = scope.fallbacks.filter((relay) =>
    coverage.isCovered(relay),
  ).length;
  const coveredDistributionRelays = scope.distributionRelays.filter((relay) =>
    coverage.isCovered(relay),
  ).length;
  const met = meetsSoftwareCoverageThreshold(
    coveredOutboxes,
    scope.outboxes.length,
    coveredFallbacks,
    scope.fallbacks.length,
    coveredDistributionRelays,
  );
  if (met) return { met: true, possible: true, summary: "ready" };

  const possibleOutboxes =
    coveredOutboxes +
    scope.outboxes.filter((relay) => isInFlight(coverage, relay)).length;
  const possibleFallbacks =
    coveredFallbacks +
    scope.fallbacks.filter((relay) => isInFlight(coverage, relay)).length;
  const possibleDistributionRelays =
    coveredDistributionRelays +
    scope.distributionRelays.filter((relay) => isInFlight(coverage, relay))
      .length;
  const possible = meetsSoftwareCoverageThreshold(
    possibleOutboxes,
    scope.outboxes.length,
    possibleFallbacks,
    scope.fallbacks.length,
    possibleDistributionRelays,
  );
  return {
    met: false,
    possible,
    summary: `outboxes: ${phaseSummary(coverage, scope.outboxes) || "none configured"}; distribution relays: ${phaseSummary(coverage, scope.distributionRelays) || "none configured"}`,
  };
}

async function waitForCoverage(
  scope$: Observable<SoftwarePublisherRelayScope>,
  coverage: RelaySubscriptionCoverage,
): Promise<SoftwarePublisherRelayScope> {
  const deadline = Date.now() + SOFTWARE_COVERAGE_SETTLEMENT_TIMEOUT_MS;
  for (;;) {
    const scope = await firstValueFrom(scope$.pipe(take(1)));
    const assessment = assessCoverage(scope, coverage);
    if (assessment.met) return scope;
    const remaining = deadline - Date.now();
    if (!assessment.possible || remaining <= 0) {
      throw new Error(
        `Software publication checks are not ready (${assessment.summary}). Please check those relays and try again.`,
      );
    }
    await firstValueFrom(
      race(
        merge(coverage.changes$, scope$.pipe(skip(1))).pipe(take(1)),
        timer(remaining),
      ),
    );
  }
}

async function hydrateCachedCoordinate(
  kind: typeof SOFTWARE_APPLICATION_KIND | typeof SOFTWARE_RELEASE_KIND,
  pubkey: string,
  identifier: string,
  store: IEventStore,
): Promise<void> {
  if (store.getReplaceable(kind, pubkey, identifier)) return;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never[]>((resolve) => {
    timeoutId = setTimeout(() => resolve([]), CACHE_HYDRATION_TIMEOUT_MS);
  });
  const events = await Promise.race([
    cacheRequest([
      { kinds: [kind], authors: [pubkey], "#d": [identifier] } as Filter,
    ]).catch(() => []),
    timeoutResult,
  ]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
  events.forEach((event) => store.add(event));
}

function castApplications(
  events: NostrEvent[],
  store: CastRefEventStore,
): SoftwareApplication[] {
  return events
    .flatMap((event) => {
      if (!isValidSoftwareApplication(event)) return [];
      try {
        return [new SoftwareApplication(event, store)];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function useSoftwarePublisherApplications(
  pubkey: string | undefined,
  repoRelayGroup: RelayGroup | undefined,
): AccountSoftwareApplications {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const scope$ = useMemo<
    Observable<SoftwarePublisherRelayScope> | undefined
  >(() => {
    if (!pubkey) return undefined;
    return combineLatest([
      store.model(MailboxesModel, pubkey).pipe(startWith(undefined)),
      fallbackRelays,
      lookupRelays,
      relayGroupUrls$(repoRelayGroup),
      userIdentityCoverage.changes$.pipe(startWith(undefined)),
    ]).pipe(
      map(([mailboxes, configuredFallbacks, configuredLookups, repoRelays]) => {
        const outboxes = uniqueRelayUrls(mailboxes?.outboxes ?? []);
        const outboxSet = new Set(outboxes);
        const fallbacks = uniqueRelayUrls(configuredFallbacks).filter(
          (relay) => !outboxSet.has(relay),
        );
        const distributionRelays = uniqueRelayUrls([
          ...fallbacks,
          ...repoRelays,
          ZAPSTORE_RELAY_URL,
        ]).filter((relay) => !outboxSet.has(relay));
        return {
          outboxes,
          fallbacks,
          distributionRelays,
          relays: uniqueRelayUrls([...outboxes, ...distributionRelays]),
          mailboxDiscovery: assessMailboxDiscovery(
            pubkey,
            configuredLookups,
            mailboxes !== undefined,
          ),
        };
      }),
      distinctUntilChanged(
        (left, right) =>
          sameStrings(left.outboxes, right.outboxes) &&
          sameStrings(left.fallbacks, right.fallbacks) &&
          sameStrings(left.distributionRelays, right.distributionRelays) &&
          left.mailboxDiscovery === right.mailboxDiscovery,
      ),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
  }, [pubkey, repoRelayGroup, store]);
  const coverage = useMemo(
    () =>
      pubkey && scope$
        ? createRelaySubscriptionCoverage({
            settlementTimeoutMs: SOFTWARE_COVERAGE_SETTLEMENT_TIMEOUT_MS,
          })
        : undefined,
    [pubkey, scope$],
  );
  const applicationFilter = useMemo<Filter | undefined>(
    () =>
      pubkey
        ? ({ kinds: [SOFTWARE_APPLICATION_KIND], authors: [pubkey] } as Filter)
        : undefined,
    [pubkey],
  );

  use$(() => {
    if (!pubkey || !scope$ || !coverage || !applicationFilter) return undefined;
    const relays$: Observable<string[]> = scope$.pipe(
      map((scope): string[] => scope.relays),
      distinctUntilChanged((left, right) => sameStrings(left, right)),
    );
    const source = resilientSubscription(
      pool,
      relays$,
      [applicationFilter, { kinds: [5], authors: [pubkey] } as Filter],
      {
        settle: false,
        paginate: false,
        retryCount: Infinity,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).pipe(onlyEvents(), mapEventsToStore(store), ignoreElements());

    return new Observable<never>((subscriber) => {
      const subscription = source.subscribe(subscriber);
      return () => {
        coverage.stop();
        subscription.unsubscribe();
      };
    });
  }, [applicationFilter, coverage, pubkey, scope$, store]);

  const applications =
    use$(() => {
      if (!applicationFilter) return of([]);
      return store
        .timeline([applicationFilter])
        .pipe(map((events) => castApplications(events, castStore)));
    }, [applicationFilter, store]) ?? [];

  const settled =
    use$(() => {
      if (!scope$ || !coverage) return of(true);
      return combineLatest([
        scope$,
        coverage.changes$.pipe(startWith(undefined)),
      ]).pipe(
        map(([scope]) => {
          const assessment = assessCoverage(scope, coverage);
          return assessment.met || !assessment.possible;
        }),
        distinctUntilChanged(),
      );
    }, [coverage, scope$]) ?? false;

  const storeRef = useRef(store);
  storeRef.current = store;
  const executeApplication = useCallback(
    async <T>(
      appId: string,
      expectedEventId: string | null,
      action: (snapshot: SoftwareApplicationSnapshot) => Promise<T>,
    ): Promise<T> => {
      if (!pubkey || !scope$ || !coverage) {
        throw new Error("Software publication preflight is not ready.");
      }
      const scope = await waitForCoverage(scope$, coverage);
      await hydrateCachedCoordinate(
        SOFTWARE_APPLICATION_KIND,
        pubkey,
        appId,
        storeRef.current,
      );
      const event = storeRef.current.getReplaceable(
        SOFTWARE_APPLICATION_KIND,
        pubkey,
        appId,
      );
      if ((event?.id ?? null) !== expectedEventId) {
        throw new Error(
          "This software application changed after you began editing. Review the latest version and try again.",
        );
      }
      return action({ event, outboxes: scope.outboxes, relays: scope.relays });
    },
    [coverage, pubkey, scope$],
  );

  const preflight = useMemo<SoftwarePublisherPreflight | undefined>(
    () =>
      pubkey && scope$ && coverage
        ? { pubkey, scope$, coverage, executeApplication }
        : undefined,
    [coverage, executeApplication, pubkey, scope$],
  );

  return { applications, settled, preflight };
}

export function useSoftwareReleaseCandidatePreflight(
  publisherPreflight: SoftwarePublisherPreflight | undefined,
  appId: string | undefined,
  version: string | undefined,
  enabled: boolean,
): SoftwareReleaseCandidatePreflight {
  const store = useEventStore();
  const requestedIdentifier =
    enabled && appId && version ? `${appId}@${version}` : undefined;
  const [identifier, setIdentifier] = useState<string | undefined>();

  useEffect(() => {
    if (!requestedIdentifier) {
      setIdentifier(undefined);
      return;
    }
    const timeoutId = setTimeout(() => setIdentifier(requestedIdentifier), 400);
    return () => clearTimeout(timeoutId);
  }, [requestedIdentifier]);

  const candidateReady =
    requestedIdentifier !== undefined && requestedIdentifier === identifier;
  const coverage = useMemo(
    () =>
      publisherPreflight && identifier
        ? createRelaySubscriptionCoverage({
            settlementTimeoutMs: SOFTWARE_COVERAGE_SETTLEMENT_TIMEOUT_MS,
          })
        : undefined,
    [identifier, publisherPreflight],
  );

  use$(() => {
    if (!publisherPreflight || !identifier || !coverage) return undefined;
    const relays$: Observable<string[]> = publisherPreflight.scope$.pipe(
      map((scope): string[] => scope.relays),
      distinctUntilChanged((left, right) => sameStrings(left, right)),
    );
    const source = resilientSubscription(
      pool,
      relays$,
      [
        {
          kinds: [SOFTWARE_RELEASE_KIND],
          authors: [publisherPreflight.pubkey],
          "#d": [identifier],
        } as Filter,
      ],
      {
        settle: false,
        paginate: false,
        retryCount: Infinity,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).pipe(onlyEvents(), mapEventsToStore(store), ignoreElements());

    return new Observable<never>((subscriber) => {
      const subscription: Subscription = source.subscribe(subscriber);
      return () => {
        coverage.stop();
        subscription.unsubscribe();
      };
    });
  }, [coverage, identifier, publisherPreflight, store]);

  const assertAvailable = useCallback(async () => {
    if (
      !publisherPreflight ||
      !requestedIdentifier ||
      !candidateReady ||
      !identifier ||
      !coverage
    ) {
      throw new Error("Choose an application and release version to check.");
    }
    await Promise.all([
      waitForCoverage(publisherPreflight.scope$, publisherPreflight.coverage),
      waitForCoverage(publisherPreflight.scope$, coverage),
    ]);
    await hydrateCachedCoordinate(
      SOFTWARE_RELEASE_KIND,
      publisherPreflight.pubkey,
      identifier,
      store,
    );
    const existing = store.getReplaceable(
      SOFTWARE_RELEASE_KIND,
      publisherPreflight.pubkey,
      identifier,
    );
    if (existing) {
      throw new Error("This application already has that release version.");
    }
  }, [
    candidateReady,
    coverage,
    identifier,
    publisherPreflight,
    requestedIdentifier,
    store,
  ]);

  return { candidateReady, assertAvailable };
}
