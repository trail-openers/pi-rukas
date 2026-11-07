#!/usr/bin/env bun
/**
 * lean/build — a build child stopped by its OWN ceiling keeps its work (#2067).
 *
 * The field shape: a six-criterion issue, a builder killed at the 400-turn
 * ceiling with most of its minutes unspent, and a run that handed back with
 * `buildAttempts` still 0 and the child's code uncommitted in the worktree. The
 * step must fold what the child wrote into the attempt's commit through the same
 * guards an `ok` round uses (frozen and protected paths reverted, nothing kept
 * the step cannot account for), so verify and ci find a clean tree, the retry
 * starts from that head, and its prompt says the budget stopped the last attempt
 * and names the frozen files the driver re-ran red.
 *
 * Split from test-lean-build.ts for the 500-line gate (AGENTS.md §12).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { emptyRunningState } from "../src/progress.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState, type RunCounters, type Step } from "../src/lean/state.ts";
import { MAX_BUILD_ATTEMPTS, next } from "../src/lean/machine.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import {
  commitPaths,
  configWithRunner,
  status,
  subject,
  subjectsAbove,
} from "./lib/lean-build-asserts.ts";
import { ROOTS, buildFixture, git, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
/** A bare run at `state`, for the table half of the (r) case below. */
function runProbe(state: LeanState): LeanRun {
  return {
    schema: 1,
    issue: 151,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "b",
    state,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
  };
}

function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** One turn past a `turns: N` ceiling — the call `spawn.ts` makes at `message_end`. */
function breachTurns(turns: number) {
  return (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: turns + 1 });
}

// ── a budget-stopped build folds its work and retries ─────────────────────
//
// The field shape (#2067): a six-criterion issue, a builder killed at the 400-turn
// ceiling with most of its minutes unspent. The step must fold what the child
// wrote into the attempt's commit — the same guards as any ok round, frozen and
// protected paths reverted — so the retry starts from that head instead of from
// the frozen commit, and the next child's prompt says the budget stopped it and
// which frozen tests are still red.
{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  const breach = (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 });
  const first = await runBuild({
    issue: 140,
    config: cfg,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    onProgressTick: breach,
  });
  assert(first.threw === undefined, `(n) the stopped round does not throw: ${first.threw?.message ?? "clean"}`);
  assert(first.outcome?.kind === "budget", `(n) the stopped round is a budget verdict (got ${first.outcome?.kind})`);
  assert(
    (first.outcome?.dispatches ?? []).length === first.dispatched && first.dispatched > 1,
    `(n) a ceiling-stopped child is retried in place and every child is billed (got ${first.dispatched})`,
  );
  assert(
    first.headAfter !== first.headBefore,
    "(n) the stopped round's work is folded into a commit, not left uncommitted",
  );
  assert(
    commitPaths(first.worktree).join() === "src/retry.ts",
    `(n) the folded commit holds the stopped child's file (got ${commitPaths(first.worktree).join(", ")})`,
  );
  assert(
    status(first.worktree) === "",
    `(n) the tree is clean after the fold, so the retry and verify can run (got ${status(first.worktree)})`,
  );

  // The fold's commit is the FIRST attempt's: the label is a log fact, and one
  // decided `build` row sits below this visit, so the round is attempt 1 however
  // many children its own ceiling stopped along the way.
  assert(
    subject(first.worktree) === "build: attempt 1 for #140",
    `(n) the folded commit carries the attempt subject (got ${subject(first.worktree)})`,
  );
  // Three children, because the run had dispatches left to spend: the round in
  // progress and two retries. The cap is a dispatch budget, so a ceiling stops
  // the CHILD and not the round — the third build is work, not a ceiling.
  assert(
    first.dispatched === 3,
    `(n) a stopped child is retried while dispatches remain, so the round spends three children (got ${first.dispatched})`,
  );

  // The retry, on the SAME tree the stopped child left: same repo, same worktree,
  // and the log now holds that one decided `build:budget` step — which is what
  // makes this attempt 2 and what its prompt must speak to.
  const budgeted: Step = {
    ...first.built.ctx.steps.at(-1)!,
    outcome: first.outcome,
  };
  const retry = await runBuild({
    issue: 140,
    // Same repo, same worktree — the tree the stopped child left, at the commit
    // the step folded — and a log whose decided `build:budget` step is what makes
    // this attempt 2 and what its prompt has to speak to.
    built: {
      ...first.built,
      headBefore: first.headAfter,
      ctx: { ...first.built.ctx, steps: [...first.built.ctx.steps.slice(0, -1), budgeted] },
    },
    config: cfg,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => { backoff(); };\n"),
    onProgressTick: breach,
  });
  assert(retry.threw === undefined, `(n) the retry ran: ${retry.threw?.message ?? "clean"}`);
  assert(retry.dispatched > 0, `(n) a builder was dispatched for the retry (got ${retry.dispatched})`);
  const prompt = retry.prompts[0] ?? "";
  assert(
    prompt.includes("This is attempt 2."),
    `(n) the retry's prompt labels the round attempt 2 (got ${prompt.match(/This is attempt \d+/)?.[0] ?? "none"})`,
  );
  assert(
    /budget/i.test(prompt),
    "(n) the retry's prompt says the previous attempt ran out of budget",
  );
  assert(
    prompt.includes("tests/AC1-retry.test.sh") && prompt.includes("still failing"),
    `(n) the retry's prompt names the frozen tests still failing (got ${prompt.slice(0, 400)})`,
  );
  assert(
    git(retry.worktree, "rev-parse", "HEAD^") === first.headAfter,
    "(n) the retry's commit sits on the previous attempt's folded commit — the work was kept",
  );
  assert(
    readFileSync(path.join(retry.worktree, "src/retry.ts"), "utf8").includes("backoff"),
    "(n) the retry's tree holds its own edit, not the previous attempt's bytes",
  );
  assert(
    subjectsAbove(retry.worktree, first.headBefore).join(" | ") ===
      "build: attempt 2 for #140 | build: attempt 1 for #140",
    `(n) both attempts are commits above the frozen head (got ${subjectsAbove(retry.worktree, first.headBefore).join(" | ")})`,
  );
}

