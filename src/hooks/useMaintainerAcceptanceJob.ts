import { useSyncExternalStore } from "react";
import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import { use$ } from "@/hooks/use$";
import { resilientSubscription } from "@/lib/resilientSubscription";
import {
  getMaintainerAcceptanceJob,
  maintainerAcceptanceKey,
  subscribeMaintainerAcceptanceJobs,
} from "@/services/maintainerAcceptance";
import { eventStore, pool } from "@/services/nostr";

export function useMaintainerAcceptanceJob(
  accountPubkey: string,
  dTag: string,
) {
  const key = maintainerAcceptanceKey(accountPubkey, dTag);
  const job = useSyncExternalStore(
    subscribeMaintainerAcceptanceJobs,
    () => getMaintainerAcceptanceJob(key),
    () => undefined,
  );
  const relayKey = job?.relayUrls.join(",") ?? "";

  use$(() => {
    if (!job || job.relayUrls.length === 0) return undefined;
    const filter: Filter = {
      kinds: [job.announcement.kind],
      authors: [accountPubkey],
      "#d": [dTag],
    } as Filter;

    return resilientSubscription(pool, job.relayUrls, [filter]).pipe(
      onlyEvents(),
      mapEventsToStore(eventStore),
    );
  }, [accountPubkey, dTag, job?.announcement.id, relayKey]);

  return job;
}
