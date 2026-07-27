import type { NostrEvent } from "nostr-tools";
import type { RepoStateRef } from "@/lib/nip34";
import { pool } from "@/services/nostr";

const STORAGE_KEY = "gitworkshop:maintainer-acceptance:v1";
const MAX_STORED_JOBS = 20;
const JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MaintainerAcceptancePhase =
  | "publishing"
  | "delivery-error"
  | "syncing"
  | "synced";

export interface MaintainerAcceptanceJob {
  key: string;
  accountPubkey: string;
  dTag: string;
  announcement: NostrEvent;
  cloneUrls: string[];
  relayUrls: string[];
  deliveredRelayUrls: string[];
  syncedCloneUrls: string[];
  relayErrors: Record<string, string>;
  phase: MaintainerAcceptancePhase;
  stateRefs: RepoStateRef[];
  knownHeadCommit?: string;
  stateCreatedAt?: number;
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
let hydrated = false;

export function maintainerAcceptanceKey(
  accountPubkey: string,
  dTag: string,
): string {
  return `${accountPubkey}:${dTag}`;
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
    typeof candidate.dTag === "string" &&
    !!candidate.announcement &&
    Array.isArray(candidate.cloneUrls) &&
    Array.isArray(candidate.relayUrls) &&
    Array.isArray(candidate.deliveredRelayUrls) &&
    !!candidate.relayErrors &&
    typeof candidate.relayErrors === "object" &&
    (candidate.phase === "publishing" ||
      candidate.phase === "delivery-error" ||
      candidate.phase === "syncing" ||
      candidate.phase === "synced") &&
    Array.isArray(candidate.stateRefs) &&
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
    const cutoff = Date.now() - JOB_MAX_AGE_MS;
    for (const value of parsed) {
      if (!isStoredJob(value) || value.updatedAt < cutoff) continue;
      jobs.set(value.key, {
        ...value,
        syncedCloneUrls: Array.isArray(value.syncedCloneUrls)
          ? value.syncedCloneUrls
          : [],
        phase: value.phase === "publishing" ? "delivery-error" : value.phase,
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
  } catch {
    storage()?.removeItem(STORAGE_KEY);
  }
}

function persist(): void {
  const values = Array.from(jobs.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_JOBS);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // In-memory state still preserves the operation for this browser session.
  }
}

function emit(): void {
  persist();
  for (const listener of listeners) listener();
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
 * Every selected GRASP relay must acknowledge the event before the job enters
 * the Git-ref syncing phase. Successful targets are retained across retries so
 * a transient failure on one server never needlessly republishes to the rest.
 */
export async function deliverMaintainerAcceptance(
  key: string,
  dependencies: MaintainerAcceptanceDeliveryDependencies = defaultDependencies,
): Promise<MaintainerAcceptanceJob | undefined> {
  const current = getMaintainerAcceptanceJob(key);
  if (!current) return undefined;

  updateMaintainerAcceptanceJob(key, {
    phase: "publishing",
    relayErrors: {},
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
  return updateMaintainerAcceptanceJob(key, {
    deliveredRelayUrls,
    relayErrors,
    phase: everyRelayDelivered ? "syncing" : "delivery-error",
  });
}
