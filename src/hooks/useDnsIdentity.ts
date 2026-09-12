import { useErrorRetry, type ErrorRetryState } from "@/hooks/useErrorRetry";
import { useState, useEffect } from "react";
import { IdentityStatus } from "applesauce-loaders/helpers";
import type { Identity } from "applesauce-loaders/helpers";
import { dnsIdentityLoader, nip05WarmupReady } from "@/services/nostr";

const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Namecoin `.bit` NIP-05 opt-in.
 *
 * A NIP-05 domain that ends in `.bit` is a Namecoin identifier, not
 * a DNS one — there is no DNS root that answers for `.bit`. We check
 * this cheaply with an inline substring test (no import cost) and,
 * on a hit, route the lookup through the lazy Namecoin resolver.
 *
 * This is one of the two integration points the gitworkshop review
 * asked for: a URL / identifier ending in `.bit` counts as an
 * explicit opt-in, so `resolveNamecoinLazily` is only ever pulled in
 * on demand. Everything else in this hook still uses the standard
 * DNS resolver.
 */
function isDotBitNip05(nip05: string): boolean {
  const atIdx = nip05.indexOf("@");
  const domain = atIdx === -1 ? nip05 : nip05.slice(atIdx + 1);
  return domain.toLowerCase().endsWith(".bit");
}

export type DnsIdentityState =
  | { status: "loading" }
  | { status: "found"; pubkey: string; relays: string[] }
  | { status: "not-found" }
  | {
      status: "error";
      reason: "timeout" | "network" | "unknown";
      message: string;
    };

/** Convert a cached Identity to a DnsIdentityState. */
function cachedIdentityToState(cached: Identity): DnsIdentityState {
  if (cached.status === IdentityStatus.Found) {
    return {
      status: "found",
      pubkey: cached.pubkey,
      relays: cached.relays ?? [],
    };
  } else if (cached.status === IdentityStatus.Missing) {
    return { status: "not-found" };
  } else {
    return { status: "error", reason: "unknown", message: cached.error };
  }
}

/**
 * Parse a standardised NIP-05 address into (name, domain). Returns null for
 * invalid input.
 */
function parseNip05(nip05: string): { name: string; domain: string } | null {
  const atIdx = nip05.indexOf("@");
  if (atIdx === -1) return null;
  return { name: nip05.slice(0, atIdx), domain: nip05.slice(atIdx + 1) };
}

/**
 * Resolves a NIP-05 address (user@domain.com or _@domain.com) to a pubkey.
 * Uses the global DnsIdentityLoader which caches results for the session.
 * Fails with a "timeout" reason if the lookup takes longer than RESOLVE_TIMEOUT_MS.
 *
 * The in-memory cache is checked synchronously during initialisation so that
 * identities already resolved this session (e.g. via usePrefetchNip05) are
 * available on the very first render — no loading flash.
 */
