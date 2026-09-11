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
import { READINESS_TIMEOUT_MS } from "../src/forge-merge.ts";
import { GH_CHECKS, GH_PR, GL_JOBS, GL_MR, ghDetection, glDetection, mkExec } from "./forge-fixtures.ts";

/** Node's exec-timeout shape: killed with SIGTERM and an empty message. */
function timeoutErr(): Error {
  const e = new Error("") as Error & { killed?: boolean; signal?: string | null };
  e.killed = true;
  e.signal = "SIGTERM";
  return e;
}

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

  // ── #636: readiness exec calls are bounded by READINESS_TIMEOUT_MS ────
  {
    const { fn, opts } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("gh pr view and gh pr checks are called with timeout=READINESS_TIMEOUT_MS", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, "ok");
      assert(opts.length === 2, `expected 2 calls, got ${opts.length}`);
      for (const o of opts) {
        assert(o !== undefined, "opts recorded");
        assert(o.timeout === READINESS_TIMEOUT_MS, `timeout ${o.timeout}`);
      }
    });
  }
  {
    await check("killed pr view (Node exec-timeout shape) fails closed with a timeout-named reason", async () => {
      const forge2 = createForge(det, {
        execFn: async (cmd: string) => {
          if (cmd.includes("pr view")) throw timeoutErr();
          return { stdout: JSON.stringify(GH_CHECKS) };
        },
      });
      const result = await forge2.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) {
        assert(/timed out after \d+ms/.test(result.reason), `reason ${result.reason}`);
      }
    });
  }
  {
    await check("killed pr checks (Node exec-timeout shape) fails closed with a timeout-named reason", async () => {
      const forge2 = createForge(det, {
        execFn: async (cmd: string) => {
          if (cmd.includes("pr view")) return { stdout: JSON.stringify(GH_PR) };
          if (cmd.includes("pr checks")) throw timeoutErr();
          return { stdout: "" };
        },
      });
      const result = await forge2.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) {
        assert(/timed out after \d+ms/.test(result.reason), `reason ${result.reason}`);
      }
    });
  }

  // ── #636: GitLab readiness exec calls (same feature, shared coverage) ─
  const glDet = glDetection("acme", "widget");
  {
    const { fn, opts } = mkExec({
      "glab api /projects/:id/merge_requests/17": { stdout: JSON.stringify(GL_MR) },
      "glab api /projects/:id/pipelines/5001/jobs": { stdout: JSON.stringify(GL_JOBS) },
    });
    const forge = createForge(glDet, { execFn: fn });
    await check("glab merge_requests and pipelines/jobs are called with timeout=READINESS_TIMEOUT_MS", async () => {
      const result = await forge.mergeReadiness(17);
      assert(result.ok, "ok");
      assert(opts.length === 2, `expected 2 calls, got ${opts.length}`);
      for (const o of opts) {
        assert(o !== undefined, "opts recorded");
        assert(o.timeout === READINESS_TIMEOUT_MS, `timeout ${o.timeout}`);
      }
    });
  }
  {
    await check("killed glab merge_requests (Node exec-timeout shape) fails closed with a timeout-named reason", async () => {
      const forge2 = createForge(glDet, {
        execFn: async (cmd: string) => {
          if (cmd.includes("merge_requests")) throw timeoutErr();
          return { stdout: "[]" };
        },
      });
      const result = await forge2.mergeReadiness(17);
      assert(result.ok === false, "should fail");
      if (!result.ok) {
        assert(/timed out after \d+ms/.test(result.reason), `reason ${result.reason}`);
      }
    });
  }
  {
    await check("killed glab pipelines/jobs (best-effort) keeps ok:true with checks=[]", async () => {
      const forge2 = createForge(glDet, {
        execFn: async (cmd: string) => {
          if (cmd.includes("merge_requests")) return { stdout: JSON.stringify(GL_MR) };
          if (cmd.includes("/jobs")) throw timeoutErr();
          return { stdout: "[]" };
        },
      });
      const result = await forge2.mergeReadiness(17);
      assert(result.ok, `ok: ${result.ok ? "" : result.reason}`);
      if (result.ok) {
        assert(result.readiness === "CLEAN", `readiness ${result.readiness}`);
        assert(Array.isArray(result.checks) && result.checks.length === 0, `checks ${JSON.stringify(result.checks)}`);
      }
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
