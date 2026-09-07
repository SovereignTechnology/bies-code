import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";
import { userPersonalDeletionCoverage } from "@/services/userPersonalDeletionCoverage";

const PUBKEY = "a".repeat(64);
const OUTBOX = "wss://outbox.example.test";
const LOOKUP_ONE = "wss://lookup-one.example.test";
const LOOKUP_TWO = "wss://lookup-two.example.test";
const RELAYS = [OUTBOX, LOOKUP_ONE, LOOKUP_TWO];
const TRANSPORT_RELAYS = RELAYS.map((relay) => `${relay}/`);

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  cacheRequest: vi.fn(),
  cooldownRemaining: vi.fn(),
  livenessFilter: vi.fn(),
  lookupRelays: [
    "wss://lookup-one.example.test",
    "wss://lookup-two.example.test",
  ],
  outbox: "wss://outbox.example.test",
  poolRelays: new Map<string, { connected: boolean }>(),
  pubkey: "a".repeat(64),
  getReplaceable: vi.fn(),
}));

vi.mock("applesauce-react/hooks", () => ({
  useActiveAccount: () => ({ pubkey: mocks.pubkey }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => ({
    add: mocks.add,
    getReplaceable: mocks.getReplaceable,
  }),
}));

vi.mock("@/hooks/use$", () => ({
  use$: () => ({ outboxes: [mocks.outbox] }),
}));

vi.mock("@/services/nostr", () => ({
  liveness: { filter: mocks.livenessFilter },
  pool: { relays: mocks.poolRelays },
}));

vi.mock("@/services/cache", () => ({
  cacheRequest: mocks.cacheRequest,
}));

vi.mock("@/services/settings", () => ({
  lookupRelays: { getValue: () => mocks.lookupRelays },
}));

vi.mock("@/lib/resilientSubscription", () => ({
  getRateLimitCooldownRemaining: mocks.cooldownRemaining,
}));

import { useRobustReplaceableAction } from "./useRobustReplaceableAction";

describe("useRobustReplaceableAction warm coverage boundary", () => {
  let releaseCoverage: (() => void) | undefined;
  let releaseDeletionCoverage: (() => void) | undefined;
  let coverage = createRelaySubscriptionCoverage({
    settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  });

  beforeEach(() => {
    mocks.add.mockReset();
    mocks.cacheRequest.mockReset();
    mocks.cacheRequest.mockResolvedValue([]);
    mocks.cooldownRemaining.mockReset();
    mocks.cooldownRemaining.mockReturnValue(0);
    mocks.livenessFilter.mockReset();
    mocks.livenessFilter.mockImplementation((relays: string[]) => relays);
    mocks.getReplaceable.mockReset();
    mocks.getReplaceable.mockReturnValue({ id: "in-memory" });
    mocks.poolRelays.clear();
    for (const relay of TRANSPORT_RELAYS) {
      mocks.poolRelays.set(relay, { connected: true });
    }

    coverage = createRelaySubscriptionCoverage({
      settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
    });
    releaseCoverage = userIdentityCoverage.activate(PUBKEY, coverage);
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "initial",
      });
    });
  });

  afterEach(() => {
    releaseDeletionCoverage?.();
    releaseDeletionCoverage = undefined;
    releaseCoverage?.();
    releaseCoverage = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects connected and liveness-healthy relays without current coverage", async () => {
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 10,
        phase: "unavailable",
      });
    });
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let error: unknown;

    await act(async () => {
      try {
        await result.current.execute(3, action);
      } catch (caught) {
        error = caught;
      }
    });

    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "Outbox relays: 1 unavailable. Lookup relays: 2 unavailable.",
        ),
      }),
    );
    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("uses warm evidence without repeating the in-flight query", async () => {
    coverage.onLifecycle({
      relay: OUTBOX,
      generation: 1,
      phase: "covered",
    });
    coverage.onLifecycle({
      relay: LOOKUP_ONE,
      generation: 2,
      phase: "covered",
    });
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();

    act(() => {
      execution = result.current.execute(3, action);
    });

    expect(result.current.pending).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();

    await act(async () => {
      coverage.onLifecycle({
        relay: LOOKUP_TWO,
        generation: 3,
        phase: "covered",
      });
      await execution;
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("hydrates an exact cached event when the warm snapshot is absent", async () => {
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "covered",
      });
    });
    const cached = { id: "cached" };
    mocks.getReplaceable.mockReturnValueOnce(undefined).mockReturnValue(cached);
    mocks.cacheRequest.mockResolvedValue([cached]);
    const action = vi.fn(async () => {
      expect(mocks.add).toHaveBeenCalledWith(cached);
    });
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await result.current.execute(3, action);
    });

    expect(mocks.cacheRequest).toHaveBeenCalledWith([
      { kinds: [3], authors: [PUBKEY] },
    ]);
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith({
      event: cached,
      outboxes: [OUTBOX],
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("accepts a rebound deletion lease after its candidate is removed", async () => {
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "covered",
      });
    });
    const candidate = { id: "candidate" };
    mocks.getReplaceable
      .mockReturnValueOnce(candidate)
      .mockReturnValue(undefined);

    const deletionCoverage = createRelaySubscriptionCoverage();
    RELAYS.forEach((relay, index) => {
      deletionCoverage.onLifecycle({
        relay,
        generation: index + 10,
        phase: "covered",
      });
    });
    releaseDeletionCoverage = userPersonalDeletionCoverage.activate(
      PUBKEY,
      new Map(),
      deletionCoverage,
    );

    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await result.current.execute(10317, action);
    });

    expect(action).toHaveBeenCalledWith({
      event: undefined,
      outboxes: [OUTBOX],
    });
  });

  it("preserves a full settlement window after a deletion lease rebinds", async () => {
    vi.useFakeTimers();
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "covered",
      });
    });
    const candidate = { id: "fresh-candidate" };
    mocks.getReplaceable.mockReturnValue(candidate);

    const staleDeletionCoverage = createRelaySubscriptionCoverage();
    RELAYS.forEach((relay, index) => {
      staleDeletionCoverage.onLifecycle({
        relay,
        generation: index + 10,
        phase: "covered",
      });
    });
    releaseDeletionCoverage = userPersonalDeletionCoverage.activate(
      PUBKEY,
      new Map([[10317, "previous-candidate"]]),
      staleDeletionCoverage,
    );

    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();
    let outcome: "pending" | "resolved" | "rejected" = "pending";

    act(() => {
      execution = result.current.execute(10317, action);
    });
    const observed = execution.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      const reboundCoverage = createRelaySubscriptionCoverage({
        settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
      });
      RELAYS.forEach((relay, index) => {
        reboundCoverage.onLifecycle({
          relay,
          generation: index + 20,
          phase: "initial",
        });
      });
      releaseDeletionCoverage = userPersonalDeletionCoverage.activate(
        PUBKEY,
        new Map([[10317, candidate.id]]),
        reboundCoverage,
      );

      await vi.advanceTimersByTimeAsync(4_000);
      expect(outcome).toBe("pending");

      await vi.advanceTimersByTimeAsync(500);
      RELAYS.forEach((relay, index) => {
        reboundCoverage.onLifecycle({
          relay,
          generation: index + 20,
          phase: "covered",
        });
      });
      await observed;
    });

    expect(outcome).toBe("resolved");
    expect(action).toHaveBeenCalledWith({
      event: candidate,
      outboxes: [OUTBOX],
    });
  });

  it("rejects a full-replacement draft when cache hydration changes its base", async () => {
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "covered",
      });
    });
    const cached = { id: "cached" };
    mocks.getReplaceable.mockReturnValueOnce(undefined).mockReturnValue(cached);
    mocks.cacheRequest.mockResolvedValue([cached]);
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await expect(
        result.current.execute(3, action, { expectedEventId: null }),
      ).rejects.toThrow("changed after you began editing");
    });

    expect(action).not.toHaveBeenCalled();
  });

  it("bounds an absent EventStore cache lookup", async () => {
    vi.useFakeTimers();
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 1,
        phase: "covered",
      });
    });
    mocks.getReplaceable.mockReturnValue(undefined);
    mocks.cacheRequest.mockReturnValue(new Promise(() => {}));
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();

    act(() => {
      execution = result.current.execute(3, action);
    });
    expect(action).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await execution;
    });

    expect(mocks.cacheRequest).toHaveBeenCalledTimes(1);
    expect(mocks.add).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("fails immediately when the account has no active coverage lease", async () => {
    releaseCoverage?.();
    releaseCoverage = undefined;
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await expect(result.current.execute(3, action)).rejects.toThrow(
        "current query coverage",
      );
    });

    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("rejects kinds outside the identity subscription filter", async () => {
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await expect(result.current.execute(1, action)).rejects.toThrow(
        "uncovered kind:1",
      );
    });

    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("preserves the fast offline failure while coverage is in flight", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await expect(result.current.execute(3, action)).rejects.toThrow(
        "You appear to be offline",
      );
    });

    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("reports the bounded warm-coverage timeout", async () => {
    releaseCoverage?.();
    releaseCoverage = undefined;
    vi.useFakeTimers();
    coverage = createRelaySubscriptionCoverage({
      settlementTimeoutMs: USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
    });
    releaseCoverage = userIdentityCoverage.activate(PUBKEY, coverage);
    RELAYS.forEach((relay, index) => {
      coverage.onLifecycle({
        relay,
        generation: index + 20,
        phase: "initial",
      });
    });
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();

    act(() => {
      execution = result.current.execute(3, action);
    });
    let error: unknown;
    const settled = execution.catch((caught) => {
      error = caught;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    });

    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "Outbox relays: 1 not responding. Lookup relays: 2 checking.",
        ),
      }),
    );
    expect(action).not.toHaveBeenCalled();
    expect(mocks.cacheRequest).not.toHaveBeenCalled();
  });

  it("continues a pending wait across active coverage replacement", async () => {
    coverage.onLifecycle({
      relay: OUTBOX,
      generation: 1,
      phase: "covered",
    });
    coverage.onLifecycle({
      relay: LOOKUP_ONE,
      generation: 2,
      phase: "covered",
    });
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();

    act(() => {
      execution = result.current.execute(3, action);
    });
    expect(result.current.pending).toBe(true);

    const oldRelease = releaseCoverage;
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const observed = execution.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    await act(async () => {
      oldRelease?.();
      releaseCoverage = undefined;
      await Promise.resolve();
    });
    expect(outcome).toBe("pending");

    // Production starts the successor subscription before making its coverage
    // handle active, so the lease is first observed with initial facts.
    const replacement = createRelaySubscriptionCoverage();
    RELAYS.forEach((relay, index) => {
      replacement.onLifecycle({
        relay,
        generation: index + 10,
        phase: "initial",
      });
    });
    await act(async () => {
      releaseCoverage = userIdentityCoverage.activate(PUBKEY, replacement);
      await Promise.resolve();
    });
    expect(outcome).toBe("pending");

    await act(async () => {
      RELAYS.forEach((relay, index) => {
        replacement.onLifecycle({
          relay,
          generation: index + 10,
          phase: "covered",
        });
      });
      await observed;
    });

    expect(outcome).toBe("resolved");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("reports an exact relay-state breakdown", async () => {
    coverage.onLifecycle({
      relay: OUTBOX,
      generation: 10,
      phase: "unavailable",
      reason: "auth",
    });
    coverage.onLifecycle({
      relay: LOOKUP_ONE,
      generation: 11,
      phase: "unavailable",
      reason: "rate-limited",
    });
    mocks.poolRelays.set(`${LOOKUP_TWO}/`, { connected: false });
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());

    await act(async () => {
      await expect(result.current.execute(3, action)).rejects.toThrow(
        "Outbox relays: 1 requiring authentication. Lookup relays: 1 rate-limited, 1 disconnected.",
      );
    });

    expect(action).not.toHaveBeenCalled();
  });
});
