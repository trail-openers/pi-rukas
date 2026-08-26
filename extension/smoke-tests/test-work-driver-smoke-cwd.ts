#!/usr/bin/env bun
/**
 * #451 — smoke-cmd runs in the worktree, not repoRoot.
 *
 * Under the worktree-isolation epic the repo root sits on mainline; the
 * product smoke command must execute in the worktree where the developer's
 * changes live. This test asserts the cwd passed to the smoke command is
 * the changed worktree, not repoRoot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

import fsSync from "node:fs";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI } {
  const pi = {
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  return { pi };
}

const repoRoot = mkdtempSync(path.join(tmpdir(), "451-smoke-repo-"));
const worktree = mkdtempSync(path.join(tmpdir(), "451-smoke-wt-"));

try {
  fsSync.mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  fsSync.writeFileSync(path.join(repoRoot, ".pi", "verify-cmd"), "echo ok\n");
  fsSync.writeFileSync(
    path.join(repoRoot, ".pi", "smoke-cmd"),
    "# product smoke\nbun run smoke\n",
  );
  let s = initialState(1010, 1011);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { default: worktree },
      baseSha: "abc123",
    },
  };
  let smokeCwd: string | undefined;
  const ctx: DriverContext = {
    pi: makeFakePi().pi,
    repoRoot,
    issue: 1010,
    issueBodyFetcherFn: () => ({ stdout: "smoke cwd test" }),
    verifyExecFn: async (cmd, opts) => {
      if (cmd === "git status --porcelain") return { stdout: "M src/app.ts\n" };
      if (cmd.includes("verify-cmd")) return { stdout: "ok\n" };
      if (cmd.startsWith("git diff")) return { stdout: "+new code\n" };
      if (cmd.includes("run smoke")) {
        smokeCwd = opts?.cwd;
        return { stdout: "smoke passed\n" };
      }
      return { stdout: "" };
    },
  };
  const gate = await verifyStepOutcome(ctx, s, "develop");
  assert(
    gate.ok,
    "#451: smoke-cmd in worktree passes gate (smoke succeeds)",
  );
  assert(
    smokeCwd === worktree,
    `#451: smoke command cwd is the changed worktree (got ${smokeCwd}, expected ${worktree})`,
  );
  assert(
    smokeCwd !== repoRoot,
    "#451: smoke command cwd is NOT repoRoot",
  );
} finally {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
