import { afterEach, describe, expect, it } from "vitest";
import { GitGraspPool } from "./pool";
import type { StateEvent } from "./types";

const pools: GitGraspPool[] = [];

function createPool(): GitGraspPool {
  const pool = new GitGraspPool({ cloneUrls: [] });
  pools.push(pool);
  return pool;
}

function stateEvent(createdAt: number, commitCharacter: string): StateEvent {
  const commitId = commitCharacter.repeat(40);
  return {
    headRef: "refs/heads/main",
    headCommitId: commitId,
    refs: [{ name: "refs/heads/main", commitId }],
    createdAt,
  };
}

afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

describe("GitGraspPool repository state ownership", () => {
  it("retains known state when consumers leave and ignores equal updates", () => {
    const pool = createPool();
    const first = stateEvent(10, "a");
    let emissionCount = 0;
    const observeState = pool.observable.subscribe(() => emissionCount++);
    const unsubscribeConsumer = pool.subscribe(() => undefined);

    pool.setAuthoritativeStateEvent(first);
    const settledEmissionCount = emissionCount;
    unsubscribeConsumer();
    pool.setAuthoritativeStateEvent({ ...first, refs: [...first.refs] });

    expect(pool.getState().authoritativeHead?.commitId).toBe(
      first.headCommitId,
    );
    expect(emissionCount).toBe(settledEmissionCount);
    observeState.unsubscribe();
  });

  it("allows authoritative rollback and explicit clearing", () => {
    const pool = createPool();
    const newer = stateEvent(20, "b");
    const older = stateEvent(10, "a");

    pool.setAuthoritativeStateEvent(newer);
    pool.setAuthoritativeStateEvent(older);
    expect(pool.getState().authoritativeHead?.commitId).toBe(
      older.headCommitId,
    );

    pool.setAuthoritativeStateEvent(null);
    expect(pool.getState().authoritativeHead).toBeNull();
    expect(pool.getState().authoritativeRefs).toEqual({});
  });

  it("lets seeds advance until an authoritative owner takes control", () => {
    const pool = createPool();
    const firstSeed = stateEvent(10, "a");
    const newerSeed = stateEvent(20, "b");
    const authoritativeRollback = stateEvent(5, "c");
    const staleJobSeed = stateEvent(30, "d");

    pool.seedStateEvent(firstSeed);
    pool.seedStateEvent(newerSeed);
    expect(pool.getState().authoritativeHead?.commitId).toBe(
      newerSeed.headCommitId,
    );

    pool.setAuthoritativeStateEvent(authoritativeRollback);
    pool.seedStateEvent(staleJobSeed);
    expect(pool.getState().authoritativeHead?.commitId).toBe(
      authoritativeRollback.headCommitId,
    );
  });

  it("rejects state updates after disposal", () => {
    const pool = createPool();
    const retained = stateEvent(10, "a");

    pool.setAuthoritativeStateEvent(retained);
    pool.dispose();
    pool.setAuthoritativeStateEvent(stateEvent(20, "b"));
    pool.seedStateEvent(stateEvent(30, "c"));

    expect(pool.isDisposed).toBe(true);
    expect(pool.getState().authoritativeHead?.commitId).toBe(
      retained.headCommitId,
    );
  });
});
