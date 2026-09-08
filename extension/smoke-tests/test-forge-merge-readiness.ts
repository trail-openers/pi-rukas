/**
 * test-forge-merge-readiness.ts — offline smoke test for the GitHub (gh)
 * merge-readiness operations of the forge adapter.
 *
 * Split from test-forge-github.ts to keep that file under the 500-line
 * hard limit. Covers CLEAN / BLOCKED / DIRTY / unreadable-checks /
 * not-OPEN paths.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-merge-readiness.ts
 */

import { createForge } from "../src/forge.ts";
import { GH_CHECKS, GH_PR, ghDetection, mkExec } from "./forge-fixtures.ts";

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
  console.log("merge readiness (GitHub):");
  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness CLEAN when mergeStateStatus=CLEAN + all pass", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) {
        assert(result.readiness === "CLEAN", `readiness ${result.readiness}`);
      }
    });
  }
  {
    const blocked = { ...GH_PR, mergeStateStatus: "BLOCKED" };
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(blocked) },
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed on BLOCKED", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) assert(result.reason.includes("BLOCKED"), `reason ${result.reason}`);
    });
  }
  {
    const failing = [
      { name: "ci", state: "completed", bucket: "fail", isRequired: true },
      { name: "lint", state: "completed", bucket: "pass", isRequired: true },
    ];
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { stdout: JSON.stringify(failing) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness DIRTY when a required check fails", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, "ok");
      if (result.ok) assert(result.readiness === "DIRTY", `readiness ${result.readiness}`);
    });
  }
  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { error: true, stderr: "no checks" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when checks unreadable", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
    });
  }
  {
    const closed = { ...GH_PR, state: "CLOSED" };
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(closed) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("readiness fails closed when PR not OPEN", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) assert(result.reason.includes("CLOSED"), `reason ${result.reason}`);
    });
  }

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-merge-readiness (GitHub) tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
