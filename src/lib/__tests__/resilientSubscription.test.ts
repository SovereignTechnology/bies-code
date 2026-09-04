/**
 * End-to-end tests for resilientSubscription / resilientRequest.
 *
 * Uses vitest-websocket-mock (WS) to stand up real mock WebSocket servers so
 * the full applesauce relay stack (RelayPool → Relay → WebSocket) runs
 * unmodified. This validates that resilientSubscription behaves correctly
 * against the actual relay protocol rather than trusting a mock of
 * applesauce internals.
 *
 * Patterns borrowed from applesauce's own relay.test.ts:
 *   - `new WS(url, { jsonProtocol: true })` for JSON-framed messages
 *   - `vi.spyOn(Relay, "fetchInformationDocument")` to skip NIP-11 HTTP fetch
 *   - `relay.keepAlive = 0` to suppress the keep-alive ping timer
 *   - `subscribeSpyTo` from @hirez_io/observer-spy for clean value assertions
 *   - `WS.clean()` in afterEach to tear down all mock servers
 *
 * ## Timer strategy
 *
 * `vi.useFakeTimers()` interacts poorly with the WS mock's internal Promise
 * queue — `server.nextMessage` hangs because it relies on microtasks that
 * fake timers don't advance. Instead, set `retryDelay: 0` and `settleTime: 1`
 * so real async timers fire quickly, then use `await tick()` to flush the
 * microtask/macrotask queue.
 *
 * ## Triggering retries
 *
 * Prefer sending `["CLOSED", subId, "error: ..."]` over closing the WebSocket
 * to trigger a retry. A CLOSED message causes the relay's req() to throw a
 * RelayClosedError which our retry() catches and re-executes defer(buildLiveSub)
 * on — all on the same WebSocket connection, no reconnect dance needed.
 *
 * Avoid `server.error()` entirely: it calls server.close() internally, which
 * tears down the mock server so it can no longer accept new connections.
 *
 * If you do need a WebSocket-level drop (e.g. to test the relay's own
 * reconnect path), use `server.close({ wasClean: false, code: 1006 })` then
 * `await server.closed` before `await server.connected`. This closes the
 * current connection but keeps the mock server alive for the next client.
 *
 * ## server.messages includes CLOSE frames
 *
 * The relay sends ["CLOSE", subId] when a subscription is torn down (on
 * unsubscribe, stream completion, or error). Don't assert
 * `server.messages.toHaveLength(n)` — filter by `m[0] === "REQ"` instead.
 *
 * ## relay.reconnectTimer
 *
 * The Relay class has a built-in exponential backoff (starting at 1s) that
 * fires after any connection drop, setting _ready$ to false until the timer
 * completes. This delays the next REQ by at least 1s even when retryDelay: 0
 * is set in resilientSubscription. Override it per-instance in beforeEach:
 *   `r.reconnectTimer = () => of(0)`
 * This makes _ready$ cycle false→true immediately so tests don't time out.
 * Do NOT use `vi.spyOn(Relay, "createReconnectTimer")` — that affects the
 * static factory and causes the relay to reconnect too aggressively, which
 * sends spurious REQs and breaks permanent-error fast-fail assertions.
 *
 * ## reconnect: false in subscription() vs req()
 *
 * resilientSubscription passes `reconnect: false` to pool.relay().subscription().
 * The relay's subscription() forwards this to req() — but req() uses the
 * `resubscribe` option (not `reconnect`) for its customRepeatOperator. So
 * `reconnect: false` does NOT disable the relay's internal repeat(). This is
 * intentional: resilientSubscription owns the reconnect lifecycle via its own
 * retry() + repeat() operators and disables the relay's internal reconnect by
 * passing `reconnect: false` to the relay's subscription() which maps to the
 * relay's own retry config, not the repeat/resubscribe config.
 */

import { subscribeSpyTo } from "@hirez_io/observer-spy";
import { BehaviorSubject, of, Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WS } from "vitest-websocket-mock";
import { Relay, RelayPool } from "applesauce-relay";
import type { NostrEvent } from "nostr-tools";

