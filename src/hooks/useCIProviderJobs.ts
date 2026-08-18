import type { CastRefEventStore } from "applesauce-common/casts/cast";
import type { Filter } from "applesauce-core/helpers";
import type { NostrEvent } from "nostr-tools";
import { of } from "rxjs";
import { map } from "rxjs/operators";
import { CIJobResultEvent, isValidCIJobResult } from "@/casts/CIJobResult";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import { CI_JOB_RESULT_KIND } from "@/lib/ci";
import { loadRelayQueryUntilSettled } from "@/lib/relayQuerySettlement";
import { pool } from "@/services/nostr";
import { gitIndexRelays, lookupRelays } from "@/services/settings";

const JOB_RESULT_LIMIT = 100;

export interface CIProviderJobsState {
  jobs: readonly CIJobResultEvent[];
  settled: boolean;
  partial: boolean;
}

function isRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

/** Load recent signed Job Results for one execution identity. */
export function useCIProviderJobs(
  pubkey: string | undefined,
  relayHints: readonly string[] = [],
): CIProviderJobsState {
  const store = useEventStore();
  const castStore = store as unknown as CastRefEventStore;
  const indexes = use$(() => gitIndexRelays, []) ?? [];
  const lookup = use$(() => lookupRelays, []) ?? [];
  const discoveryRelays = [...new Set([...indexes, ...lookup])];
  const discoveryRelayKey = discoveryRelays.join(",");

  const mailboxQuery = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      discoveryRelays,
      [{ kinds: [10002], authors: [pubkey] } as Filter],
      store,
    );
  }, [pubkey, discoveryRelayKey, store]);

  const mailboxes = use$(() => {
    if (!pubkey) return undefined;
    return store.mailboxes(pubkey);
  }, [pubkey, store]);
  const outboxes = mailboxes?.outboxes ?? [];
  const relayHintKey = [...relayHints].sort().join(",");
  const outboxKey = [...outboxes].sort().join(",");
  const jobRelays = [
    ...new Set([...relayHints.filter(isRelayUrl), ...outboxes, ...indexes]),
  ];
  const jobRelayKey = jobRelays.join(",");

  const jobsQuery = use$(() => {
    if (!pubkey) {
      return of({ settled: true, relayCount: 0, failedRelayCount: 0 });
    }
    return loadRelayQueryUntilSettled(
      pool,
      jobRelays,
      [
        {
          kinds: [CI_JOB_RESULT_KIND],
          authors: [pubkey],
          limit: JOB_RESULT_LIMIT,
        } as Filter,
      ],
      store,
    );
  }, [pubkey, jobRelayKey, outboxKey, relayHintKey, store]);

  const jobs =
    use$(() => {
      if (!pubkey) return of([] as CIJobResultEvent[]);
      return store
        .timeline([
          {
            kinds: [CI_JOB_RESULT_KIND],
            authors: [pubkey],
          } as Filter,
        ])
        .pipe(
          map((events) =>
            (events as NostrEvent[])
              .flatMap((event) =>
                isValidCIJobResult(event)
                  ? [new CIJobResultEvent(event, castStore)]
                  : [],
              )
              .sort((a, b) => b.event.created_at - a.event.created_at)
              .slice(0, JOB_RESULT_LIMIT),
          ),
        );
    }, [pubkey, store]) ?? [];

  const settled = mailboxQuery?.settled === true && jobsQuery?.settled === true;
  return {
    jobs,
    settled,
    partial:
      (mailboxQuery?.failedRelayCount ?? 0) > 0 ||
      (jobsQuery?.failedRelayCount ?? 0) > 0 ||
      (settled && (jobsQuery?.relayCount ?? 0) === 0),
  };
}
