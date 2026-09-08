/**
 * test-forge-ci-watch.ts — offline smoke test for the GitHub (gh) CI
 * watch + run operations of the forge adapter.
 *
 * Split from test-forge-github.ts to keep that file under the 500-line
 * hard limit. The CI poll loop (ciWatch) and one-shot fetch (ciRun) are
 * covered here; the rest of the GitHub forge surface stays in
 * test-forge-github.ts.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-ci-watch.ts
 */

import { createForge } from "../src/forge.ts";
import { GH_RUN_DONE, GH_RUN_RUNNING, ghDetection, mkExec } from "./forge-fixtures.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const det = ghDetection("acme", "widget");
  console.log("ci watch (GitHub):");
  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": { stdout: JSON.stringify(GH_RUN_DONE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch returns terminal on first poll", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok, "ok");
      assert(result.terminal, "terminal");
      assert(!result.timedOut, "not timed out");
      assert(result.run !== undefined, "run present");
      assert(result.run!.status === "COMPLETED", `status ${result.run!.status}`);
      assert(result.run!.conclusion === "SUCCESS", `conclusion ${result.run!.conclusion}`);
    });
  }
  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": { stdout: JSON.stringify(GH_RUN_RUNNING) },
    });
    const forge = createForge(det, { execFn: fn });
    let nowMs = 0;
    const sleep = async (_ms: number) => {
      nowMs += _ms;
    };
    await check("ciWatch times out at the cap", async () => {
      const result = await forge.ciWatch(901, {
        pollMs: 1000,
        timeoutMs: 2500,
        now: () => nowMs,
        sleep,
      });
      assert(result.ok, "ok");
      assert(!result.terminal, "not terminal");
      assert(result.timedOut, "timed out");
      assert(result.run !== undefined, "run present");
      assert(result.run!.status === "IN_PROGRESS", `status ${result.run!.status}`);
    });
  }
  console.log("ci run (GitHub):");
  {
    const { fn } = mkExec({
      "gh api /repos/acme/widget/actions/runs/901": { stdout: JSON.stringify(GH_RUN_DONE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciRun returns the normalized run", async () => {
      const run = await forge.ciRun(901);
      assert(run.id === 901, `id ${run.id}`);
      assert(run.status === "COMPLETED", `status ${run.status}`);
      assert(run.conclusion === "SUCCESS", `conclusion ${run.conclusion}`);
      assert(run.headBranch === "feature/issue-17-x", `head ${run.headBranch}`);
    });
  }

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-ci-watch (GitHub) tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
