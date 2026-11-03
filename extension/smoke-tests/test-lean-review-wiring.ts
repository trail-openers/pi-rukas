#!/usr/bin/env bun
/**
 * lean/review — the step's own contract, driven with both gates and the fixer
 * stubbed and a real temp git repo behind them.
 *
 * The step makes four claims worth testing rather than reading, and each is a
 * claim a stub of the gates CANNOT fake on its own — so the repo, the branch and
 * the commits are real, and only the models are stubs:
 *
 *   (a) `done` only when BOTH gates clear, and the reason names the commit;
 *   (b) a gate that produced no verdict is never a pass (the loop's `infra`
 *       arm, the lens round's `REVIEW_INCOMPLETE`);
 *   (c) a fix round's commit lands on the run's branch and on origin, and the
 *       next round reviews THAT and not the previous head;
 *   (d) the frozen contract survives: a fixer that committed a change to a
 *       frozen test is refused, and the run's worktree is put back where the
 *       gates read it.
 *
 * Plus the deterministic preconditions, which all run before a single child is
 * paid: an unreadable origin, a run with no base, and a budget too small to pay
 * for a round are all refusals, never a `done`.
 *
 * The gates and the fixer are the three injected seams of `ReviewDeps`, so no
 * child process is spawned and no token is spent.
 *
 * The two cases that pin ABSENCE OF SIGNAL — a lens round that ran no lens, and
 * the evidence helpers reading a ref that cannot exist — live in
 * `test-lean-review-absence.ts`, which shares this file's repo harness through
 * `lib/lean-review-fixtures.ts`.
 */

import path from "node:path";
import { DEFAULT_BUDGETS, defaultConfig } from "../src/lean/config.ts";
import { FIX_RUN_ID_SHAPE, prNumberFromLog } from "../src/lean/review-log.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  CAUSE_NEW_CRITICAL,
  CAUSE_NOT_ADDRESSED,
  DISPATCHES_MAX_ROWS,
  type DispatchUsageRow,
  FIXER_ROLE,
  LENS_ROLE,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
  type ReviewDeps,
  blockingFinding,
  blockingReject,
  carriedFinding,
  carriedLensRound,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  frozenBlob,
  git,
  lensRoundFor,
  lensRoundWith,
  lensRowResult,
  makeRepo,
  result,
  runStep as run,
  passed,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (a) both gates clean → `done`, and the reason names the reviewed commit ──
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const seen: string[] = [];
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async (a) => {
        seen.push(`adv:${a.head}`);
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        seen.push(`lens:${a.head}`);
        // The production shape of a clean round: six lenses ran, so the round
        // reports their usage. A round with `usage: undefined` is a round that
        // ran nobody, and the step refuses it (`test-lean-review-absence.ts`).
        return cleanLensRound();
      },
    }),
  );
  assert(threw === undefined, `(a) a clean run does not throw (${threw?.message})`);
  assert(outcome?.kind === "done", `(a) both gates clean with no fix round is "done" (got ${outcome?.kind})`);
  assert(
    (outcome?.reason ?? "").includes(head.slice(0, 12)),
    `(a) the reason names the commit the gates read`,
  );
  assert(
    seen.length === 2 && seen[0] === `adv:${head}` && seen[1] === `lens:${head}`,
    `(a) both gates reviewed the SAME commit (${seen.join(", ")})`,
  );
  // The adversarial pass is one row; the six-lens round is now SIX, one per
  // child that ran (see `lensRows`) — a single synthetic row for the round was
  // the defect, because it priced every lens review at one child's cost.
  assert(
    (outcome?.dispatches ?? []).length === 7 && (outcome?.dispatches ?? []).every((r) => r.ok),
    `(a) every child of both gate rounds is recorded as its own cost row (got ${String((outcome?.dispatches ?? []).length)})`,
  );
  // H5, and the regression the synthetic row hid. The six lens rows must carry
  // six DIFFERENT durations: one row per child with a shared `ms` is exactly the
  // shape a folded round fakes, and a fold that dropped five children would still
  // satisfy a count-only assertion.
  const lensMs = (outcome?.dispatches ?? []).filter((r) => r.role === LENS_ROLE).map((r) => r.ms);
  assert(
    lensMs.length === 6 && new Set(lensMs).size === 6 && lensMs.every((m) => m > 0),
    `(a) the six lens rows carry six DISTINCT non-zero durations — a synthetic row collapsed to one timing is visible here, not only in the count (${JSON.stringify(lensMs)})`,
  );
  // H5: the gate's row is attributed to the role the LOOP reports. The frozen
  // driver records its adversarial dispatches the same way, which is what makes
  // lean's `byRole` column comparable to the driver's at all.
  assert(
    (outcome?.dispatches ?? []).some((r) => r.role === ADVERSARIAL_GATE_ROLE),
    `(a) the adversarial gate's row carries the loop's own synthesised role, so lean's byRole cost column lines up with the frozen driver's (got ${JSON.stringify((outcome?.dispatches ?? []).map((r) => r.role))})`,
  );
}

