import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoStateRef } from "@/lib/nip34";
import {
  GitGraspPool,
  type InfoRefsUploadPackResponse,
  type PoolState,
} from "@/lib/git-grasp-pool";
import { useGitExplorer } from "./useGitExplorer";

const COMMIT_ID = "a".repeat(40);
const CLONE_URL = "https://git.example.test/owner/repo";
const INFO_REFS: InfoRefsUploadPackResponse = {
  refs: { "refs/heads/main": COMMIT_ID },
  symrefs: { HEAD: "refs/heads/main" },
  capabilities: [],
};

function repositoryRefs(): RepoStateRef[] {
  return [
    {
      name: "refs/heads/main",
      commitId: COMMIT_ID,
      parentCommitIds: [],
    },
  ];
}

function poolSnapshot(pool: GitGraspPool): PoolState {
  return {
    ...pool.getState(),
    effectiveRefs: {
      "refs/heads/main": {
        commitId: COMMIT_ID,
        source: "state",
      },
    },
  };
}

describe("useGitExplorer", () => {
  const pools: GitGraspPool[] = [];

  afterEach(() => {
    for (const pool of pools) pool.dispose();
    pools.length = 0;
  });

  it("does not restart when equivalent derived ref containers are recreated", async () => {
    const pool = new GitGraspPool({ cloneUrls: [CLONE_URL] });
    pools.push(pool);
    vi.spyOn(pool, "getEffectiveInfoRefs").mockReturnValue(INFO_REFS);
    const getTree = vi.spyOn(pool, "getTree").mockResolvedValue(null);

    const { result, rerender } = renderHook(
      ({ state, stateRefs }: { state: PoolState; stateRefs: RepoStateRef[] }) =>
        useGitExplorer(pool, state, {
          knownHeadCommit: COMMIT_ID,
          stateRefs,
        }),
      {
        initialProps: {
          state: poolSnapshot(pool),
          stateRefs: repositoryRefs(),
        },
      },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    const settledFetchCount = getTree.mock.calls.length;

    await act(async () => {
      rerender({
        state: poolSnapshot(pool),
        stateRefs: repositoryRefs(),
      });
      await Promise.resolve();
    });

    expect(getTree).toHaveBeenCalledTimes(settledFetchCount);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).not.toBeNull();
  });
});
