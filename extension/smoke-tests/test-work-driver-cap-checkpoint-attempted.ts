#!/usr/bin/env bun
/**
 * #1414 round 3 — the checkpoint's record distinguishes "the typecheck was
 * ATTEMPTED and decided nothing" from "it was never attempted", and the
 * handoff renders a different sentence for each.
 *
 * Split from test-work-driver-cap-checkpoint.ts (AGENTS.md §12 file-size
 * limit): that file asks whether the checkpoint COMMITTED, and this one asks
 * what the record says about a check it ran or did not run. The question is
 * worth its own file because the two shapes are indistinguishable in the
 * record's older fields — `typechecked` absent covers "attempted, no verdict"
 * AND "never attempted" — so the round-2 renderer could only print one bullet
 * for both, and printed a verdict-shaped one for a checkpoint that had run no
 * check. `typecheckAttempted` is the field that separates them; these cases
 * are what make it load-bearing rather than decorative.
 *
 * Three real checkpoints, one per shape the field can take:
 *   - dirty tree, check ran, no verdict   → attempted: true,  reason recorded,
 *     handoff prints the no-verdict bullet with the reason;
 *   - clean tree, nothing to save         → no attempt recorded, no typecheck
 *     call at all;
 *   - report-only kill (write-gated role) → no attempt recorded, no call;
 *   - #1414 round 3 finding — the COMMIT FAILS after the check ran → the record
 *     still says it was attempted AND still carries the verdict it reached. That
 *     case is the one the field was written for: the round-2 assignment sat ahead
 *     of the call inside the branch's outer try, so any escape past it (a stage or
 *     commit throw landing in the outer catch, which resets only `tree`) dropped
 *     the attempt and the verdict together, and the handoff reported a tree the
 *     driver had actually compiled as never checked. The commit is forced to fail
 *     through `checkpointExecFn` — an injected `git commit` rejection with the
 *     real executor behind every other verb, so the stage and the check stay real.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { checkpointCapedDispatch } from "../src/work-driver-cap-checkpoint.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { initialState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-attempted-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function capKillState(
  repoRoot: string,
  issue: number,
  role: "developer" | "explore" = "developer",
): ReturnType<typeof initialState> {
  let s = initialState(issue, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop",
      worktrees: { default: repoRoot },
    },
  };
  s = {
    ...s,
    eventLog: [
      ...s.eventLog,
      {
        kind: "dispatch-failed" as const,
        step: "develop" as const,
        role: role as "developer",
        jobId: "j1",
        label: "developer",
        ms: 1000,
        at: Date.now(),
        exitCode: 143,
        killCause: "loop" as const,
        errorTail: "killed by pi-rukas (loop)",
      },
    ],
  };
  return s;
}

const fakePi = { sendUserMessage: () => {} } as unknown as Parameters<
  typeof checkpointCapedDispatch
>[0]["host"];

/**
 * A spy that records the typecheck calls and forwards every git verb to the
 * REAL executor — the checkpoint's git calls must stay real observations, so a
 * fake cannot make `tree` or the call count vacuous.
 */
function typecheckSpy(
  behaviour: "resolve" | "reject-could-not-run" | "reject-diagnostic",
): {
  fn: NonNullable<DriverContext["checkpointExecFn"]>;
  calls: { cmd: string }[];
} {
  const calls: { cmd: string }[] = [];
  const fn: NonNullable<DriverContext["checkpointExecFn"]> = async (cmd, opts2) => {
    if (cmd.includes("tsc")) {
      calls.push({ cmd });
      if (behaviour === "resolve") return { stdout: "", stderr: "" };
      if (behaviour === "reject-diagnostic") {
        throw Object.assign(new Error("Command failed: bun x tsc --noEmit"), {
          code: 2,
          stdout: "src/foo.ts(3,5): error TS2345: Argument of type 'x' is not assignable.",
          stderr: "",
        });
      }
      throw Object.assign(
        new Error("Command failed: bun x tsc --noEmit\nsh: tsc: command not found"),
        { code: 127, stdout: "", stderr: "sh: tsc: command not found" },
      );
    }
    // #1414 round 3 — `checkpointExecFn` is TYPECHECK-ONLY (work-driver-context.ts
    // #1414: "the checkpoint's git calls keep calling `execp`, so a fake cannot
    // make `tree: "committed"` a tautology"), verified by observation: this spy
    // sees only `bun x tsc --noEmit`. The commit is failed through the separate,
    // narrower `checkpointCommitFn` in `run()` instead, so this spy stays unable
    // to touch the commit at all.
    return execp(cmd, { maxBuffer: 8 * 1024 * 1024, ...opts2 });
  };
  return { fn, calls };
}

