import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";
import { userIdentityCoverage } from "@/services/userIdentityCoverage";

const PUBKEY = "a".repeat(64);
const OUTBOX = "wss://outbox.example.test";
const LOOKUP_ONE = "wss://lookup-one.example.test";
const LOOKUP_TWO = "wss://lookup-two.example.test";
const RELAYS = [OUTBOX, LOOKUP_ONE, LOOKUP_TWO];
const TRANSPORT_RELAYS = RELAYS.map((relay) => `${relay}/`);

const mocks = vi.hoisted(() => ({
  addressLoader: vi.fn(),
  livenessFilter: vi.fn(),
  lookupRelays: [
    "wss://lookup-one.example.test",
    "wss://lookup-two.example.test",
  ],
  outbox: "wss://outbox.example.test",
  poolRelays: new Map<string, { connected: boolean }>(),
  pubkey: "a".repeat(64),
}));

vi.mock("applesauce-react/hooks", () => ({
  useActiveAccount: () => ({ pubkey: mocks.pubkey }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => ({}),
}));

vi.mock("@/hooks/use$", () => ({
  use$: () => ({ outboxes: [mocks.outbox] }),
}));

vi.mock("@/services/nostr", () => ({
  addressLoader: mocks.addressLoader,
  liveness: { filter: mocks.livenessFilter },
  pool: { relays: mocks.poolRelays },
}));

vi.mock("@/services/settings", () => ({
  lookupRelays: { getValue: () => mocks.lookupRelays },
}));

import { useRobustReplaceableAction } from "./useRobustReplaceableAction";

describe("useRobustReplaceableAction warm coverage boundary", () => {
  let releaseCoverage: (() => void) | undefined;
  let coverage = createRelaySubscriptionCoverage();

  beforeEach(() => {
    mocks.addressLoader.mockReset();
    mocks.livenessFilter.mockReset();
    mocks.livenessFilter.mockImplementation((relays: string[]) => relays);
    mocks.poolRelays.clear();
    for (const relay of TRANSPORT_RELAYS) {
      mocks.poolRelays.set(relay, { connected: true });
    }

    coverage = createRelaySubscriptionCoverage();
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
        message: expect.stringContaining("Check your relay connections"),
      }),
    );
    expect(action).not.toHaveBeenCalled();
    expect(mocks.addressLoader).not.toHaveBeenCalled();
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
    expect(mocks.addressLoader).not.toHaveBeenCalled();

    await act(async () => {
      coverage.onLifecycle({
        relay: LOOKUP_TWO,
        generation: 3,
        phase: "covered",
      });
      await execution;
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(mocks.livenessFilter).toHaveBeenCalledWith([`${OUTBOX}/`]);
    expect(mocks.livenessFilter).toHaveBeenCalledWith([
      `${LOOKUP_ONE}/`,
      `${LOOKUP_TWO}/`,
    ]);
    expect(mocks.addressLoader).not.toHaveBeenCalled();
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
    expect(mocks.addressLoader).not.toHaveBeenCalled();
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
    expect(mocks.addressLoader).not.toHaveBeenCalled();
  });

  it("reports the bounded warm-coverage timeout", async () => {
    vi.useFakeTimers();
    const action = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useRobustReplaceableAction());
    let execution = Promise.resolve();

    act(() => {
      execution = result.current.execute(3, action);
    });
    const rejection = expect(execution).rejects.toThrow(
      "Relay checks are still in progress",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    });

    expect(action).not.toHaveBeenCalled();
    expect(mocks.addressLoader).not.toHaveBeenCalled();
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

    const replacement = createRelaySubscriptionCoverage();
    RELAYS.forEach((relay, index) => {
      replacement.onLifecycle({
        relay,
        generation: index + 10,
        phase: "initial",
      });
    });
    const oldRelease = releaseCoverage;
    releaseCoverage = userIdentityCoverage.activate(PUBKEY, replacement);
    oldRelease?.();

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
});
