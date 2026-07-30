/**
 * ElectrumX over WebSocket Secure (WSS) transport for Namecoin name
 * lookups. Browser-first: every endpoint in {@link DEFAULT_ELECTRUMX_SERVERS}
 * was probe-tested to confirm it accepts WSS and serves a valid
 * ElectrumX JSON-RPC reply from a browser-equivalent client (no raw
 * TCP, no self-signed cert that would fail a browser TLS handshake).
 *
 * Holds the pluggable WebSocket constructor, the default server list,
 * the minimal JSON-RPC-2.0 client, and the `name_show` lookup that
 * walks `blockchain.scripthash.get_history` →
 * `blockchain.transaction.get`. The same `lookupNameValue` function is
 * exposed to the value layer so the ifa-0001 `import` resolver in
 * `value.ts` can re-enter the WSS path for sub-imports.
 */
import {
  buildNameIndexScript,
  electrumScriptHash,
  extractNameValue,
} from "./script";

/** A pluggable WebSocket implementation; must match the browser API. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocketCtor = any;

let _WebSocket: WebSocketCtor;
try {
  _WebSocket = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
} catch {
  _WebSocket = undefined;
}

/**
 * Inject a WebSocket implementation. Browsers ship one out of the box
 * so callers there should never need this; the override exists for
 * tests (mock `WebSocket`) and for any future server-side path.
 */
export function useWebSocketImplementation(impl: WebSocketCtor): void {
  _WebSocket = impl;
}

/** A single Namecoin ElectrumX endpoint over WSS. */
export type ElectrumXServer = {
  /** Hostname, e.g. `electrumx.testls.space`. */
  host: string;
  /** Port serving WSS, e.g. `50004`. */
  port: number;
  /** WSS path. Defaults to `/`. Most operators accept any path. */
  path?: string;
};

/**
 * Default list of Namecoin ElectrumX WSS endpoints, tried in order
 * until one returns a definitive result (name found, expired, or
 * missing). Probe-tested 2026-06-19, then live-verified in Chrome
 * after deployment. Browsers refuse non-publicly-trusted certs
 * (no `rejectUnauthorized: false` escape hatch), so only the LE-cert
 * endpoint is browser-reachable today; the others are kept as
 * best-effort fallbacks so non-browser hosts (Node with the `ws`
 * package + a self-signed-accepting `WebSocket`) can still reach
 * them.
 *
 * Browser TLS status of each entry, with reasoning so the next
 * audit doesn't have to redo the work:
 *
 * - `electrum.nmc.ethicnology.com:50004` — LE cert. ✅ browser-reachable.
 * - `electrumx.testls.space:50004` — self-signed (CN=`electrum.testls.space`,
 *   issuer-self). ❌ `ERR_CERT_AUTHORITY_INVALID` in Chrome.
 * - `relay.testls.bit:443/electrumx` — Namecoin TLS chain. ❌ untrusted by
 *   stock browsers without a Namecoin-aware verifier.
 * - `relay.testls.bit:50004` — self-signed. ❌ `ERR_CERT_AUTHORITY_INVALID`.
 *
 * The Amethyst / quartz list additionally carries `nmc2.bitcoins.sk`,
 * `46.229.238.187`, and `23.158.233.10` for JVM TLS paths that pin
 * self-signed certs or skip hostname checks; none of those work from
 * a browser (no WSS exposure on the first two, hostname-verification
 * failure on the third), so they are intentionally omitted entirely.
 */
