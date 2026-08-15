/**
 * merge-push-fetch — fetchers for the git objects a browser merge push needs.
 *
 * Extracted from MergePanel so the same fetches can run in two places:
 *
 *   - at merge-click time (MergePanel handlers), as the authoritative
 *     fallback; and
 *   - proactively in the background while the PR page is idle
 *     (usePrefetchedMergePushObjects), so the merge button is near-instant.
 *
 * Both helpers manage their own timeout AbortController internally; the
 * optional `externalSignal` lets a caller (the background prefetch) cancel
 * the fetch early, e.g. when the PR tip or branch head changes.
 */

import type { NostrEvent } from "nostr-tools";
import type { GitGraspPool } from "@/lib/git-grasp-pool";
import type { PackableObject } from "@/lib/git-packfile";
import { getStateRefs } from "@/lib/nip34";

export const PR_BRANCH_OBJECT_FETCH_TIMEOUT_MS = 90_000;
export const ISSUE_STATE_DELTA_FETCH_TIMEOUT_MS = 30_000;
export const ISSUE_STATE_DELTA_MAX_DEPTH = 500;

/**
 * Link an optional external abort signal to a local controller so either
 * source aborts the underlying fetch. Returns an unlink cleanup.
 */
function linkAbort(
  local: AbortController,
  externalSignal: AbortSignal | undefined,
): () => void {
  if (!externalSignal) return () => {};
  if (externalSignal.aborted) {
    local.abort();
    return () => {};
  }
  const onAbort = () => local.abort();
  externalSignal.addEventListener("abort", onAbort);
  return () => externalSignal.removeEventListener("abort", onAbort);
}

/**
 * Fetch every commit/tree/blob in the PR branch range so the target Grasp
 * server receives objects it may not already have. This is the dominant cost
 * of a PR-type merge push.
 */
export async function fetchPRBranchObjectsWithTimeout(
  gitPool: GitGraspPool,
  tipCommitHash: string,
  stopAtCommitHash: string,
  fallbackUrls: string[],
  externalSignal?: AbortSignal,
): Promise<PackableObject[] | null> {
  const abort = new AbortController();
  const unlink = linkAbort(abort, externalSignal);
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, PR_BRANCH_OBJECT_FETCH_TIMEOUT_MS);

  try {
    const objects = await gitPool.getPackableObjectsForCommitRange(
      tipCommitHash,
      stopAtCommitHash,
      abort.signal,
      fallbackUrls,
    );

    if (timedOut) {
      throw new Error(
        "Timed out while fetching PR branch objects from the git server. " +
          "Try again, or merge locally with ngit if the server remains slow.",
      );
    }

    return objects;
  } finally {
    globalThis.clearTimeout(timeout);
    unlink();
  }
}

/**
 * Fetch the objects for the commits between the signed Nostr state's branch
 * head and the current git head, used by issue auto-resolution to scan the
 * commit messages landing with the merge. Returns [] when the state already
 * matches the git head (the common case) or on any failure — the scan is
 * best-effort.
 */
export async function fetchIssueScanObjectsForStateDelta(
  gitPool: GitGraspPool,
  currentStateEvent: NostrEvent | null | undefined,
  defaultBranchName: string,
  defaultBranchHead: string,
  fallbackUrls: string[],
  externalSignal?: AbortSignal,
): Promise<PackableObject[]> {
  const oldStateHead = currentStateEvent
    ? getStateRefs(currentStateEvent).find(
        (ref) => ref.name === `refs/heads/${defaultBranchName}`,
      )?.commitId
    : undefined;
  if (!oldStateHead || oldStateHead === defaultBranchHead) return [];

  const abort = new AbortController();
  const unlink = linkAbort(abort, externalSignal);
  const timeout = globalThis.setTimeout(
    () => abort.abort(),
    ISSUE_STATE_DELTA_FETCH_TIMEOUT_MS,
  );

  try {
    const history = await gitPool.getCommitHistory(
      defaultBranchHead,
      ISSUE_STATE_DELTA_MAX_DEPTH,
      abort.signal,
      fallbackUrls,
      oldStateHead,
    );
    if (!history?.some((commit) => commit.hash === oldStateHead)) return [];

    return (
      (await gitPool.getPackableObjectsForCommitRange(
        defaultBranchHead,
        oldStateHead,
        abort.signal,
        fallbackUrls,
        ISSUE_STATE_DELTA_MAX_DEPTH,
      )) ?? []
    );
  } catch {
    return [];
  } finally {
    globalThis.clearTimeout(timeout);
    unlink();
  }
}
