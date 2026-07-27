import { useSyncExternalStore } from "react";
import {
  type MaintainerAcceptanceJob,
  getMaintainerAcceptanceJob,
  getMaintainerAcceptanceJobs,
  maintainerAcceptanceKey,
  subscribeMaintainerAcceptanceJobs,
} from "@/services/maintainerAcceptance";

const EMPTY_JOBS: MaintainerAcceptanceJob[] = [];

export function useMaintainerAcceptanceJob(
  accountPubkey: string,
  invitationAnchor: string,
  dTag: string,
) {
  const key = maintainerAcceptanceKey(accountPubkey, invitationAnchor, dTag);
  return useSyncExternalStore(
    subscribeMaintainerAcceptanceJobs,
    () => getMaintainerAcceptanceJob(key),
    () => undefined,
  );
}

export function useMaintainerAcceptanceJobs() {
  return useSyncExternalStore(
    subscribeMaintainerAcceptanceJobs,
    getMaintainerAcceptanceJobs,
    () => EMPTY_JOBS,
  );
}
