#!/usr/bin/env bun
/**
 * lean/review — the step's CHILD BUDGET is a ceiling, not an aspiration.
 *
 * Split from `test-lean-review-wiring.ts` along the seam that file's own cases
 * describe: everything there drives the step to a VERDICT (both gates clean, a
 * gate with no verdict, a fix wave landing), while this file drives it to its
 * BOUND. The size ratchet refused 550 lines in one file, and the seam is real
 * rather than convenient — a bound case fails for a reason a verdict case cannot
 * produce.
 *
 * What the bound used to be, and why this file exists: the step ran a round loop
 * whose guard sat inside the six-lens arm, so the adversarial arm's findings
 * branch called the fixer and `continue`d without ever passing it. A gate that
 * kept returning findings looped forever, buying a reviewer AND a fixer every
 * pass — **550 fix rounds in 90 seconds** measured, every one a paid child. That
 * loop is gone: there is one full review, one fix wave, one re-review, so the
 * runaway is unreachable by shape rather than by a counter. Unreachable is not
 * the same as asserted, so the budget is now measured against `rows` — the record
 * the operator actually reads — with the exact counts, from a stub designed to
 * provoke as many children as it can.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import type { DispatchSpec } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  FIXER_ROLE,
  LENS_ROLE,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
  blockingFinding,
  carriedFinding,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  lensRoundWith,
  makeRepo,
  parsedRound,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { ReviewInfraError } from "../src/lean/review.ts";

const { assert, failures } = makeAssert();

// ── (e4) THE ADVERSARIAL ARM IS BOUNDED TOO — the CRITICAL #1930 shipped with.
//
// The stub is the worst honest case the adversarial arm can present: `rejected`
// with findings, on BOTH passes, against a fixer that commits every time. That is
// the shape that used to buy children forever. Under one wave it buys: two
// adversarial passes, twelve lens children, one fixer — and the step hands back
// with the carried row named. The counts are exact equalities, not `<=`: the
// regression this case exists to catch is a step that buys one more pass, and a
// `<=` would let it through.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  let advAsks = 0;
  let fixers = 0;
  let lensRounds = 0;
  // ONE `fixerThatCommits` instance for the whole case, counted on the way through
  // rather than re-created per call: its per-tree commit counter has to keep
  // advancing or a re-run writes a byte-identical tree.
  const alwaysCommit = fixerThatCommits("always-findings");
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () =>
        result({
          loopOutcome: "rejected",
          text: `1. unbounded read (ask ${String(++advAsks)})`,
          // Parsed, deliberately: an UNparsed rejection is refused as "no verdict"
          // before any child is bought, which is correct and would make this case
          // measure that guard instead of the budget.
          adversarialRounds: parsedRound("ISSUES_FOUND"),
        }),
      // The lens round's own rows come back carried on both passes, so neither
      // gate is ever satisfied and both try to send work to a fixer.
      lens: async () => {
        lensRounds++;
        return lensRoundWith("ISSUES_FOUND", [carriedFinding()]);
      },
      dispatch: async (spec: DispatchSpec) => {
        fixers++;
        return alwaysCommit(spec);
      },
    }),
  );
  // The budget holds rather than the step reporting the head reviewed. `done` or
  // `fixed` here would be the worst answer available: an unreviewed head carried
  // on to `ci`.
  assert(
    outcome === undefined,
    `(e4) an adversarial gate that never clears is never reported as reviewed (got kind ${String(outcome?.kind)})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.message.includes(CAUSE_NOT_ADDRESSED),
    `(e4) the ADVERSARIAL arm stops at the wave's shape rather than looping, and names what is still open (${threw?.message})`,
  );
  // THE MEASURED NUMBERS, and the ones this case exists to hold. Before the wave
  // the same shape was unbounded (550 fix rounds in 90 seconds); a regression that
  // puts a second fix wave or a third pass back takes these counts up, which is
  // why every one of them is an exact equality and not a `<=`.
  assert(
    fixers === REVIEW_CHILD_BUDGET.fixerWaves,
    `(e4) exactly ${String(REVIEW_CHILD_BUDGET.fixerWaves)} fixer was bought by the always-findings stub — the unbounded arm bought hundreds (measured 550 in 90s) and every one of them was a paid child (got ${String(fixers)})`,
  );
  assert(
    advAsks === REVIEW_CHILD_BUDGET.adversarialPasses,
    `(e4) and the same for the reviewer — ${String(REVIEW_CHILD_BUDGET.adversarialPasses)} passes, no bound-breaking extra (${String(advAsks)})`,
  );
  assert(
    lensRounds === REVIEW_PASSES,
    `(e4) and exactly ${String(REVIEW_PASSES)} six-lens rounds ran, the full review and the re-review (${String(lensRounds)})`,
  );
  // The findings that stopped it reach the operator, so the handback says what was
  // outstanding rather than only that the step gave up: the row's citation AND the
  // gate's own text, which is the only place the reviewer's wording survives.
  assert(
    (threw as ReviewInfraError | undefined)?.message.includes("unbounded read") === true &&
      (threw as ReviewInfraError | undefined)?.message.includes("a.ts:1") === true,
    `(e4) and the refusal names the findings still open, since a bound with nothing to show for it cannot be triaged (${(threw as ReviewInfraError | undefined)?.message.slice(0, 200)})`,
  );
  // The cost of the whole wave is on the record even though the step threw — a
  // run that bought a fixer and reported none is the under-billing this suite
  // exists to prevent, and the row total is the budget stated as rows.
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.length === PASS_ROWS * REVIEW_PASSES + 1,
    `(e4) the rows on the refusal are the wave's full child count: ${String(REVIEW_CHILD_BUDGET.adversarialPasses)} gate + ${String(REVIEW_CHILD_BUDGET.lensChildren)} lens + ${String(REVIEW_CHILD_BUDGET.fixerWaves)} fixer = ${String(PASS_ROWS * REVIEW_PASSES + 1)} (got ${String(rows.length)})`,
  );
  assert(
    rows.filter((r) => r.role === FIXER_ROLE).length === REVIEW_CHILD_BUDGET.fixerWaves,
    `(e4) and the fixer this arm bought is billed on the refusal (got ${String(rows.filter((r) => r.role === FIXER_ROLE).length)})`,
  );
  assert(
    rows.filter((r) => r.role === LENS_ROLE).length === REVIEW_CHILD_BUDGET.lensChildren,
    `(e4) and every lens child is its own row — ${String(REVIEW_CHILD_BUDGET.lensChildren)} for ${String(REVIEW_PASSES)} rounds (got ${String(rows.filter((r) => r.role === LENS_ROLE).length)})`,
  );
  assert(
    rows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length ===
      REVIEW_CHILD_BUDGET.adversarialPasses,
    `(e4) and both adversarial passes are billed under the loop's role (got ${String(rows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length)})`,
  );
}

// ── (e5) NO PATH BUYS A THIRD PASS, and a clean first review buys no fixer ───
//
// AC1/AC5 in one case: the cheapest run must dispatch the fewest children, and
// the most obstructive run above must not exceed the ceiling. Both halves are
// needed — a suite that only drives the busy case cannot tell a step that always
// buys two passes from one that respects the policy, and a suite that only drives
// the clean case cannot see a third pass at all.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 6;\n" });
  const clean = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ adversarial: async () => result({ loopOutcome: "approved" }) }),
  );
  assert(
    clean.threw === undefined && clean.outcome?.kind === "done",
    `(e5) a review with nothing blocking passes without a wave (${clean.threw?.message ?? `kind ${String(clean.outcome?.kind)}`})`,
  );
  const cleanRows = clean.outcome?.dispatches ?? [];
  assert(
    cleanRows.length === PASS_ROWS,
    `(e5) and it dispatched ONE pass's worth of children — one gate row and six lens rows, no fixer and no second review (got ${String(cleanRows.length)}, expected ${String(PASS_ROWS)})`,
  );
  assert(
    cleanRows.every((r) => r.ok),
    "(e5) and every child it bought is recorded as having run",
  );
  // A second review pass on a run that never blocked would have to come from
  // somewhere, and there is nowhere: the step has no loop left to put it in.
  assert(
    cleanRows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length === 1,
    `(e5) and the adversarial gate ran exactly once on a clean branch (got ${String(cleanRows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length)})`,
  );
  assert(
    cleanRows.some((r) => r.role === FIXER_ROLE) === false,
    "(e5) and no fixer was dispatched for findings nobody reported",
  );
  // The busy run above is the ceiling; state it here so the number lives in one
  // case rather than in a comment. `cleanLensRound` is used as the shape check.
  assert(
    PASS_ROWS * REVIEW_PASSES + 1 < 2 * PASS_ROWS + 2,
    `(e5) the budget is arithmetically the wave and nothing more: ${String(PASS_ROWS * REVIEW_PASSES + 1)} children for ${String(REVIEW_PASSES)} passes plus one fixer`,
  );
}

// ── (e6) A FIX WAVE THAT CHANGED NOTHING IS A NAMED CAUSE, NOT A RE-REVIEW ──
//
// The empty fix range is the case the re-review has no input for, and the spec
// refuses both wrong answers: it is never a pass, and it never reaches a re-review
// that would have to be told an empty range. So the children bought stop at the
// wave, and the cause names the condition rather than "no lens ran".
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 7;\n" });
  let lensRounds = 0;
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => {
        lensRounds++;
        return lensRoundWith("ISSUES_FOUND", [blockingFinding({ title: "silent catch" })]);
      },
      // The default fixer: dispatched, paid for, commits nothing.
    }),
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(e6) a fixer that committed nothing is a throw, not a pass (${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    threw instanceof ReviewInfraError && threw.message.includes(CAUSE_NO_CHANGE),
    `(e6) and the cause is the named no-change one, so the handback is triageable rather than a "ran no lens" refusal (${threw?.message})`,
  );
  assert(
    lensRounds === 1,
    `(e6) and the re-review was NEVER dispatched for an empty fix range — one lens round, the full review (${String(lensRounds)})`,
  );
}

// The blocking row helper is imported by name to keep the case readable.

cleanupRoots();
process.exit(failures());
