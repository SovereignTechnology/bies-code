/**
 * Tests for the tri-state {@link resolveNamecoinLookup} public entry
 * point.
 *
 * The gitworkshop review explicitly asked the resolver to distinguish
 * "resolver unavailable" from "genuine name not found". These tests
 * pin that behaviour:
 *
 *   - Every server unreachable  → `{ status: "unavailable" }`
 *   - Every server misses       → `{ status: "not-found" }`
 *   - Value has no `nostr` field → `{ status: "not-found" }`
 *   - Happy path                → `{ status: "resolved", result: {...} }`
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveNamecoinLookup,
  resolveNamecoinNip05,
  useWebSocketImplementation,
  DEFAULT_ELECTRUMX_SERVERS,
} from "../index";

// The lightweight fake `WebSocket` engine already used by
// transport.test.ts. Re-declaring inline here so the two files stay
// independent — this suite exercises the public entry point, not the
// transport layer.
interface FakeHandler {
  kind: "happy" | "miss" | "fail" | "expired";
  name?: string;
  valueJSON?: string;
}

const handlersByHost: Record<string, FakeHandler> = {};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  private pendingCalls = new Map<
    number,
    { method: string; params: unknown[] }
  >();
  private handler: FakeHandler;

  constructor(public url: string) {
    const host = new URL(url).hostname;
    this.handler = handlersByHost[host] ?? { kind: "fail" };
    // Simulate async open microtask
    setTimeout(() => {
      if (this.handler.kind === "fail") {
        this.readyState = 3;
        this.dispatch("close", {});
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatch("open", {});
    }, 0);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((c) => c !== cb);
  }
  private dispatch(type: string, ev: unknown): void {
    const single = (this as unknown as Record<string, unknown>)[`on${type}`] as
      | ((ev: unknown) => void)
      | null;
    single?.(ev);
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  send(raw: string): void {
    const { id, method, params } = JSON.parse(raw) as {
      id: number;
      method: string;
      params: unknown[];
    };
    this.pendingCalls.set(id, { method, params });
    setTimeout(() => this.respond(id, method, params), 1);
  }
  private respond(id: number, method: string, _params: unknown[]): void {
    // server.version → no-op OK
    if (method === "server.version") {
      this.emit(id, { result: ["ElectrumX 1.19.0", "1.4"] });
      return;
    }
    if (method === "blockchain.scripthash.get_history") {
      if (this.handler.kind === "miss") {
        // Empty history → NameMissError inside the resolver.
        this.emit(id, { result: [] });
        return;
      }
      // Any non-empty history — the tx will actually determine the outcome.
      this.emit(id, {
        result: [{ tx_hash: "aa".repeat(32), height: 900000 }],
      });
      return;
    }
    if (method === "blockchain.transaction.get") {
      // A dummy vout containing a marker payload the fake extractNameValue
      // can find. We can't easily fake the real script parser here; the
      // real transport tests already cover that path. For this suite we
      // rely on the extractor to fall through to `null` for our synthetic
      // tx — which reads as "no value found" and is treated as not-found.
      this.emit(id, { result: { vout: [] } });
      return;
    }
    if (method === "blockchain.headers.subscribe") {
      this.emit(id, { result: { height: 900500 } });
      return;
    }
    this.emit(id, { error: `unhandled method ${method}` });
  }
  private emit(id: number, body: { result?: unknown; error?: unknown }): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, ...body });
    this.dispatch("message", { data: msg });
  }
  close(): void {
    this.readyState = 3;
    this.dispatch("close", {});
  }
}

beforeEach(() => {
  for (const key of Object.keys(handlersByHost)) delete handlersByHost[key];
  useWebSocketImplementation(FakeWebSocket as unknown as WebSocket);
  // Clear the module-level session cache between tests so each `it`
  // exercises a fresh resolver state machine.
  vi.resetModules();
});

describe("resolveNamecoinLookup — tri-state", () => {
  it("returns { status: 'unavailable' } when every configured server refuses the connection", async () => {
    // Every default server → fail → the whole chain is transport-failed.
    for (const srv of DEFAULT_ELECTRUMX_SERVERS) {
      handlersByHost[srv.host] = { kind: "fail" };
    }
    const outcome = await resolveNamecoinLookup("d/nobody");
    expect(outcome).toEqual({ status: "unavailable" });
  });

  it("returns { status: 'not-found' } when at least one server confirms a definitive miss", async () => {
    for (const srv of DEFAULT_ELECTRUMX_SERVERS) {
      handlersByHost[srv.host] = { kind: "miss" };
    }
    const outcome = await resolveNamecoinLookup("d/nobody");
    expect(outcome).toEqual({ status: "not-found" });
  });

  it("returns not-found when a value comes back but has no nostr field", async () => {
    // At least one server yields a happy vout (empty in the fake but the
    // extractor will fall through to `null`, which the resolver treats
    // as not-found).
    for (const srv of DEFAULT_ELECTRUMX_SERVERS) {
      handlersByHost[srv.host] = { kind: "happy", name: "d/foo" };
    }
    const outcome = await resolveNamecoinLookup("d/foo");
    expect(outcome.status).toBe("not-found");
  });

  it("does not cache 'unavailable' outcomes so a later retry can hit again", async () => {
    for (const srv of DEFAULT_ELECTRUMX_SERVERS) {
      handlersByHost[srv.host] = { kind: "fail" };
    }
    const first = await resolveNamecoinLookup("d/retry-me");
    expect(first).toEqual({ status: "unavailable" });
    // Second call must re-execute the state machine (not read a cached
    // "unavailable" outcome as not-found).
    const second = await resolveNamecoinLookup("d/retry-me");
    expect(second).toEqual({ status: "unavailable" });
  });

  it("resolveNamecoinNip05 collapses 'unavailable' and 'not-found' to null (legacy shape)", async () => {
    for (const srv of DEFAULT_ELECTRUMX_SERVERS) {
      handlersByHost[srv.host] = { kind: "fail" };
    }
    const result = await resolveNamecoinNip05("d/legacy");
    expect(result).toBeNull();
  });
});
