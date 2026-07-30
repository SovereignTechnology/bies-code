/**
 * Public surface for Namecoin `.bit` NIP-05 resolution.
 *
 * Wraps the low-level WSS transport, the ifa-0001 `import` resolver,
 * and the JSON value extractor behind a single cached entry point.
 *
 * Browser-first: every endpoint in {@link DEFAULT_ELECTRUMX_SERVERS}
 * was probe-tested to confirm it accepts WSS and serves valid
 * ElectrumX JSON-RPC; no server-side proxy is required.
 *
 * Everything under this module is intentionally kept behind a dynamic
 * `import()` boundary at the call sites (see
 * `src/lib/namecoin/lazy.ts`). No code outside the two thin integration
 * points in `useNamecoinSearchRedirect` and `useNamecoinNip05Identity`
 * should statically import this file, so the whole feature stays out
 * of the main app bundle and startup path.
 */
import { parseIdentifier } from "./identifier";
import {
  DEFAULT_ELECTRUMX_SERVERS,
  makeWssLookup,
  nameShowWithFallback,
  type ElectrumXServer,
} from "./transport";
import {
  extractNostrFromValue,
  resolveValueWithImports,
  type NamecoinResolveResult,
} from "./value";
import {
  getCachedNamecoinResolve,
  setCachedNamecoinResolve,
  getInflightNamecoinResolve,
  setInflightNamecoinResolve,
  deleteInflightNamecoinResolve,
} from "./cache";

export {
  isNamecoinIdentifier,
  isDotBit,
  parseIdentifier,
  type ParsedIdentifier,
} from "./identifier";
export {
  DEFAULT_ELECTRUMX_SERVERS,
  useWebSocketImplementation,
  type ElectrumXServer,
  type NameLookupResult,
} from "./transport";
export {
  extractNostrFromValue,
  resolveValueWithImports,
  DEFAULT_IMPORT_DEPTH,
  type NamecoinResolveResult,
  type NamecoinValueFetcher,
} from "./value";

/**
 * Tri-state result surface for `.bit` / `d/` / `id/` resolution:
 *
 * - `resolved`    — name exists and points at a Nostr pubkey.
 * - `not-found`   — at least one ElectrumX server responded with a
 *                   definitive miss (empty history or expired), the
 *                   value lacked a verifiable `nostr` field, or the
 *                   ifa-0001 `import` chain terminated without one.
 *                   Retrying will not change the answer until the
 *                   Namecoin chain state changes.
 * - `unavailable` — every configured ElectrumX server was unreachable
 *                   (refused socket, TLS failure, timeout) with no
 *                   server returning a definitive miss. Retryable.
 *
 * Callers should surface `unavailable` distinctly so the user knows
 * the resolver is offline, not that the name is bad — this is called
 * out explicitly in the review feedback from gitworkshop.
 */
export type NamecoinLookupOutcome =
  | { status: "resolved"; result: NamecoinResolveResult }
  | { status: "not-found" }
  | { status: "unavailable" };

/**
 * Resolve a `.bit` / `d/` / `id/` identifier to a Nostr pubkey + relay
 * list. Session-cached and deduped by in-flight key so repeated lookups
 * of the same identifier hit a single WSS round trip.
 *
 * The old signature (returning `null`) is preserved as
 * {@link resolveNamecoinNip05Legacy} for the tests and code paths that
 * only care about pubkey-or-nothing. New callers should prefer the
 * tri-state {@link resolveNamecoinLookup}.
 */
export async function resolveNamecoinLookup(
  identifier: string,
  servers?: ElectrumXServer[],
): Promise<NamecoinLookupOutcome> {
  const cached = getCachedNamecoinResolve(identifier, servers);
  if (cached !== undefined) {
    return cached === null
      ? { status: "not-found" }
      : { status: "resolved", result: cached };
  }

  // In-flight dedup: if a lookup for this identifier is already open,
  // reuse the same promise. Note: we intentionally do NOT cache
  // `unavailable` — a later call after the resolver comes back should
  // retry, not memoise the outage.
  const inflight = getInflightNamecoinResolve(identifier, servers);
  if (inflight) {
    const result = await inflight;
    return result === null
      ? { status: "not-found" }
      : { status: "resolved", result };
  }

  const p = (async () => {
    const outcome = await queryProfileWithImports(identifier, servers);
    if (outcome.status === "resolved") {
      setCachedNamecoinResolve(identifier, outcome.result, servers);
    } else if (outcome.status === "not-found") {
      setCachedNamecoinResolve(identifier, null, servers);
    }
    // Do NOT cache "unavailable" — resolver-offline is transient.
    deleteInflightNamecoinResolve(identifier, servers);
    return outcome.status === "resolved" ? outcome.result : null;
  })();
  setInflightNamecoinResolve(identifier, p, servers);
  const result = await p;
  // Re-derive the tri-state: if `result` is null, walk the resolver
  // one more time via the cache (which was populated with a genuine
  // not-found) or return unavailable. Cheaper: re-execute the state
  // machine directly.
  if (result) return { status: "resolved", result };
  const cachedAfter = getCachedNamecoinResolve(identifier, servers);
  return cachedAfter === null
    ? { status: "not-found" }
    : { status: "unavailable" };
}

/**
 * Legacy pubkey-or-nothing entry point, kept for compatibility with
 * older callers and tests. Returns `null` for both "not-found" and
 * "unavailable" — new code should prefer {@link resolveNamecoinLookup}
 * which surfaces the distinction the gitworkshop review asked for.
 */
export async function resolveNamecoinNip05(
  identifier: string,
  servers?: ElectrumXServer[],
): Promise<NamecoinResolveResult | null> {
  const outcome = await resolveNamecoinLookup(identifier, servers);
  return outcome.status === "resolved" ? outcome.result : null;
}

async function queryProfileWithImports(
  identifier: string,
  serversArg?: ElectrumXServer[],
): Promise<NamecoinLookupOutcome> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return { status: "not-found" };

  const servers = serversArg ?? DEFAULT_ELECTRUMX_SERVERS;
  const lookup = await nameShowWithFallback(parsed.namecoinName, servers);
  if (lookup.kind === "unavailable") return { status: "unavailable" };
  if (lookup.kind === "not-found") return { status: "not-found" };

  // Walk ifa-0001 `import` chains so a leaf-name pointing at a parent
  // resolves correctly. `lookupNameValue` is the same WSS fallback
  // chain we just used; it is also session-deduped at the WSS layer
  // because every sub-name has its own cache key. Sub-import
  // unavailability is intentionally absorbed as "empty imported
  // object" — the top-level identifier's availability is what matters
  // for the resolver-online vs offline signal.
  const wssLookup = makeWssLookup(servers);
  const merged = await resolveValueWithImports(lookup.value, wssLookup);
  if (!merged) return { status: "not-found" };

  const extracted = extractNostrFromValue(merged, parsed);
  return extracted
    ? { status: "resolved", result: extracted }
    : { status: "not-found" };
}
