import { useErrorRetry, type ErrorRetryState } from "@/hooks/useErrorRetry";
/**
 * Search-side Namecoin `.bit` / `d/` / `id/` resolution.
 *
 * Kept as a separate hook so `useRepositorySearch` only needs one
 * import and one call to opt in — matches the "small, clearly defined
 * integration points" bullet in the gitworkshop feedback.
 *
 * All Namecoin work happens behind the lazy shim in
 * `@/lib/namecoin/lazy`, so the heavy `src/lib/namecoin/` module and
 * its ElectrumX transport code never enter the main bundle. They are
 * fetched on-demand the first time a user types (or navigates to) an
 * explicit `.bit` / `d/` / `id/` identifier.
 */
import { useEffect, useRef, useState } from "react";
import { isNamecoinIdentifier } from "@/lib/namecoin/lazy";

/** Lifecycle of the Namecoin resolution for a given search query. */
export type NamecoinResolutionStatus =
  | "idle"
  | "resolving"
  | "resolved"
  | "not-found"
  | "unavailable";

export interface NamecoinSearchResolution {
  recovery?: ErrorRetryState;
  /** True iff the query is an explicit `.bit` / `d/` / `id/` identifier. */
  isNamecoinQuery: boolean;
  /** Where the resolver is in its lifecycle. */
  status: NamecoinResolutionStatus;
  /** Hex pubkey once `status === "resolved"`. */
  pubkey?: string;
  /** Relay hints published in the same Namecoin record, if any. */
  relays?: string[];
}

const IDLE: NamecoinSearchResolution = {
  isNamecoinQuery: false,
  status: "idle",
};

/**
 * Resolves a trimmed search query as a `.bit` / `d/` / `id/` identifier
 * via lazy-loaded Namecoin resolution. Returns `{ isNamecoinQuery: false,
 * status: "idle" }` for any other query so the caller can pass the
 * query through unchanged. The resolver module is dynamically imported
 * on the first `.bit` query and cached for the rest of the session.
 *
 * Semantics match the review's "opt-in" rule: this hook only fires
 * network requests when `isNamecoinIdentifier(trimmedQuery)` is true.
 */
export function useNamecoinSearchResolution(
  trimmedQuery: string,
): NamecoinSearchResolution {
  const isNamecoinQuery = isNamecoinIdentifier(trimmedQuery);
  const [state, setState] = useState<NamecoinSearchResolution>(() =>
    isNamecoinQuery ? { isNamecoinQuery: true, status: "resolving" } : IDLE,
  );

  // Track the query the hook is currently resolving; a new query
  // during in-flight resolution supersedes the previous one and its
  // late result is discarded.
  const activeQueryRef = useRef<string | null>(null);

  const [retryVersion, setRetryVersion] = useState(0);
  const recovery = useErrorRetry({
    resourceKey: trimmedQuery,
    failed: state.status === "unavailable",
    busy: state.status === "resolving",
    onRetry: () => setRetryVersion((version) => version + 1),
    policy: { mode: "read", requiresSigning: false, context: "connection" },
  });

  useEffect(() => {
    if (!isNamecoinQuery) {
      activeQueryRef.current = null;
      setState(IDLE);
      return;
    }

    activeQueryRef.current = trimmedQuery;
    setState({ isNamecoinQuery: true, status: "resolving" });

    // Dynamic import here — the whole resolver stays out of the
    // startup bundle. `lazy.ts` internally caches the module handle
    // so concurrent callers share a single module fetch.
    void import(
      /* webpackChunkName: "namecoin-resolver" */ "@/lib/namecoin/lazy"
    )
      .then(({ resolveNamecoinLazily }) => resolveNamecoinLazily(trimmedQuery))
      .then((outcome) => {
        if (activeQueryRef.current !== trimmedQuery) return; // superseded
        if (outcome.status === "resolved") {
          setState({
            isNamecoinQuery: true,
            status: "resolved",
            pubkey: outcome.result.pubkey,
            relays: outcome.result.relays,
          });
        } else if (outcome.status === "not-found") {
          setState({ isNamecoinQuery: true, status: "not-found" });
        } else {
          setState({ isNamecoinQuery: true, status: "unavailable" });
        }
      })
      .catch(() => {
        if (activeQueryRef.current !== trimmedQuery) return;
        // Module load itself blew up. Treat as resolver unavailable
        // so the UI stays honest per the review's "distinguish
        // unavailable from not-found" bullet.
        setState({ isNamecoinQuery: true, status: "unavailable" });
      });
    return () => {
      activeQueryRef.current = null;
    };
  }, [isNamecoinQuery, trimmedQuery, retryVersion]);

  return { ...state, recovery };
}
