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
import { defaultConfig } from "../src/lean/config.ts";
import { FIX_RUN_ID_SHAPE, prNumberFromLog } from "../src/lean/review-log.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { DispatchSpec } from "../src/types.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  DISPATCHES_MAX_ROWS,
  type DispatchUsageRow,
  FIXER_ROLE,
  LENS_ROLE,
  MAX_REVIEW_ROUNDS,
  type ReviewDeps,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  frozenBlob,
  git,
  lensRowResult,
  makeRepo,
  result,
  runStep as run,
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
  assert(outcome?.kind === "done", `(a) both gates clean is "done" (got ${outcome?.kind})`);
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
          return result({ loopOutcome: "rejected", text: "1. silent catch" });
        return result({ loopOutcome: "approved" });
      },
      lens: async (a) => {
        reviewed.push(`lens:${a.head}`);
        return cleanLensRound();
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
  assert(
    outcome?.kind === "done",
    `(c) the run finishes once the re-review is clean (got ${outcome?.kind})`,
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
        if (seen2.length === 1) return result({ loopOutcome: "rejected", text: "1. leak" });
        return result({ loopOutcome: "approved" });
      },
      lens: async () => cleanLensRound(),
      dispatch: async (spec: DispatchSpec) => {
        put(spec.cwd as string, "second-fix.ts", "export const s = 1;\n");
        git(spec.cwd as string, "add", "-A");
        git(spec.cwd as string, "commit", "-q", "-m", "fix: the second finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(
    second.threw === undefined && second.outcome?.kind === "done",
    `(c2) a fix round touching ONLY unfrozen files passes the frozen proof — the probe hashes bytes, not an object id (${second.threw?.message ?? String(second.outcome?.kind)})`,
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

  // (e3) H3 — THE SHIPPED DEFAULT BUYS MORE THAN ONE ROUND.
  //
  // `budgets.review.turns` ships at 150 and the round bound used to be
  // `max(1, floor(turns / 300))` = 1, so the default configuration gave a step
  // whose whole purpose is "fix, then RE-review" a single round: it could fix and
  // then had to hand back a head its own fixer had moved without any gate having
  // looked at it again. The round bound is now `MAX_REVIEW_ROUNDS`, a constant;
  // the budget is money, not rounds. So driving the step at exactly the shipped
  // default must produce MORE than one round of work — and asserting on the
  // shipped default rather than a fixture-chosen 600 is the point: a fixture that
  // picked a generous budget could not tell a working loop from a one-round one.
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  let e3LensRounds = 0;
  const atDefaultBudget = depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    // Findings that CHANGE each round. A fixer that commits and a gate that
    // re-reports the identical text is a deterministic gate nobody can satisfy,
    // and the step now breaks that tie rather than buying the same reply again
    // (see `stagnantAgainstFix`) — which is the right behaviour and would make
    // this case measure the break instead of the bound. Varying the finding says
    // the gate is genuinely looking at a new head each round.
    lens: async () => {
      e3LensRounds++;
      return {
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND" as const,
        findings: `- [HIGH] SECURITY a.ts:1: leak (round ${String(e3LensRounds)})`,
      };
    },
    dispatch: fixerThatCommits("e3"),
  });
  const { threw: t3, outcome: o3 } = await run(ctxFor(repoRoot, baseSha, BRANCH), atDefaultBudget);
  assert(
    t3 instanceof ReviewInfraError &&
      /reached round 4 at the step's bound of 3 rounds/.test(t3.message),
    `(e3) at the SHIPPED 150-turn default the step runs all ${String(MAX_REVIEW_ROUNDS)} rounds and then refuses — the round bound is the constant, not the budget (${t3?.message ?? `got ${String(o3?.kind)}`})`,
  );
  assert(
    e3LensRounds === MAX_REVIEW_ROUNDS,
    `(e3) and it really paid for ${String(MAX_REVIEW_ROUNDS)} lens rounds rather than one (${String(e3LensRounds)})`,
  );
  assert(
    (t3 as ReviewInfraError | undefined)?.dispatches.length === DISPATCHES_MAX_ROWS,
    `(e3) the rows on the refusal are CLIPPED to the validator's own cap: this run paid for ${String(MAX_REVIEW_ROUNDS * 7 + (MAX_REVIEW_ROUNDS - 1))} children and the record may hold ${String(DISPATCHES_MAX_ROWS)}, so an unbounded handback would have been dropped by the loader whole (got ${String((t3 as ReviewInfraError | undefined)?.dispatches.length)})`,
  );
  // The clip is the point of the case, and a tail clip is only distinguishable
  // from a head slice when the roles differ between the two ends. What the clip
  // holds HERE is arithmetic: `MAX_REVIEW_ROUNDS` rounds x 7 gate children fill
  // the cap exactly, so the TAIL IS the WHOLE ARRAY and no role is excluded from
  // either end. Asserting "the first row is not a reviewer" against that was a
  // coincidence, not evidence — and it went red the moment the round bound moved
  // to the top of the loop body (where it belongs, and where it now covers the
  // adversarial arm too), because the bound stopped spending a round-4 reviewer
  // before refusing. The head/tail distinction is asserted WHERE ARITHMETIC ALLOWS
  // IT — in `(f)`, whose extra adversarial passes overfill the cap — rather than
  // restated where it is foreclosed.
  const e3Rows = (t3 as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    e3Rows.some((r) => r.role === FIXER_ROLE),
    "(e3) and the clip keeps the TAIL, so the last fixer — the child that decided the step — is among them",
  );
  assert(
    e3Rows.length === DISPATCHES_MAX_ROWS,
    `(e3) precondition made explicit: this run's rows EXACTLY fill the cap, so the clip is a no-op here and the case cannot tell head from tail — ${String(MAX_REVIEW_ROUNDS)} rounds x 7 gate children = ${String(MAX_REVIEW_ROUNDS * 7)} rows reach the refusal (the fixers are consumed within a round, before the bound trips) and the cap is ${String(DISPATCHES_MAX_ROWS)}; that is why the head/tail assertion lives in \`(f)\`, where the extra adversarial passes overfill it (got ${String(e3Rows.length)})`,
  );

  // (f) What a handback owes the operator is the cost of EVERY round, not the
  // one that failed. A total re-derived per round would report a two-round run
  // as a one-round one, and the next run would be bought on that lie. This run
  // pays for the FULL bound — more children than the row cap can record — so the
  // assertion below also drives the clip, which a 15-row run never reaches.
  const { repoRoot: rr2, baseSha: bs2 } = makeRepo();
  await setup({ repoRoot: rr2, baseSha: bs2, branch: BRANCH, feature: "export const f = 4;\n" });
  let fRound = 0;
  const neverClears = depsWith({
    adversarial: async () => result({ loopOutcome: "approved" }),
    // Varies per round: an identical text from a gate that keeps seeing a moved
    // head is a deterministic gate, and the step breaks that tie rather than
    // paying for the bound (see `stagnantAgainstFix`).
    lens: async () => ({
      ...cleanLensRound(),
      verdict: "ISSUES_FOUND" as const,
      findings: `- [HIGH] SECURITY a.ts:1: leak (round ${String(++fRound)})`,
    }),
    // Every fixer commits, so no round is refused for fixing nothing, and each
    // carries its tree's `runId` — the field the resume path matches on.
    dispatch: fixerThatCommits("f"),
  });
  const { threw: t4 } = await run(ctxFor(rr2, bs2, BRANCH), neverClears);
  // MAX_REVIEW_ROUNDS rounds, each one reviewer + six lenses + one fixer, so the
  // step paid for 3*(rounds+1) children — far more than the 16 a single outcome
  // may record.
  // MAX_REVIEW_ROUNDS rounds, each one reviewer + six lenses, and a fixer after
  // every round that did not clear.
  const paid = MAX_REVIEW_ROUNDS * 7 + (MAX_REVIEW_ROUNDS - 1);
  assert(
    t4 instanceof ReviewInfraError &&
      new RegExp(
        `reached round ${String(MAX_REVIEW_ROUNDS + 1)} at the step's bound of ${String(MAX_REVIEW_ROUNDS)} rounds`,
      ).test(t4.message),
    `(f) the loop runs to the bound, then throws (${t4?.message})`,
  );
  assert(
    paid > DISPATCHES_MAX_ROWS,
    `(f) precondition: this run paid for ${String(paid)} children, more than the ${String(DISPATCHES_MAX_ROWS)} the record may hold — so the clip is exercised rather than merely declared`,
  );
  assert(
    (t4 as ReviewInfraError | undefined)?.dispatches.length === DISPATCHES_MAX_ROWS,
    `(f) and the handback records exactly the cap's worth, not the uncapped total the loader would reject (got ${String((t4 as ReviewInfraError | undefined)?.dispatches.length)})`,
  );
  const fRows = (t4 as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    fRows.filter((r) => r.role === LENS_ROLE).length === 12,
    `(f) the tail it kept holds TWELVE lens rows — six per round for the last two rounds: a round collapsed to one row under-billed every lens review the run paid for (got ${String(fRows.filter((r) => r.role === LENS_ROLE).length)})`,
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
    "(f) and those twelve timings are not one value repeated — six distinct child timings per round survive the clip",
  );
  assert(
    fRows.some((r) => r.role === FIXER_ROLE),
    "(f) the FIXER is billed too: a step whose cost report omits the round that did the work cannot be used to price the next run",
  );
  assert(
    fRows.filter((r) => r.role === ADVERSARIAL_GATE_ROLE).length >= 1,
    `(f) the adversarial passes appear under the LOOP's role, the same role the frozen driver's events use — so the byRole columns are comparable (${JSON.stringify(fRows.map((r) => r.role))})`,
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

  // (g) A budget that pays for no round at all still gets a real look, and a head
  // that was not reviewed is never reported as reviewed.
  //
  // This case used to assert "one look, then refuses", reading the round cap off
  // `turns` (`max(1, floor(turns / 300))`). That derivation is HIGH#2 and is gone:
  // it made the default 150-turn budget yield ONE round, so the step could fix but
  // never re-review. The round cap is `MAX_REVIEW_ROUNDS` now and the budget bounds
  // the MONEY, so what this case still has to prove is the two things that survived
  // — a degenerate budget does not skip the review, and it does not certify a head
  // nobody looked at. Asserting the old sentence would have pinned the bug.
  let gRound = 0;
  const { threw: t5 } = await run(
    ctxFor(rr2, bs2, BRANCH),
    depsWith({
      loadConfig: async () => ({
        ...defaultConfig(),
        budgets: { ...defaultConfig().budgets, review: { turns: 0, tokens: 0, minutes: 0 } },
      }),
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND" as const,
        findings: `- [HIGH] SECURITY a.ts:1: leak (round ${String(gRound++)})`,
      }),
      dispatch: fixerThatCommits("g"),
    }),
  );
  assert(
    gRound >= 1,
    `(g) a zero review budget still pays for at least one lens look — it does not silently skip the review (${String(gRound)} lens round(s) ran)`,
  );
  assert(
    t5 instanceof ReviewInfraError,
    `(g) and a head the review could not clear is an error, never a pass (${t5?.message ?? `kind ${String((t5 as undefined) === undefined ? "none" : "other")}`})`,
  );
  assert(
    gRound <= MAX_REVIEW_ROUNDS,
    `(g) and the loop is bounded by the rounds constant rather than by a turn division, so it cannot run away on a zero budget (${String(gRound)} <= ${String(MAX_REVIEW_ROUNDS)})`,
  );
}

