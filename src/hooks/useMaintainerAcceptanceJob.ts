import { useEffect, useSyncExternalStore } from "react";
import {
  getMaintainerAcceptanceJob,
  maintainerAcceptanceKey,
  subscribeMaintainerAcceptanceJobs,
} from "@/services/maintainerAcceptance";
import { eventStore } from "@/services/nostr";

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
  const announcement = job?.announcement;

  useEffect(() => {
    if (announcement) eventStore.add(announcement);
  }, [announcement]);

  return job;
}