export function useDnsIdentity(
  nip05: string | undefined,
): DnsIdentityState & { recovery: ErrorRetryState } {
  const [state, setState] = useState<DnsIdentityState>(() => {
    // Check the in-memory cache synchronously so components that arrive from
    // the repositories list (where usePrefetchNip05 has already run) render
    // the resolved state immediately without a loading flash.
    if (!nip05) return { status: "loading" };
    const parsed = parseNip05(nip05);
    if (!parsed) return { status: "loading" };
    // `.bit` names never hit the DNS loader; keep the initial state as
    // `loading` and let the effect below route to Namecoin resolution.
    if (isDotBitNip05(nip05)) return { status: "loading" };
    const cached = dnsIdentityLoader.getIdentity(parsed.name, parsed.domain);
    return cached ? cachedIdentityToState(cached) : { status: "loading" };
  });

  const [stateKey, setStateKey] = useState(nip05);
  const currentState: DnsIdentityState =
    stateKey === nip05 ? state : { status: "loading" };
  const [retryVersion, setRetryVersion] = useState(0);
  const recovery = useErrorRetry({
    resourceKey: nip05,
    failed: currentState.status === "error",
    busy: currentState.status === "loading",
    onRetry: () => setRetryVersion((version) => version + 1),
    policy:
      nip05 && parseNip05(nip05)
        ? { mode: "read", requiresSigning: false, context: "connection" }
        : { mode: "manual" },
  });

  useEffect(() => {
    setStateKey(nip05);
    if (!nip05) {
      setState({ status: "loading" });
      return;
    }

    const parsed = parseNip05(nip05);
    if (!parsed) {
      setState({
        status: "error",
        reason: "unknown",
        message: `Invalid NIP-05 address: ${nip05}`,
      });
      return;
    }
    const { name, domain } = parsed;
    setState({ status: "loading" });

    let cancelled = false;

    // ------------------------------------------------------------
    // Namecoin `.bit` short-circuit — opt-in path.
    //
    // The identifier itself carries the opt-in signal (`.bit` TLD),
    // so lazy-load the Namecoin resolver and skip the DNS path
    // entirely. Matches the gitworkshop review bullet: "same
    // client-side resolver for both search and direct repository URLs".
    // ------------------------------------------------------------
    if (domain.toLowerCase().endsWith(".bit")) {
      // Namecoin `.bit` records use the same `_` root convention as
      // NIP-05 to mean "the record for the bare domain". Rebuild the
      // identifier in the form the resolver accepts.
      const bareDomain = domain.slice(0, -".bit".length);
      const identifier =
        name === "_" ? `${bareDomain}.bit` : `${name}@${bareDomain}.bit`;
      void import(
        /* webpackChunkName: "namecoin-resolver" */ "@/lib/namecoin/lazy"
      )
        .then(({ resolveNamecoinLazily }) => resolveNamecoinLazily(identifier))
        .then((outcome) => {
          if (cancelled) return;
          if (outcome.status === "resolved") {
            setState({
              status: "found",
              pubkey: outcome.result.pubkey,
              relays: outcome.result.relays ?? [],
            });
          } else if (outcome.status === "not-found") {
            setState({ status: "not-found" });
          } else {
            // `unavailable` — map onto the existing `error/network`
            // shape so downstream Nip05ResolveError renders a
            // "resolver offline" style message rather than the
            // more definitive not-found page.
            setState({
              status: "error",
              reason: "network",
              message:
                "Namecoin resolver unavailable — could not reach any ElectrumX server.",
            });
          }
        })
        .catch(() => {
          if (cancelled) return;
          setState({
            status: "error",
            reason: "network",
            message: "Namecoin resolver unavailable (module load failed).",
          });
        });
      return () => {
        cancelled = true;
      };
    }

    // Await the IDB warmup before checking the in-memory cache. On a fresh
    // page load the warmup is async; if the user navigates to a NIP-05 repo
    // URL before it completes, getIdentity() would return undefined even
    // though IDB has the entry. Awaiting the warmup first ensures the
    // synchronous cache check always reflects the persisted state.
    nip05WarmupReady.then(() => {
      if (cancelled) return;

      // Check in-memory cache — avoids a loading flash when the identity is
      // already resolved (e.g. back-navigation or warm IDB).
      const cached = dnsIdentityLoader.getIdentity(name, domain);
      if (cached && retryVersion === 0) {
        setState(cachedIdentityToState(cached));
        return;
      }

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("__timeout__")), RESOLVE_TIMEOUT_MS),
      );

      Promise.race([
        retryVersion > 0
          ? dnsIdentityLoader.fetchIdentity(name, domain)
          : dnsIdentityLoader.loadIdentity(name, domain),
        timeoutPromise,
      ])
        .then((identity) => {
          if (cancelled) return;
          // Populate the in-memory map so subsequent getIdentity() calls hit.
          dnsIdentityLoader.identities.set(`${name}@${domain}`, identity);
          setState(cachedIdentityToState(identity));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof Error && err.message === "__timeout__") {
            setState({
              status: "error",
              reason: "timeout",
              message: `Lookup timed out after ${RESOLVE_TIMEOUT_MS / 1000} seconds`,
            });
          } else {
            const msg =
              err instanceof Error
                ? err.message
                : "Failed to resolve NIP-05 identity";
            // "Failed to fetch" is the browser's generic network error
            const isNetwork =
              err instanceof TypeError ||
              (err instanceof Error &&
                err.message.toLowerCase().includes("fetch"));
            setState({
              status: "error",
              reason: isNetwork ? "network" : "unknown",
              message: msg,
            });
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [nip05, retryVersion]);

  return { ...currentState, recovery };
}
