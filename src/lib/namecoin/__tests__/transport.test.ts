import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  DEFAULT_ELECTRUMX_SERVERS,
  nameShowWithFallback,
  useWebSocketImplementation,
  type ElectrumXServer,
} from "@/lib/namecoin/transport";
import {
  buildNameIndexScript,
  electrumScriptHash,
} from "@/lib/namecoin/script";

// ---------------------------------------------------------------------------
// Fake WebSocket + scripted response engine
// ---------------------------------------------------------------------------

type Handler = (call: {
  method: string;
  params: unknown[];
  id: number;
}) => Promise<{ result?: unknown; error?: unknown } | null>;

interface Listeners {
  open: Array<() => void>;
  message: Array<(ev: { data: string }) => void>;
  close: Array<() => void>;
  error: Array<(e: Error) => void>;
}

const opensCount: Record<string, number> = {};

class FakeWebSocket {
  url: string;
  private listeners: Listeners = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  private handler: Handler;
  private openDelayMs: number;
  closed = false;

  constructor(
    url: string,
    handler: Handler,
    options: { openDelayMs?: number; failOpen?: boolean } = {},
  ) {
    this.url = url;
    this.handler = handler;
    this.openDelayMs = options.openDelayMs ?? 0;
    if (!opensCount[url]) opensCount[url] = 0;
    opensCount[url]++;
    if (options.failOpen) {
      setTimeout(() => {
        this.fire("error", new Error("connect refused"));
        this.fire("close");
      }, 0);
      return;
    }
    setTimeout(() => {
      if (!this.closed) this.fire("open");
    }, this.openDelayMs);
  }

  addEventListener<K extends keyof Listeners>(
    type: K,
    fn: Listeners[K][number],
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners[type] as Array<any>).push(fn);
  }

  send(raw: string): void {
    if (this.closed) throw new Error("send on closed");
    let parsed: { id?: number; method?: string; params?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed.id !== "number" || typeof parsed.method !== "string") {
      return;
    }
    void this.handler({
      method: parsed.method,
      params: parsed.params ?? [],
      id: parsed.id,
    }).then((reply) => {
      if (this.closed || reply == null) return;
      const data = JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id!,
        ...reply,
      });
      this.fire("message", { data });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire("close");
  }

  private fire<K extends keyof Listeners>(type: K, arg?: unknown): void {
    for (const fn of this.listeners[type]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn as any)(arg);
    }
  }
}

// ---------------------------------------------------------------------------
// Reusable scenarios
// ---------------------------------------------------------------------------

const PK_64 = "a".repeat(64);
const NAME_VALUE_JSON = `{"nostr":"${PK_64}"}`;

function buildVoutHexFor(name: string, valueJSON: string): string {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const valueBytes = enc.encode(valueJSON);
  const out: number[] = [0x53];
  // name push
  if (nameBytes.length < 0x4c) {
    out.push(nameBytes.length);
  } else {
    out.push(0x4c, nameBytes.length);
  }
  for (const b of nameBytes) out.push(b);
  // value push (always small enough for OP_PUSHDATA1)
  out.push(0x4c, valueBytes.length);
  for (const b of valueBytes) out.push(b);
  out.push(0x6d, 0x75);
  return bytesToHex(new Uint8Array(out));
}

function happyHandler(name: string, valueJSON: string): Handler {
  const scriptHash = electrumScriptHash(
    buildNameIndexScript(new TextEncoder().encode(name)),
  );
  return async ({ method, params }) => {
    if (method === "server.version") {
      return { result: ["FakeElectrumX 1.0", "1.4"] };
    }
    if (method === "blockchain.scripthash.get_history") {
      if (params[0] !== scriptHash) {
        return { result: [] };
      }
      return { result: [{ tx_hash: "deadbeef", height: 1000 }] };
    }
    if (method === "blockchain.transaction.get") {
      return {
        result: {
          vout: [{ scriptPubKey: { hex: buildVoutHexFor(name, valueJSON) } }],
        },
      };
    }
    if (method === "blockchain.headers.subscribe") {
      return { result: { height: 1000 } }; // not expired
    }
    return { error: { code: -1, message: "unknown method" } };
  };
}

function missHandler(): Handler {
  return async ({ method }) => {
    if (method === "server.version") {
      return { result: ["FakeElectrumX 1.0", "1.4"] };
    }
    if (method === "blockchain.scripthash.get_history") {
      return { result: [] };
    }
    return { error: { code: -1, message: "no" } };
  };
}