export const DEFAULT_ELECTRUMX_SERVERS: ElectrumXServer[] = [
  // ElectrumX 1.19.0, public Let's Encrypt cert. ONLY entry guaranteed
  // to work from a browser today; kept first so the fallback chain
  // succeeds on the first hop.
  { host: "electrum.nmc.ethicnology.com", port: 50004 },
  // ElectrumX 1.16.0, self-signed cert. Best-effort fallback for non-
  // browser callers that inject a `WebSocket` impl which accepts the
  // pin (see {@link useWebSocketImplementation}).
  { host: "electrumx.testls.space", port: 50004 },
  // ElectrumX 1.16.0 on port 443 (TLS-multiplexed alongside the relay).
  // The non-`/electrumx` paths on :443 route to the Nostr relay; only
  // `/electrumx` returns ElectrumX JSON-RPC. Namecoin TLS chain.
  { host: "relay.testls.bit", port: 443, path: "/electrumx" },
  // Same backend on the conventional ElectrumX WSS port; self-signed.
  { host: "relay.testls.bit", port: 50004 },
];

/** Blocks until a Namecoin name expires (~250 days at ~10 min/block). */
const NAME_EXPIRE_DEPTH = 36000;

const textEncoder = new TextEncoder();

class NameMissError extends Error {}

/**
 * Tri-state result from a Namecoin name lookup:
 *
 * - `found`      — the name exists, is unexpired, and has a value payload.
 * - `not-found`  — at least one server returned a definitive miss (empty
 *                  history or expired-past-{@link NAME_EXPIRE_DEPTH}); the
 *                  name genuinely doesn't resolve.
 * - `unavailable`— every server failed transport (refused socket, timeout,
 *                  malformed reply) with no definitive miss from anyone.
 *                  Retryable; the resolver is not reachable right now.
 *
 * This split is required by the gitworkshop feedback loop so the UI can
 * distinguish "name doesn't exist" from "can't reach ElectrumX right now".
 */
export type NameLookupResult =
  | { kind: "found"; value: string }
  | { kind: "not-found" }
  | { kind: "unavailable" };

/**
 * Walk `servers` in order looking up `name`. Behaviour:
 *
 * - First server that returns a value → return `found`.
 * - First server that returns a definitive miss latches the outcome but we
 *   still continue in case a later server has fresher indexing that returns
 *   a value. If no later server returns a value, we finalise `not-found`.
 * - If every server fails transport (no miss, no value), return `unavailable`.
 *
 * This function replaces the earlier `nameShowWithFallback` which
 * collapsed "not-found" and "unavailable" into a single `null`.
 */
export async function nameShowWithFallback(
  name: string,
  servers: ElectrumXServer[],
): Promise<NameLookupResult> {
  let definitiveMiss = false;
  for (const srv of servers) {
    try {
      const value = await nameShow(name, srv);
      if (value === null) {
        // Successful `null` = resolved-but-expired; treat as definitive.
        return { kind: "not-found" };
      }
      return { kind: "found", value };
    } catch (err) {
      if (err instanceof NameMissError) {
        definitiveMiss = true;
        continue;
      }
      // Transport error — try next server.
    }
  }
  return definitiveMiss ? { kind: "not-found" } : { kind: "unavailable" };
}

async function nameShow(
  name: string,
  srv: ElectrumXServer,
): Promise<string | null> {
  if (!_WebSocket) {
    throw new Error(
      "namecoin/transport: no WebSocket implementation available; call useWebSocketImplementation(impl).",
    );
  }

  const url = buildWSSUrl(srv);
  const rpc = new RPC(new _WebSocket(url));
  try {
    await rpc.opened;
    await rpc.call("server.version", ["gitworkshop/namecoin-nip05", "1.4"]);

    const script = buildNameIndexScript(textEncoder.encode(name));
    const scriptHash = electrumScriptHash(script);
    const history = await rpc.call<Array<{ tx_hash: string; height: number }>>(
      "blockchain.scripthash.get_history",
      [scriptHash],
    );
    if (!history || history.length === 0) throw new NameMissError();
    const latest = history[history.length - 1];

    const tx = await rpc.call<{
      vout: Array<{ scriptPubKey?: { hex?: string } }>;
    }>("blockchain.transaction.get", [latest.tx_hash, true]);

    // Expiry check (best-effort): subscribe to headers to learn the
    // chain tip, then compare to the latest update height. Failures
    // here are non-fatal.
    let currentHeight = 0;
    try {
      const header = await rpc.call<{ height?: number }>(
        "blockchain.headers.subscribe",
        [],
      );
      if (header && typeof header.height === "number") {
        currentHeight = header.height;
      }
    } catch {
      // ignore
    }
    if (
      currentHeight > 0 &&
      latest.height > 0 &&
      currentHeight - latest.height >= NAME_EXPIRE_DEPTH
    ) {
      return null; // expired
    }

    return extractNameValue(tx.vout, name);
  } finally {
    rpc.close();
  }
}

