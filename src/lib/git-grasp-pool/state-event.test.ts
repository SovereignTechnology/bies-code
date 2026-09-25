import { afterEach, describe, expect, it, vi } from "vitest";
import { StateEventManager, stateEventInputsEqual } from "./state-event";

const NOW_MS = 1_800_000_000_000;

function stateEvent(createdAt: number) {
  return {
    headCommitId: "a".repeat(40),
    refs: [
      {
        name: "refs/heads/main",
        commitId: "a".repeat(40),
      },
    ],
    createdAt,
  };
}

describe("StateEventManager backoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll Git servers for a historical state mismatch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const manager = new StateEventManager();
    const retry = vi.fn();
    manager.update(stateEvent(NOW_MS / 1000 - 301));

    manager.scheduleBackoffFetch(retry);
    vi.runAllTimers();

    expect(retry).not.toHaveBeenCalled();
    expect(manager.retryAt).toBeNull();
  });

  it("keeps the bounded retry window for newly published state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const manager = new StateEventManager();
    const retry = vi.fn();
    manager.update(stateEvent(NOW_MS / 1000 - 60));

    manager.scheduleBackoffFetch(retry);

    expect(manager.retryAt).toBe(NOW_MS + 2_000);
    vi.advanceTimersByTime(2_000);
    expect(retry).toHaveBeenCalledOnce();
    expect(manager.retryAt).toBeNull();
  });
});

describe("stateEventInputsEqual", () => {
  it("compares refs as an exact multiset", () => {
    const duplicateMain = {
      ...stateEvent(1),
      refs: [
        { name: "refs/heads/main", commitId: "a".repeat(40) },
        { name: "refs/heads/main", commitId: "a".repeat(40) },
      ],
    };
    const mainAndDev = {
      ...stateEvent(1),
      refs: [
        { name: "refs/heads/main", commitId: "a".repeat(40) },
        { name: "refs/heads/dev", commitId: "b".repeat(40) },
      ],
    };

    expect(stateEventInputsEqual(duplicateMain, mainAndDev)).toBe(false);
    expect(
      stateEventInputsEqual(mainAndDev, {
        ...mainAndDev,
        refs: [...mainAndDev.refs].reverse(),
      }),
    ).toBe(true);
  });
});
