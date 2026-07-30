# Namecoin `.bit` NIP-05 resolution

gitworkshop uses Namecoin (`.bit`, `d/`, `id/`) as an optional NIP-05
identity source. This document describes how the feature stays entirely
optional, well-isolated, and out of the main application bundle so it
does not affect users who never touch a `.bit` name.

## Scope and constraints

Namecoin resolution is a purely optional feature. The implementation
honours the following constraints so it never taxes the majority of the
application:

1. **Opt-in via identifier shape.** A `.bit` domain in a repo URL, or
   an explicit `.bit` / `d/` / `id/` search query, counts as opting in.
2. **No network traffic without opt-in.** Namecoin-specific requests are
   only issued when the identifier itself signals Namecoin.
3. **Lazy loaded.** The resolver, ElectrumX transport, script builders,
   and ifa-0001 import walker are behind a dynamic `import()`. The main
   `dist/index-*.js` bundle contains none of them; a dedicated chunk is
   fetched on first use.
4. **Concentrated in its own module.** The Namecoin implementation lives
   under `src/lib/namecoin/`. Integration points elsewhere in the app
   are limited to two tiny surfaces (see below).
5. **Same client-side resolver for URLs and search.** The direct
   `.bit` repo URL path and the search bar both go through the same
   `resolveNamecoinLazily` entry point.
6. **Distinguishes unavailable from not-found.** The public tri-state
   surface exposes `resolved` / `not-found` / `unavailable` so the UI
   can tell the user "no such name" vs "resolver offline".

The client-side WSS implementation is deliberately not a serverless
gateway. It talks to publicly-hosted Namecoin ElectrumX servers
directly over WebSocket Secure — no provider-specific backend is
required, so the static-hosting story of gitworkshop is preserved.

## Module layout

```
src/lib/namecoin/
├── index.ts        Public tri-state resolver (dynamically imported)
├── lazy.ts         Cheap identifier check + lazy loader shim
├── identifier.ts   Pure parser for .bit / d/ / id/ identifiers
├── transport.ts    ElectrumX-over-WSS JSON-RPC client
├── script.ts       Namecoin script and hash helpers
├── value.ts        Value extraction and ifa-0001 import walker
├── cache.ts        Session-level pos/neg/inflight cache
├── hex.ts          Small hex helper
└── __tests__/      78 hermetic vitest cases
```

`lazy.ts` is the boundary of the eager surface. Nothing outside the two
integration points (below) statically imports anything else from
`src/lib/namecoin/`. `lazy.ts` re-exports the cheap synchronous
`isNamecoinIdentifier` predicate (a tiny regex) so callers can gate
without paying the resolver's cost.

## Integration points

The rest of the application touches Namecoin in exactly two places.
Both use dynamic `import(/* webpackChunkName: "namecoin-resolver" */
"@/lib/namecoin/lazy")` so the resolver only lands in the browser when
a user actually needs it.

### 1. `useDnsIdentity` — direct `.bit` repo URLs

`src/hooks/useDnsIdentity.ts` handles NIP-05 → pubkey resolution for
routes like `/alice@example.bit/reponame`. When the domain ends in
`.bit`, the hook skips the DNS loader and dispatches to
`resolveNamecoinLazily` instead. This is the only change to the URL
resolution path. Every other NIP-05 domain continues to resolve
through the standard DNS path unchanged.

### 2. `useNamecoinSearchResolution` — search bar

`src/hooks/useNamecoinSearchResolution.ts` is a thin peer of
`useRepositorySearch`. It looks at the committed query, and if the
query is a `.bit` / `d/` / `id/` identifier, it fires the lazy
resolver and reports `resolving` / `resolved` / `not-found` /
`unavailable`. `useRepositorySearch` reads its output and, on
`resolved`, funnels the resulting pubkey through the same
matched-user fan-out that the `npub1…` short-circuit uses.

## Tri-state semantics

Every resolution ultimately returns one of:

- `{ status: "resolved", result: { pubkey, relays? } }`
- `{ status: "not-found" }`
- `{ status: "unavailable" }`

- **`resolved`** — the name exists, is unexpired, and points at a valid
  Nostr pubkey.
- **`not-found`** — Namecoin definitively has no record we can use
  (empty history, expired, no `nostr` field, or the ifa-0001 chain
  terminated without one).
- **`unavailable`** — every configured ElectrumX server was unreachable
  (refused socket, TLS failure, timeout) without a single server
  returning a definitive miss. This is a transient condition; the UI
  should tell the user the resolver is offline and let them retry. The
  session cache deliberately does **not** memoise `unavailable`.

## Servers

`DEFAULT_ELECTRUMX_SERVERS` in `transport.ts` currently lists four
public endpoints. Only `electrum.nmc.ethicnology.com:50004` presents a
publicly-trusted (Let's Encrypt) TLS certificate; the other three are
best-effort fallbacks for non-browser callers that inject a WebSocket
implementation which accepts self-signed pins. Additional endpoints
should only be added after probing them from a real browser.

## Bundle verification

After `pnpm build`, the main entry chunk contains zero Namecoin code:

```sh
grep -c "electrumx\|blockchain.scripthash\|resolveNamecoinLookup" \
  dist/assets/index-*.js
```

should show `0` for the biggest chunk (the main app) and a small
non-zero for the on-demand `namecoin-resolver` chunk (~10 KB
minified). If the numbers ever change, the lazy discipline has
regressed — check for a new static `import { ... } from
"@/lib/namecoin/index"` outside the two documented integration
points.
