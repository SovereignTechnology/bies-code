import { act, renderHook } from "@testing-library/react";
import { EMPTY, of } from "rxjs";
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
  replaceable: vi.fn(),
}));

vi.mock("applesauce-react/hooks", () => ({
  useActiveAccount: () => ({ pubkey: mocks.pubkey }),
}));

vi.mock("@/hooks/useEventStore", () => ({
  useEventStore: () => ({ replaceable: mocks.replaceable }),
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
    mocks.addressLoader.mockReturnValue(EMPTY);
    mocks.livenessFilter.mockReset();
    mocks.livenessFilter.mockImplementation((relays: string[]) => relays);
    mocks.replaceable.mockReset();
    mocks.replaceable.mockReturnValue(of({ id: "cached" }));
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
      expect.objectContaining({ message: expect.stringContaining("coverage") }),
    );
    expect(action).not.toHaveBeenCalled();
    expect(mocks.addressLoader).not.toHaveBeenCalled();
  });

  it("waits for the in-flight relay needed by the existing threshold", async () => {
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
    expect(mocks.addressLoader).toHaveBeenCalledWith({
      kind: 3,
      pubkey: PUBKEY,
      relays: RELAYS,
    });
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
});
