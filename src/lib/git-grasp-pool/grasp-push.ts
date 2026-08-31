/**
 * git-grasp-pool — multi-server Grasp push.
 *
 * Pushes one primary ref update (plus any state-event refs a server is
 * missing) to every announced Grasp git server, tolerating servers that lag
 * behind the signed Nostr state event:
 *
 *   - A server whose branch head already matches the target is a no-op.
 *   - A server missing the branch entirely (fresh mirror) gets the branch
 *     created with a bounded catch-up pack of recent history.
 *   - A server whose head differs from the consensus old hash (missed earlier
 *     pushes, or diverged) is brought in line with the signed state event —
 *     the state event is the source of truth, even when that is not a
 *     fast-forward for that mirror.
 *   - State-event refs the server is missing (tags, non-default branches) are
 *     pushed alongside the primary update, fetching any objects the shared
 *     pack does not already contain.
 *
 * The fan-out (`pushRefUpdateToGraspServers`) guards the SIGNED STATE with
 * `assertFastForwardSafe` before anything is sent: the state event must never
 * advance to a tip that does not descend from the current state tip.
 * Individual mirrors may be force-aligned; the signed state may not.
 *
 * The fan-out resolves as soon as one server accepts; slow or unreachable
 * mirrors keep syncing in the background and report through `onUpdate` /
 * `summary.settled` rather than holding up the caller.
 *
 * Extracted from `MergePanel` so it can run without React and be reused by
 * any flow that pushes browser-created objects to Grasp servers.
 */

import type { NostrEvent } from "nostr-tools";
import { createPackfile, type PackableObject } from "@/lib/git-packfile";
import {
  getReceivePackRefs,
  pushToGitServer,
  ZERO_HASH,
  type RefUpdate,
} from "@/lib/git-push";
import { assertFastForwardSafe } from "@/lib/patch-merge";
import {
  gitAuthorizationHeaders,
  type GitHttpAuthorizationProvider,
} from "@/lib/git-http-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of pushing to a single Grasp server. */
export interface PushDeliveryOutcome {
  cloneUrl: string;
  ok: boolean;
  message: string;
  /** True while the push to this server is still in flight. */
  pending?: boolean;
}

/** Aggregate outcome of pushing to every Grasp server. */
export interface PushDeliverySummary {
  outcomes: PushDeliveryOutcome[];
  successCount: number;
  totalCount: number;
  /** Servers whose push is still in flight (background catch-up). */
  pendingCount: number;
  /**
   * Resolves with the final summary once every server has settled. Never
   * rejects — per-server failures are reported in the outcomes.
   */
  settled: Promise<PushDeliverySummary>;
}

/** A ref the servers should advertise after the push completes. */
export interface DesiredStateRef {
  refName: string;
  /**
   * The exact object ID the ref must point to. Annotated tags use the tag
   * object ID, not the peeled commit.
   */
  commitHash: string;
  /**
   * The peeled commit hash for annotated tags, when the state event declares
   * one via ref^{}.
   */
  peeledCommitHash?: string;
}

/**
 * Fetches the extra objects a lagging server needs: everything from
 * `stopAtCommitId` (exclusive; empty string = unbounded but depth-capped) up
 * to `tipCommitId`. Returns null when the objects cannot be fetched.
 */
export type CatchUpObjectFetcher = (
  tipCommitId: string,
  stopAtCommitId: string,
  includeObjectIds?: string[],
  signal?: AbortSignal,
) => Promise<PackableObject[] | null>;

/**
 * Shared context for pushing one ref update to every Grasp server.
 *
 * `baseObjects` / `sharedPackfile` cover the expected case (server ref at the
 * consensus old hash). `desiredRefs` is the complete post-push state-event ref
 * set. `fetchCatchUpObjects` fetches the extra objects a lagging server needs:
 * everything from its actual head up to the consensus old hash, plus missing
 * state-event refs such as tags or non-default branches.
 */
export interface GraspPushContext {
  baseObjects: PackableObject[];
  sharedPackfile: Uint8Array;
  desiredRefs: DesiredStateRef[];
  fetchCatchUpObjects: CatchUpObjectFetcher;
  authorizationProvider?: GitHttpAuthorizationProvider;
  signal: AbortSignal;
}

