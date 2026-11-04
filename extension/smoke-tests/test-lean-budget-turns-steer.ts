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
 * Asserted on the arms `armBudget` hands its dispatch seam, and on what
 * `reviewDeps().dispatch` — the seam the fixer is actually spawned through —
 * hands `spawnSpecialist`. The first half is red when the arms carry no turns
 * denominator; the second is red when the arms carry one and the spawn does not
 * receive it, which is the half that killed a real fixer at 401/400 turns.
 */

import { mock } from "bun:test";
import { fixPrompt, reviewDeps } from "../src/lean/review-deps.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// The ceiling the headless proof run died at, so the number under test is the
// one a real child was killed by rather than an invented one.
const REVIEW_TURNS = 400;
// The build, challenge and specify children ship the same 400-turn ceiling
// (`config.ts`), and it is the number the build child blew through in the field.
// The case passes the value in on its own arms, so a default drifting cannot make
// the assertion below vacuously true.
const BUILD_TURNS = REVIEW_TURNS;
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

// ── (4) THE ARMS REACH THE SPAWN, AT EVERY SEAM THAT NAMES THEM KEY BY KEY.
//
// `review-deps.ts`'s `dispatch` is the function that builds the fixer's spawn
// options, and `build` / `challenge` / `specify` each have their own that does
// the same for their child. All four name the arms ONE BY ONE rather than
// spreading them — which is precisely how a key goes missing: the arms carry
// `budgetTurns`, the seam never names it, the child is killed at its turns
// ceiling never told where it stood, and every assertion above stays green.
// `build`'s child is the other observed 401/400 overrun.
//
// `spawnSpecialist` is the only thing these seams call, so intercepting it reads
// what the CHILD was handed rather than what `armBudget` produced. One mock for
// the whole section: a second `mock.module` for the same specifier does not
// reliably replace the first, and the site tag on the spec is what keeps the
// four captures apart.
{
  const { buildDeps } = await import("../src/lean/build.ts");
  const { challengeDeps } = await import("../src/lean/challenge.ts");
  const { specifyDeps } = await import("../src/lean/command.ts");
  const seen: { site: string; o: Record<string, unknown> }[] = [];
  const spawnUrl = new URL("../src/spawn.ts", import.meta.url).href;
  mock.module(spawnUrl, () => ({
    spawnSpecialist: (spec: unknown, o: Record<string, unknown> = {}) => {
      seen.push({ site: String((spec as { prompt?: string }).prompt), o });
      return Promise.resolve({
        role: "developer",
        ok: true,
        text: "",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    },
    // `review-deps.ts` imports it from the same module the mock replaces.
    makeRunId: () => "test-run",
  }));
  const arms = armBudget({ turns: BUILD_TURNS, tokens: 0, minutes: 0 });
  const spec = { role: "developer", prompt: "p", cwd: "/wt" };
  // Arms in, spawn options out — the seam is the only thing between them.
  await buildDeps(false).dispatch({ ...spec, prompt: "build" }, { ...arms.opts });
  await challengeDeps(false).dispatch({ ...spec, prompt: "challenge" }, { ...arms.opts });
  await specifyDeps(false).dispatch({ ...spec, prompt: "specify" }, { ...arms.opts });
  await reviewDeps(false).dispatch({ ...spec, prompt: "fixer" }, { ...arms.opts });
  assert(
    seen.length === 4,
    `(4) precondition: the four seams each dispatched once (got ${String(seen.length)}, expected 4)`,
  );
  for (const site of ["build", "challenge", "specify", "fixer"]) {
    const captured = seen.find((s) => s.site === site)?.o;
    assert(
      captured?.budgetTurns === BUILD_TURNS,
      `(4) THE ARMS REACH THE SPAWN: the ${site} child's options carried budgetTurns ${String(BUILD_TURNS)} (captured ${String(captured?.budgetTurns)}) — the seam forwards the arms key by key, so a key it does not name is a key the child never has`,
    );
    assert(
      captured?.onProgress === arms.opts.onProgress,
      `(4) and the ${site} seam still forwards the hook that fires the abort, so this is the same arms object the child is bounded by and not one the case wrote`,
    );
  }
}

process.exit(failures());