// ── the fold's sweep of the frozen tests shares ONE deadline ─────────────────
{
  // The fold re-runs every frozen file AFTER the child was paid (#2067), so a sweep
  // with no deadline outlives the step's own budget: each runner sleeps thirty
  // seconds, far past the bound the case sets — and once the deadline is spent, no
  // later file may even start. A file whose runner never answered is not one the
  // driver watched fail, so it is not named as failing either.
  const STARTED: string[] = [];
  const HANG_A = "tests/hang-a.test.sh";
  const HANG_B = "tests/hang-b.test.sh";
  const SLEEPER = "#!/bin/sh\nsleep 30\necho \"not ok - $0\" 1>&2\nexit 1\n";
  const began = Date.now();
  const r = await runBuild({
    issue: 141,
    config: {
      ...configWithRunner(),
      budgets: { ...defaultConfig().budgets, build: { turns: 1, tokens: 0, minutes: 0 } },
    },
    // Both sleepers hang past the bound the case sets: with a per-file ceiling
    // instead of one shared deadline, three attempts would cost six sleeps.
    extraFrozen: { [HANG_A]: SLEEPER, [HANG_B]: SLEEPER },
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    onProgressTick: breachTurns(1),
    blockedTimeoutMs: 150,
    execSpy: (cmd, o) => {
      if (cmd !== "git") STARTED.push(String((o as { argv?: string[] })?.argv?.[0] ?? cmd));
    },
  });
  const reason = r.outcome?.reason ?? "";
  assert(r.threw === undefined, `(h) the hung sweep does not throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "budget",
    `(h) the stopped round still reports its budget verdict (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    Date.now() - began < 10_000,
    `(h) the fold returned at its bound, not when the sleeping runners finished`,
  );
  assert(
    !reason.includes("still failing") && !reason.includes(HANG_A) && !reason.includes(HANG_B),
    `(h) a file whose runner never answered is not named as failing (got ${reason})`,
  );
  // One sweep per attempt, and it never runs the list past the bound: the sleeper is
  // abandoned at the deadline and the sweep returns, so three attempts cost three
  // bounded sweeps — not three sleeps of thirty seconds. AC1 answers green before
  // each sleeper starts, so every sweep pays exactly one abandoned runner.
  assert(
    STARTED.length === 6 && STARTED.filter((f) => f === HANG_A).length === 3,
    `(h) the sweep stopped at its bound every attempt (${JSON.stringify(STARTED)})`,
  );
}

// ── (r) the FIELD WALK: table and step spend the same three rounds ─────────
//
// The field log: `build:ok`, `challenge:new-tests`, `build:budget`, handback —
// two real builders, and a run handed back with a fix outstanding. Nothing
// composed the two halves before: `test-lean-machine*.ts` priced the edges and
// this file's other cases drove the step, and the gap between them is where one
// ceiling stop came to cost two attempts. So drive the walk through the REAL
// table to the second build, hand the step exactly the counters and log the
// walk produced, and count children.
//
// The walk bills one round (the first build). The step's in-step ceiling is read
// off that counter, so the run has two dispatches left and the stopped child is
// retried until all three are spent. Under entry-billing the same walk reached
// this step at `buildAttempts` 3 — the challenge charged one on the way OUT of
// build — and the step returned after a single child.
{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  const breach = (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 });
  const built = buildFixture(151);
  // The step's in-step ceiling reads the run's counter, and `buildFixture` seeds
  // `createRun`'s initial one, so the case sets the walk's answer here: one round
  // billed entering this visit.
  built.ctx.run.counters = { ...built.ctx.run.counters, buildAttempts: 1 };
  const first = await runBuild({
    issue: 151,
    built,
    config: cfg,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    onProgressTick: breach,
  });
  assert(first.threw === undefined, `(r) the stopped round does not throw: ${first.threw?.message ?? "clean"}`);
  assert(
    first.outcome?.kind === "budget",
    `(r) the round still reports its budget verdict (got ${first.outcome?.kind ?? first.threw?.message})`,
  );
  // One round was billed entering this visit, so two dispatches remain and the
  // loop buys both before the cap stops it. Pre-fix the counter read 3 here (the
  // challenge had charged one leaving build) and the step returned after a
  // single child — the field symptom exactly.
  assert(
    first.dispatched === MAX_BUILD_ATTEMPTS - 1,
    `(r) a run billed one round spends the two dispatches it has left on work, not on ceilings (got ${first.dispatched} children)`,
  );
  assert(
    (first.outcome?.reason ?? "").includes(`after ${String(MAX_BUILD_ATTEMPTS)} build attempts`),
    `(r) the verdict the cap ends names the dispatches it spent (got ${first.outcome?.reason})`,
  );
  assert(
    first.headAfter !== first.headBefore,
    "(r) the stopped children were folded, so no paid-for work is left uncommitted",
  );
  // The walk's other half, through the table: leaving build on that budget
  // verdict bills nothing, so the run arrives at its gate with two rounds spent
  // and the third still unwon — the third build the field run never got.
  const walk = { state: "build" as LeanState, counters: { ...INITIAL_COUNTERS } };
  for (const kind of ["ok", "new-tests"] as const) {
    const moved = next({ ...runProbe(walk.state), counters: walk.counters }, { kind });
    walk.state = moved.state;
    walk.counters = moved.counters;
  }
  assert(
    walk.state === "build" && walk.counters.buildAttempts === 1,
    `(r) the challenge's new tests earned the second build and billed the one round it dispatched (got ${walk.state}/${walk.counters.buildAttempts})`,
  );
  const stopped = next({ ...runProbe("build"), counters: walk.counters }, { kind: "budget" });
  assert(
    stopped.state === "verify" && stopped.counters.buildAttempts === 1,
    `(r) a ceiling-stopped build leaves its gate billing nothing (got ${stopped.state}/${stopped.counters.buildAttempts})`,
  );
  const third = next({ ...runProbe("verify"), counters: stopped.counters }, { kind: "red" });
  assert(
    third.state === "build" && third.counters.buildAttempts === 2,
    `(r) and the red from that gate still earns the THIRD build (got ${third.state}/${third.counters.buildAttempts})`,
  );
}

