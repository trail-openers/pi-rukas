#!/usr/bin/env bun
/**
 * /research wigolo fallback — LIVE (dev-only, NOT in the pre-push gate:
 * verify-loop.ts skips `-live.ts`). Skips with a message unless wigolo is
 * installed AND PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1.
 *
 * When it runs: one real explore child (the same spawn seam the driver
 * uses) is asked to run `wigolo search` and `wigolo fetch` with `--json`
 * and report the results through the research-reporter extension; the
 * assertion is that its reply carries `backend: wigolo` and at least one
 * structured claim was captured.
 *
 * Run: cd extension && PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 bun smoke-tests/test-research-fallback-live.ts
 */

import { execSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function skip(msg: string): never {
  console.log(`⊘ LIVE skipped: ${msg}`);
  process.exit(0);
}

try {
  execSync("command -v wigolo", { stdio: "ignore" });
} catch {
  skip("wigolo is not installed (npm install -g --ignore-scripts wigolo@0.2.1)");
}
if (process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN !== "1") {
  skip("set PI_ENSEMBLE_ALLOW_LIVE_SPAWN=1 to spawn a real child");
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function main() {
  const { dispatchCore } = await import("../src/dispatch.ts");
  const { RESEARCH_EXTRA_ARGS } = await import("../src/research-driver.ts");

  const prompt = [
    "LIVE wigolo check (#773). Run exactly these two commands and report the results:",
    `  wigolo search "bun test runner" --json 2>/dev/null`,
    `  wigolo fetch https://bun.sh --json 2>/dev/null`,
    "For each result, call report_research_claim (kind finding, source = the URL or 'none' for the search).",
    "Then write a SHORT summary and END your reply with the line `backend: wigolo`.",
  ].join("\n");

  const r = await dispatchCore(
    { registerTool: () => {} } as never,
    { role: "explore", prompt, cwd: REPO_ROOT },
    {
      label: "research-wigolo-live",
      timeoutMs: 10 * 60 * 1000,
      extraArgs: RESEARCH_EXTRA_ARGS,
    },
  );
  assert(r.ok && !r.errorStop, `dispatch ok (ms=${r.ms})`);
  assert(/backend:\s*wigolo/.test(r.text), "reply carries `backend: wigolo`");
  const claims = r.toolUses.filter((t) => (t as { name?: string }).name === "report_research_claim");
  assert(claims.length > 0, `at least one structured claim via the reporter (got ${claims.length})`);
}

main()
  .then(() => process.exit(exit))
  .catch((err) => {
    console.error(`✗ live run failed: ${(err as Error).message}`);
    process.exit(1);
  });
