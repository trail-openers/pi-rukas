#!/usr/bin/env bun
/**
 * AC3 (#2030) — the `apply` arms integrate() really produces, driven through
 * the real entry point, and one residual of the mapping this fix left behind.
 *
 * AC3's frozen file feeds the classifier a hand-built `{ failure: "apply" }`.
 * `integrate()` returns that discriminator from THREE arms — the aborted pick
 * batch, the publish refusal, and the patch fallback's `git apply` — and the
 * arm the second commit-pr actually takes is the last: the pick conflicts, the
 * orchestrator preserves the worktree's patch, and applying it fails too. A
 * mapping that covers one arm passes the frozen test while the others still
 * reach the operator as `other`.
 *
 * This drives `mechanizedCommitPr` (not the classifier) with a real `git apply`
 * rejection, so the arm is exercised by the code that produces it. The second
 * block pins the residual: the vocabulary module's own header still states the
 * behaviour AC3 removes — "the writer now labels apply failures `other`" —
 * which is the sentence the next reader (and the next lens) will reason from.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { causeFromIntegrateFailure } from "../src/work-driver-commit-helpers.ts";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { IntegrateResult } from "../src/work-driver-integrate.ts";
import type { WorkState } from "../src/workflow-state.ts";

const FILE = "test-AC3-apply-arm-git-apply.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

const ROOT_SHA = "1111111111111111111111111111111111111111";
const WT_SHA = "3333333333333333333333333333333333333333";
const BASE = "2222222222222222222222222222222222222222";

/** repoRoot answers clean; the worktree answers one dirty file and a `git apply`
 * that git refuses — the patch-transplant arm of integrate()'s apply failure. */
function mkExec(): NonNullable<DriverContext["verifyExecFn"]> {
  return async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
    const line = cmd === "git" && o?.argv ? ["git", ...o.argv].join(" ") : cmd;
    const inWt = (o?.cwd ?? "").includes("task-a");
    if (line.startsWith("git rev-list --reverse --first-parent")) return { stdout: "" };
    if (line.startsWith("git rev-list --count")) return { stdout: "0\n" };
    if (line.startsWith("git status --porcelain"))
      return { stdout: inWt ? " M src/a.rs\u0000" : "" };
    if (line.startsWith("git diff --cached --binary"))
      return {
        stdout: "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@\n+x\n",
      };
    if (line === "git rev-parse HEAD") return { stdout: `${inWt ? WT_SHA : ROOT_SHA}\n` };
    if (line.startsWith("git apply")) {
      const e = new Error("Command failed: git apply") as Error & { stderr?: string };
      e.stderr = "error: patch failed: src/a.rs:1\nerror: src/a.rs: patch does not apply";
      throw e;
    }
    if (line.startsWith("git diff --cached --name-only")) return { stdout: "src/a.rs\n" };
    return { stdout: "" };
  };
}

function commitPrState(dir: string): WorkState {
  return {
    issue: 2030,
    eventLog: [],
    pipelineState: {
      currentStep: "adversarial",
      reviewRound: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-2030-x",
      baseSha: BASE,
      worktrees: { a: path.join(dir, ".worktrees/issue-2030-task-a") },
      workstreams: { a: { scope: "fix module a", paths: ["src/a.rs"], outOfScope: [] } },
    },
  } as unknown as WorkState;
}

{
  const dir = mkdtempSync(path.join(tmpdir(), "ac3-apply-arm-"));
  try {
    const ctx = { repoRoot: dir, issue: 2030, verifyExecFn: mkExec() } as unknown as DriverContext;
    const res = await mechanizedCommitPr(ctx, commitPrState(dir), Date.now());
    const reason = (res as { reason?: string }).reason ?? "";
    assert(
      res.ok === false,
      `the git-apply arm fails the mechanized commit-pr (${reason.slice(0, 70)})`,
    );
    assert(
      /git apply failed/i.test(reason),
      `…and it is the git-apply arm that failed, not the pick (${JSON.stringify(reason.slice(0, 90))})`,
    );
    assert(
      (res as { conflictPatch?: string }).conflictPatch !== undefined,
      "…the arm preserved the conflict patch, which is integrate()'s apply-failure shape",
    );
    assert(
      (res as { fallbackCause?: string }).fallbackCause === "apply-conflict",
      `the git-apply arm is classified as apply-conflict, not other (got ${JSON.stringify((res as { fallbackCause?: string }).fallbackCause)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The result the AC1/AC2 skip produces when everything was already on the
// branch: a SUCCESS with no workstreams. It must answer no cause at all.
{
  const allSkippedOk = {
    ok: true,
    workstreams: [],
    empty: true,
    noDiff: { default: "/r/.worktrees/issue-2030-default" },
  } as unknown as IntegrateResult;
  assert(
    causeFromIntegrateFailure(allSkippedOk) === undefined,
    `an ok:true "everything was already on the branch" result answers NO cause (${JSON.stringify(causeFromIntegrateFailure(allSkippedOk))})`,
  );
}

// The vocabulary module that owns `CommitPrFallbackCause` still documents the
// pre-#2030 behaviour as current, in the present tense, at the one place a
// reader of the union looks for its meaning.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(
    path.join(here, "..", "src", "workflow-state-events-commitpr.ts"),
    "utf8",
  );
  assert(
    !/labels apply failures `?other`?/i.test(src),
    "the CommitPrFallbackCause module no longer states that the writer labels apply failures `other` (it is the union's only prose and now contradicts the code)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
