# Relay query-budget benchmarks

Measures what a production build of the app actually sends to relays while
navigating a reference repository: REQ frames, bytes of REQ filter JSON,
distinct relay connections, EVENT frames received, and coarse wall-clock
timings. REQ count and filter bytes are the hard budget (near-deterministic
client behaviour); timings run against live public relays and are only a
coarse smoke test — their job is to catch a 0.5s → 15s cliff, not a 10%
wobble.

## Scenarios

Both scenarios run in one browser session against `vite preview` serving a
fresh production build, in a brand-new browser context (no IndexedDB, no
localStorage, so default settings apply — including outbox relay mode):

1. **Cold load** — navigate straight to the reference repo's Issues tab and
   poll the Issues/PRs tab text (label + streaming open-count badge) until it
   has not changed for 5s.
2. **Warm switch** — from settled Issues, click the PRs tab, measure the
   time until the PRs tab is active and painted, then wait for stability
   again. WebSocket counters for this scenario are the delta from the
   cold-load snapshot.

## Reference repository

The default reference repo is `nostr://danconwaydev.com/gitworkshop` — this
very repository, which has a substantial issue/PR history. Keep using it so
runs stay comparable with `baseline.json`; `--repo` exists for ad-hoc
investigation, not for baseline comparisons.

## Running

```sh
# Nix (recommended) — browsers come from the flake-pinned bundle:
nix develop .#bench --command pnpm bench

# Elsewhere — provision a browser once, then run directly:
npx playwright-core install chromium
pnpm bench
```

Useful flags (see `pnpm bench --help`):

- `--compare benchmarks/baseline.json` — diff the run against the committed
  baseline and exit non-zero on regressions. Hard-budget limits are
  currently generous (~2× baseline REQ frames, ~3× filter bytes, +30%
  distinct relays) because on current main the settle-gated measurement
  window lets reconnect churn accumulate, making counts vary up to ~2×
  between runs; the limits exist to catch order-of-magnitude cliffs and
  should be tightened as subscription behaviour becomes deterministic.
  Latency metrics fail only past `max(3× baseline, baseline + 10s)`.
- `--skip-build` — reuse the existing `dist/` (repeat runs on one commit).
- `--repo <nostr://owner/repo-id>` / `--out <file>` / `--port <port>`.

Each run writes a JSON report to `benchmarks/results/` (gitignored) and
prints a human-readable summary.

## Baseline workflow

`baseline.json` is the median of 3 runs (by cold-load REQ frames) at a known
commit — see its `meta.commit`. Any change to subscription/loader behaviour
must keep `pnpm bench --skip-build --compare benchmarks/baseline.json`
passing; refresh the baseline (same 3-run median procedure) only as a
deliberate, reviewed act.

## Toolchain notes

The default devShell deliberately omits the ~1 GB Chromium bundle; only the
`bench` shell carries it. The `playwright-core` devDependency is pinned to the
exact version of `pkgs.playwright-driver` in `flake.nix` so the browser
revisions match — bump them together.

The benchmark is never part of pre-commit, `pnpm test`, or CI.