// ── (f) the ci:red fix round: entered AT the cap, one child, no in-step retry ─
//
// The other side of the same coin as (r). A CI fix round is the one build the
// table enters with its dispatch budget ALREADY spent: three real rounds plus
// the fix round itself — which no dispatch bought — leave `buildAttempts` at 4,
// one past the cap. Read as `dispatchedBefore + tries + 1 >= cap`, that entry
// still reads as room for a retry, and a ceiling-stopped fix round buys children
// the run has no rounds left to pay for. The rule the loop obeys is the
// dispatches-spent-so-far comparison, so this visit runs its one child, folds it,
// and leaves.
{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  const breach = (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 });
  const built = buildFixture(152);
  // The counter the ci:red edge really hands a fix round — derived through the
  // table rather than typed as a literal: three dispatched rounds, then the CI
  // fix round itself, which no dispatch bought.
  const ciFix = next(
    {
      ...runProbe("verify"),
      counters: { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS },
    },
    { kind: "red" },
  );
  const walked = next({ ...runProbe("ci"), counters: ciFix.counters }, { kind: "red" });
  assert(
    walked.state === "build" && walked.counters.buildAttempts === MAX_BUILD_ATTEMPTS + 1,
    `(f) the table hands a ci fix round one round past the cap (got ${walked.state}/${walked.counters.buildAttempts})`,
  );
  // Written as properties of the fixture's own counters object, the way (r) does
  // it: `runBuild` re-points `run.steps` when it wires the fixture, so a
  // wholesale replace of `run.counters` on the stale copy the case holds is the
  // one edit the step never reads.
  built.ctx.run.counters.buildAttempts = walked.counters.buildAttempts;
  built.ctx.run.counters.ciFixUsed = walked.counters.ciFixUsed;
  const fix = await runBuild({
    issue: 152,
    built,
    config: cfg,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    onProgressTick: breach,
  });
  assert(
    fix.threw === undefined,
    `(f) the fix round does not throw: ${fix.threw?.message ?? "clean"}`,
  );
  assert(
    fix.outcome?.kind === "budget",
    `(f) the stopped fix round reports its budget verdict (got ${fix.outcome?.kind ?? fix.threw?.message})`,
  );
  assert(
    fix.dispatched === 1,
    `(f) a budget-stopped child on a visit entered with buildAttempts at the cap dispatches exactly 1 child (got ${fix.dispatched})`,
  );
  assert(
    (fix.outcome?.dispatches ?? []).length === 1,
    `(f) and bills exactly the one child it ran (got ${(fix.outcome?.dispatches ?? []).length})`,
  );
  // The number the handback prints is the dispatches the run has PAID FOR: the
  // three the table billed before this visit, plus the fix round this visit is.
  // Deriving it from the walk's counter rather than typing it keeps the assertion
  // the table's answer, not the case's guess about the cap.
  assert(
    (fix.outcome?.reason ?? "").includes(
      `after ${String(walked.counters.buildAttempts + 1)} build attempts`,
    ),
    `(f) the verdict counts the round this visit is running among the dispatches spent (got ${fix.outcome?.reason})`,
  );
  assert(
    fix.headAfter !== fix.headBefore,
    "(f) the fix round's work is still folded, so a paid-for child is not thrown away",
  );
  assert(
    status(fix.worktree) === "",
    `(f) and the tree is clean for ci to re-check (got ${status(fix.worktree)})`,
  );
}