import {
  resilientSubscription,
  resilientRequest,
} from "@/lib/resilientSubscription";
import { createRelaySubscriptionCoverage } from "@/lib/relaySubscriptionCoverage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush microtasks + a few macrotask rounds to let timers fire. */
async function tick(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const RELAY_URL = "wss://test.relay";
const RELAY_URL_2 = "wss://test2.relay";

const mockEvent: NostrEvent = {
  kind: 1,
  id: "aabbcc" + "0".repeat(58),
  pubkey: "dd" + "0".repeat(62),
  created_at: 1_700_000_000,
  tags: [],
  content: "hello",
  sig: "ee" + "0".repeat(126),
};

const mockEvent2: NostrEvent = {
  ...mockEvent,
  id: "ff" + "0".repeat(62),
  created_at: 1_700_000_001,
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let server: WS;
let server2: WS;
let pool: RelayPool;

beforeEach(() => {
  // Suppress NIP-11 HTTP fetch — not relevant to these tests
  vi.spyOn(Relay, "fetchInformationDocument").mockImplementation(() =>
    of(null),
  );

  server = new WS(RELAY_URL, { jsonProtocol: true });
  server2 = new WS(RELAY_URL_2, { jsonProtocol: true });

  pool = new RelayPool();

  // Disable keep-alive pings on every relay the pool creates.
  // Also override the relay's internal reconnect backoff timer to fire
  // immediately (timer(0)) so reconnect tests don't have to wait 1s+.
  const origRelay = pool.relay.bind(pool);
  vi.spyOn(pool, "relay").mockImplementation((url: string) => {
    const r = origRelay(url);
    r.keepAlive = 0;
    r.reconnectTimer = () => of(0);
    return r;
  });
});

afterEach(async () => {
  await WS.clean();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: consume the next REQ message and return the subscription id
// ---------------------------------------------------------------------------
async function expectReq(ws: WS, filter?: object): Promise<string> {
  const msg = (await ws.nextMessage) as [string, string, ...unknown[]];
  expect(msg[0]).toBe("REQ");
  if (filter) expect(msg[2]).toMatchObject(filter);
  return msg[1]; // subscription id
}

function triggerForegroundResume(): void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const now = Date.now();
  const nowSpy = vi.spyOn(Date, "now");

  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    nowSpy.mockReturnValue(now);
    document.dispatchEvent(new Event("visibilitychange"));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    nowSpy.mockReturnValue(now + 31_000);
    document.dispatchEvent(new Event("visibilitychange"));
  } finally {
    nowSpy.mockRestore();
    if (ownDescriptor) {
      Object.defineProperty(document, "visibilityState", ownDescriptor);
    } else {
      delete (document as unknown as { visibilityState?: string })
        .visibilityState;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Basic event delivery
// ---------------------------------------------------------------------------

describe("basic event delivery", () => {
  it("delivers events from a single relay before EOSE", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: false,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const subId = await expectReq(server, { kinds: [1] });
    server.send(["EVENT", subId, mockEvent]);
    server.send(["EOSE", subId]);

    spy.unsubscribe();

    expect(spy.getValues()).toContainEqual(
      expect.objectContaining({ id: mockEvent.id }),
    );
  });

  it("merges events from two relays", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL, RELAY_URL_2], [{ kinds: [1] }], {
        settle: false,
        reconnect: false,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const subId1 = await expectReq(server);
    const subId2 = await expectReq(server2);

    server.send(["EVENT", subId1, mockEvent]);
    server2.send(["EVENT", subId2, mockEvent2]);

    spy.unsubscribe();

    const ids = spy.getValues().map((v) => (v as NostrEvent).id);
    expect(ids).toContain(mockEvent.id);
    expect(ids).toContain(mockEvent2.id);
  });

  it("sends CLOSE to the relay when unsubscribed", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: false,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const subId = await expectReq(server);
    spy.unsubscribe();

    await expect(server).toReceiveMessage(["CLOSE", subId]);
  });
});

describe("stable-filter lifecycle coverage", () => {
  it("requires a real EOSE and stops coverage with its owner", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).subscribe();

    const subId = await expectReq(server);
    const initial = coverage.get(RELAY_URL);
    expect(initial?.phase).toBe("initial");
    expect(coverage.isCovered(RELAY_URL)).toBe(false);

    server.send(["EOSE", subId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));
    expect(coverage.get(RELAY_URL)?.generation).toBe(initial?.generation);

    subscription.unsubscribe();
    expect(coverage.get(RELAY_URL)?.phase).toBe("stopped");
  });

  it("invalidates reconnect and graceful-close cycles until their EOSE", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const lifecycle = vi.fn(coverage.onLifecycle);
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: Infinity,
        onRelayLifecycle: lifecycle,
      },
    ).subscribe();

    const firstId = await expectReq(server);
    server.send(["EOSE", firstId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));

    const relay = pool.relay(RELAY_URL);
    relay.error$.next(new Error("transport lost"));
    await vi.waitFor(() =>
      expect(coverage.get(RELAY_URL)?.phase).toBe("unavailable"),
    );
    expect(coverage.isCovered(RELAY_URL)).toBe(false);

    relay.error$.next(null);
    relay.open$.next(new Event("open"));
    const retryId = await vi.waitFor(() => {
      const requests = server.messages.filter(
        (message) => Array.isArray(message) && message[0] === "REQ",
      ) as Array<["REQ", string]>;
      expect(requests).toHaveLength(2);
      return requests[1][1];
    });
    expect(coverage.get(RELAY_URL)?.phase).toBe("initial");
    expect(coverage.isCovered(RELAY_URL)).toBe(false);
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ relay: RELAY_URL, phase: "unavailable" }),
    );

    server.send(["EOSE", retryId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));

    server.send(["CLOSED", retryId, "relay restarting"]);
    const repeatId = await vi.waitFor(() => {
      const requests = server.messages.filter(
        (message) => Array.isArray(message) && message[0] === "REQ",
      ) as Array<["REQ", string]>;
      expect(requests).toHaveLength(3);
      return requests[2][1];
    });
    expect(coverage.get(RELAY_URL)?.phase).toBe("initial");
    expect(coverage.isCovered(RELAY_URL)).toBe(false);

    server.send(["EOSE", repeatId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));
    subscription.unsubscribe();
  });

  it("applies the configured backoff and pre-EOSE budget after transport recovery", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const retryGate = new Subject<0>();
    const retryDelay = vi.fn(() => retryGate);
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryCount: 1,
        retryDelay,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).subscribe();

    await expectReq(server);
    const relay = pool.relay(RELAY_URL);
    relay.error$.next(new Error("transport lost"));
    relay.error$.next(null);
    relay.open$.next(new Event("open"));

    await vi.waitFor(() => expect(retryDelay).toHaveBeenCalledTimes(1));
    expect(
      server.messages.filter(
        (message) => Array.isArray(message) && message[0] === "REQ",
      ),
    ).toHaveLength(1);

    retryGate.next(0);
    await vi.waitFor(() =>
      expect(
        server.messages.filter(
          (message) => Array.isArray(message) && message[0] === "REQ",
        ),
      ).toHaveLength(2),
    );

    relay.error$.next(new Error("transport lost again"));
    await tick();
    expect(retryDelay).toHaveBeenCalledTimes(1);
    expect(coverage.isCovered(RELAY_URL)).toBe(false);
    subscription.unsubscribe();
  });

  it("marks foreground gap-fill as catching up until its real EOSE", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: true,
        retryDelay: 0,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).subscribe();

    const liveId = await expectReq(server);
    server.send(["EOSE", liveId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));

    triggerForegroundResume();
    expect(coverage.get(RELAY_URL)?.phase).toBe("catching-up");
    expect(coverage.isCovered(RELAY_URL)).toBe(false);

    const gapFillId = await expectReq(server, { kinds: [1] });
    server.send(["EOSE", gapFillId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));
    subscription.unsubscribe();
  });

  it("retries a foreground gap-fill that closes before EOSE", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: true,
        retryDelay: 0,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).subscribe();

    const liveId = await expectReq(server);
    server.send(["EOSE", liveId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));

    triggerForegroundResume();
    const firstGapFillId = await expectReq(server);
    server.send(["CLOSED", firstGapFillId, "relay restarting"]);
    const retryGapFillId = await expectReq(server);
    expect(retryGapFillId).not.toBe(firstGapFillId);
    expect(coverage.get(RELAY_URL)?.phase).toBe("catching-up");

    server.send(["EOSE", retryGapFillId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));
    subscription.unsubscribe();
  });

  it("uses a full foreground query when the live backfill has not EOSEd", async () => {
    const coverage = createRelaySubscriptionCoverage();
    const subscription = resilientSubscription(
      pool,
      [RELAY_URL],
      [{ kinds: [1] }],
      {
        settle: false,
        reconnect: true,
        gapFill: true,
        retryDelay: 0,
        onRelayLifecycle: (event) => coverage.onLifecycle(event),
      },
    ).subscribe();

    const liveId = await expectReq(server);
    server.send(["EVENT", liveId, mockEvent]);
    await tick();
    triggerForegroundResume();

    const message = (await server.nextMessage) as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(message[0]).toBe("REQ");
    expect(message[2]).toMatchObject({ kinds: [1] });
    expect(message[2]).not.toHaveProperty("since");
    server.send(["EOSE", message[1]]);

    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));
    subscription.unsubscribe();
  });

  it("starts added relays fresh and stops only removed relay coverage", async () => {
    const relays = new BehaviorSubject<string[]>([RELAY_URL]);
    const coverage = createRelaySubscriptionCoverage();
    const subscription = resilientSubscription(pool, relays, [{ kinds: [1] }], {
      settle: false,
      reconnect: true,
      gapFill: false,
      retryDelay: 0,
      onRelayLifecycle: (event) => coverage.onLifecycle(event),
    }).subscribe();

    const firstId = await expectReq(server);
    server.send(["EOSE", firstId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL)).toBe(true));

    relays.next([RELAY_URL, RELAY_URL_2]);
    const secondId = await expectReq(server2);
    expect(coverage.get(RELAY_URL_2)?.phase).toBe("initial");
    expect(coverage.isCovered(RELAY_URL)).toBe(true);

    server2.send(["EOSE", secondId]);
    await vi.waitFor(() => expect(coverage.isCovered(RELAY_URL_2)).toBe(true));
    relays.next([RELAY_URL_2]);
    await vi.waitFor(() =>
      expect(coverage.get(RELAY_URL)?.phase).toBe("stopped"),
    );
    expect(coverage.isCovered(RELAY_URL_2)).toBe(true);

    subscription.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 2. EOSE settle signal
// ---------------------------------------------------------------------------

describe("EOSE settle signal", () => {
  it("emits EOSE after all relays have settled", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL, RELAY_URL_2], [{ kinds: [1] }], {
        settle: true,
        settleTime: 1,
        reconnect: false,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const subId1 = await expectReq(server);
    const subId2 = await expectReq(server2);

    server.send(["EOSE", subId1]);
    server2.send(["EOSE", subId2]);

    await tick();

    spy.unsubscribe();

    expect(spy.getValues()).toContain("EOSE");
  });

  it("does not emit EOSE when settle is disabled", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: false,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const subId = await expectReq(server);
    server.send(["EOSE", subId]);

    await tick();
    spy.unsubscribe();

    expect(spy.getValues()).not.toContain("EOSE");
  });
});

