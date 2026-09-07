/**
 * git-grasp-pool — pool registry
 *
 * Singleton-per-repo registry that ensures multiple hooks/components sharing
 * the same clone URLs share one pool instance.
 *
 * The registry key is the sorted, joined clone URL list — same pattern as
 * Unlike the old service-per-repo pattern, the registry
 * handles the case where clone URLs grow over time (new announcement events)
 * by calling pool.addUrls() rather than destroying and recreating the pool.
 *
 * Lifecycle:
 * - getOrCreatePool() returns an existing pool or creates a new one
 * - The pool manages its own subscriber ref-counting and eviction
 * - When a pool is disposed (after eviction grace period), it removes
 *   itself from the registry
 * - Pools with growing URL sets are found by checking if any existing
 *   pool's URL set is a subset of the requested URLs
 */

import { GitGraspPool } from "./pool";
import type { GitHttpAuthorizationProvider } from "@/lib/git-http-auth";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Module-level registry of active pools */
const registry = new Map<string, GitGraspPool>();

/**
 * Build a stable cache key from a set of clone URLs.
 * Sorted so different orderings of the same URLs map to the same key.
 */
function makeKey(cloneUrls: string[], accessScope = "public"): string {
  return `${accessScope}\0${[...cloneUrls].sort().join("\n")}`;
}

/**
 * Find an existing pool whose URL set overlaps with the requested URLs.
 * This handles the case where clone URLs grow over time — we want to
 * reuse the existing pool and add the new URLs to it, rather than
 * creating a new pool.
 *
 * Returns the pool and its current key if found, or undefined.
 */
function findOverlappingPool(
  cloneUrls: string[],
  accessScope: string,
): { pool: GitGraspPool; key: string } | undefined {
  const requestedSet = new Set(cloneUrls);

  for (const [key, pool] of registry) {
    if (pool.isDisposed) {
      registry.delete(key);
      continue;
    }

    const [keyScope, serializedUrls = ""] = key.split("\0", 2);
    if (keyScope !== accessScope) continue;

    const existingUrls = serializedUrls.split("\n");
    // Check if there's any overlap
    const hasOverlap = existingUrls.some((u) => requestedSet.has(u));
    if (hasOverlap) {
      return { pool, key };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GetPoolOptions {
  cloneUrls: string[];
  corsProxyBase?: string | null;
  knownCorsBlockedOrigins?: string[];
  evictionGracePeriodMs?: number;
  infoRefsTtlMs?: number;
  expectRepositoryProvisioning?: boolean;
  authorizationProvider?: GitHttpAuthorizationProvider;
}

/**
 * Get or create a GitGraspPool for the given clone URLs.
 *
 * If a pool already exists for these exact URLs, returns it.
 * If a pool exists for a subset of these URLs (the URL list grew),
 * adds the new URLs to the existing pool and re-keys it.
 * Otherwise creates a new pool.
 */
export function getOrCreatePool(options: GetPoolOptions): GitGraspPool {
  const { cloneUrls, ...rest } = options;
  const accessScope = rest.authorizationProvider?.accessScope ?? "public";
  const key = makeKey(cloneUrls, accessScope);

  // Exact match
  const existing = registry.get(key);
  if (existing && !existing.isDisposed) {
    if (rest.expectRepositoryProvisioning !== undefined) {
      existing.setRepositoryProvisioningExpected(
        rest.expectRepositoryProvisioning,
      );
    }
    return existing;
  }

  // Check for overlapping pool (URL list grew)
  // Private pools are exact repository/account sessions. They must never grow
  // by overlap because that could attach a credential to a different root.
  const overlapping = rest.authorizationProvider
    ? undefined
    : findOverlappingPool(cloneUrls, accessScope);
  if (overlapping) {
    // Add new URLs to the existing pool
    overlapping.pool.addUrls(cloneUrls);
    if (rest.expectRepositoryProvisioning !== undefined) {
      overlapping.pool.setRepositoryProvisioningExpected(
        rest.expectRepositoryProvisioning,
      );
    }
    // Re-key the registry if the key changed
    if (overlapping.key !== key) {
      registry.delete(overlapping.key);
      registry.set(key, overlapping.pool);
    }

    return overlapping.pool;
  }

  // Create new pool
  const pool = new GitGraspPool({
    cloneUrls,
    ...rest,
  });

  registry.set(key, pool);

  return pool;
}

/**
 * Get the current pool for a set of clone URLs without creating one.
 * Returns undefined if no pool exists.
 */
export function peekPool(
  cloneUrls: string[],
  authorizationProvider?: GitHttpAuthorizationProvider,
): GitGraspPool | undefined {
  const accessScope = authorizationProvider?.accessScope ?? "public";
  const key = makeKey(cloneUrls, accessScope);
  const pool = registry.get(key);
  if (pool && !pool.isDisposed) return pool;

  // Check for overlapping pool
  const overlapping = authorizationProvider
    ? undefined
    : findOverlappingPool(cloneUrls, accessScope);
  return overlapping?.pool;
}

/**
 * Remove a disposed pool from the registry.
 * Called internally when a pool's eviction timer fires.
 */
export function removePool(
  cloneUrls: string[],
  authorizationProvider?: GitHttpAuthorizationProvider,
): void {
  const key = makeKey(
    cloneUrls,
    authorizationProvider?.accessScope ?? "public",
  );
  const pool = registry.get(key);
  if (pool?.isDisposed) {
    registry.delete(key);
  }
}

/**
 * Clear all pools from the registry. Disposes each one.
 * Primarily for testing.
 */
export function clearRegistry(): void {
  for (const pool of registry.values()) {
    if (!pool.isDisposed) pool.dispose();
  }
  registry.clear();
}

/** Dispose authenticated pools before another account becomes active. */
export function clearPrivateRegistry(pubkey: string): void {
  const prefix = `private:${pubkey}:`;
  for (const [key, pool] of registry) {
    if (!key.startsWith(prefix)) continue;
    if (!pool.isDisposed) pool.dispose();
    registry.delete(key);
  }
}
