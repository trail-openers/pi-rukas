#!/usr/bin/env bun
/**
 * #1324 — the optional `.pi/verify-cmd-fast` tier and the distinct
 * `verify-timeout:<step>` cap.
 *
 * A fast failure (typecheck/lint) must short-circuit the full verify in
 * every worktree and on the consolidated tree; absent the file nothing
 * changes. A verify run killed at its bound must park as
 * `verify-timeout:<step>` with text that says it timed out and names the
 * bound — never as `verify-failed:<step>`, which is a verdict on the code.
 * Driven through the real `runVerifyCommandGate` and
 * `runCommitPrConsolidatedVerify` with real git and a stub executor.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import { VERIFY_SUITE_TIMEOUT_ENV, suiteTierTimeoutMs } from "../src/work-driver-verify-budget.ts";
import {
  VERIFY_TIMEOUT_LABEL,
  boundText,
  verifyCapFor,
} from "../src/work-driver-verify-develop-helpers.ts";
import { FAST_TIER_LABEL, fastVerifyCmdFor, withFastTier } from "../src/work-driver-verify-fast.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
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

const FULL = "bash scripts/verify.sh";
// Mirrors the real .pi/verify-cmd-fast first line: string identity only; the executor is stubbed.
const FAST = "bun x tsc --noEmit && bun run check";
const TSC = "src/a.ts(3,1): error TS2304: Cannot find name 'nope'.\n";
const root = mkdtempSync(path.join(tmpdir(), "pi-fast-tier-"));
// Case 5 asserts the DEFAULT bound's text. #1509 moved that bound to the SUITE
// tier's own knob, so the pin below (which clears the shared
// PI_ENSEMBLE_VERIFY_TIMEOUT_MS) still matters: an operator who raised the
// shared knob (a 45-min laptop setting) would otherwise shift the fallback the
// suite tier resolves through and fail the case for the wrong reason. The
// asserted text is derived from the production helper rather than spelled here.
await assertDefaultVerifyBound(assert);
// The commit-pr tier's own bound (a different knob from the develop gate's),
// spelled the same way the production helper spells it.
const INTEGRATION_BOUND = boundText(900_000);
type Outcome = { ok: true } | { ok: false; stdout: string; killed?: boolean };
type Calls = Array<{ cmd: string; timeout?: number }>;

/** A stub executor: git runs for real, verify commands get a chosen outcome. */
function stubExec(calls: Calls, outcomeFor: (cmd: string) => Outcome) {
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmdArg, o) => {
    const cmd = commandOf(cmdArg, o);
    if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
    calls.push({ cmd, timeout: o?.timeout });
    const r = outcomeFor(cmd);
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
  return execFn;
}

async function makeRepo(name: string, fast?: string) {
  const repo = path.join(root, name, "repo");
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  if (fast !== undefined) writeFileSync(path.join(repo, ".pi", "verify-cmd-fast"), fast);
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
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\ntmp/\n");
  return { repo, wt, baseSha };
}

