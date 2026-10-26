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
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
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

async function run(
  name: string,
  outcomeFor: (where: "base" | "change", baseRun?: 1 | 2) => Outcome,
  // The callbacks the gate's tail rule (`reportBaselineLeg`) is asked to fire. A
  // case that never passes them cannot tell a claim from a finding, which is the
  // distinction #1826 turns on for the killed arm: the timeout's sentence still
  // leads the evidence, and neither the cap's claim nor #1349's excuse may follow.
  baselineCallbacks: {
    onBaselineAttributed?: () => void;
    onBaselineRedEstablished?: (established: boolean) => void;
  } = {},
) {
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

  const baselineDir = path.join(repo, ".worktrees", "baseline-verify-9-base1");
  const secondBaselineDir = path.join(repo, ".worktrees", "baseline-verify-9-base2");
  const verifyRuns: Array<"base" | "change"> = [];
  let baselineHadChange: boolean | undefined;
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    cmd = commandOf(cmd, o);
    if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
    const where = o?.cwd === baselineDir || o?.cwd === secondBaselineDir ? "base" : "change";
    if (where === "base") baselineHadChange = existsSync(path.join(baselineDir, "change.txt"));
    verifyRuns.push(where);
    const r = outcomeFor(where, o?.cwd === secondBaselineDir ? 2 : 1);
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
    ...baselineCallbacks,
  });
  const listed = (await git(repo, ["worktree", "list"])).stdout;
  return {
    failures,
    notes,
    verifyRuns,
    baselineHadChange,
    baseSha,
    state,
    listed,
    baselineDir,
    secondBaselineDir,
  };
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
    r.verifyRuns.filter((w) => w === "base").length === 2,
    `red at base: the baseline is run TWICE after the failure (#1826 — one red run is not a red base; got ${r.verifyRuns.filter((w) => w === "base").length})`,
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
    first.includes("base run 1") && first.includes("base run 2"),
    `red at base: the finding names BOTH base runs (got ${first.slice(0, 200)})`,
  );
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
  assert(
    !r.listed.includes("baseline-verify-9"),
    "red at base: the temporary worktrees are removed",
  );
  assert(
    !existsSync(r.baselineDir) && !existsSync(r.secondBaselineDir),
    "red at base: BOTH temporary directories are gone",
  );
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
  const attributed: boolean[] = [];
  const established: boolean[] = [];
  const r = await run(
    "timeout",
    () => ({
      ok: false,
      stdout: "ok    no product or host names in platform files\n",
      killed: true,
    }),
    {
      onBaselineAttributed: () => attributed.push(true),
      onBaselineRedEstablished: (e) => established.push(e),
    },
  );
  const all = r.failures.join("\n");
  assert(
    !all.includes("no specific assertion could be extracted") &&
      !all.includes("specific assertion:"),
    "timeout: no failure claims an assertion about the code",
  );
  assert(
    r.failures.some((f) => f.includes(`${BOUND} timeout on the CONSOLIDATED tree`)),
    "timeout: the consolidated run is reported as exceeding its bound",
  );
  // #1826 — a killed FIRST base run is no longer evidence about the base: it
  // judged nothing, so it triggers no second run, raises no baseline-red claim on
  // either channel, and leaves the change's own timeout entry as the park's
  // evidence. The `[verify-timeout]` line above is what an operator now reads for
  // this shape, and no assertion in the handoff quotes a base it never saw.
  assert(
    !r.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)),
    "timeout: a base run killed at its bound raises no [baseline-red] finding (a killed run confirms nothing, #1826)",
  );
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 1,
    `timeout: the killed base run is not re-run to confirm it (got ${r.verifyRuns.filter((w) => w === "base").length} base runs)`,
  );
  // The killed arm's own route, kept: no second run, no two-run claim on either
  // channel, and the base reported as NOT ESTABLISHED rather than red.
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established")),
    "timeout: the base is reported as not established rather than red",
  );
  // Its evidence is the timeout's own sentence, and cap precedence routes that
  // sentence ahead of anything else (#1404), so the killed arm cannot reach the cap
  // #1826 withholds: the claim is the `[baseline-red]` entry standing alone as the
  // gate's whole verdict, and a killed run's entry leads with `[verify-timeout]`.
  const baselineEntries = r.failures.filter((f) => f.startsWith(BASELINE_RED_MARKER));
  assert(
    baselineEntries.length <= 1 && baselineEntries.every((f) => f.includes("[verify-timeout]")),
    `timeout: the killed base raises no plain [baseline-red] claim — at most the timeout's own entry (${JSON.stringify(baselineEntries.map((f) => f.slice(0, 60)))})`,
  );
  // The two claims the gate's tail rule reads, asked of the real caller rather than
  // inferred from prose: a killed base run raises NEITHER. #1349's excuse rides on
  // `onBaselineAttributed` (voided: a killed run holds no stream), and the cap's
  // claim rides on `onBaselineRedEstablished` — whose `false` is what stops the
  // cycle parking as `verify-baseline-red:develop`, since no path reaching that cap
  // exists without the claim having fired. Asking `verifyCapFor` with the claim
  // hard-coded to false would test the router's argument, not the gate's answer.
  assert(
    attributed.length === 0,
    `timeout: a killed base run earns #1349's excuse for nothing (got ${JSON.stringify(attributed)})`,
  );
  assert(
    established.length === 1 && established[0] === false,
    `timeout: the killed base reports itself NOT established to the cap (got ${JSON.stringify(established)})`,
  );
  assert(
    !r.notes.some((n) => n.includes("FLAKY")),
    "timeout: a killed base run is not recorded as a flaky base — it never asked for a second run",
  );
});

