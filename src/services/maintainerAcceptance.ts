import type { NostrEvent } from "nostr-tools";
import type { RepoStateRef } from "@/lib/nip34";
import { pool } from "@/services/nostr";

// Deliberately do not hydrate v2 jobs: they contain legacy roster-shaped
// announcements that must never be delivered under the reciprocal model.
const STORAGE_KEY = "gitworkshop:maintainer-acceptance:v3";
const MAX_STORED_JOBS = 20;
export const MAINTAINER_ACCEPTANCE_JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RETRY_INITIAL_MS = 5_000;
const DELIVERY_RETRY_MAX_MS = 5 * 60 * 1000;

export type MaintainerAcceptancePhase =
  | "publishing"
  | "delivery-error"
  | "syncing"
  | "synced";

export interface MaintainerAcceptanceJob {
  key: string;
  accountPubkey: string;
  invitationAnchor: string;
  dTag: string;
  announcement: NostrEvent;
  cloneUrls: string[];
  relayUrls: string[];
  deliveredRelayUrls: string[];
  syncedCloneUrls: string[];
  relayErrors: Record<string, string>;
  deliveryAttempt: number;
  nextDeliveryRetryAt?: number;
  broadcastReceived: boolean;
  phase: MaintainerAcceptancePhase;
  stateRefs: RepoStateRef[];
  knownHeadCommit?: string;
  stateCreatedAt?: number;
  createdAt: number;
  completedAt?: number;
  updatedAt: number;
}

export interface RelayDelivery {
  relayUrl: string;
  ok: boolean;
  message: string;
}

export interface MaintainerAcceptanceDeliveryDependencies {
  publishRelay(event: NostrEvent, relayUrl: string): Promise<RelayDelivery>;
}

const jobs = new Map<string, MaintainerAcceptanceJob>();
const listeners = new Set<() => void>();
const deliveryRuns = new Map<
  string,
  Promise<MaintainerAcceptanceJob | undefined>
>();
let hydrated = false;
let jobSnapshot: MaintainerAcceptanceJob[] = [];

export function maintainerAcceptanceKey(
  accountPubkey: string,
  invitationAnchor: string,
  dTag: string,
): string {
  return `${accountPubkey}:${invitationAnchor}:${dTag}`;
}

function storage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isStoredJob(value: unknown): value is MaintainerAcceptanceJob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MaintainerAcceptanceJob>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.accountPubkey === "string" &&
    typeof candidate.invitationAnchor === "string" &&
    typeof candidate.dTag === "string" &&
    !!candidate.announcement &&
    Array.isArray(candidate.cloneUrls) &&
    Array.isArray(candidate.relayUrls) &&
    Array.isArray(candidate.deliveredRelayUrls) &&
    !!candidate.relayErrors &&
    typeof candidate.relayErrors === "object" &&
    typeof candidate.deliveryAttempt === "number" &&
    typeof candidate.broadcastReceived === "boolean" &&
    (candidate.phase === "publishing" ||
      candidate.phase === "delivery-error" ||
      candidate.phase === "syncing" ||
      candidate.phase === "synced") &&
    Array.isArray(candidate.stateRefs) &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;

  const persisted = storage()?.getItem(STORAGE_KEY);
  if (!persisted) return;

  try {
    const parsed: unknown = JSON.parse(persisted);
    if (!Array.isArray(parsed)) return;
    const cutoff = Date.now() - MAINTAINER_ACCEPTANCE_JOB_MAX_AGE_MS;
    for (const value of parsed) {
      if (!isStoredJob(value) || value.createdAt < cutoff) continue;
      jobs.set(value.key, {
        ...value,
        syncedCloneUrls: Array.isArray(value.syncedCloneUrls)
          ? value.syncedCloneUrls
          : [],
        phase: value.phase === "publishing" ? "delivery-error" : value.phase,
        nextDeliveryRetryAt:
          value.phase === "publishing" ? Date.now() : value.nextDeliveryRetryAt,
        relayErrors:
          value.phase === "publishing"
            ? {
                ...value.relayErrors,
                interrupted:
                  "Publishing was interrupted. Retry to finish delivering the invitation.",
              }
            : value.relayErrors,
      });
    }
    refreshSnapshot();
  } catch {
    storage()?.removeItem(STORAGE_KEY);
  }
}