// ---------------------------------------------------------------------------
// 3. resilientRequest — autoClose
// ---------------------------------------------------------------------------

describe("resilientRequest (autoClose)", () => {
  it("completes the stream after EOSE with no pagination", async () => {
    const spy = subscribeSpyTo(
      resilientRequest(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: true,
        settleTime: 1,
        retryDelay: 0,
      }),
    );

    const subId = await expectReq(server);
    server.send(["EVENT", subId, mockEvent]);
    server.send(["EOSE", subId]);

    await tick();

    expect(spy.receivedComplete()).toBe(true);
    expect(spy.getValues()).toContainEqual(
      expect.objectContaining({ id: mockEvent.id }),
    );
    expect(spy.getValues()).toContain("EOSE");
  });
});

// ---------------------------------------------------------------------------
// 4. Reconnect — since: lastReceivedAt injected on retry
// ---------------------------------------------------------------------------

describe("reconnect with since: lastReceivedAt", () => {
  it("does NOT inject since on the first connection (no events received yet)", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
      }),
    );

    const msg = (await server.nextMessage) as [string, string, object];
    expect(msg[0]).toBe("REQ");
    expect(msg[2]).not.toHaveProperty("since");

    spy.unsubscribe();
  });

  it("injects since: lastReceivedAt - gapFillBuffer on reconnect after error", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: true,
        gapFill: false,
        gapFillBuffer: 600,
        retryDelay: 0,
        retryCount: Infinity,
      }),
    );

    const subId = await expectReq(server, { kinds: [1] });

    // Deliver one event so lastReceivedAt is set
    server.send(["EVENT", subId, mockEvent]);
    await tick();

    // Trigger a retry via a transient CLOSED error (no WebSocket reconnect needed)
    server.send(["CLOSED", subId, "error: temporary outage"]);
    await tick();

    // The reconnect REQ should include since: mockEvent.created_at - 600
    const reconnectMsg = (await server.nextMessage) as [
      string,
      string,
      { since?: number },
    ];
    expect(reconnectMsg[0]).toBe("REQ");
    expect(reconnectMsg[2].since).toBe(mockEvent.created_at - 600);

    spy.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 5. Permanent CLOSED — fast-fail, no retry