// ── (e4) THE ADVERSARIAL ARM IS BOUNDED TOO — the CRITICAL this handler shipped
// with.
//
// `(e3)`/`(f)` above drive the LENS arm to the bound, and the round guard sat with
// them, inside the lens arm. The adversarial arm's findings branch called `fixRound`
// and `continue`d without ever passing that guard, so a gate that keeps returning
// findings looped forever and every pass bought a reviewer AND a fixer. Measured on
// this same loop: **550 fix rounds in 90 seconds**, every one a paid child — the
// exact shape that made the frozen driver unmergeable, and the reason this case
// exists rather than a comment asserting the bound covers both arms.
//
// The stub is the adversarial arm's worst honest case: `loopOutcome: "rejected"`
// with findings that VARY per round. Varying them is deliberate — this arm has two
// stop conditions, `stagnantAgainstFix` (same gate, same text, a head that moved)
// and the round bound, and a stub with one fixed string trips the earlier one, so
// the case would measure the tie-breaker and never reach the bound. Varying the text
// says the gate is genuinely re-looking at a new head and only the bound can stop
// it, which is the defect's shape.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  let advAsks = 0;
  let fixers = 0;
  let lensRounds = 0;
  // ONE `fixerThatCommits` instance for the whole case, counted on the way through
  // rather than re-created per call: its per-tree commit counter has to keep
  // advancing or two rounds write byte-identical trees.
  const alwaysCommit = fixerThatCommits("always-findings");
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () =>
        result({
          loopOutcome: "rejected",
          text: `1. unbounded read (round ${String(++advAsks)})`,
        }),
      // Never consulted on this arm — the findings branch `continue`s before the
      // lens gate runs. Counted so the case can say the loop never even reached the
      // arm that used to hold the only guard.
      lens: async () => {
        lensRounds++;
        return cleanLensRound();
      },
      dispatch: async (spec: DispatchSpec) => {
        fixers++;
        return alwaysCommit(spec);
      },
    }),
  );
  // The bound fires rather than the step reporting the head reviewed. `done` here
  // would be the worst answer available: an unreviewed head carried on to `ci`.
  assert(
    outcome === undefined,
    `(e4) an adversarial gate that never clears is never reported as reviewed (got kind ${String(outcome?.kind)})`,
  );
  assert(
    threw instanceof ReviewInfraError &&
      /reached round 4 at the step's bound of 3 rounds/.test(threw.message),
    `(e4) the ADVERSARIAL arm stops at the stated bound rather than looping — the guard is at the top of the loop body, so it covers this arm too (${threw?.message})`,
  );
  // THE MEASURED NUMBER, and the one this case exists to hold. Before the hoist the
  // same shape was unbounded (the lens arm of this loop measured 550 fix rounds in
  // 90 seconds); a regression that puts the guard back inside the lens arm takes
  // this back to hundreds, which is why it is an exact equality and not a `<=`.
  assert(
    fixers === MAX_REVIEW_ROUNDS,
    `(e4) exactly ${String(MAX_REVIEW_ROUNDS)} fix rounds were bought by the always-findings stub — the unbounded arm bought hundreds (measured 550 in 90s) and every one of them was a paid child (got ${String(fixers)})`,
  );
  assert(
    advAsks === MAX_REVIEW_ROUNDS,
    `(e4) and the same for the reviewer — ${String(MAX_REVIEW_ROUNDS)} passes, no bound-breaking extra (${String(advAsks)})`,
  );
  assert(
    lensRounds === 0,
    `(e4) and the loop never reached the lens arm at all, which is where the guard used to live and why this arm had none (${String(lensRounds)} lens rounds ran)`,
  );
  // The findings that stopped it reach the operator, so the handback says what was
  // outstanding rather than only that the loop gave up.
  assert(
    (threw as ReviewInfraError | undefined)?.message.includes("unbounded read") === true,
    `(e4) and the refusal names the findings still open, since a bound with nothing to show for it cannot be triaged (${(threw as ReviewInfraError | undefined)?.message.slice(0, 200)})`,
  );
  // The cost of those rounds is on the record even though the step threw, clipped to
  // the loader's cap — a run that bought three fixers and reported none is the
  // under-billing this suite exists to prevent.
  assert(
    (threw as ReviewInfraError | undefined)?.dispatches.some((r) => r.role === FIXER_ROLE) ===
      true,
    "(e4) and the fixers this arm bought are billed on the refusal",
  );
}

cleanupRoots();
process.exit(failures());
