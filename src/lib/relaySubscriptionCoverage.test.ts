import { afterEach, describe, expect, it, vi } from "vitest";

import { createRelaySubscriptionCoverage } from "./relaySubscriptionCoverage";
import { UserIdentityCoverageOwner } from "@/services/userIdentityCoverage";

const RELAY = "wss://relay.example.test";
const OTHER_RELAY = "wss://other.example.test";

describe("relay subscription coverage", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects stale generation completion", () => {
    const coverage = createRelaySubscriptionCoverage();
    coverage.onLifecycle({ relay: RELAY, generation: 1, phase: "initial" });
    coverage.onLifecycle({
      relay: RELAY,
      generation: 2,
      phase: "catching-up",
    });

    coverage.onLifecycle({ relay: RELAY, generation: 1, phase: "covered" });

    expect(coverage.get(RELAY)).toEqual({
      relay: RELAY,
      generation: 2,
      phase: "catching-up",
    });
    expect(coverage.isCovered(RELAY)).toBe(false);

    coverage.stop();
    coverage.onLifecycle({ relay: RELAY, generation: 3, phase: "covered" });
    expect(coverage.get(RELAY)?.phase).toBe("stopped");
  });

  it("invalidates teardown and account replacement without clearing the successor", () => {
    const owner = new UserIdentityCoverageOwner();
    const first = createRelaySubscriptionCoverage();
    const releaseFirst = owner.activate("first", first);
    first.onLifecycle({ relay: RELAY, generation: 1, phase: "covered" });
    expect(owner.coveredRelays("first", [RELAY])).toEqual([RELAY]);

    const second = createRelaySubscriptionCoverage();
    const releaseSecond = owner.activate("second", second);
    second.onLifecycle({
      relay: OTHER_RELAY,
      generation: 2,
      phase: "covered",
    });

    expect(first.get(RELAY)?.phase).toBe("stopped");
    expect(owner.get("first")).toBeUndefined();
    expect(owner.coveredRelays("second", [`${OTHER_RELAY}/`])).toEqual([
      `${OTHER_RELAY}/`,
    ]);

    releaseFirst();
    expect(owner.get("second")).toBe(second);
    releaseSecond();
    expect(second.get(OTHER_RELAY)?.phase).toBe("stopped");
    expect(owner.get("second")).toBeUndefined();
  });

  it("projects a settling generation as not responding and accepts its late EOSE", () => {
    vi.useFakeTimers();
    const coverage = createRelaySubscriptionCoverage({
      settlementTimeoutMs: 1_000,
    });
    const changes = vi.fn();
    const subscription = coverage.changes$.subscribe(changes);

    coverage.onLifecycle({ relay: RELAY, generation: 1, phase: "initial" });
    vi.advanceTimersByTime(1_000);

    expect(coverage.get(RELAY)).toEqual({
      relay: RELAY,
      generation: 1,
      phase: "not-responding",
    });
    expect(coverage.isCovered(RELAY)).toBe(false);

    coverage.onLifecycle({ relay: RELAY, generation: 1, phase: "covered" });
    expect(coverage.isCovered(RELAY)).toBe(true);
    expect(changes).toHaveBeenLastCalledWith({
      relay: RELAY,
      generation: 1,
      phase: "covered",
    });

    subscription.unsubscribe();
    coverage.stop();
  });

  it("cancels settlement deadlines when coverage stops", () => {
    vi.useFakeTimers();
    const coverage = createRelaySubscriptionCoverage({
      settlementTimeoutMs: 1_000,
    });
    const changes = vi.fn();
    coverage.changes$.subscribe(changes);
    coverage.onLifecycle({ relay: RELAY, generation: 1, phase: "initial" });

    coverage.stop();
    vi.advanceTimersByTime(1_000);

    expect(coverage.get(RELAY)?.phase).toBe("stopped");
    expect(changes).toHaveBeenCalledTimes(2);
  });
});