/** The develop gate as verifyDevelopOutcome drives it (fast tier wrapped in). */
async function developGate(
  name: string,
  fast: string | undefined,
  outcomeFor: (c: string) => Outcome,
) {
  const { repo, wt, baseSha } = await makeRepo(name, fast);
  const calls: Calls = [];
  const state = initialState(9);
  state.pipelineState.worktrees = { default: wt };
  state.pipelineState.baseSha = baseSha;
  const failures: string[] = [];
  const notes: string[] = [];
  await runVerifyCommandGate({
    execFn: withFastTier(stubExec(calls, outcomeFor), FULL, await fastVerifyCmdFor(repo)),
    // #1509 — the develop gate passes its own tier in rather than letting the
    // gate guess: this caller runs the project's full command, so it is the
    // suite tier. Callers that do not pass one keep the pre-#1509 shared
    // bound, which is why this is an argument and not a default.
    suiteTierTimeoutMs: await suiteTierTimeoutMs(repo),
    cmd: FULL,
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
  return { failures, calls, state, repoRoot: repo };
}

// 1 — the file is optional and read like .pi/verify-cmd.
{
  const { repo } = await makeRepo("discovery", `# fast tier\n\n${FAST}\n`);
  assert(
    (await fastVerifyCmdFor(repo)) === FAST,
    "fast tier: first non-comment line is the command",
  );
  const { repo: bare } = await makeRepo("discovery-absent");
  assert((await fastVerifyCmdFor(bare)) === undefined, "fast tier: absent file → undefined");
  const exec = stubExec([], () => ({ ok: true }));
  assert(
    withFastTier(exec, FULL, undefined) === exec,
    "absent: the executor is returned unchanged",
  );
}

// 2 — absent: behaviour unchanged, only the full command runs.
{
  const r = await developGate("absent", undefined, () => ({ ok: true }));
  assert(r.failures.length === 0, "absent: a green gate passes");
  assert(
    r.calls.length > 0 && r.calls.every((c) => c.cmd === FULL),
    "absent: only the full command runs",
  );
}

// 3 — fast passes: it runs first, then the full command, everywhere.
// #1240 pins this case to the always-run shape: the gate is N=1 and every
// per-worktree run is green, so with the duplicate-run skip ON the
// consolidated pair below would not run AT ALL and this 4-call assertion would
// be asserting the pre-#1240 shape by accident. The skip's own behaviour —
// including that it skips the fast tier along with the full command, since
// both live inside one `verifyExec` — is what
// test-work-driver-consolidated-verify-skip.ts case a tests.
// Only `0` disables the skip, so the case must set `0` explicitly to pin the
// always-run shape it asserts. The restore puts back exactly what the
// environment held, so an operator's own setting outlives the block.
{
  const prevSkip = process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
  process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = "0";
  const r = await developGate("fast-green", FAST, () => ({ ok: true }));
  // The `delete` restore form is mandated by the env-clear ratchet
  // (test-env-clear-gate.ts): on Bun 1.4 assigning the undefined literal to an
  // env key stores the string "undefined" rather than removing the key, which
  // would read as "skip enabled" to every later case in this file.
  if (prevSkip === undefined) delete process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP;
  else process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = prevSkip;
  assert(r.failures.length === 0, "fast green: the gate passes");
  const cmds = r.calls.map((c) => c.cmd);
  assert(
    cmds.length === 4 && cmds.join(",") === [FAST, FULL, FAST, FULL].join(","),
    `fast green with the #1240 skip disabled: fast then full in the worktree AND on the consolidated tree (${cmds.join(", ")})`,
  );
}

// 3b — the shared bound: the full run gets what a measurably slow fast run left,
// and never less than 1 ms (a zero or negative timeout would mean "no bound").
{
  const budget = async (bound: number, fastMs: number) => {
    const seen: number[] = [];
    const exec = async (cmd: string, o?: { timeout?: number }) => {
      if (cmd === FAST) await new Promise((r) => setTimeout(r, fastMs));
      else seen.push(o?.timeout ?? Number.NaN);
      return { stdout: "" };
    };
    const started = Date.now();
    await withFastTier(exec, FULL, FAST)(FULL, { timeout: bound });
    return { full: seen[0] ?? Number.NaN, elapsed: Date.now() - started };
  };
  const r = await budget(10_000, 150);
  assert(
    r.full < 10_000 - 140 && r.full >= 10_000 - r.elapsed,
    `shared bound: the full run's timeout is the bound minus the fast run's time (got ${r.full}, elapsed ${r.elapsed})`,
  );
  const clamped = await budget(50, 120);
  assert(
    clamped.full === 1,
    `shared bound: an exhausted budget clamps to 1 ms (got ${clamped.full})`,
  );
}

// 4 — fast fails: the full command never runs, the evidence names the tier.
{
  const r = await developGate("fast-red", FAST, (c) =>
    c === FAST ? { ok: false, stdout: TSC } : { ok: true },
  );
  assert(!r.calls.some((c) => c.cmd === FULL), "fast red: the full verify is short-circuited");
  const all = r.failures.join("\n");
  assert(
    all.includes("TS2304") && all.includes(FAST_TIER_LABEL),
    "fast red: evidence quotes tsc and names the tier",
  );
  assert(
    verifyCapFor("develop", r.failures) === "verify-failed:develop",
    "fast red: a code failure stays verify-failed",
  );
  // #1064 — with ONE workstream the consolidated probe now names the same tree
  // the per-worktree entry names, so the tree clause no longer says which run
  // produced an entry. What still separates them is the COMMAND: the per-worktree
  // loop ran the FAST tier (and carries the tier note); the probe ran the
  // project's full command and must never claim the tier note. The partition is
  // computed once so a failure names the entry that broke it.
  const tiered = r.failures.filter((f) => f.includes(FAST_TIER_LABEL));
  const [onlyTier] = tiered;
  assert(
    tiered.length === 1 &&
      (onlyTier ?? "").includes(`verify command \`${FAST}\` failed in`) &&
      r.failures.some(
        (f) => !f.includes(FAST_TIER_LABEL) && f.includes("failed in") && f.includes(`\`${FULL}\``),
      ),
    `fast red: exactly one entry claims the fast tier and it names the fast command; the full-command entry never does (tiered: ${tiered.join(" | ").slice(0, 200)})`,
  );
}

// 4b — the FAST tier killed at the bound: still a timeout, through the rethrow.
{
  const r = await developGate("fast-killed", FAST, (c) =>
    c === FAST ? { ok: false, stdout: "", killed: true } : { ok: true },
  );
  assert(!r.calls.some((c) => c.cmd === FULL), "fast killed: the full verify is short-circuited");
  assert(
    verifyCapFor("develop", r.failures) === "verify-timeout:develop",
    `fast killed: the cap is verify-timeout:develop (failures: ${r.failures.join(" | ").slice(0, 300)})`,
  );
  assert(
    r.failures.some((f) => f.includes(VERIFY_TIMEOUT_LABEL) && f.includes(`\`${FAST}\` exceeded`)),
    "fast killed: the per-worktree headline names the fast command as the one that timed out",
  );
}

// 5 — killed at the bound: its own cap, its own text, a valid state file.
await pinDefaultVerifyTimeout(async () => {
  const r = await developGate("timeout", FAST, (c) =>
    c === FULL ? { ok: false, stdout: "ok   1 passing\n", killed: true } : { ok: true },
  );
  assert(
    r.failures.length > 0 && r.failures.every((f) => f.includes(VERIFY_TIMEOUT_LABEL)),
    "timeout: every failure is labelled a timeout",
  );
  const cap = verifyCapFor("develop", r.failures);
  assert(
    cap === "verify-timeout:develop",
    `timeout: the cap is verify-timeout:develop (got ${cap})`,
  );
  let st = r.state;
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 1, origin: "outcome-gate" },
    },
  };
  st = appendEvent(st, { kind: "cap-hit", at: 2, cap, reviewRound: 0, nextStep: "handoff" });
  const text = explainCap(cap, st);
  // #1509 — the bound this case now names is the SUITE tier's, not the shared
  // 10-minute number, and so is the knob: the full verify command IS the tier
  // that pays for the whole offline suite, which is the tier whose bound had to
  // grow. The shared `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` text would send an operator
  // to raise a knob that no longer governs this run — exactly the mis-diagnosis
  // the per-tier split removes. Both strings are derived from the production
  // helper rather than spelled as literals here.
  const suiteBound = boundText(await suiteTierTimeoutMs(r.repoRoot));
  assert(
    text.includes("TIMED OUT") && text.includes(suiteBound),
    `timeout: the handoff says it timed out, with the SUITE tier's bound (${suiteBound})`,
  );
  assert(
    text.includes(VERIFY_SUITE_TIMEOUT_ENV) && text.includes("reduce concurrency"),
    "timeout: the handoff recovery names the suite tier's knob and concurrency",
  );
  assert(!text.includes("rejected"), "timeout: the handoff does not call it a rejection");
  st.pipelineState.status = "running";
  st.pipelineState.currentStep = "handoff";
  assert(
    validateDiscriminants(st).length === 0,
    "timeout: the cap validates on a running state file",
  );
  assert(
    verifyCapFor("develop", [...r.failures, "verify command `x` failed in /w: boom"]) ===
      "verify-failed:develop",
    "mixed: one real failure among timeouts is verify-failed",
  );
});

