import { useEffect, useMemo } from "react";
import { mapEventsToStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import { tap } from "rxjs/operators";

import { useGitPool } from "@/hooks/useGitPool";
import { useMaintainerAcceptanceJobs } from "@/hooks/useMaintainerAcceptanceJob";
import { use$ } from "@/hooks/use$";
import type { RepoStateRef } from "@/lib/nip34";
import type { UrlState } from "@/lib/git-grasp-pool";
import {
  clearMaintainerAcceptanceJob,
  isMaintainerAcceptanceJobExpired,
  MAINTAINER_ACCEPTANCE_JOB_MAX_AGE_MS,
  recordMaintainerAcceptanceBroadcast,
  recordMaintainerAcceptanceCloneSync,
  runMaintainerAcceptanceDelivery,
  settleMaintainerAcceptanceJob,
  type MaintainerAcceptanceJob,
} from "@/services/maintainerAcceptance";
import { eventStore, pool } from "@/services/nostr";
import { resilientSubscription } from "@/lib/resilientSubscription";

const COMPLETED_JOB_VISIBLE_MS = 60_000;

/**
 * Keep invitation publication, broadcast confirmation, and Git provisioning
 * alive independently of the repository page. This component is mounted once
 * at the application boundary, so internal navigation cannot pause an active
 * acceptance job.
 */
export function MaintainerAcceptanceMonitor() {
  const jobs = useMaintainerAcceptanceJobs();
  return jobs.map((job) => (
    <MaintainerAcceptanceJobMonitor key={job.key} job={job} />
  ));
}

function MaintainerAcceptanceJobMonitor({
  job,
}: {
  job: MaintainerAcceptanceJob;
}) {
  const active = job.phase !== "quarantined";
  const relayKey = job.relayUrls.join(",");
  const shouldPollGit =
    active &&
    job.deliveredRelayUrls.length > 0 &&
    !isMaintainerAcceptanceJobExpired(job);
  const { poolState, pool: gitPool } = useGitPool(
    shouldPollGit ? job.cloneUrls : [],
    {
      knownHeadCommit: job.knownHeadCommit,
      stateRefs: job.stateRefs,
      stateCreatedAt: job.stateCreatedAt,
      expectRepositoryProvisioning: shouldPollGit,
    },
  );

  useEffect(() => {
    if (!gitPool || !shouldPollGit) return;
    return () => gitPool.setRepositoryProvisioningExpected(false);
  }, [gitPool, shouldPollGit]);

  use$(() => {
    if (!active || job.relayUrls.length === 0) return undefined;
    const filter: Filter = {
      kinds: [job.announcement.kind],
      authors: [job.accountPubkey],
      "#d": [job.dTag],
    } as Filter;

    return resilientSubscription(pool, job.relayUrls, [filter]).pipe(
      onlyEvents(),
      tap((event) => recordMaintainerAcceptanceBroadcast(job.key, event)),
      mapEventsToStore(eventStore),
    );
  }, [
    active,
    job.accountPubkey,
    job.announcement.id,
    job.dTag,
    job.key,
    relayKey,
  ]);

  useEffect(() => {
    const expiresAt = job.createdAt + MAINTAINER_ACCEPTANCE_JOB_MAX_AGE_MS;
    if (Date.now() >= expiresAt) {
      clearMaintainerAcceptanceJob(job.key);
      return;
    }

    const expiryTimeout = window.setTimeout(
      () => clearMaintainerAcceptanceJob(job.key),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(expiryTimeout);
  }, [job.createdAt, job.key]);

  useEffect(() => {
    if (!active) return;
    const allDelivered = job.relayUrls.every((url) =>
      job.deliveredRelayUrls.includes(url),
    );
    if (allDelivered) return;

    const retryAt = job.nextDeliveryRetryAt ?? Date.now();
    const timeout = window.setTimeout(
      () => void runMaintainerAcceptanceDelivery(job.key),
      Math.max(0, retryAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [
    job.createdAt,
    active,
    job.deliveredRelayUrls,
    job.key,
    job.nextDeliveryRetryAt,
    job.relayUrls,
  ]);

  const newlySyncedCloneUrls = useMemo(
    () =>
      job.cloneUrls.filter(
        (cloneUrl) =>
          !job.syncedCloneUrls.includes(cloneUrl) &&
          cloneUrlMatchesState(poolState.urls[cloneUrl], job.stateRefs),
      ),
    [job.cloneUrls, job.stateRefs, job.syncedCloneUrls, poolState.urls],
  );

  useEffect(() => {
    if (!active) return;
    for (const cloneUrl of newlySyncedCloneUrls) {
      recordMaintainerAcceptanceCloneSync(job.key, cloneUrl);
    }
  }, [active, job.key, newlySyncedCloneUrls]);

  useEffect(() => {
    if (!active) return;
    settleMaintainerAcceptanceJob(job.key);
  }, [
    active,
    job.broadcastReceived,
    job.deliveredRelayUrls,
    job.key,
    job.relayUrls,
    job.syncedCloneUrls,
    job.cloneUrls,
  ]);

  useEffect(() => {
    if (!job.completedAt) return;
    const timeout = window.setTimeout(
      () => clearMaintainerAcceptanceJob(job.key),
      Math.max(0, job.completedAt + COMPLETED_JOB_VISIBLE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [job.completedAt, job.key]);

  return null;
}

function cloneUrlMatchesState(
  urlState: UrlState | undefined,
  stateRefs: RepoStateRef[],
): boolean {
  if (urlState?.status !== "ok" || !urlState.infoRefs) return false;
  if (stateRefs.length === 0) return true;

  return stateRefs.every(({ name, commitId }) => {
    const advertisedCommit =
      urlState.infoRefs?.refs[`${name}^{}`] ?? urlState.infoRefs?.refs[name];
    return advertisedCommit === commitId;
  });
}
