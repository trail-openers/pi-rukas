#!/usr/bin/env bun
/**
 * The develop gate's baseline comparison and timeout reporting.
 *
 * A verify command that already fails at the cycle's base commit parked
 * every cycle as `verify-failed:develop` with evidence blaming the diff; a
 * consolidated run KILLED at its timeout was reported as "specific
 * assertion: (no specific assertion could be extracted)". Driven through the
 * real `runVerifyCommandGate` with real git and a stub verify command whose
 * outcome is chosen per working directory.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import {
  assertDefaultVerifyBound,
  defaultBoundText,
  pinDefaultVerifyTimeout,
} from "./lib/verify-timeout-pin.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) => execFileP("/bin/sh", ["-c", cmd], { cwd });

const CMD = "bash scripts/verify.sh";
// The timeout cases assert the DEFAULT bound's text. The bound is read from
// the production helper with PI_ENSEMBLE_VERIFY_TIMEOUT_MS absent (see
// ./lib/verify-timeout-pin.ts), so an operator who raised the knob (a 45-min
// laptop setting) does not fail them for the wrong reason, and a future
// change to the default moves the asserted text with it.
const BOUND = await defaultBoundText();
// One self-check lives in the lib and BOTH consumers call it, so the shared
// helper cannot silently read a bound the gate does not use — and the pin is
// proven to put the operator's own knob value back afterwards.
await assertDefaultVerifyBound(assert);
const root = mkdtempSync(path.join(tmpdir(), "pi-baseline-red-"));
type Outcome = { ok: true } | { ok: false; stdout: string; killed?: boolean };

async function run(name: string, outcomeFor: (where: "base" | "change") => Outcome) {
  const repo = path.join(root, name, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "issue-9-default");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "change.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change"]);
  // The integration root ignores its own worktrees, as the driver arranges.
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\ntmp/\n");

  const baselineDir = path.join(repo, ".worktrees", "baseline-verify-9");
  const verifyRuns: Array<"base" | "change"> = [];
  let baselineHadChange: boolean | undefined;
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    cmd = commandOf(cmd, o);
    if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
    const where = o?.cwd === baselineDir ? "base" : "change";
    if (where === "base") baselineHadChange = existsSync(path.join(baselineDir, "change.txt"));
    verifyRuns.push(where);
    const r = outcomeFor(where);
    if (r.ok) return { stdout: "" };
    const e = new Error(`Command failed: ${cmd}`) as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    e.stdout = r.stdout;
    e.stderr = "";
    e.killed = r.killed;
    throw e;
  };
  const state = initialState(9);
  state.pipelineState.worktrees = { default: wt };
  state.pipelineState.baseSha = baseSha;
  const failures: string[] = [];
  const notes: string[] = [];
  await runVerifyCommandGate({
    execFn,
    cmd: CMD,
    ctx: {
      host: {} as unknown as DriverContext["host"],
      repoRoot: repo,
      issue: 9,
    } as DriverContext,
    state,
    worktrees: { default: wt },
    baseSha,
    changedWorktrees: [wt],
    workstreamBaseShas: undefined,
    failures,
    notes,
  });
  const listed = (await git(repo, ["worktree", "list"])).stdout;
  return { failures, notes, verifyRuns, baselineHadChange, baseSha, state, listed, baselineDir };
}

const CARGO = "running 41 tests\nerror: test failed, to rerun pass `--bin console`\n";

// 1 — the happy path never pays for a baseline run.
{
  const r = await run("green", () => ({ ok: true }));
  assert(r.failures.length === 0, "green gate: no failures");
  assert(!r.verifyRuns.includes("base"), "green gate: the baseline is NOT run on the happy path");
}

// 2 — red at base: the same test fails with and without the change.
{
  const r = await run("red-at-base", () => ({ ok: false, stdout: CARGO }));
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 1,
    "red at base: the baseline is run exactly once after the failure",
  );
  assert(
    r.baselineHadChange === false,
    "red at base: the baseline tree does not contain the change",
  );
  const first = r.failures[0] ?? "";
  assert(
    first.startsWith(BASELINE_RED_MARKER),
    "red at base: the baseline finding LEADS the failures",
  );
  assert(first.includes(r.baseSha.slice(0, 12)), "red at base: the finding names the base sha");
  assert(
    first.includes("error: test failed, to rerun pass `--bin console`") &&
      first.includes("SAME assertion"),
    "red at base: the finding names the base assertion and that the change's run shares it",
  );
  assert(
    first.length <= 800,
    `red at base: the finding survives the 800-char evidence bound (${first.length})`,
  );
  assert(r.failures.length > 1, "red at base: the change's own failures are kept, not replaced");
  assert(!r.listed.includes("baseline-verify-9"), "red at base: the temporary worktree is removed");
  assert(!existsSync(r.baselineDir), "red at base: the temporary directory is gone");
  let st = r.state;
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 0 },
    },
  };
  st = appendEvent(st, {
    kind: "cap-hit",
    at: 0,
    cap: "verify-failed:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: first,
  });
  const explained = explainCap("verify-failed:develop", st);
  assert(
    explained.includes("already fails at the cycle's base commit") &&
      !explained.includes("Inspect the worktree(s), fix or re-dispatch"),
    "red at base: the handoff no longer tells the operator to fix the worktree",
  );
}

// 3 — green at base: the change broke it; nothing is excused.
{
  const r = await run("green-at-base", (w) =>
    w === "base" ? { ok: true } : { ok: false, stdout: CARGO },
  );
  assert(r.failures.length > 0, "green at base: the failure still blocks");
  assert(
    !r.failures.some((f) => f.includes(BASELINE_RED_MARKER)),
    "green at base: no baseline-red finding",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify passed")),
    "green at base: a note records that the gate was green before the change",
  );
}

// 4 — a base run that fails for want of dependencies proves nothing.
{
  const r = await run("deps", (w) =>
    w === "base"
      ? { ok: false, stdout: "error: Cannot find module 'typescript'\n" }
      : { ok: false, stdout: CARGO },
  );
  assert(
    !r.failures.some((f) => f.includes(BASELINE_RED_MARKER)),
    "missing deps at base: NOT reported as a red baseline",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established")),
    "missing deps at base: reported as not established",
  );
}

// 5 — a run killed at its timeout is reported as a timeout, everywhere.
await pinDefaultVerifyTimeout(async () => {
  const r = await run("timeout", () => ({
    ok: false,
    stdout: "ok    no product or host names in platform files\n",
    killed: true,
  }));
  const all = r.failures.join("\n");
  assert(
    !all.includes("no specific assertion could be extracted") &&
      !all.includes("specific assertion:"),
    "timeout: no failure claims an assertion about the code",
  );
  assert(
    // #1064 — this fixture is ONE workstream, so the consolidated run's label
    // names that workstream's own tree; the CONSOLIDATED wording belongs to a
    // run that combined more than one (pinned N>1 by the #669 case in
    // test-work-driver-verify-consolidated.ts). What is unchanged is the
    // sentence's shape: the `[verify-timeout]` lead and the bound it names —
    // that the run was killed, which is the whole content of a killed run.
    r.failures.some(
      (f) =>
        f.includes(`${BOUND} timeout in the single workstream's own tree`) &&
        f.includes(r.state.pipelineState.worktrees?.default ?? ""),
    ),
    "timeout: the consolidated run of a single-workstream cycle is reported as exceeding its bound, in its own tree",
  );
  assert(
    !all.includes("CONSOLIDATED tree"),
    `#1064: a single-workstream cycle never says CONSOLIDATED tree (got: ${all.slice(0, 300)})`,
  );
  assert(
    (r.failures[0] ?? "").startsWith(BASELINE_RED_MARKER) &&
      (r.failures[0] ?? "").includes(`${BOUND} timeout on a clean checkout`),
    "timeout: a base run that also times out says the gate cannot finish inside its bound",
  );
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
