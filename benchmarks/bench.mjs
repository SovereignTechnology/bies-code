// Relay query-budget benchmark.
//
// Drives a production build (vite build + vite preview) in headless Chromium
// and measures what the app actually sends to relays while opening a
// reference repository's Issues tab (cold load, fresh browser context) and
// switching to the PRs tab (warm switch). WebSocket traffic is recorded by an
// init script that wraps window.WebSocket before any app code runs.
//
// REQ frame count and REQ filter JSON bytes are the primary budget: they are
// properties of the client's behaviour and near-deterministic across runs.
// Wall-clock timings run against live public relays and are noisier, so they
// are budgeted with absolute ceilings rather than tight relative ones — they
// exist to catch a 0.4s -> 9s cliff, not a 10% wobble.
//
// See benchmarks/README.md for usage and the baseline workflow.

import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "nostr://danconwaydev.com/gitworkshop" },
    compare: { type: "string" },
    out: { type: "string" },
    port: { type: "string", default: "4173" },
    "skip-build": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`Usage: pnpm bench [options]

Options:
  --repo <url>        Repository to measure. nostr://<owner>/<repo-id> or a
                      raw app path like /danconwaydev.com/gitworkshop.
                      Default: nostr://danconwaydev.com/gitworkshop
  --compare <file>    Diff this run against a committed baseline JSON and
                      exit non-zero on budget regressions.
  --out <file>        Where to write the JSON report.
                      Default: benchmarks/results/run-<timestamp>.json
  --port <port>       vite preview port (default 4173).
  --skip-build        Reuse the existing dist/ instead of running vite build.
`);
  process.exit(0);
}

const repoPath = args.repo.startsWith("nostr://")
  ? `/${args.repo.slice("nostr://".length)}`
  : args.repo.startsWith("/")
    ? args.repo
    : `/${args.repo}`;
const port = Number(args.port);

// Quiet/timeout windows for "badge counts stopped changing" detection.
const QUIET_MS = 5000;
const POLL_MS = 500;
const COLD_TIMEOUT_MS = 180_000;
const WARM_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Browser preflight
// ---------------------------------------------------------------------------

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error(
    "playwright-core is not installed. Run `pnpm install` (or `npm ci`) first.",
  );
  process.exit(1);
}

