import { useEffect, useMemo, useState } from "react";
import type { Observable } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { use$ } from "@/hooks/use$";
import { useEventStore } from "@/hooks/useEventStore";
import {
  coordsCacheKey,
  getPRTargetBranch,
  PR_KIND,
  PR_UPDATE_KIND,
} from "@/lib/nip34";
import {
  getEffectivePRMergeBases,
  type InferredPRParentRelation,
} from "@/lib/inferredPRParents";
import { InferredPRParentsModel } from "@/models/InferredPRParentsModel";
import type { RepositoryState } from "@/casts/RepositoryState";
import type { GitGraspPool, PoolState } from "@/lib/git-grasp-pool";
import { useAuthoritativeDefaultBranch } from "./useAuthoritativeDefaultBranch";
import { isValidGitBranchName } from "./useAuthoritativePRTargetBranch";

type Reachability = "landed" | "unlanded" | "unknown";
type TargetHeadResolution =
  | { status: "resolved"; commitId: string }
  | { status: "pending" }
  | { status: "unknown" };

interface StackReachabilityCheck {
  childId: string;
  mergeBase: string;
  targetBranch: string | undefined;
}

interface ReachabilitySnapshot {
  key: string;
  byChildId: Map<string, Reachability>;
}

const STACK_REACHABILITY_HISTORY_LIMIT = 200;