function buildWSSUrl(srv: ElectrumXServer): string {
  const path = srv.path ?? "/";
  return `wss://${srv.host}:${srv.port}${
    path.startsWith("/") ? path : "/" + path
  }`;
}

/**
 * Resolve `name`'s raw value JSON via the same WSS fallback chain used
 * by user-facing lookups. Exposed so the ifa-0001 `import` resolver in
 * `value.ts` can re-enter the transport for sub-imports without having
 * to thread the server list through every layer.
 *
 * Adapter shape: the import resolver only cares about
 * "here is the JSON" vs "give up on this branch", so we flatten
 * `unavailable` and `not-found` to `null` for its consumers. The
 * top-level resolver keeps the tri-state via {@link nameShowWithFallback}
 * directly.
 */
export function makeWssLookup(
  servers: ElectrumXServer[],
): (namecoinName: string) => Promise<string | null> {
  return async (namecoinName: string) => {
    const r = await nameShowWithFallback(namecoinName, servers);
    return r.kind === "found" ? r.value : null;
  };
}

/**
 * Minimal JSON-RPC-2.0 over WebSocket.
 *
 * Every outbound call carries a per-request timeout so a server that
 * accepts the socket but never replies cannot stall verification
 * flows; {@link nameShowWithFallback} catches the timeout error and
 * moves on to the next server.
 */
class RPC {
  static readonly REQUEST_TIMEOUT_MS = 8000;

  opened: Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ws: any;
  private id = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ws: any) {
    this.ws = ws;
    // `opened` must reject if the socket closes (or fails) before it opens.
    // Chrome does not always fire `error` for TLS-handshake failures like
    // `ERR_CERT_AUTHORITY_INVALID` — the socket just `close`s with no prior
    // `error`. Without rejecting `opened` on a pre-open `close`,
    // `await rpc.opened` hangs forever and the fallback loop in
    // `nameShowWithFallback` never advances to the next server.
    let openedSettled = false;
    this.opened = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        openedSettled = true;
        resolve();
      });
      ws.addEventListener("error", () => {
        if (!openedSettled) {
          openedSettled = true;
          reject(new Error("websocket error"));
        }
      });
      ws.addEventListener("close", () => {
        // If we never opened, fail the `opened` promise so the caller can
        // move on to the next server. If we already opened, fail any
        // pending RPCs so their awaits unblock with a clear error.
        if (!openedSettled) {
          openedSettled = true;
          reject(new Error("websocket closed before open"));
        }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("websocket closed"));
        }
        this.pending.clear();
      });
    });
    ws.addEventListener("message", (ev: { data: unknown }) =>
      this.onMessage(ev),
    );
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.id;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout (${method})`));
      }, RPC.REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });

      try {
        this.ws.send(msg);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(ev: { data: unknown }): void {
    let parsed: { id?: number; result?: unknown; error?: unknown };
    try {
      const data =
        typeof ev.data === "string"
          ? ev.data
          : new TextDecoder().decode(ev.data as ArrayBuffer);
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed.id !== "number") return;
    const p = this.pending.get(parsed.id);
    if (!p) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      p.reject(
        new Error(
          typeof parsed.error === "string"
            ? parsed.error
            : JSON.stringify(parsed.error),
        ),
      );
    } else {
      p.resolve(parsed.result);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
