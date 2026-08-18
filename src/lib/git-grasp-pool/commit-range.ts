import type { Commit } from "./types";

/**
 * Select `reachable(tip) - reachable(base)` from a tip's fetched history.
 *
 * `history` is expected to contain commits reachable from the tip, with parent
 * links connecting every included base ancestor back to the base. The pool's
 * bounded graph walk provides that contract for PR histories. Its order is
 * preserved, but it must not be used to infer ancestry: commit timestamps can
 * place a merge parent's commits before the merge commit in the array.
 *
 * When the base is outside the fetched window, the history is returned
 * unchanged, preserving the previous best-effort behaviour.
 */
export function selectCommitRange(
  history: readonly Commit[],
  baseCommitId: string | null | undefined,
): Commit[] {
  if (!baseCommitId || history.length === 0) return [...history];

  const commitsByHash = new Map(history.map((commit) => [commit.hash, commit]));
  const reachableFromBase = new Set<string>();
  const pending = [baseCommitId];

  while (pending.length > 0) {
    const commitId = pending.pop();
    if (!commitId || reachableFromBase.has(commitId)) continue;

    reachableFromBase.add(commitId);
    const commit = commitsByHash.get(commitId);
    if (commit) pending.push(...commit.parents);
  }

  return history.filter((commit) => !reachableFromBase.has(commit.hash));
}
