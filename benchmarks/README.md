# Relay query-budget benchmarks

Measures what a production build of the app actually sends to relays while
navigating a reference repository: REQ frames, bytes of REQ filter JSON,
distinct relay connections, EVENT frames received, and coarse wall-clock
timings. REQ count and filter bytes are the hard budget (near-deterministic
client behaviour); timings run against live public relays and are only a
coarse smoke test.

**Status: stub.** `pnpm bench` currently just verifies that a
Playwright-managed Chromium is available; the measurement harness and the
committed baseline land separately.

## Running

```sh
# Nix (recommended) — browsers come from the flake-pinned bundle:
nix develop .#bench --command pnpm bench

# Elsewhere — provision a browser once, then run directly:
npx playwright-core install chromium
pnpm bench
```

The default devShell deliberately omits the ~1 GB Chromium bundle; only the
`bench` shell carries it. The `playwright-core` devDependency is pinned to the
exact version of `pkgs.playwright-driver` in `flake.nix` so the browser
revisions match — bump them together.

The benchmark is never part of pre-commit, `pnpm test`, or CI.