function expiredHandler(name: string, valueJSON: string): Handler {
  const scriptHash = electrumScriptHash(
    buildNameIndexScript(new TextEncoder().encode(name)),
  );
  return async ({ method, params }) => {
    if (method === "server.version") return { result: ["F", "1.4"] };
    if (method === "blockchain.scripthash.get_history") {
      if (params[0] !== scriptHash) return { result: [] };
      // height very old vs tip
      return { result: [{ tx_hash: "deadbeef", height: 1 }] };
    }
    if (method === "blockchain.transaction.get") {
      return {
        result: {
          vout: [{ scriptPubKey: { hex: buildVoutHexFor(name, valueJSON) } }],
        },
      };
    }
    if (method === "blockchain.headers.subscribe") {
      return { result: { height: 1_000_000 } };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Test wiring: per-test scripted handlers indexed by host
// ---------------------------------------------------------------------------

let handlersByHost: Record<
  string,
  | { kind: "happy"; valueJSON: string; name: string }
  | { kind: "miss" }
  | { kind: "fail" }
  | { kind: "expired"; valueJSON: string; name: string }
> = {};

function makeWebSocketCtor() {
  return function (url: string) {
    const host = new URL(url).hostname;
    const config = handlersByHost[host];
    if (!config) {
      // Default: refuse the connection.
      return new FakeWebSocket(url, async () => null, { failOpen: true });
    }
    if (config.kind === "happy") {
      return new FakeWebSocket(
        url,
        happyHandler(config.name, config.valueJSON),
      );
    }
    if (config.kind === "miss") {
      return new FakeWebSocket(url, missHandler());
    }
    if (config.kind === "expired") {
      return new FakeWebSocket(
        url,
        expiredHandler(config.name, config.valueJSON),
      );
    }
    return new FakeWebSocket(url, async () => null, { failOpen: true });
  } as unknown as typeof WebSocket;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  handlersByHost = {};
  for (const k of Object.keys(opensCount)) delete opensCount[k];
  useWebSocketImplementation(makeWebSocketCtor());
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const S = (host: string, port = 50004): ElectrumXServer => ({ host, port });

describe("DEFAULT_ELECTRUMX_SERVERS", () => {
  it("only contains wss-usable endpoints (probe-verified)", () => {
    // Sanity: every server is one of the browser-verified hosts.
    const allowed = new Set([
      "electrumx2.testls.space",
      "electrumx.testls.space",
      "relay.testls.bit",
      "electrum.nmc.ethicnology.com",
    ]);
    for (const s of DEFAULT_ELECTRUMX_SERVERS) {
      expect(allowed.has(s.host)).toBe(true);
    }
    // We omit nmc2.bitcoins.sk and the bare-IP entries because they don't
    // expose WSS to a browser-equivalent client. If a future endpoint is
    // added, expand `allowed` after probing it first.
    expect(DEFAULT_ELECTRUMX_SERVERS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("nameShowWithFallback — single server happy path", () => {
  it("returns { kind: 'found' } with the latest name_update value JSON", async () => {
    handlersByHost["fake.test"] = {
      kind: "happy",
      name: "d/foo",
      valueJSON: NAME_VALUE_JSON,
    };
    const r = await nameShowWithFallback("d/foo", [S("fake.test")]);
    expect(r).toEqual({ kind: "found", value: NAME_VALUE_JSON });
  });
});

describe("nameShowWithFallback — fallback chain", () => {
  it("skips a server that refuses the connection and tries the next", async () => {
    handlersByHost["bad.test"] = { kind: "fail" };
    handlersByHost["good.test"] = {
      kind: "happy",
      name: "d/foo",
      valueJSON: NAME_VALUE_JSON,
    };
    const r = await nameShowWithFallback("d/foo", [
      S("bad.test"),
      S("good.test"),
    ]);
    expect(r).toEqual({ kind: "found", value: NAME_VALUE_JSON });
  });

  it("returns { kind: 'not-found' } when every server reports a definitive miss", async () => {
    handlersByHost["a.test"] = { kind: "miss" };
    handlersByHost["b.test"] = { kind: "miss" };
    const r = await nameShowWithFallback("d/missing", [
      S("a.test"),
      S("b.test"),
    ]);
    expect(r).toEqual({ kind: "not-found" });
  });

  it("returns { kind: 'unavailable' } when every server fails transport with no definitive miss", async () => {
    handlersByHost["a.test"] = { kind: "fail" };
    handlersByHost["b.test"] = { kind: "fail" };
    const r = await nameShowWithFallback("d/foo", [S("a.test"), S("b.test")]);
    expect(r).toEqual({ kind: "unavailable" });
  });

  it("returns { kind: 'not-found' } when at least one server confirms a miss even if others fail", async () => {
    // A transport-broken server followed by a definitive-miss server
    // should still resolve as not-found, not unavailable.
    handlersByHost["broken.test"] = { kind: "fail" };
    handlersByHost["missing.test"] = { kind: "miss" };
    const r = await nameShowWithFallback("d/nope", [
      S("broken.test"),
      S("missing.test"),
    ]);
    expect(r).toEqual({ kind: "not-found" });
  });
});

describe("nameShowWithFallback — expiry", () => {
  it("returns { kind: 'not-found' } when the name update is past the expiry window", async () => {
    handlersByHost["e.test"] = {
      kind: "expired",
      name: "d/foo",
      valueJSON: NAME_VALUE_JSON,
    };
    const r = await nameShowWithFallback("d/foo", [S("e.test")]);
    expect(r).toEqual({ kind: "not-found" });
  });
});