// ── (g) the in-step retry bound is ONE ROUND BELOW THE CAP ────────────────
//
// (f) pins the visit entered one past the cap; (r) pins a visit entered at one
// round spent. Neither discriminates the `- 1` in the loop's own bound: at
// `buildAttempts` 4 a rule of `cap - dispatchedBefore` clamps to 0 all the same.
// The round this visit is running is the one the `- 1` pays for, and the visit
// that shows it is the one entered one round SHORT of the cap — where the
// pre-fix rule still sees room for a retry and buys a child the run has no
// round left to pay for. So walk the table to the LAST round it can bill
// (`MAX_BUILD_ATTEMPTS - 1`), then compare what this visit buys there against
// what it buys one round earlier.
{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  // The shortest walk the table allows to the run's LAST billable build: the
  // first build goes `ok` into the one challenge round the run gets, the second
  // `ok` is capped so it goes straight to its gate, and the red there buys the
  // third — the round `buildAttempts` reads `MAX_BUILD_ATTEMPTS - 1` entering.
  // Derived through `next` rather than typed, the way (f) does.
  const walk = [
    { state: "build" as LeanState, kind: "ok" },
    { state: "challenge" as LeanState, kind: "new-tests" },
    { state: "build" as LeanState, kind: "ok" },
    { state: "verify" as LeanState, kind: "red" },
  ];
  let last = { state: "build" as LeanState, counters: { ...INITIAL_COUNTERS } };
  for (const step of walk) {
    const moved = next({ ...runProbe(step.state), counters: last.counters }, { kind: step.kind });
    last = { state: moved.state, counters: moved.counters };
  }
  assert(
    last.state === "build" && last.counters.buildAttempts === MAX_BUILD_ATTEMPTS - 1,
    `(g) the table's last billable build enters one round short of the cap (got ${last.state}/${last.counters.buildAttempts})`,
  );
  const stoppedAt = async (counters: RunCounters, issue: number) => {
    const built = buildFixture(issue);
    // Property-by-property, as (f) does: `runBuild` re-points `run.steps` when it
    // wires the fixture, so replacing `run.counters` wholesale on the copy the
    // case holds is the one edit the step never reads.
    built.ctx.run.counters.buildAttempts = counters.buildAttempts;
    built.ctx.run.counters.ciFixUsed = counters.ciFixUsed;
    return runBuild({
      issue,
      built,
      config: cfg,
      child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
      onProgressTick: breachTurns(BUILD_TURNS),
    });
  };
  // Entered one round below the cap: the run has exactly one dispatch left to buy,
  // the round this visit is, so the ceiling-stopped child runs once, folds, leaves.
  const atCap = await stoppedAt(last.counters, 153);
  assert(
    atCap.threw === undefined,
    `(g) the last-round visit does not throw: ${atCap.threw?.message ?? "clean"}`,
  );
  assert(
    atCap.outcome?.kind === "budget",
    `(g) and still reports its budget verdict (got ${atCap.outcome?.kind ?? atCap.threw?.message})`,
  );
  assert(
    atCap.dispatched === Math.max(1, MAX_BUILD_ATTEMPTS - (MAX_BUILD_ATTEMPTS - 1)),
    `(g) a ceiling stop on a visit entered at the cap less one dispatches NO in-step retry (got ${atCap.dispatched})`,
  );
  assert(
    (atCap.outcome?.dispatches ?? []).length === atCap.dispatched,
    `(g) and bills exactly the children it ran (got ${(atCap.outcome?.dispatches ?? []).length})`,
  );
  assert(
    atCap.headAfter !== atCap.headBefore,
    "(g) the last round's work is still folded, so a paid-for child is not thrown away",
  );
  // One round earlier the SAME ceiling buys the child that round pays for: the
  // pair is what makes the bound discriminating rather than merely true.
  const oneBeforeCap = await stoppedAt({ ...INITIAL_COUNTERS, buildAttempts: 1 }, 154);
  assert(
    oneBeforeCap.dispatched === Math.max(1, MAX_BUILD_ATTEMPTS - 1),
    `(g) the same ceiling one round earlier DOES retry in-step (got ${oneBeforeCap.dispatched})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
