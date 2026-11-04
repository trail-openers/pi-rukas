#!/usr/bin/env bun
/**
 * lean/step-budget — a turns ceiling reaches the SPAWN, not only the abort.
 *
 * Lean enforced turns through an `AbortController` alone, so the #1991
 * budget-progress steer had no denominator and never fired. A real fix wave
 * worked 401 turns against a 400-turn ceiling and was killed with nothing
 * committed: the child was never told where it stood, so it never had the
 * chance to commit what it had done. The abort is the kill and stays as it is;
 * what was missing is `budgetTurns`, the value the steer counts down.
 *
 * Asserted on the arms `armBudget` hands its dispatch seam, so this file is red
 * on the one spawn option that was missing and green on nothing else.
 */

import { fixPrompt } from "../src/lean/review-deps.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// The ceiling the headless proof run died at, so the number under test is the
// one a real child was killed by rather than an invented one.
const REVIEW_TURNS = 400;
{
  const b = armBudget({ turns: REVIEW_TURNS, tokens: 0, minutes: 0 });
  assert(
    b.opts.budgetTurns === REVIEW_TURNS,
    `(1) the step's turns ceiling travels as its own spawn option (got ${String(b.opts.budgetTurns)})`,
  );
  assert(
    b.opts.signal !== undefined && b.opts.onProgress !== undefined,
    "(1) and the abort arm that actually ends the child is still there",
  );
}

// A turns lever the child cannot count down to must not be set: `armChildBounds`
// reads `<= 0` as no lever, and a 0 denominator steers a bogus "turn 3 of 0".
{
  assert(
    armBudget({ turns: 0, tokens: 1000, minutes: 0 }).opts.budgetTurns === undefined,
    "(2) a tokens-only budget sets no turns lever",
  );
  assert(
    armBudget({ turns: 0, tokens: 0, minutes: 20 }).opts.budgetTurns === undefined,
    "(2) nor does a minutes-only one, whose lever the run bound already paces",
  );
  assert(
    armBudget(undefined).opts.budgetTurns === undefined,
    "(2) and a state with no budget at all sets none",
  );
}

// (3) The ORDER of the work, and what a wave that runs out of budget keeps.
// The headless proof run's fixer worked 401 turns against a 400-turn ceiling,
// committed nothing, and was aborted: every fix it had made was lost. Its brief
// said only "commit what you changed" — at the END, with no order of work and no
// way to set aside a finding it cannot close inside the diff. Pinned on the
// rendered brief because the child only ever sees this string.
{
  const brief = fixPrompt({
    issue: 7,
    wave: "full" as const,
    gate: "six-lens review (ISSUES_FOUND)",
    findings: "- [CRITICAL] SECURITY a.ts:1: leak\n- [HIGH] SIMPLICITY b.ts:2: dead branch",
    worktree: "/repo/.worktrees/lean-7-fix-l-1-0-1793451347919",
    repoRoot: "/repo",
    branch: "lean/issue-7",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234568",
    frozenPaths: ["tests/AC1.test.ts"],
    budget: { opts: {}, fired: () => undefined },
    stop: {},
  });
  assert(
    /highest severity first/i.test(brief),
    `(3) the brief orders the wave: highest severity first (looked for that phrase in the "What to do" section)`,
  );
  assert(
    /commit each fix as you finish it/i.test(brief) && /keeps only what it committed/i.test(brief),
    "(3) it says commit each fix as it lands, and says WHY: a wave that runs out of budget keeps only what it committed",
  );
  assert(
    /run(s|ing)? out/i.test(brief) && /budget/i.test(brief),
    "(3) the budget itself is named to the child, which is what makes the instruction act on a turn-bound kill",
  );
  assert(
    /name it in your reply and move on/i.test(brief) && /Untouchable/.test(brief),
    "(3) an Untouchable-file or out-of-diff closure is named and skipped, not chased",
  );
}

process.exit(failures());
