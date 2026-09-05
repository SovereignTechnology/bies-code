import { act, renderHook } from "@testing-library/react";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import {
  USER_IDENTITY_COVERAGE_SETTLEMENT_TIMEOUT_MS,
  userIdentityCoverage,
} from "@/services/userIdentityCoverage";

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
  replaceable: vi.fn(),
}));

vi.mock("applesauce-react/hooks", () => ({
  useActiveAccount: () => ({ pubkey: mocks.pubkey }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => ({
    add: mocks.add,
    replaceable: mocks.replaceable,
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
    mocks.replaceable.mockReset();
    mocks.replaceable.mockReturnValue(of({ id: "in-memory" }));
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
    mocks.replaceable.mockReturnValue(of(undefined));
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
    expect(action).toHaveBeenCalledTimes(1);
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
    mocks.replaceable.mockReturnValue(of(undefined));
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
    let replacement: ReturnType<typeof createRelaySubscriptionCoverage>;
    act(() => {
      oldRelease?.();
      releaseCoverage = undefined;
      replacement = createRelaySubscriptionCoverage();
      releaseCoverage = userIdentityCoverage.activate(PUBKEY, replacement);
      RELAYS.forEach((relay, index) => {
        replacement.onLifecycle({
          relay,
          generation: index + 10,
          phase: "initial",
        });
      });
    });

    await act(async () => {
      RELAYS.forEach((relay, index) => {
        replacement.onLifecycle({
          relay,
          generation: index + 10,
          phase: "covered",
        });
      });
      await execution;
    });

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
