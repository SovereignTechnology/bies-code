/**
 * Resolve which branch a PR's collapsed merged-in commits came from by
 * looking at the commit graph, not the merge commit's message.
 *
 * For each spine merge in the range (see `collapseMergedInCommits`), a
 * merge parent belongs to branch X when it is reachable from X's current
 * head — an exact tip match or an ancestry hit inside the head's (cached,
 * bounded) history window. Branches are tried in preference order: the
 * PR's target branch, then main/master, then the rest, capped to avoid
 * fanning out history fetches on branch-heavy repos.
 *
 * Returns a map of merge commit hash → branch name for every merge that
 * could be resolved. Merges whose source branch has been deleted (its
 * commits are no longer reachable from any current head) stay absent —
 * callers may fall back to parsing the merge subject.
 */

import { useEffect, useMemo, useState } from "react";
import type { GitGraspPool, PoolState, Commit } from "@/lib/git-grasp-pool";
import { collapseMergedInCommits } from "@/lib/commit-graph";

const MAX_BRANCHES = 8;
const HISTORY_DEPTH = 200;

export function useMergedInSourceBranches(
  pool: GitGraspPool | null,
  poolState: PoolState,
  commits: Commit[],
  targetBranchName?: string | null,
): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map());

  const collapse = useMemo(() => collapseMergedInCommits(commits), [commits]);

  const branches = useMemo(() => {
    const heads: { name: string; commitId: string }[] = [];
    for (const [ref, resolved] of Object.entries(poolState.effectiveRefs)) {
      if (ref.startsWith("refs/heads/")) {
        heads.push({
          name: ref.slice("refs/heads/".length),
          commitId: resolved.commitId,
        });
      }
    }
    const rank = (name: string) =>
      name === targetBranchName
        ? 0
        : name === "main" || name === "master"
          ? 1
          : 2;
    heads.sort(
      (a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1),
    );
    return heads.slice(0, MAX_BRANCHES);
  }, [poolState.effectiveRefs, targetBranchName]);

  // Stable key so the effect re-runs only when tips actually move.
  const branchesKey = useMemo(
    () => branches.map((b) => `${b.name}:${b.commitId}`).join(","),
    [branches],
  );

  useEffect(() => {
    if (!pool || !collapse || branches.length === 0) {
      setNames(new Map());
      return;
    }
    const spineByHash = new Map(collapse.spine.map((c) => [c.hash, c]));
    const abort = new AbortController();

    (async () => {
      const resolved = new Map<string, string>();
      const reachableFromHead = new Map<string, Set<string>>();

      for (const mergeHash of collapse.groups.keys()) {
        const merge = spineByHash.get(mergeHash);
        if (!merge) continue;
        const mergedParents = merge.parents.slice(1);

        for (const branch of branches) {
          if (mergedParents.includes(branch.commitId)) {
            resolved.set(mergeHash, branch.name);
            break;
          }
          let reachable = reachableFromHead.get(branch.commitId);
          if (!reachable) {
            const history = await pool.getCommitHistory(
              branch.commitId,
              HISTORY_DEPTH,
              abort.signal,
            );
            if (abort.signal.aborted) return;
            reachable = new Set((history ?? []).map((c) => c.hash));
            reachableFromHead.set(branch.commitId, reachable);
          }
          if (mergedParents.some((parent) => reachable.has(parent))) {
            resolved.set(mergeHash, branch.name);
            break;
          }
        }
      }

      if (!abort.signal.aborted) setNames(resolved);
    })().catch(() => {
      if (!abort.signal.aborted) setNames(new Map());
    });

    return () => abort.abort();
    // branchesKey stands in for the branches array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, collapse, branchesKey]);

  return names;
}