// 6 — commit-pr: the fast tier runs first and a kill is a timeout, not a classification.
{
  const { repo } = await makeRepo("commit-pr", FAST);
  const calls: Calls = [];
  const red = await runCommitPrConsolidatedVerify(
    stubExec(calls, (c) => (c === FAST ? { ok: false, stdout: TSC } : { ok: true })),
    {
      verifyCmd: FULL,
      repoRoot: repo,
      workstreamCount: 1,
      workstreamIds: ["default"],
      timeoutMs: 60_000,
    },
  );
  assert(red.ok === false && !red.timedOut, "commit-pr fast red: a failure, not a timeout");
  assert(
    !calls.some((c) => c.cmd === FULL),
    "commit-pr fast red: the full verify is short-circuited",
  );
  const killed = await runCommitPrConsolidatedVerify(
    stubExec([], (c) => (c === FULL ? { ok: false, stdout: "", killed: true } : { ok: true })),
    {
      verifyCmd: FULL,
      repoRoot: repo,
      workstreamCount: 1,
      workstreamIds: ["default"],
      timeoutMs: 900_000,
    },
  );
  assert(
    killed.ok === false &&
      killed.timedOut === true &&
      killed.classifiedMessage.includes(INTEGRATION_BOUND) &&
      killed.classifiedMessage.includes("PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS"),
    "commit-pr timeout: flagged, with the bound and the integration knob",
  );
  // #1064 — the tree half of that clause. This seam's probe always verifies the
  // integration checkout at repoRoot, so even at N=1 (the case the develop seam
  // renames) the commit-pr timeout stays CONSOLIDATED: naming a workstream
  // worktree here would send the operator to a tree that never held the change.
  assert(
    killed.ok === false &&
      killed.classifiedMessage.includes("on the CONSOLIDATED tree") &&
      !killed.classifiedMessage.includes(".worktrees/issue-9-default"),
    `commit-pr timeout: names the integration checkout, not a workstream worktree (got: ${killed.ok === false ? killed.classifiedMessage.slice(0, 200) : ""})`,
  );
  const fastKilled = await runCommitPrConsolidatedVerify(
    stubExec([], (c) => (c === FAST ? { ok: false, stdout: "", killed: true } : { ok: true })),
    {
      verifyCmd: FULL,
      repoRoot: repo,
      workstreamCount: 1,
      workstreamIds: ["default"],
      timeoutMs: 900_000,
    },
  );
  assert(
    fastKilled.ok === false &&
      fastKilled.timedOut === true &&
      fastKilled.classifiedMessage.includes(`\`${FAST}\` exceeded`),
    "commit-pr fast killed: a timeout, and the headline names the fast command",
  );
  assert(
    red.ok === false &&
      red.classifiedMessage.includes(FAST) &&
      !red.classifiedMessage.includes(FULL),
    "commit-pr fast red: the headline names the fast command, not the full one",
  );
  let st = initialState(9);
  st = appendEvent(st, {
    kind: "cap-hit",
    at: 2,
    cap: "verify-timeout:commit-pr",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: killed.ok ? "" : killed.classifiedMessage,
  });
  const text = explainCap("verify-timeout:commit-pr", st);
  assert(
    text.includes("TIMED OUT") && text.includes(INTEGRATION_BOUND),
    "commit-pr timeout: the handoff names the bound",
  );
}

// 7 — the developer runs the fast tier and leaves the full one to the driver.
{
  const withFast = inlineDevelopPrompt(
    [9],
    "/tmp/s",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    FULL,
    undefined,
    undefined,
    undefined,
    FAST,
  );
  assert(
    withFast.includes(`\`${FAST}\``) && withFast.includes("Do NOT run the full verify"),
    "prompt: names the fast tier, not the full run",
  );
  const without = inlineDevelopPrompt(
    [9],
    "/tmp/s",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    FULL,
  );
  assert(
    without.includes("this is the exact command the verify gate will run"),
    "prompt: unchanged without the file",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
