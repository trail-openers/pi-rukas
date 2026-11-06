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
import type { Step } from "../src/lean/state.ts";
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
    subject(first.worktree) === "build: attempt 1 for #140",
    `(n) the folded commit carries the attempt subject (got ${subject(first.worktree)})`,
  );
  assert(
    commitPaths(first.worktree).join() === "src/retry.ts",
    `(n) the folded commit holds the stopped child's file (got ${commitPaths(first.worktree).join(", ")})`,
  );
  assert(
    status(first.worktree) === "",
    `(n) the tree is clean after the fold, so the retry and verify can run (got ${status(first.worktree)})`,
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

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