const executable = chromium.executablePath();
if (!existsSync(executable)) {
  console.error(`Playwright Chromium not found at:\n  ${executable}\n`);
  console.error("Provision a browser first:");
  console.error("  Nix:    nix develop .#bench --command pnpm bench");
  console.error(
    "          (the default devShell deliberately omits the ~1 GB browser bundle)",
  );
  console.error("  Other:  npx playwright-core install chromium");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// WebSocket instrumentation (runs inside the page before any app code)
// ---------------------------------------------------------------------------

function instrumentWebSockets() {
  const agg = { relays: {} };
  const enc = new TextEncoder();
  const relay = (rawUrl) => {
    const url = String(rawUrl).replace(/\/$/, "");
    return (agg.relays[url] ??= {
      sockets: 0,
      reqFrames: 0,
      reqFilterBytes: 0,
      closeFrames: 0,
      eventFramesSent: 0,
      otherFramesSent: 0,
      eventFramesReceived: 0,
      eoseFrames: 0,
    });
  };
  const OrigWebSocket = window.WebSocket;
  window.WebSocket = class extends OrigWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      relay(url).sockets++;
      // Incoming frames can be numerous and large; classify by prefix
      // instead of parsing JSON so instrumentation stays cheap.
      this.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        const r = relay(this.url);
        if (/^\[\s*"EVENT"/.test(ev.data)) r.eventFramesReceived++;
        else if (/^\[\s*"EOSE"/.test(ev.data)) r.eoseFrames++;
      });
    }
    send(data) {
      if (typeof data === "string") {
        const r = relay(this.url);
        if (/^\[\s*"REQ"/.test(data)) {
          r.reqFrames++;
          try {
            // ["REQ", <sub-id>, <filter>...] — budget only the filters.
            const filters = JSON.parse(data).slice(2);
            r.reqFilterBytes += enc.encode(JSON.stringify(filters)).length;
          } catch {
            r.reqFilterBytes += enc.encode(data).length;
          }
        } else if (/^\[\s*"CLOSE"/.test(data)) r.closeFrames++;
        else if (/^\[\s*"EVENT"/.test(data)) r.eventFramesSent++;
        else r.otherFramesSent++;
      }
      return super.send(data);
    }
  };
  window.__wsMetrics = { snapshot: () => JSON.parse(JSON.stringify(agg)) };
}

// ---------------------------------------------------------------------------
// Aggregation helpers (Node side)
// ---------------------------------------------------------------------------

const COUNTER_KEYS = [
  "sockets",
  "reqFrames",
  "reqFilterBytes",
  "closeFrames",
  "eventFramesSent",
  "otherFramesSent",
  "eventFramesReceived",
  "eoseFrames",
];

function summarize(relays) {
  const totals = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
  for (const counters of Object.values(relays)) {
    for (const k of COUNTER_KEYS) totals[k] += counters[k];
  }
  const { sockets, ...rest } = totals;
  return {
    ...rest,
    socketsOpened: sockets,
    distinctRelays: Object.keys(relays).length,
    perRelay: relays,
  };
}

function diffSnapshots(before, after) {
  const relays = {};
  for (const [url, counters] of Object.entries(after.relays)) {
    const prev = before.relays[url];
    const delta = Object.fromEntries(
      COUNTER_KEYS.map((k) => [k, counters[k] - (prev?.[k] ?? 0)]),
    );
    if (Object.values(delta).some((v) => v !== 0)) relays[url] = delta;
  }
  return summarize(relays);
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the Issues/PRs tab text (label + streaming open-count badge) until it
 * has not changed for QUIET_MS. A zero-count repo never renders a badge, so
 * "text unchanged" is the only reliable settled signal.
 */
async function waitForStableTabs(page, timeoutMs) {
  const start = Date.now();
  let lastText = null;
  let lastChange = start;
  while (Date.now() - start < timeoutMs) {
    const text = await page.evaluate(() => {
      const read = (sel) =>
        document.querySelector(sel)?.innerText.replace(/\s+/g, " ") ?? "";
      return `${read('nav a[href$="/issues"]')} | ${read('nav a[href$="/prs"]')}`;
    });
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= QUIET_MS) {
      return {
        stable: true,
        timeToStableMs: lastChange - start,
        tabText: text,
      };
    }
    await sleep(POLL_MS);
  }
  return {
    stable: false,
    timeToStableMs: Date.now() - start,
    tabText: lastText,
  };
}

async function runScenarios(browser, baseUrl) {
  // Fresh context: no IndexedDB, localStorage, or service-worker state, so
  // the app boots with default settings (outbox relay mode included).
  const context = await browser.newContext();
  await context.addInitScript(instrumentWebSockets);
  const page = await context.newPage();

  // --- Cold load: open the Issues tab directly ---------------------------
  const coldStart = Date.now();
  await page.goto(`${baseUrl}${repoPath}/issues`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  // The boot splash is removed when React mounts; the tab nav appears only
  // after NIP-05 identity resolution and repo announcement processing.
  await page.waitForSelector("#app-splash", {
    state: "detached",
    timeout: 60_000,
  });
  await page.waitForSelector('nav a[href$="/issues"]', { timeout: 120_000 });
  const navToTabsVisibleMs = Date.now() - coldStart;
  const coldWait = await waitForStableTabs(page, COLD_TIMEOUT_MS);
  const coldSnapshot = await page.evaluate(() => window.__wsMetrics.snapshot());
  const coldLoad = {
    ...summarize(coldSnapshot.relays),
    navToTabsVisibleMs,
    timeToStableMs: navToTabsVisibleMs + coldWait.timeToStableMs,
    stable: coldWait.stable,
    tabText: coldWait.tabText,
  };

  // --- Warm switch: click the PRs tab from settled Issues ----------------
  const warmStart = Date.now();
  await page.click('nav a[href$="/prs"]');
  // waitForFunction polls on requestAnimationFrame, so this resolves only
  // once the main thread is free enough to paint the active PRs tab.
  await page.waitForFunction(
    () =>
      document
        .querySelector('nav a[href$="/prs"]')
        ?.className.includes("border-pink-500"),
    null,
    { timeout: 60_000 },
  );
  const tabSwitchMs = Date.now() - warmStart;
  const warmWait = await waitForStableTabs(page, WARM_TIMEOUT_MS);
  const warmSnapshot = await page.evaluate(() => window.__wsMetrics.snapshot());
  const warmSwitch = {
    ...diffSnapshots(coldSnapshot, warmSnapshot),
    tabSwitchMs,
    timeToStableMs: tabSwitchMs + warmWait.timeToStableMs,
    stable: warmWait.stable,
    tabText: warmWait.tabText,
  };

  await context.close();
  return { coldLoad, warmSwitch };
}

// ---------------------------------------------------------------------------
// Reporting and comparison
// ---------------------------------------------------------------------------

const fmt = (n) => n.toLocaleString("en-US");
const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;

function printScenario(name, s) {
  console.log(`\n${name}`);
  console.log(`  REQ frames sent:     ${fmt(s.reqFrames)}`);
  console.log(`  REQ filter bytes:    ${fmt(s.reqFilterBytes)}`);
  console.log(`  distinct relays:     ${fmt(s.distinctRelays)}`);
  console.log(`  sockets opened:      ${fmt(s.socketsOpened)}`);
  console.log(`  EVENT frames recv:   ${fmt(s.eventFramesReceived)}`);
  if (s.navToTabsVisibleMs !== undefined)
    console.log(`  tabs visible after:  ${fmtSec(s.navToTabsVisibleMs)}`);
  if (s.tabSwitchMs !== undefined)
    console.log(`  tab switch:          ${fmtSec(s.tabSwitchMs)}`);
  console.log(
    `  time to stable tabs: ${fmtSec(s.timeToStableMs)}${s.stable ? "" : " (NEVER SETTLED — hit timeout)"}`,
  );
  console.log(`  tabs settled at:     ${JSON.stringify(s.tabText)}`);
}

// Budgets are per scenario, because cold load and warm switch now have very
// different shapes. Query limits are `base * (1 + pct) + abs`; timing limits
// are `max(base * mult, floor)` so that a sub-second baseline still gets an
// absolute ceiling rather than an absurdly tight relative one.
//
// Cold load is close to reproducible: across the three baseline runs REQ
// frames spanned 1,400–1,631 (±13% of the median) and filter bytes
// 2.11–2.36 MB (±6%), so a ~35% band plus a small absolute allowance leaves
// room for live churn and for the reference repo accumulating items without
// hiding a real regression. distinctRelays was identical (54) in all three
// runs; its slack only covers live NIP-65 outbox drift.
//
// Warm switch is now single-digit REQs (9, 9, 89 across the baseline runs),
// so its limits are deliberately absolute rather than relative: one run had
// the tail of cold-load identity enrichment reconnect onto four relays after
// the scenario boundary, costing ~80 extra REQs. Percentages of a median of
// 9 would be meaningless; the ceilings still fail an order of magnitude
// below the pre-additive-subscription behaviour (636 REQs / 1.29 MB).
const BUDGET = {
  coldLoad: {
    query: {
      reqFrames: { pct: 0.35, abs: 50 },
      reqFilterBytes: { pct: 0.35, abs: 65536 },
      distinctRelays: { pct: 0.3, abs: 3 },
    },
    timing: {
      navToTabsVisibleMs: { mult: 3, floor: 8_000 },
      timeToStableMs: { mult: 2, floor: 60_000 },
    },
  },
  warmSwitch: {
    query: {
      reqFrames: { pct: 1.0, abs: 120 },
      reqFilterBytes: { pct: 1.0, abs: 40_960 },
      distinctRelays: { pct: 0.3, abs: 3 },
    },
    // A warm tab switch is a store read; it must never quietly return to
    // seconds. Thresholds are generous against live-relay noise (baseline
    // 0.4s, slowest baseline run 1.6s) but well below the ~9s it used to
    // take, and below the 3s at which the switch stops feeling instant.
    timing: {
      tabSwitchMs: { mult: 3, floor: 2_000 },
      timeToStableMs: { mult: 3, floor: 6_000 },
    },
  },
};

function compare(baseline, report) {
  let failed = false;
  for (const scenario of ["coldLoad", "warmSwitch"]) {
    const base = baseline[scenario];
    const cur = report[scenario];
    if (!base || !cur) continue;
    console.log(`\n${scenario} vs baseline:`);
    for (const [metric, { pct, abs }] of Object.entries(
      BUDGET[scenario].query,
    )) {
      const limit = Math.ceil(base[metric] * (1 + pct)) + abs;
      const ok = cur[metric] <= limit;
      if (!ok) failed = true;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${metric}: ${fmt(cur[metric])} (baseline ${fmt(base[metric])}, limit ${fmt(limit)})`,
      );
    }
    for (const [metric, { mult, floor }] of Object.entries(
      BUDGET[scenario].timing,
    )) {
      if (base[metric] === undefined || cur[metric] === undefined) continue;
      const limit = Math.max(base[metric] * mult, floor);
      const ok = cur[metric] <= limit;
      if (!ok) failed = true;
      console.log(
        `  ${ok ? "PASS" : "FAIL"}  ${metric}: ${fmtSec(cur[metric])} (baseline ${fmtSec(base[metric])}, limit ${fmtSec(limit)})`,
      );
    }
    if (!cur.stable) {
      failed = true;
      console.log(`  FAIL  tabs never settled within the timeout`);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Build + preview + run
// ---------------------------------------------------------------------------

const viteBin = join(root, "node_modules", ".bin", "vite");

if (!args["skip-build"]) {
  console.log("Building production bundle (vite build)...");
  const build = spawnSync(viteBin, ["build", "-l", "error"], {
    cwd: root,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    console.error("vite build failed");
    process.exit(1);
  }
} else if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("--skip-build was passed but dist/index.html does not exist");
  process.exit(1);
}

console.log(`Starting vite preview on port ${port}...`);
const preview = spawn(
  viteBin,
  ["preview", "--port", String(port), "--strictPort"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
preview.stderr.on("data", (d) => process.stderr.write(d));

const baseUrl = `http://localhost:${port}`;

let exitCode = 0;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) break;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error("vite preview did not start");
    await sleep(250);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    console.log(`Measuring ${repoPath} (cold load + warm switch)...`);
    const scenarios = await runScenarios(browser, baseUrl);

    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        commit: (() => {
          try {
            return execSync("git rev-parse --short HEAD", { cwd: root })
              .toString()
              .trim();
          } catch {
            return null;
          }
        })(),
        repo: args.repo,
        repoPath,
        chromiumVersion: browser.version(),
      },
      ...scenarios,
    };

    const outFile = args.out
      ? resolve(args.out)
      : join(
          root,
          "benchmarks",
          "results",
          `run-${report.meta.timestamp.replace(/[:.]/g, "-")}.json`,
        );
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

    printScenario("Cold load (fresh context, Issues tab):", report.coldLoad);
    printScenario("Warm switch (Issues -> PRs tab):", report.warmSwitch);
    console.log(`\nReport written to ${outFile}`);

    if (args.compare) {
      const baseline = JSON.parse(readFileSync(resolve(args.compare), "utf8"));
      const failed = compare(baseline, report);
      console.log(
        failed
          ? "\nRESULT: FAIL — query budget regressed against baseline"
          : "\nRESULT: PASS — within budget",
      );
      if (failed) exitCode = 1;
    } else if (!report.coldLoad.stable || !report.warmSwitch.stable) {
      console.error("\nWARNING: tab counts never settled within the timeout");
      exitCode = 1;
    }
  } finally {
    await browser.close();
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  preview.kill();
}

process.exit(exitCode);