async function run(
  repo: string,
  issue: number,
  spy: ReturnType<typeof typecheckSpy>,
  role: "developer" | "explore" = "developer",
  opts: { failCommit?: boolean } = {},
) {
  const commitCalls: string[] = [];
  // #1414 round 3 — the commit-only seam. `checkpointExecFn` cannot reach the
  // commit (typecheck-only, by design), so the driver offers `checkpointCommitFn`
  // for exactly this call and nothing else.
  const commitFn: NonNullable<DriverContext["checkpointCommitFn"]> = async (cmd, execOpts) => {
    commitCalls.push(cmd);
    if (opts.failCommit) {
      throw Object.assign(
        new Error("Command failed: git commit -q --no-verify\nfixtures refuse"),
        { code: 1, stdout: "", stderr: "fixtures refuse" },
      );
    }
    return execp(cmd, { maxBuffer: 8 * 1024 * 1024, ...execOpts });
  };
  const ctx = {
    host: fakePi,
    repoRoot: repo,
    issue,
    checkpointExecFn: spy.fn,
    checkpointCommitFn: commitFn,
  } as unknown as Parameters<typeof checkpointCapedDispatch>[0];
  const out = await checkpointCapedDispatch(ctx, capKillState(repo, issue, role), "develop");
  return { out, commitCalls };
}

// ---- dirty tree, check RAN, reached no verdict → attempted, with a reason.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    const s = capKillState(repo, 9908);
    await writeState(repo, s);
    const spy = typecheckSpy("reject-could-not-run");
    const { out } = await run(repo, 9908, spy);
    const cps = out.pipelineState.capedPartialState;
    assert(spy.calls.length === 1, "#1414-r3: the checkpoint ran the typecheck once");
    assert(
      cps?.typechecked === undefined && "typechecked" in (cps ?? {}) === false,
      "#1414-r3: a check that decided nothing leaves typechecked off the record",
    );
    assert(
      cps?.typecheckAttempted === true,
      `#1414-r3: but it records that the check WAS attempted (got ${String(cps?.typecheckAttempted)})`,
    );
    assert(
      typeof cps?.typecheckReason === "string" && cps.typecheckReason.length > 0,
      `#1414-r3: and carries the reason (got ${JSON.stringify(cps?.typecheckReason)})`,
    );
    // The record and the renderer must agree: an attempt is the no-verdict
    // bullet, never the not-attempted one. `renderHandoffMarkdown(state, forge?)`
    // takes a forge type, not a repo path — one argument here.
    const md = renderHandoffMarkdown(out);
    assert(
      /typecheck: no verdict/.test(md) && !/typecheck: not attempted/.test(md),
      "#1414-r3: an attempted no-verdict check renders the no-verdict bullet",
    );
    assert(/could not run/.test(md), "#1414-r3: and the recorded reason reaches the handoff");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- clean tree: nothing was on disk, so the driver never reaches the check.