function refreshSnapshot(): void {
  jobSnapshot = Array.from(jobs.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

function persist(): void {
  const values = jobSnapshot.slice(0, MAX_STORED_JOBS);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // In-memory state still preserves the operation for this browser session.
  }
}

function emit(): void {
  refreshSnapshot();
  persist();
  for (const listener of listeners) listener();
}

export function getMaintainerAcceptanceJobs(): MaintainerAcceptanceJob[] {
  ensureHydrated();
  return jobSnapshot;
}

export function getMaintainerAcceptanceJob(
  key: string,
): MaintainerAcceptanceJob | undefined {
  ensureHydrated();
  return jobs.get(key);
}

export function subscribeMaintainerAcceptanceJobs(
  listener: () => void,
): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveMaintainerAcceptanceJob(
  job: MaintainerAcceptanceJob,
): void {
  ensureHydrated();
  jobs.set(job.key, job);
  emit();
}

export function updateMaintainerAcceptanceJob(
  key: string,
  update: Partial<MaintainerAcceptanceJob>,
): MaintainerAcceptanceJob | undefined {
  const current = getMaintainerAcceptanceJob(key);
  if (!current) return undefined;
  const next = { ...current, ...update, updatedAt: Date.now() };
  jobs.set(key, next);
  emit();
  return next;
}

export function clearMaintainerAcceptanceJob(key: string): void {
  ensureHydrated();
  if (!jobs.delete(key)) return;
  emit();
}

export function isMaintainerAcceptanceJobExpired(
  job: MaintainerAcceptanceJob,
  now = Date.now(),
): boolean {
  return now - job.createdAt >= MAINTAINER_ACCEPTANCE_JOB_MAX_AGE_MS;
}

function responseAccepted(ok: boolean, message: string | undefined): boolean {
  return (
    ok ||
    /duplicate|already (?:have|exists|stored)|event already/i.test(
      message ?? "",
    )
  );
}

export async function publishAcceptanceToRelay(
  event: NostrEvent,
  relayUrl: string,
): Promise<RelayDelivery> {
  try {
    const responses = await pool.publish([relayUrl], event);
    const accepted = responses.find((response) =>
      responseAccepted(response.ok, response.message),
    );
    if (accepted) {
      return {
        relayUrl,
        ok: true,
        message: accepted.message ?? "accepted",
      };
    }

    return {
      relayUrl,
      ok: false,
      message:
        responses
          .map((response) => response.message)
          .filter((message): message is string => !!message)
          .join("; ") || "Relay did not accept the announcement.",
    };
  } catch (error) {
    return {
      relayUrl,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const defaultDependencies: MaintainerAcceptanceDeliveryDependencies = {
  publishRelay: publishAcceptanceToRelay,
};

/**
 * Deliver a signed reciprocal announcement and transition its durable job.
 *
 * Git-ref polling can begin as soon as one selected GRASP relay acknowledges
 * the event. Successful targets are retained across retries so a transient
 * failure on one server never needlessly republishes to the rest.
 */
export async function deliverMaintainerAcceptance(
  key: string,
  dependencies: MaintainerAcceptanceDeliveryDependencies = defaultDependencies,
): Promise<MaintainerAcceptanceJob | undefined> {
  const current = getMaintainerAcceptanceJob(key);
  if (!current) return undefined;

  updateMaintainerAcceptanceJob(key, {
    phase:
      current.deliveredRelayUrls.length > 0 || current.phase === "synced"
        ? current.phase
        : "publishing",
    relayErrors: {},
    nextDeliveryRetryAt: undefined,
  });

  const pendingRelayUrls = current.relayUrls.filter(
    (relayUrl) => !current.deliveredRelayUrls.includes(relayUrl),
  );
  const deliveries = await Promise.all(
    pendingRelayUrls.map((relayUrl) =>
      dependencies.publishRelay(current.announcement, relayUrl),
    ),
  );

  const latest = getMaintainerAcceptanceJob(key);
  if (!latest || latest.announcement.id !== current.announcement.id) {
    return latest;
  }

  const deliveredRelayUrls = Array.from(
    new Set([
      ...latest.deliveredRelayUrls,
      ...deliveries
        .filter((delivery) => delivery.ok)
        .map((delivery) => delivery.relayUrl),
    ]),
  );
  const relayErrors = Object.fromEntries(
    deliveries
      .filter((delivery) => !delivery.ok)
      .map((delivery) => [delivery.relayUrl, delivery.message]),
  );

  const everyRelayDelivered = latest.relayUrls.every((relayUrl) =>
    deliveredRelayUrls.includes(relayUrl),
  );
  const anyRelayDelivered = deliveredRelayUrls.length > 0;
  const deliveryAttempt =
    everyRelayDelivered || deliveries.length === 0
      ? 0
      : latest.deliveryAttempt + 1;
  const nextDeliveryRetryAt = everyRelayDelivered
    ? undefined
    : Date.now() +
      Math.min(
        DELIVERY_RETRY_INITIAL_MS * 2 ** Math.max(0, deliveryAttempt - 1),
        DELIVERY_RETRY_MAX_MS,
      );
  return updateMaintainerAcceptanceJob(key, {
    deliveredRelayUrls,
    relayErrors,
    deliveryAttempt,
    nextDeliveryRetryAt,
    phase:
      latest.phase === "synced"
        ? "synced"
        : anyRelayDelivered
          ? "syncing"
          : "delivery-error",
  });
}

export function runMaintainerAcceptanceDelivery(
  key: string,
): Promise<MaintainerAcceptanceJob | undefined> {
  const existing = deliveryRuns.get(key);
  if (existing) return existing;

  const run = deliverMaintainerAcceptance(key).finally(() => {
    deliveryRuns.delete(key);
  });
  deliveryRuns.set(key, run);
  return run;
}

export function recordMaintainerAcceptanceBroadcast(
  key: string,
  event: NostrEvent,
): MaintainerAcceptanceJob | undefined {
  const job = getMaintainerAcceptanceJob(key);
  if (!job || job.broadcastReceived || event.id !== job.announcement.id) {
    return job;
  }
  return updateMaintainerAcceptanceJob(key, { broadcastReceived: true });
}

export function recordMaintainerAcceptanceCloneSync(
  key: string,
  cloneUrl: string,
): MaintainerAcceptanceJob | undefined {
  const job = getMaintainerAcceptanceJob(key);
  if (!job || !job.cloneUrls.includes(cloneUrl)) return job;
  if (job.syncedCloneUrls.includes(cloneUrl)) return job;
  const syncedCloneUrls = Array.from(
    new Set([...job.syncedCloneUrls, cloneUrl]),
  );
  return updateMaintainerAcceptanceJob(key, {
    syncedCloneUrls,
    phase: "synced",
  });
}

export function settleMaintainerAcceptanceJob(
  key: string,
): MaintainerAcceptanceJob | undefined {
  const job = getMaintainerAcceptanceJob(key);
  if (!job) return undefined;
  const allDelivered = job.relayUrls.every((url) =>
    job.deliveredRelayUrls.includes(url),
  );
  const allSynced = job.cloneUrls.every((url) =>
    job.syncedCloneUrls.includes(url),
  );
  if (!allDelivered || !allSynced || !job.broadcastReceived) return job;
  if (job.completedAt) return job;
  return updateMaintainerAcceptanceJob(key, { completedAt: Date.now() });
}