// ── (b) a gate with no verdict is not a pass ────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ adversarial: async () => result({ loopOutcome: "infra-failure" }) }),
  );
  assert(
    threw instanceof ReviewInfraError && /no verdict/.test(threw.message),
    `(b1) an adversarial pass with no verdict throws rather than passing (${threw?.message})`,
  );
  const { threw: t2 } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      lens: async () => ({ ...cleanLensRound(), verdict: "REVIEW_INCOMPLETE", findings: "x" }),
    }),
  );
  assert(
    t2 instanceof ReviewInfraError && /did not complete/.test(t2.message),
    `(b2) an incomplete lens round throws rather than being fixed against (${t2?.message})`,
  );

}

// ── (c) a fix round lands on the branch, and the next round reviews THAT ─────
{
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const reviewed: string[] = [];
  const seen2: string[] = [];
  const ctx = ctxFor(repoRoot, baseSha, BRANCH);
  const { outcome, threw } = await run(
    ctx,
    depsWith({
      adversarial: async (a) => {
        reviewed.push(`adv:${a.head}`);
        // Findings on round 1, clean on round 2: the step must re-review what
        // its own fixer produced and not certify the round-1 head twice.
        if (reviewed.length === 1)
          return blockingReject("1. silent catch");
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        reviewed.push(`lens:${a.head}`);
        // The re-review must not re-report the row the wave was asked to answer,
        // or the step reads its own finding back as NOT ADDRESSED (which is the
        // right behaviour, and the wrong thing for this case to measure). It does
        // stamp the range the step handed it — an un-stamped re-review is refused
        // as a verdict on some other diff.
        return lensRoundFor(a, "APPROVED", []);
      },
      dispatch: async (spec: DispatchSpec) => {
        // The fixer's own work, made where the step sent it.
        put(spec.cwd ?? "", "fix.ts", "export const fixed = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(c) a fix round does not throw (${threw?.message})`);
  // Exactly `fixed`, not `passed()`: this case proves below that origin's branch
  // moved, and the table routes a moved head to `verify` ONLY on `fixed` — a
  // `done` here would send the run to `ci` over a head its newest verify does not
  // describe. `passed()` accepts both kinds and would not tell them apart.
  assert(
    outcome?.kind === "fixed",
    `(c) the run PASSES on the kind a fix round earns — fixed, so the table re-verifies (got ${String(outcome?.kind)})`,
  );
  const branchHead = git(repoRoot, "rev-parse", `origin/${BRANCH}`);
  assert(branchHead !== head, "(c) origin's branch moved: the fixer's commit is on it");
  assert(
    git(repoRoot, "log", "--format=%s", `origin/${BRANCH}`).includes("fix: the finding"),
    "(c) the fixer's commit is on origin's branch, not just in its disposable tree",
  );
  assert(
    reviewed[1] !== `adv:${head}`,
    `(c) round 2's reviewer read the FIXED head, not round 1's (${reviewed.join(", ")})`,
  );
  assert(
    git(repoRoot, "merge-base", "--is-ancestor", head, branchHead) === "",
    "(c) the pushed head descends from the reviewed head (git's own ancestry claim held)",
  );

  // (c2) THE SAME RUN, WITH THE FROZEN RECORD PRESENT. `integrate` proves every
  // frozen blob at the fixer's head still hashes to its record before it pushes.
  // That proof is a `git show` re-hashed against a sha256; a probe reading an
  // OBJECT ID instead (`rev-parse <ref>:<path>`) matches nothing at all, so it
  // would refuse every fix round that ever committed — in the one place the step
  // claims to enforce the contract. A run that froze nothing cannot catch that:
  // `frozen` is empty and the comparison never runs. So this is (c) again with
  // the map the fixture's own base commit hashes to, and asserts the half (d)
  // cannot: a legitimate fix still lands.
  const frozenNow = { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, "HEAD")) };
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "ok", frozen: frozenNow, tests: { AC1: ["tests/AC1.test.ts"] } },
  });
  const second = await run(
    ctx,
    depsWith({
      adversarial: async () => {
        seen2.push("x");
        if (seen2.length === 1) return blockingReject("1. leak");
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => lensRoundFor(a, "APPROVED", []),
      dispatch: async (spec: DispatchSpec) => {
        put(spec.cwd as string, "second-fix.ts", "export const s = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the second finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    second.threw === undefined && second.outcome?.kind === "fixed",
    `(c2) a fix round touching ONLY unfrozen files passes the frozen proof — the probe hashes bytes, not an object id (${second.threw?.message ?? `kind ${String(second.outcome?.kind)}`})`,
  );
  assert(
    git(repoRoot, "log", "--format=%s", `origin/${BRANCH}`).includes("fix: the second finding"),
    "(c2) and its commit is on origin — the proof did not refuse a legitimate fix",
  );
}


// ── the preconditions, all paid for before any child is ─────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  let dispatched = 0;
  const counting = depsWith({
    adversarial: async () => {
      dispatched++;
      return result({ loopOutcome: "approved" });
    },
    lens: async () => {
      dispatched++;
      return cleanLensRound();
    },
  });
  const { threw } = await run(ctxFor(repoRoot, baseSha, "lean/issue-7-never-pushed"), counting);
  assert(
    threw instanceof ReviewInfraError && /lean\/issue-7-never-pushed/.test(threw.message),
    `(e1) a branch origin does not have is a refusal, never an empty-diff approval (${threw?.message})`,
  );
  assert(dispatched === 0, "(e1) no child was paid for a review that could not run");

  const noBase = ctxFor(repoRoot, "", BRANCH);
  const { threw: t2 } = await run(noBase, counting);
  assert(
    t2 instanceof ReviewInfraError && /no base commit/.test(t2.message),
    `(e2) a run with no base is refused before a gate runs (${t2?.message})`,
  );

  // (e3) THE BUDGETS ARE MONEY AND ROUNDS RESPECTIVELY — at the shipped default.
  //
  // The step used to derive its round cap from `budgets.review.turns`
  // (`max(1, floor(turns / 300))` = 1), which gave the shipped default a step
  // whose whole job is "fix, then RE-review" a single round. That derivation, and
  // the round loop it bounded, are both gone: the shape of the wave is
  // `REVIEW_CHILD_BUDGET` and the budget is only money. What this case pins now
  // is the pair of facts that survived the deletion, asserted at the SHIPPED
  // default rather than a fixture-chosen budget: the default pays for the whole
  // wave (both gate passes, twelve lens children, one fixer), and a wave that
  // cannot clear is a refusal that carries its rows clipped to the validator's
  // own cap.
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  let e3LensRounds = 0;
  let e3AdvPasses = 0;
  let e3Fixers = 0;
  const atDefaultBudget = depsWith({
    adversarial: async () => {
      e3AdvPasses++;
      return blockingReject("1. the carried row the wave must answer");
    },
    // The same blocking row both times. `carried: true` is what the review layer
    // puts on an open row its round did not resolve, and it is the ONLY thing the
    // step reads for NOT ADDRESSED — so the fixture states the layer's fate
    // rather than hoping the step guesses it from a re-appearing row. The re-review
    // stamps its range, or the step refuses the round before it can hand back.
    lens: async (a) => {
      e3LensRounds++;
      return a.wave === "fix"
        ? carriedLensRound(a, [blockingFinding()])
        : lensRoundWith("ISSUES_FOUND", [carriedFinding()]);
    },
    dispatch: async (spec: DispatchSpec) => {
      e3Fixers++;
      return fixerThatCommits("e3")(spec);
    },
  });
  const { threw: t3, outcome: o3 } = await run(ctxFor(repoRoot, baseSha, BRANCH), atDefaultBudget);
  assert(
    t3 instanceof ReviewInfraError && t3.message.includes(CAUSE_NOT_ADDRESSED),
    `(e3) at the SHIPPED ${String(DEFAULT_BUDGETS.review?.turns)}-turn default the wave runs and the carried row hands back with the named cause — the budget is money, the wave is the shape (${t3?.message ?? `got ${String(o3?.kind)}`})`,
  );
  assert(
    e3LensRounds === REVIEW_PASSES && e3AdvPasses === REVIEW_CHILD_BUDGET.adversarialPasses,
    `(e3) and it really paid for both passes — ${String(REVIEW_PASSES)} lens rounds and ${String(REVIEW_CHILD_BUDGET.adversarialPasses)} adversarial passes, not one (${String(e3LensRounds)} lens, ${String(e3AdvPasses)} adv)`,
  );
  assert(
    e3Fixers === REVIEW_CHILD_BUDGET.fixerWaves,
    `(e3) and exactly ${String(REVIEW_CHILD_BUDGET.fixerWaves)} fixer ran — one wave, whatever the gates report (${String(e3Fixers)})`,
  );
  assert(
    (t3 as ReviewInfraError | undefined)?.dispatches.length ===
      PASS_ROWS * REVIEW_PASSES + 1,
    `(e3) the rows on the refusal are every child the wave bought, under the validator's cap of ${String(DISPATCHES_MAX_ROWS)}: 2 gate rows + 12 lens rows + 1 fixer (got ${String((t3 as ReviewInfraError | undefined)?.dispatches.length)})`,
  );
  const e3Rows = (t3 as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    e3Rows.filter((r) => r.role === LENS_ROLE).length === REVIEW_CHILD_BUDGET.lensChildren,
    `(e3) and all ${String(REVIEW_CHILD_BUDGET.lensChildren)} lens children are billed — one row each, so a round collapsed to a single row under-bills every lens review the run paid for (got ${String(e3Rows.filter((r) => r.role === LENS_ROLE).length)})`,
  );
  assert(
    e3Rows.some((r) => r.role === FIXER_ROLE),
    "(e3) and the fixer — the child that decided the step — is among them",
  );

  // (f) What a handback owes the operator is the cost of EVERY pass, not the one
  // that failed. A total re-derived per pass would report a two-pass run as a
  // one-pass one, and the next run would be bought on that lie. The wave's row
  // total now sits BELOW the loader's cap, so the clip is no longer reachable
  // here — and saying so is the assertion: a case that claimed to exercise the
  // clip while paying for 15 children would be declaring a test it never ran.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 4;\n" });
  const neverClears = depsWith({
    adversarial: async () => blockingReject("1. the carried row the wave must answer"),
    lens: async (a) => lensRoundFor(a, "ISSUES_FOUND", [carriedFinding()]),
    // The fixer commits, so the wave is not refused for fixing nothing, and each
    // carries its tree's `runId` — the field the resume path matches on.
    dispatch: fixerThatCommits("f"),
  });
  const { threw: t4 } = await run(ctxFor(rr2, bs2, BRANCH), neverClears);
  const paid = PASS_ROWS * REVIEW_PASSES + 1;
  assert(
    t4 instanceof ReviewInfraError && t4.message.includes(CAUSE_NOT_ADDRESSED),
    `(f) the wave runs both passes, then hands back with the named cause (${t4?.message})`,
  );
  assert(
    paid < DISPATCHES_MAX_ROWS,
    `(f) precondition made explicit: the wave pays for ${String(paid)} children, fewer than the ${String(DISPATCHES_MAX_ROWS)} the record may hold — so the clip is NOT exercised here and no assertion in this file may claim it is; cap behaviour lives in test-lean-review-consolidation.ts (w)`,
  );
  assert(
    (t4 as ReviewInfraError | undefined)?.dispatches.length === paid,
    `(f) and the handback records the whole wave, not just the pass that failed (got ${String((t4 as ReviewInfraError | undefined)?.dispatches.length)} of ${String(paid)})`,
  );
  const fRows = (t4 as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    fRows.filter((r) => r.role === LENS_ROLE).length === REVIEW_CHILD_BUDGET.lensChildren,
    `(f) the rows hold TWELVE lens rows — six per pass: a round collapsed to one row under-billed every lens review the run paid for (got ${String(fRows.filter((r) => r.role === LENS_ROLE).length)})`,
  );
  assert(
    fRows.filter((r) => r.role === LENS_ROLE).every((r) => r.ms > 0),
    "(f) and each carries the timing its own child reported, not a synthetic 0",
  );
  assert(
    fRows
      .filter((r) => r.role === LENS_ROLE)
      .map((r) => r.ms)
      .filter((m, i, a) => a.indexOf(m) === i).length >= 6,
    "(f) and those twelve timings are not one value repeated — six distinct child timings per pass survive",
  );
  assert(
    fRows.some((r) => r.role === FIXER_ROLE),
    "(f) the FIXER is billed too: a step whose cost report omits the round that did the work cannot be used to price the next run",
  );
  assert(
    fRows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length ===
      REVIEW_CHILD_BUDGET.adversarialPasses,
    `(f) both adversarial passes appear under the LOOP's role, the same role the frozen driver's events use — so the byRole columns are comparable (${JSON.stringify(fRows.map((r) => r.role))})`,
  );
  // T1 — the fixer row keeps its OWN duration and carries the tree id in its own
  // field. The row that used to smuggle the id through `ms` reported a 13-digit
  // "duration" for the step's most expensive child.
  const fixerRow = fRows.find((r) => r.role === FIXER_ROLE);
  assert(
    fixerRow !== undefined && fixerRow.ms >= 0 && fixerRow.ms < 1e12,
    `(T1) the fixer's \`ms\` is a duration again, not a 13-digit epoch (${String(fixerRow?.ms)})`,
  );
  assert(
    fixerRow?.runId !== undefined && FIX_RUN_ID_SHAPE.test(fixerRow.runId),
    `(T1) and the tree identity rides in \`runId\`, in the shape the validator accepts (${String(fixerRow?.runId)})`,
  );

  // (g) A budget that pays for nothing still gets a real look, and a head that
  // was not reviewed is never reported as reviewed.
  //
  // This case used to assert "one look, then refuses", reading the round cap off
  // `turns`. That derivation is gone, and so is the loop it bounded: the shape of
  // the wave is `REVIEW_CHILD_BUDGET`, the budget bounds the MONEY, so what this
  // case still has to prove is the two things that survived — a degenerate budget
  // does not skip the review, and it does not certify a head nobody looked at.
  // Asserting the old sentence would have pinned the bug.
  let gRound = 0;
  const { threw: t5 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      loadConfig: async () => ({
        ...defaultConfig(),
        budgets: { ...defaultConfig().budgets, review: { turns: 0, tokens: 0, minutes: 0 } },
      }),
      adversarial: async () => blockingReject("1. the row the wave must answer"),
      lens: async (a) => {
        gRound++;
        // The same row both passes (`title` cannot vary, or the re-review's row is
        // a different finding and the step has nothing to call NOT ADDRESSED).
        // The row is what fails the run, not the budget: a zero budget must not
        // turn into a head nobody looked at being certified.
        return a.wave === "fix"
          ? carriedLensRound(a, [blockingFinding()])
          : lensRoundWith("ISSUES_FOUND", [carriedFinding()]);
      },
      dispatch: fixerThatCommits("g"),
    }),
  );
  assert(
    gRound === REVIEW_PASSES,
    `(g) a zero review budget still pays for both lens passes — it does not silently skip the review (${String(gRound)} lens round(s) ran)`,
  );
  assert(
    t5 instanceof ReviewInfraError,
    `(g) and a head the review could not clear is an error, never a pass (${t5?.message ?? "no throw"})`,
  );
  assert(
    gRound <= REVIEW_PASSES,
    `(g) and the step is bounded by the wave's shape rather than a turn division, so it cannot run away on a zero budget (${String(gRound)} <= ${String(REVIEW_PASSES)})`,
  );
}

cleanupRoots();
process.exit(failures());