// ---------------------------------------------------------------------------

describe("permanent CLOSED errors", () => {
  it("settles immediately on 'restricted' CLOSED without retrying", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: true,
        settleTime: 1,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: 3,
      }),
    );

    const subId = await expectReq(server);

    // Relay rejects with a permanent policy error
    server.send(["CLOSED", subId, "restricted: paid relay"]);

    await tick();

    // EOSE should still fire (settle signal was called via signal.error)
    expect(spy.getValues()).toContain("EOSE");

    // No retry REQ — only the initial one (server.messages also includes the CLOSE)
    const reqs = server.messages.filter((m) => (m as string[])[0] === "REQ");
    expect(reqs).toHaveLength(1);

    spy.unsubscribe();
  });

  it("settles immediately on 'blocked' CLOSED without retrying", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: true,
        settleTime: 1,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: 3,
      }),
    );

    const subId = await expectReq(server);
    server.send(["CLOSED", subId, "blocked: you are banned"]);

    await tick();

    expect(spy.getValues()).toContain("EOSE");
    // No retry REQ — only the initial one
    const reqs = server.messages.filter((m) => (m as string[])[0] === "REQ");
    expect(reqs).toHaveLength(1);

    spy.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 6. Transient error — retries then delivers events
// ---------------------------------------------------------------------------

