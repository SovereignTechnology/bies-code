/**
 * Lazy entry point for Namecoin `.bit` NIP-05 resolution.
 *
 * Purpose: keep the entire `src/lib/namecoin/` implementation
 * (identifier / value / transport / script / cache) out of the main
 * app bundle and out of the startup path. Nothing in this file
 * statically imports `./index`; the resolver is only pulled in when a
 * caller actually needs it (a `.bit` URL is navigated to, or an
 * explicit `.bit` search is typed).
 *
 * Why not just call `import("./index")` inline at each site?
 *
 * - Duplicates the import call and its cache logic at each site.
 * - Loses in-module deduping across concurrent sites (e.g. search
 *   hook and repo-URL hook firing at the same time).
 * - Makes it harder to keep the tri-state (`resolved` /
 *   `not-found` / `unavailable`) shape uniform across sites.
 *
 * This module is intentionally under 60 non-comment lines: the light
 * shape is what lets the search and repo-URL integration points stay
 * tiny (a single import + one call, per Dan's "small, clearly defined
 * integration points" requirement).
 */
import type { NamecoinLookupOutcome } from "./index";

export { isNamecoinIdentifier, isDotBit } from "./identifier";
export type { NamecoinLookupOutcome } from "./index";
export type { NamecoinResolveResult } from "./value";

// Module handle. Populated lazily on the first invocation of
// `resolveNamecoinLazily`; every subsequent call reuses the same
// module — no duplicate network fetch, no duplicate module init.
type NamecoinModule = typeof import("./index");
let modulePromise: Promise<NamecoinModule> | null = null;

/**
 * Load the resolver module once per session. The dynamic
 * `import()` expression carries a webpack/vite `webpackChunkName`
 * magic-comment hint so bundlers emit a stable chunk name for
 * ops visibility.
 */
function loadModule(): Promise<NamecoinModule> {
  if (!modulePromise) {
    modulePromise = import(
      /* webpackChunkName: "namecoin-resolver" */
      "./index"
    ).catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

/**
 * Lazy tri-state resolver. Returns:
 *
 * - `{ status: "resolved", result: { pubkey, relays? } }`
 * - `{ status: "not-found" }`  when Namecoin definitively says no.
 * - `{ status: "unavailable" }` when every ElectrumX server was
 *   unreachable — the caller should show a "resolver offline"
 *   message and (optionally) fall back to standard resolution.
 *
 * The tri-state addresses the "distinguish an unavailable resolver
 * from a genuine name not found result" bullet from the review.
 */
export async function resolveNamecoinLazily(
  identifier: string,
): Promise<NamecoinLookupOutcome> {
  try {
    const mod = await loadModule();
    return await mod.resolveNamecoinLookup(identifier);
  } catch {
    // Module fetch failure (network hiccup fetching the chunk, CSP
    // block, etc.). Treated as `unavailable` — retrying may succeed.
    return { status: "unavailable" };
  }
}

/**
 * Test-only reset for the module singleton so vitest can exercise
 * the lazy-load path deterministically across suites.
 */
export function __resetForTests(): void {
  modulePromise = null;
}
