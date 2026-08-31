// Relay query-budget benchmark (stub).
//
// This currently performs only the browser preflight: it verifies that a
// Playwright-managed Chromium is available and explains how to provision one
// when it is not. The measurement harness itself (production build +
// instrumented navigation scenarios) has not landed yet, so the script always
// exits non-zero. See benchmarks/README.md.

import { existsSync } from "node:fs";

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

console.log(`Chromium available: ${executable}`);
console.error(
  "The benchmark harness is not implemented yet; this stub only checks browser availability.",
);
process.exit(1);