// 5b — a base that is RED once and GREEN once is not a baseline-red park: the
// failure is attributed to the change exactly as a green base attributes it, and
// the flaky base is recorded (#1826's central case — the four cycles in one
// 40-minute window that parked while a fifth on the same mainline merged).
{
  // Both arms red through the FIRST base run and the second green is what the
  // fixture's per-cwd switch expresses; the change's own run must stay red or
  // the comparison is never reached at all.
  const r = await run("red-then-green", (w, baseRun) =>
    w === "base"
      ? baseRun === 2
        ? { ok: true }
        : { ok: false, stdout: CARGO }
      : { ok: false, stdout: CARGO },
  );
  assert(
    r.verifyRuns.filter((w) => w === "base").length === 2,
    `red then green: the confirming run was paid for (got ${r.verifyRuns.filter((w) => w === "base").length})`,
  );
  assert(
    !r.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)),
    "red then green: no baseline-red finding — one red base run is not a red base",
  );
  assert(
    r.failures.length > 0,
    "red then green: the change's own failure still blocks, attributed as on a green base",
  );
  assert(
    r.notes.some((n) => n.startsWith("baseline verify not established") && n.includes("#1826")),
    "red then green: a note says the base was not confirmed, in the terms of the rule",
  );
  assert(
    r.notes.some(
      (n) => n.includes("FLAKY") && n.includes("base run 1") && n.includes("base run 2"),
    ),
    `red then green: the flaky base is recorded, naming both runs (got ${JSON.stringify(r.notes.filter((n) => n.includes("FLAKY")))})`,
  );
}

// 5c — the park's handoff names BOTH base runs and their outcomes.
{
  const r = await run("red-at-base-explain", () => ({ ok: false, stdout: CARGO }));
  const first = r.failures[0] ?? "";
  let st = appendEvent(r.state, {
    kind: "cap-hit",
    at: 0,
    cap: "verify-baseline-red:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: first,
  });
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 0 },
    },
  };
  const explained = explainCap("verify-baseline-red:develop", st);
  assert(
    explained.includes("base run 1") && explained.includes("base run 2"),
    "handoff: explainCap(verify-baseline-red:develop) names both base runs (got the first 200: " +
      explained.slice(0, 200) +
      ")",
  );
  assert(
    /base run 1: FAILED[\s\S]*base run 2: FAILED/.test(explained),
    "handoff: both runs are named WITH their outcomes, not just counted",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