/** Inputs for {@link pushRefUpdateToGraspServers}. */
export interface PushRefUpdateParams {
  /** Grasp server clone URLs to push to. */
  cloneUrls: string[];
  /** All objects required for the primary update (deduped internally). */
  objects: PackableObject[];
  /** The primary ref update (consensus old hash → new hash). */
  refUpdate: RefUpdate;
  /**
   * Current kind:30618 repository state. Its refs (plus the primary update)
   * form the complete post-push ref set every server is verified against.
   */
  currentStateEvent?: NostrEvent | null;
  /** Fetches catch-up objects for lagging or fresh servers. */
  fetchCatchUpObjects: CatchUpObjectFetcher;
  authorizationProvider?: GitHttpAuthorizationProvider;
  /** Cancels authorization, receive-pack, verification, and background mirrors. */
  signal?: AbortSignal;
  /**
   * Called with a fresh summary snapshot every time a server settles,
   * including servers that settle after the returned promise has already
   * resolved with the first success.
   */
  onUpdate?: (summary: PushDeliverySummary) => void;
}

// ---------------------------------------------------------------------------
// URL formatting (shared with UI delivery summaries)
// ---------------------------------------------------------------------------

/**
 * Extract a hostname from common HTTP(S), SSH, and scp-style git remote URLs.
 */
export function getGitRemoteHostname(cloneUrl: string): string | undefined {
  try {
    return new URL(cloneUrl).hostname;
  } catch {
    const sshMatch = cloneUrl.match(/^(?:[^@\s]+@)?([^:\s]+):/);
    if (sshMatch?.[1]) return sshMatch[1];

    const schemeMatch = cloneUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
    return schemeMatch?.[1];
  }
}

/** Hostname of a clone URL, falling back to the raw URL. */
export function formatCloneUrlHost(cloneUrl: string): string {
  return getGitRemoteHostname(cloneUrl) ?? cloneUrl;
}