function isGitCommitId(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Resolve inferred PR parents, then remove relationships whose shared commit
 * is already reachable from the child's target branch.
 *
 * The EventStore model deliberately remains Git-independent: it discovers
 * cheap candidates by matching `merge-base` and `c` tags. This hook performs
 * the authoritative graph check in one batched pass through the shared pool.
 */
export function useInferredPRParents(
  repoCoords: string[] | undefined,
  gitPool: GitGraspPool | null,
  gitPoolState: PoolState,
  repoState: RepositoryState | null | undefined,
) {
  const store = useEventStore();
  const key = useMemo(
    () => (repoCoords ? coordsCacheKey([...repoCoords].sort()) : ""),
    [repoCoords],
  );
  const coords = useMemo(() => (key ? key.split(",") : []), [key]);
  const inferredParents = use$(() => {
    if (!key) return undefined;
    return store.model(InferredPRParentsModel, key) as unknown as Observable<
      Map<string, InferredPRParentRelation>
    >;
  }, [key, store]);

  // Store read only: RepoLayout's NIP-34 loaders already fetch these events.
  // We need the effective child merge base and declared target branch because
  // the compact relation objects intentionally contain display data only.
  const topologyEvents = use$(() => {
    if (!key) return undefined;
    return store.timeline([
      { kinds: [PR_KIND, PR_UPDATE_KIND], "#a": coords },
    ]) as Observable<NostrEvent[]>;
  }, [key, store]);

  const { defaultBranchName, defaultBranchHead } =
    useAuthoritativeDefaultBranch(gitPoolState, repoState);

  const checks = useMemo<StackReachabilityCheck[]>(() => {
    if (!inferredParents || !topologyEvents) return [];
    const roots = topologyEvents.filter((event) => event.kind === PR_KIND);
    const updates = topologyEvents.filter(
      (event) => event.kind === PR_UPDATE_KIND,
    );
    const mergeBases = getEffectivePRMergeBases(roots, updates, coords);
    const rootsById = new Map(roots.map((event) => [event.id, event]));

    return [...inferredParents.keys()].flatMap((childId) => {
      const mergeBase = mergeBases.get(childId);
      const root = rootsById.get(childId);
      if (!mergeBase || !root) return [];
      return [
        {
          childId,
          mergeBase,
          targetBranch: getPRTargetBranch(root),
        },
      ];
    });
  }, [coords, inferredParents, topologyEvents]);

  const checksKey = checks
    .map(({ childId, mergeBase, targetBranch }) =>
      [childId, mergeBase, targetBranch ?? ""].join(":"),
    )
    .sort()
    .join("|");
  const targetHeadsKey = checks
    .map(({ targetBranch }) => {
      if (!targetBranch || targetBranch === defaultBranchName) {
        return `${defaultBranchName ?? ""}:${defaultBranchHead ?? ""}`;
      }
      const ref = `refs/heads/${targetBranch}`;
      return `${ref}:${gitPoolState.authoritativeRefs[ref]?.commitId ?? ""}`;
    })
    .sort()
    .join("|");
  const reachabilityKey = [
    checksKey,
    targetHeadsKey,
    gitPoolState.loading ? "loading" : "settled",
    gitPool ? "pool" : "no-pool",
  ].join("||");

  const [reachability, setReachability] = useState<ReachabilitySnapshot>({
    key: "",
    byChildId: new Map(),
  });

  useEffect(() => {
    const abort = new AbortController();
    setReachability({ key: reachabilityKey, byChildId: new Map() });

    if (!gitPool || checks.length === 0) {
      return () => abort.abort();
    }

    const targetBranches = [
      ...new Set(checks.map(({ targetBranch }) => targetBranch)),
    ];

    Promise.all(
      targetBranches.map(async (targetBranch) => {
        try {
          if (!targetBranch || targetBranch === defaultBranchName) {
            const resolution: TargetHeadResolution = isGitCommitId(
              defaultBranchHead,
            )
              ? { status: "resolved", commitId: defaultBranchHead }
              : {
                  status:
                    !defaultBranchHead && gitPoolState.loading
                      ? "pending"
                      : "unknown",
                };
            return [targetBranch, resolution] as const;
          }

          if (!isValidGitBranchName(targetBranch)) {
            return [
              targetBranch,
              { status: "unknown" } satisfies TargetHeadResolution,
            ] as const;
          }

          const ref = `refs/heads/${targetBranch}`;
          await gitPool.resolveRef(ref);
          if (abort.signal.aborted) return undefined;
          const commitId = gitPool.getState().authoritativeRefs[ref]?.commitId;
          return [
            targetBranch,
            isGitCommitId(commitId)
              ? ({
                  status: "resolved",
                  commitId,
                } satisfies TargetHeadResolution)
              : ({ status: "unknown" } satisfies TargetHeadResolution),
          ] as const;
        } catch {
          if (abort.signal.aborted) return undefined;
          return [
            targetBranch,
            { status: "unknown" } satisfies TargetHeadResolution,
          ] as const;
        }
      }),
    ).then(async (targetResults) => {
      if (abort.signal.aborted) return;
      const targetHeads = new Map(
        targetResults.filter(
          (
            result,
          ): result is readonly [string | undefined, TargetHeadResolution] =>
            result !== undefined,
        ),
      );
      const checksByTargetHead = new Map<string, StackReachabilityCheck[]>();
      const byChildId = new Map<string, Reachability>();

      for (const check of checks) {
        const { childId, mergeBase, targetBranch } = check;
        const target = targetHeads.get(targetBranch);
        if (!target || target.status === "pending") continue;
        if (target.status === "unknown" || !isGitCommitId(mergeBase)) {
          byChildId.set(childId, "unknown");
          continue;
        }

        const targetChecks = checksByTargetHead.get(target.commitId) ?? [];
        targetChecks.push(check);
        checksByTargetHead.set(target.commitId, targetChecks);
      }

      const historyResults = await Promise.all(
        [...checksByTargetHead].map(async ([targetHead, targetChecks]) => {
          try {
            const history = await gitPool.getCommitHistory(
              targetHead,
              STACK_REACHABILITY_HISTORY_LIMIT,
              abort.signal,
            );
            if (abort.signal.aborted) return undefined;
            const reachable = new Set<string>(history?.map(({ hash }) => hash));
            reachable.add(targetHead);
            const missingResult: Reachability = !history
              ? "unknown"
              : history.length < STACK_REACHABILITY_HISTORY_LIMIT
                ? "unlanded"
                : "unknown";
            return targetChecks.map(
              ({ childId, mergeBase }) =>
                [
                  childId,
                  reachable.has(mergeBase) ? "landed" : missingResult,
                ] as const,
            );
          } catch {
            if (abort.signal.aborted) return undefined;
            return targetChecks.map(
              ({ childId }) => [childId, "unknown"] as const,
            );
          }
        }),
      );
      if (abort.signal.aborted) return;
      for (const results of historyResults) {
        if (!results) continue;
        for (const [childId, result] of results) {
          byChildId.set(childId, result);
        }
      }
      setReachability({
        key: reachabilityKey,
        byChildId,
      });
    });

    return () => abort.abort();
  }, [
    checks,
    checksKey,
    defaultBranchHead,
    defaultBranchName,
    gitPool,
    gitPoolState.loading,
    reachabilityKey,
    targetHeadsKey,
  ]);

  return useMemo(() => {
    if (!inferredParents || !topologyEvents) return undefined;
    if (!gitPool) return inferredParents;

    const filtered = new Map(inferredParents);
    for (const { childId } of checks) {
      const result =
        reachability.key === reachabilityKey
          ? reachability.byChildId.get(childId)
          : undefined;
      // Keep pending relations out of the UI so a landed parent does not
      // briefly flash as a stack. Unknown checks degrade to the tag inference.
      if (result === undefined || result === "landed") {
        filtered.delete(childId);
      }
    }
    return filtered;
  }, [
    checks,
    gitPool,
    inferredParents,
    reachability,
    reachabilityKey,
    topologyEvents,
  ]);
}