describe("transient error retry", () => {
  it("retries on connection error and delivers events on reconnect", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: 3,
      }),
    );

    // First attempt — relay sends a transient CLOSED (not a permanent prefix)
    // Using a CLOSED message avoids the WebSocket reconnect dance entirely.
    const subId1 = await expectReq(server);
    server.send(["CLOSED", subId1, "error: temporary outage"]);
    await tick();

    // Second attempt — defer() re-executes so nanoid generates a fresh subscription id
    const subId2 = await expectReq(server);
    expect(subId2).not.toBe(subId1);
    server.send(["EVENT", subId2, mockEvent]);

    await tick();
    spy.unsubscribe();

    expect(spy.getValues()).toContainEqual(
      expect.objectContaining({ id: mockEvent.id }),
    );
  });

  it("gives up after retryCount transient errors before first EOSE and settles", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: true,
        settleTime: 1,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: 2,
      }),
    );

    // Exhaust all retries using transient CLOSED messages (no WebSocket reconnect needed)
    // initial attempt + 2 retries = 3 total
    for (let i = 0; i < 3; i++) {
      const subId = await expectReq(server);
      server.send(["CLOSED", subId, "error: temporary outage"]);
      await tick();
    }

    await tick();

    // After giving up, settle signal fires so EOSE is emitted
    expect(spy.getValues()).toContain("EOSE");
    // Only 3 REQs sent — no further retries
    const reqs = server.messages.filter((m) => (m as string[])[0] === "REQ");
    expect(reqs).toHaveLength(3);

    spy.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 7. Graceful relay close — repeat() resubscribes
// ---------------------------------------------------------------------------

describe("graceful relay close (CLOSED without error prefix)", () => {
  it("resubscribes after a graceful CLOSED", async () => {
    const spy = subscribeSpyTo(
      resilientSubscription(pool, [RELAY_URL], [{ kinds: [1] }], {
        settle: false,
        reconnect: true,
        gapFill: false,
        retryDelay: 0,
        retryCount: Infinity,
      }),
    );

    const subId1 = await expectReq(server);
    // Graceful close — no error prefix means repeat() resubscribes
    server.send(["CLOSED", subId1, "relay restarting"]);

    await tick();

    // Should have resubscribed with a fresh subscription id
    const subId2 = await expectReq(server);
    expect(subId2).not.toBe(subId1);

    spy.unsubscribe();
  });
});