/** One-line human summary of a push delivery. */
export function summarizePushDelivery(summary: PushDeliverySummary): string {
  const base = `Pushed to ${summary.successCount}/${summary.totalCount} Grasp server${summary.totalCount !== 1 ? "s" : ""}`;
  return summary.pendingCount > 0
    ? `${base} (${summary.pendingCount} still syncing).`
    : `${base}.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deduplicate packable objects by hash (last one wins). */
export function uniquePackableObjects(
  objects: PackableObject[],
): PackableObject[] {
  const byHash = new Map<string, PackableObject>();
  for (const object of objects) byHash.set(object.hash, object);
  return [...byHash.values()];
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/**
 * Compact a raw receive-pack response body for inclusion in a user-facing
 * error message. Strips control characters (pkt-line framing, side-band
 * prefixes) and truncates — enough for a bug report to identify what the
 * server actually said.
 */
function summarizeRawPushResponse(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, " ")
    .trim();
  if (cleaned.length === 0) return "empty response";
  return cleaned.length > 160 ? `${cleaned.slice(0, 160)}…` : cleaned;
}

async function getAdvertisedRefs(
  cloneUrl: string,
  authorizationProvider?: GitHttpAuthorizationProvider,
  signal?: AbortSignal,
): Promise<Record<string, string> | null> {
  try {
    if (signal) throwIfAborted(signal);
    return (
      await getReceivePackRefs(cloneUrl, signal, (url) =>
        gitAuthorizationHeaders(authorizationProvider, url, signal),
      )
    ).refs;
  } catch {
    if (signal?.aborted) throw abortError(signal);
    return null;
  }
}

function getAdvertisedRef(
  refs: Record<string, string>,
  refName: string,
): string | undefined {
  return refs[refName];
}

function getPeeledAdvertisedRef(
  refs: Record<string, string>,
  refName: string,
): string | undefined {
  return refs[`${refName}^{}`] ?? refs[refName];
}

function advertisedRefsContainHash(
  refs: Record<string, string>,
  hash: string,
): boolean {
  return Object.values(refs).includes(hash);
}

function refsMatch(
  refs: Record<string, string>,
  refName: string,
  expectedHash: string,
): boolean {
  return getAdvertisedRef(refs, refName) === expectedHash;
}

function getRawStateRefs(stateEvent: NostrEvent): DesiredStateRef[] {
  const peeled = new Map<string, string>();
  for (const [name, hash] of stateEvent.tags) {
    if (name?.endsWith("^{}") && hash) peeled.set(name.slice(0, -3), hash);
  }

  return stateEvent.tags
    .filter(([name]) => name?.startsWith("refs/") && !name.endsWith("^{}"))
    .map(([refName, commitHash]) => ({
      refName,
      commitHash: commitHash ?? "",
      peeledCommitHash: peeled.get(refName),
    }))
    .filter(({ commitHash }) => commitHash);
}

/**
 * The complete ref set every server should advertise after the push: the
 * state event's refs with the primary update applied on top.
 */
export function getPostPushStateRefs(
  stateEvent: NostrEvent | null | undefined,
  primaryUpdate: RefUpdate,
): DesiredStateRef[] {
  const refs = new Map<string, DesiredStateRef>();

  if (stateEvent) {
    for (const ref of getRawStateRefs(stateEvent)) {
      refs.set(ref.refName, ref);
    }
  }

  refs.set(primaryUpdate.refName, {
    refName: primaryUpdate.refName,
    commitHash: primaryUpdate.newHash,
  });

  return [...refs.values()].filter(
    ({ commitHash }) => commitHash !== ZERO_HASH,
  );
}

async function serverRefsMatch(
  cloneUrl: string,
  desiredRefs: DesiredStateRef[],
  authorizationProvider?: GitHttpAuthorizationProvider,
  signal?: AbortSignal,
): Promise<boolean> {
  const advertisedRefs = await getAdvertisedRefs(
    cloneUrl,
    authorizationProvider,
    signal,
  );
  if (!advertisedRefs) return false;

  return desiredRefs.every(({ refName, commitHash }) =>
    refsMatch(advertisedRefs, refName, commitHash),
  );
}

// ---------------------------------------------------------------------------
// Per-server push
// ---------------------------------------------------------------------------

/** Push one ref update (plus missing state refs) to a single Grasp server. */
export async function pushToGraspServer(
  cloneUrl: string,
  refUpdate: RefUpdate,
  ctx: GraspPushContext,
): Promise<PushDeliveryOutcome> {
  throwIfAborted(ctx.signal);
  // Read the server's actual advertised ref. Grasp servers can lag behind the
  // signed Nostr state (missed earlier pushes), so the consensus old hash is
  // not necessarily what this server has.
  const advertisedRefs = await getAdvertisedRefs(
    cloneUrl,
    ctx.authorizationProvider,
    ctx.signal,
  );
  const serverHead = advertisedRefs
    ? getAdvertisedRef(advertisedRefs, refUpdate.refName)
    : null;

  const missingStateRefUpdates: RefUpdate[] = advertisedRefs
    ? ctx.desiredRefs
        .filter(({ refName, commitHash }) =>
          refName === refUpdate.refName
            ? false
            : !refsMatch(advertisedRefs, refName, commitHash),
        )
        .map(({ refName, commitHash }) => ({
          oldHash: advertisedRefs[refName] ?? ZERO_HASH,
          newHash: commitHash,
          refName,
        }))
    : [];

  if (serverHead === refUpdate.newHash && missingStateRefUpdates.length === 0) {
    return {
      cloneUrl,
      ok: true,
      message: "already matches the state event",
    };
  }

  const effectiveUpdates: RefUpdate[] = [];
  let primaryCatchUpObjects: PackableObject[] = [];
  const supplementalObjects: PackableObject[] = [];
  let packfile = ctx.sharedPackfile;

  try {
    if (serverHead === undefined) {
      // The server does not have the branch at all (e.g. a fresh mirror).
      // Create it, sending a bounded catch-up pack of recent history alongside
      // the base objects. If the repo is deeper than the bound, the server's
      // connectivity check fails and the outcome reports it.
      const catchUp = await ctx.fetchCatchUpObjects(
        refUpdate.oldHash,
        "",
        undefined,
        ctx.signal,
      );
      throwIfAborted(ctx.signal);
      primaryCatchUpObjects = catchUp ?? [];
      effectiveUpdates.push({ ...refUpdate, oldHash: ZERO_HASH });
    } else if (serverHead !== null && serverHead !== refUpdate.oldHash) {
      // The server's ref differs from the consensus old hash — it is behind
      // (or diverged). Fetch the objects between its head and the consensus
      // head so the pack is complete from the server's point of view, and use
      // the server's real head as the old hash so receive-pack accepts the
      // update. The signed Nostr state event is the source of truth here;
      // mirrors are brought in line with it even when that is not a
      // fast-forward for the mirror.
      const catchUp = await ctx.fetchCatchUpObjects(
        refUpdate.oldHash,
        serverHead,
        undefined,
        ctx.signal,
      );
      throwIfAborted(ctx.signal);
      if (!catchUp) {
        return {
          cloneUrl,
          ok: false,
          message:
            `server's ${refUpdate.refName} is at ${serverHead.slice(0, 8)} ` +
            `(expected ${refUpdate.oldHash.slice(0, 8)}) and catch-up objects ` +
            "could not be fetched",
        };
      }
      primaryCatchUpObjects = catchUp;
      effectiveUpdates.push({ ...refUpdate, oldHash: serverHead });
    } else if (serverHead !== refUpdate.newHash) {
      effectiveUpdates.push(refUpdate);
    }
    // serverHead === null (advertisement unreadable) or serverHead matches the
    // consensus old hash: push the shared pack with the consensus update.

    if (advertisedRefs) {
      for (const update of missingStateRefUpdates) {
        const existingHash = getPeeledAdvertisedRef(
          advertisedRefs,
          update.refName,
        );
        const desiredRef = ctx.desiredRefs.find(
          ({ refName }) => refName === update.refName,
        );
        const tipCommitId = desiredRef?.peeledCommitHash ?? update.newHash;
        const includeObjectIds = desiredRef?.peeledCommitHash
          ? [update.newHash]
          : undefined;

        if (
          !advertisedRefsContainHash(advertisedRefs, update.newHash) &&
          !ctx.baseObjects.some((object) => object.hash === update.newHash) &&
          !primaryCatchUpObjects.some(
            (object) => object.hash === update.newHash,
          )
        ) {
          const catchUp = await ctx.fetchCatchUpObjects(
            tipCommitId,
            existingHash ?? "",
            includeObjectIds,
            ctx.signal,
          );
          throwIfAborted(ctx.signal);

          if (!catchUp) {
            return {
              cloneUrl,
              ok: false,
              message:
                `server is missing ${update.refName} at ` +
                `${update.newHash.slice(0, 8)} and objects could not be fetched`,
            };
          }

          supplementalObjects.push(...catchUp);
        }

        effectiveUpdates.push(update);
      }
    }

    const needsCustomPackfile =
      primaryCatchUpObjects.length > 0 || supplementalObjects.length > 0;
    if (needsCustomPackfile) {
      throwIfAborted(ctx.signal);
      packfile = await createPackfile(
        uniquePackableObjects([
          ...ctx.baseObjects,
          ...primaryCatchUpObjects,
          ...supplementalObjects,
        ]),
      );
      throwIfAborted(ctx.signal);
    }

    const result = await pushToGitServer(
      cloneUrl,
      effectiveUpdates,
      packfile,
      ctx.signal,
      (url) =>
        gitAuthorizationHeaders(ctx.authorizationProvider, url, ctx.signal),
    );
    throwIfAborted(ctx.signal);
    const refFailures = result.refResults.filter((r) => !r.ok);

    if (
      result.unpackOk &&
      refFailures.length === 0 &&
      (await serverRefsMatch(
        cloneUrl,
        ctx.desiredRefs,
        ctx.authorizationProvider,
        ctx.signal,
      ))
    ) {
      return {
        cloneUrl,
        ok: true,
        message: "accepted",
      };
    }

    if (
      await serverRefsMatch(
        cloneUrl,
        ctx.desiredRefs,
        ctx.authorizationProvider,
        ctx.signal,
      )
    ) {
      return {
        cloneUrl,
        ok: true,
        message: "accepted; server reported a stale failure",
      };
    }

    // Application-level rejection (ERR pkt-line). Grasp servers reply this
    // way when the push is refused before git-receive-pack runs — most
    // importantly "authorisation failed: <reason>" when the signed state
    // event is not in purgatory. Report the server's reason verbatim.
    if (result.serverError) {
      return {
        cloneUrl,
        ok: false,
        message: `server rejected push: ${result.serverError}`,
      };
    }

    if (!result.unpackOk) {
      return {
        cloneUrl,
        ok: false,
        message: result.unpackStatus
          ? `unpack failed: ${result.unpackStatus}`
          : "push failed: server returned no unpack status " +
            `(${summarizeRawPushResponse(result.rawResponse)})`,
      };
    }

    const failures = refFailures
      .map((r) => `${r.refName}: ${r.reason ?? "unknown"}`)
      .join("; ");

    return {
      cloneUrl,
      ok: false,
      message: failures || "ref update rejected",
    };
  } catch (err) {
    if (ctx.signal.aborted) throw abortError(ctx.signal);
    if (
      await serverRefsMatch(
        cloneUrl,
        ctx.desiredRefs,
        ctx.authorizationProvider,
        ctx.signal,
      )
    ) {
      return {
        cloneUrl,
        ok: true,
        message: "accepted; confirmation failed",
      };
    }

    return {
      cloneUrl,
      ok: false,
      message: err instanceof Error ? err.message : "push failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * Push one ref update to every Grasp server, in parallel.
 *
 * Guards the signed Nostr state at the single push choke point: never advance
 * the state to a tip that does not descend from the current state tip. A
 * non-fast-forward update of the state event orphans commits already on the
 * branch — the disaster an incorrect merge base can cause. Throws before
 * sending anything. This guards the STATE EVENT only; individual Grasp
 * mirrors that lag or diverge are forced in line with the signed state (see
 * {@link pushToGraspServer}).
 *
 * Resolves with a per-server delivery summary as soon as ONE server accepted
 * — a slow or unreachable mirror must not hold up the rest of the merge
 * sequence. The remaining pushes continue in the background: each settle
 * invokes `onUpdate` with a fresh snapshot, and `summary.settled` resolves
 * with the final summary once every server has settled. Throws only when
 * every server rejected.
 */
export async function pushRefUpdateToGraspServers(
  params: PushRefUpdateParams,
): Promise<PushDeliverySummary> {
  const { cloneUrls, objects, refUpdate, currentStateEvent } = params;
  const signal = params.signal ?? new AbortController().signal;

  throwIfAborted(signal);
  assertFastForwardSafe(objects, refUpdate.oldHash, refUpdate.newHash);

  if (cloneUrls.length === 0) {
    throw new Error(
      "Push failed: no Grasp servers to push to. " +
        "The state event will expire from purgatory in 30 minutes.",
    );
  }

  const baseObjects = uniquePackableObjects(objects);
  throwIfAborted(signal);
  const sharedPackfile = await createPackfile(baseObjects);
  throwIfAborted(signal);
  const ctx: GraspPushContext = {
    baseObjects,
    sharedPackfile,
    desiredRefs: getPostPushStateRefs(currentStateEvent, refUpdate),
    fetchCatchUpObjects: params.fetchCatchUpObjects,
    authorizationProvider: params.authorizationProvider,
    signal,
  };

  const outcomes: PushDeliveryOutcome[] = cloneUrls.map((cloneUrl) => ({
    cloneUrl,
    ok: false,
    message: "still syncing",
    pending: true,
  }));

  let resolveSettled!: (summary: PushDeliverySummary) => void;
  const settled = new Promise<PushDeliverySummary>((resolve) => {
    resolveSettled = resolve;
  });

  const snapshot = (): PushDeliverySummary => ({
    outcomes: outcomes.map((outcome) => ({ ...outcome })),
    successCount: outcomes.filter((outcome) => outcome.ok).length,
    totalCount: outcomes.length,
    pendingCount: outcomes.filter((outcome) => outcome.pending).length,
    settled,
  });

  return new Promise<PushDeliverySummary>((resolve, reject) => {
    let firstSettled = false;

    const recordOutcome = (index: number, outcome: PushDeliveryOutcome) => {
      outcomes[index] = outcome;
      const summary = snapshot();
      params.onUpdate?.(summary);

      if (!firstSettled && outcome.ok) {
        firstSettled = true;
        resolve(summary);
      }

      if (summary.pendingCount > 0) return;

      if (!firstSettled) {
        firstSettled = true;
        if (signal.aborted) {
          reject(abortError(signal));
          resolveSettled(summary);
          return;
        }
        const reasons = summary.outcomes
          .map(
            (each) => `${formatCloneUrlHost(each.cloneUrl)}: ${each.message}`,
          )
          .join("; ");
        reject(
          new Error(
            `Push failed to all Grasp servers. ${reasons}. ` +
              "The state event will expire from purgatory in 30 minutes.",
          ),
        );
      }
      resolveSettled(summary);
    };

    cloneUrls.forEach((cloneUrl, index) => {
      pushToGraspServer(cloneUrl, refUpdate, ctx)
        .catch(
          (err): PushDeliveryOutcome => ({
            cloneUrl,
            ok: false,
            message: err instanceof Error ? err.message : "push failed",
          }),
        )
        .then((outcome) =>
          recordOutcome(index, { ...outcome, pending: false }),
        );
    });
  });
}
