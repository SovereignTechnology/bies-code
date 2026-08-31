# Relay query-budget benchmarks

Measures what a production build of the app actually sends to relays while
navigating a reference repository: REQ frames, bytes of REQ filter JSON,
distinct relay connections, EVENT frames received, and wall-clock timings.
REQ count and filter bytes are the primary budget (near-deterministic client
behaviour); timings run against live public relays and are noisier, so they
are budgeted with absolute ceilings — their job is to catch a 0.4s → 9s
cliff, not a 10% wobble.

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
  baseline and exit non-zero on regressions (see "Compare limits").
- `--skip-build` — reuse the existing `dist/` (repeat runs on one commit).
- `--repo <nostr://owner/repo-id>` / `--out <file>` / `--port <port>`.

Each run writes a JSON report to `benchmarks/results/` (gitignored) and
prints a human-readable summary.

## Baseline workflow

`baseline.json` is the median of 3 runs (by cold-load REQ frames) at a known
commit — see its `meta.commit`. Any change to subscription/loader behaviour
must keep `pnpm bench --skip-build --compare benchmarks/baseline.json`
passing; refresh the baseline (same 3-run median procedure) only as a
deliberate, reviewed act, re-deriving the compare limits from the spread of
those runs.

## Compare limits

Query limits are `baseline × (1 + pct) + abs`; timing limits are
`max(baseline × mult, floor)` — an absolute floor, so a sub-second baseline
gets a sensible ceiling instead of a hair-trigger relative one. Limits are
per scenario because the two scenarios no longer have the same shape.

| scenario    | metric               | baseline | limit   | spread over the 3 baseline runs |
| ----------- | -------------------- | -------- | ------- | ------------------------------- |
| cold load   | `reqFrames`          | 1,601    | 2,212   | 1,400 – 1,631                   |
| cold load   | `reqFilterBytes`     | 2.23 MB  | 2.93 MB | 2.11 – 2.36 MB                  |
| cold load   | `distinctRelays`     | 54       | 74      | 54 – 54                         |
| cold load   | `navToTabsVisibleMs` | 1.8s     | 8.0s    | 1.6 – 1.9s                      |
| cold load   | `timeToStableMs`     | 23.6s    | 60.0s   | 17.1 – 36.7s                    |
| warm switch | `reqFrames`          | 9        | 138     | 9 – 89                          |
| warm switch | `reqFilterBytes`     | 3.2 KB   | 47.4 KB | 3.2 – 31.4 KB                   |
| warm switch | `distinctRelays`     | 17       | 26      | 14 – 19                         |
| warm switch | `tabSwitchMs`        | 0.4s     | 2.0s    | 0.4 – 1.6s                      |
| warm switch | `timeToStableMs`     | 0.4s     | 6.0s    | 0.4 – 1.6s                      |

Rationale:

- **Cold load is close to reproducible** — REQ frames varied ±13% of the
  median and filter bytes ±6%. A ~35% band plus a small absolute allowance
  absorbs that, live relay churn, and the reference repo accumulating issues
  and PRs over time. This replaces the previous 2×/3× slack, which existed
  because settle-gated measurement let reconnect churn pile up before
  additive subscriptions landed.
- **Warm switch is now single-digit REQs**, so its limits are absolute
  rather than relative: percentages of a median of 9 mean nothing. One
  baseline run spent ~80 extra REQs because the tail of cold-load identity
  enrichment reconnected onto four relays just after the scenario boundary,
  which is the variance the `abs` allowance covers. The ceilings still fail
  an order of magnitude below the pre-additive-subscription behaviour
  (636 REQs / 1.29 MB of filter JSON for the same tab switch).
- **`distinctRelays` keeps its tight limit** (+30%, +3). It was identical
  across all three cold runs; the slack only covers live NIP-65 outbox
  drift, and in the warm scenario the fact that it counts relays with _any_
  delta counter.
- **Timings are budgeted, not just reported.** The warm tab switch is a
  store read and must never quietly return to seconds: it fails above 2s,
  and warm settle above 6s — generous against live-relay latency noise, but
  far below the ~9s both took before. Cold load fails above 8s to first
  paint of the tabs and 60s to settle, which catches a cliff without
  reacting to a slow relay day.

A scenario that never settles within its timeout fails regardless of counts.

## Toolchain notes

The default devShell deliberately omits the ~1 GB Chromium bundle; only the
`bench` shell carries it. The `playwright-core` devDependency is pinned to the
exact version of `pkgs.playwright-driver` in `flake.nix` so the browser
revisions match — bump them together.

The benchmark is never part of pre-commit, `pnpm test`, or CI.
