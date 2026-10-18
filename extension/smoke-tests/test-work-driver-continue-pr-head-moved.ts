#!/usr/bin/env bun
/**
 * #1468 — the head-moved guard at step boundaries and before the lens-fix
 * reposition, against REAL git: a bare origin, the driver's clone and a
 * second clone that pushes to the PR head.
 *
 * - The remote moved before lens-review: the cycle caps
 *   `continue-pr-head-moved` before endIfPrGone reads the PR.
 * - A second clone pushed between commit-pr and lens-fix: runLensFix caps
 *   and never fast-forwards the fix tree onto the foreign tip.
 * - No continuedPr: no ls-remote call is made.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { ContinuedPr } from "../src/work-driver-continue-pr-state.ts";
import { runLensFix } from "../src/work-driver-lens-fix.ts";
import { runStep } from "../src/work-driver-run-step.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

gitTestEnv();
process.env.PI_ENSEMBLE_FORGE = "github";
process.env.PI_ENSEMBLE_VERIFY = "0";
const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 1468;
const HEAD = "feat";
const PR = 42;
const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1468-head-moved-"));
let n = 0;

/** A driver clone whose PR head `feat` is at P on origin, with a fix tree at P. */
async function fixture() {
  const dir = path.join(root, `c${n++}`);
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const other = path.join(dir, "other");
  const wt = path.join(dir, "wt");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  for (const [k, v] of [
    ["user.email", "t@example.com"],
    ["user.name", "T"],
  ] as const) {
    await git(repo, ["config", k, v]);
  }
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const M = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  await git(repo, ["checkout", "-q", "-b", HEAD]);
  writeFileSync(path.join(repo, "a.txt"), "pr\n");
  await git(repo, ["commit", "-q", "-am", "pr"]);
  const P = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["push", "-q", "-u", "origin", HEAD]);
  await git(repo, ["checkout", "-q", "main"]);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, P]);

  const foreignPush = async () => {
    await execFileP("git", ["clone", "-q", "--branch", HEAD, origin, other]);
    await git(other, ["config", "user.email", "o@example.com"]);
    await git(other, ["config", "user.name", "O"]);
    writeFileSync(path.join(other, "b.txt"), "foreign\n");
    await git(other, ["add", "."]);
    await git(other, ["commit", "-q", "-m", "foreign"]);
    await git(other, ["push", "-q", "origin", HEAD]);
    return git(other, ["rev-parse", "HEAD"]);
  };

  const calls: string[] = [];
  let dispatches = 0;
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    const line = commandOf(cmd, o);
    calls.push(line);
    if (line.startsWith("gh pr view")) {
      return {
        stdout: JSON.stringify({
          number: PR,
          state: "MERGED",
          headRefName: HEAD,
          baseRefName: "main",
        }),
      };
    }
    if (line.startsWith("gh ")) return { stdout: "" };
    return realExec(cmd, o);
  };
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: repo,
    issue: ISSUE,
    verifyExecFn: exec,
    issueBodyFetcherFn: async () => ({ stdout: "title:\tt\nstate:\tOPEN\n\nbody" }),
    dispatchFn: async () => {
      dispatches += 1;
      throw new Error("no dispatch in this test");
    },
  } as unknown as DriverContext;

  const cp: ContinuedPr = {
    number: PR,
    headRefName: HEAD,
    headSha: P,
    mainlineSha: M,
    conflictPaths: [],
    matchedBy: "branch",
  };
  const base = initialState(ISSUE, Date.now());
  const state = (step: WorkState["pipelineState"]["currentStep"], continued: boolean): WorkState =>
    appendEvent(
      {
        ...base,
        pipelineState: {
          ...base.pipelineState,
          currentStep: step,
          lastCompletedStep: "commit-pr",
          branchName: HEAD,
          baseSha: M,
          prNumber: PR,
          reviewRound: 1,
          worktrees: { default: wt },
          ...(continued ? { continuedPr: cp } : {}),
        },
      },
      {
        kind: "lens-issues-found",
        at: Date.now(),
        jobId: "j",
        round: 1,
        findings: JSON.stringify([
          { path: "a.txt", line: 1, severity: "MEDIUM", title: "t", lens: "CORRECTNESS" },
        ]),
      },
    );
  return {
    ctx,
    state,
    calls,
    wt,
    foreignPush,
    dispatched: () => dispatches,
  };
}

const lastCap = (s: WorkState) =>
  [...s.eventLog].reverse().find((e) => e.kind === "cap-hit") as
    | { cap?: string; evidence?: string }
    | undefined;

try {
  // ---- remote moved before lens-review: capped before endIfPrGone --------
  {
    const t = await fixture();
    await t.foreignPush();
    const out = await runStep(t.ctx, t.state("lens-review", true), "lens-review");
    assert(
      lastCap(out)?.cap === "continue-pr-head-moved",
      `lens-review after a foreign push caps continue-pr-head-moved (got ${lastCap(out)?.cap})`,
    );
    assert(
      !t.calls.some((c) => c.startsWith("gh pr view")),
      "…before endIfPrGone reads the PR (a step-boundary check)",
    );
    assert(out.pipelineState.status !== "merged", "…and the cycle is not ended as merged");
  }

  // ---- foreign push between commit-pr and lens-fix: no ff onto it --------
  {
    const t = await fixture();
    const before = await git(t.wt, ["rev-parse", "HEAD"]);
    const foreign = await t.foreignPush();
    let out: WorkState | undefined;
    try {
      out = await runLensFix(t.ctx, t.state("lens-fix", true), Date.now());
    } catch {
      out = undefined;
    }
    assert(
      out !== undefined && lastCap(out)?.cap === "continue-pr-head-moved",
      `runLensFix after a foreign push caps continue-pr-head-moved (got ${out ? lastCap(out)?.cap : "a throw"})`,
    );
    assert(
      !t.calls.some((c) => /^git merge --ff-only/.test(c)),
      "…no merge --ff-only ran in the fix tree",
    );
    const after = await git(t.wt, ["rev-parse", "HEAD"]);
    assert(
      after === before && after !== foreign,
      "…the fix tree was not moved onto the foreign tip",
    );
    assert(t.dispatched() === 0, "…and the fixer was not dispatched");
  }

  // ---- no continuedPr: no ls-remote ---------------------------------------
  {
    const t = await fixture();
    await t.foreignPush();
    const out = await runStep(t.ctx, t.state("lens-review", false), "lens-review");
    assert(
      !t.calls.some((c) => c.startsWith("git ls-remote")),
      "without continuedPr no ls-remote call is made",
    );
    assert(
      out.pipelineState.status === "merged",
      "…and the step runs as before (endIfPrGone ends the merged PR)",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