// `writeState` drops `.pi/work-state/<issue>.json` in the tree, so the fixture
// commits everything and writes nothing after — the checkpoint takes its state
// in memory and does not re-read it.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    const s = capKillState(repo, 9911);
    await writeState(repo, s);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--no-verify", "-m", "fixture state");
    assert(git(repo, "status", "--porcelain") === "", "#1414-r3: fixture tree is clean");
    const spy = typecheckSpy("resolve");
    const { out } = await run(repo, 9911, spy);
    const cps = out.pipelineState.capedPartialState;
    assert(
      cps?.tree === "clean",
      `#1414-r3: a clean tree records clean (got ${String(cps?.tree)})`,
    );
    assert(spy.calls.length === 0, "#1414-r3: a clean tree runs no typecheck");
    assert(
      cps?.typecheckAttempted === undefined,
      `#1414-r3: and records no attempt (got ${String(cps?.typecheckAttempted)})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- report-only kill (a structurally write-gated role): no stage, no commit,
// and no typecheck — so the record must not claim an attempt. This is the half
// that makes the renderer's not-attempted bullet reachable from a real
// checkpoint rather than only from a hand-built fixture.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    await writeState(repo, capKillState(repo, 9909, "explore"));
    const spy = typecheckSpy("resolve");
    const { out } = await run(repo, 9909, spy, "explore");
    const cps = out.pipelineState.capedPartialState;
    assert(spy.calls.length === 0, "#1414-r3: a report-only kill runs no typecheck");
    assert(cps?.reportOnly === true, "#1414-r3: and records reportOnly");
    assert(
      cps?.typecheckAttempted === undefined,
      `#1414-r3: and does NOT claim an attempt (got ${String(cps?.typecheckAttempted)})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- THE finding: the COMMIT FAILS after the check ran. The record must keep
// BOTH facts the check produced — that it ran, and what it concluded.
//
// This is the case the field exists for, and the one the round-2 shape got
// wrong: `typecheckAttempted = true` sat ahead of the call inside the dirty
// branch's outer try, so a throw anywhere after it landed in the outer catch —
// which resets only `tree` — and the record written below carried neither the
// attempt nor the outcome.
//
// The commit is made to fail by a pre-commit hook the fixture plants and git
// itself enforces (see `makeRepo`), NOT by stubbing the driver: the exec seam is
// typecheck-only, and a stub there would make `tree` mean nothing. The control
// assertions below fail loudly if the hook ever stops firing, because a
// `tree: "committed"` in this block would mean the case being asserted never
// happened.
//
// Both verdicts are driven, because "the outcome survives" has two arms and the
// pre-fix bug destroyed them the same way: a `false` that survives is
// `typechecked: false` (the handoff's broken-code bullet), and a no-verdict that
// survives is `typecheckReason` (its no-verdict bullet). A fix that kept only one
// arm would pass half this block.
for (const [behaviour, wantVerdict] of [
  ["reject-diagnostic", false],
  ["reject-could-not-run", undefined],
] as const) {
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    const issue = behaviour === "reject-diagnostic" ? 9912 : 9913;
    await writeState(repo, capKillState(repo, issue));
    const spy = typecheckSpy(behaviour);
    const { out, commitCalls } = await run(repo, issue, spy, "developer", { failCommit: true });
    const cps = out.pipelineState.capedPartialState;
    // Controls first: if the injected commit failure ever stopped reaching the
    // driver, everything under here would assert an outcome nothing produced.
    assert(spy.calls.length === 1, `commit-fails/${behaviour}: the check still ran once`);
    assert(
      commitCalls.some((c) => c.includes("git commit")),
      `commit-fails/${behaviour}: the commit seam really was called (got ${JSON.stringify(commitCalls)})`,
    );
    assert(
      cps?.tree === "dirty-uncommitted" && cps?.commitSha === undefined,
      `commit-fails/${behaviour}: the fixture's commit really failed — tree dirty, no sha (got ${String(cps?.tree)}/${String(cps?.commitSha)})`,
    );
    assert(
      cps?.typecheckAttempted === true,
      `commit-fails/${behaviour}: the record STILL says the check was attempted (got ${String(cps?.typecheckAttempted)})`,
    );
    if (wantVerdict === false) {
      assert(
        cps?.typechecked === false,
        `commit-fails/${behaviour}: and still carries the FAILED verdict it reached (got ${String(cps?.typechecked)})`,
      );
      assert(
        cps?.typecheckReason === undefined,
        `commit-fails/${behaviour}: a real verdict carries no no-verdict reason`,
      );
      const md = renderHandoffMarkdown(out);
      assert(
        /typecheck FAILED at checkpoint/.test(md),
        `commit-fails/${behaviour}: and the handoff still prints the broken-code bullet`,
      );
    } else {
      assert(
        cps?.typechecked === undefined,
        `commit-fails/${behaviour}: a no-verdict check still leaves typechecked off (got ${String(cps?.typechecked)})`,
      );
      assert(
        typeof cps?.typecheckReason === "string" && cps.typecheckReason.length > 0,
        `commit-fails/${behaviour}: and STILL carries its reason (got ${JSON.stringify(cps?.typecheckReason)})`,
      );
      const md = renderHandoffMarkdown(out);
      assert(
        /typecheck: no verdict/.test(md) && !/typecheck: not attempted/.test(md),
        `commit-fails/${behaviour}: the handoff prints the no-verdict bullet, never the not-attempted one`,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---- mutation direction: a COMMIT THAT SUCCEEDS after the same diagnostic still
// records the verdict, so the block above fails on a lost outcome rather than on
// a fixture that never worked.
{
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, "extension"), { recursive: true });
    writeFileSync(path.join(repo, "in-scope.ts"), "in\n");
    await writeState(repo, capKillState(repo, 9914));
    const spy = typecheckSpy("reject-diagnostic");
    const { out } = await run(repo, 9914, spy);
    const cps = out.pipelineState.capedPartialState;
    assert(
      cps?.tree === "committed" && cps?.typechecked === false,
      `commit-fails: mutation guard — a succeeding commit records committed + the false verdict (got ${String(cps?.tree)}/${String(cps?.typechecked)})`,
    );
    assert(spy.calls.length === 1, "commit-fails: mutation guard — the check ran exactly once");
    assert(
      cps?.typecheckAttempted === true,
      "commit-fails: and the attempt on the happy path too",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);