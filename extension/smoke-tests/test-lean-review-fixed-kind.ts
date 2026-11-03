#!/usr/bin/env bun
/**
 * lean/review — `fixed` or `done`, and the fact that decides it.
 *
 * `machine.ts` routes the review step's two kinds apart: `fixed` re-verifies the
 * head the step pushed, `done` goes to `ci`. The routing is pinned by
 * `test-lean-machine.ts`; these cases pin the STEP's half — that the kind it
 * reports matches what it actually did to origin — plus the rule the whole design
 * rests on: the answer comes from the durable step log, so a resumed attempt that
 * lost its closure still gets it right.
 *
 * Both directions are asserted, because each breaks a different way. Report
 * `fixed` on a run that fixed nothing and every clean run pays for a redundant
 * re-verification and a second push. Report `done` on a run that did fix, and the
 * run walks into `ci` over a head its gate never read, where `ci.ts` throws — and
 * that case is invisible to every other test in the suite, because the step itself
 * SUCCEEDED.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  blockingFinding,
  cleanLensRound,
  lensRoundWith,
  resolvedLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixerThatCommits,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import type { DispatchUsageRow, FixRunId } from "../src/lean/step-budget.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { PASS_KINDS, fixedFromLog } from "../src/lean/review-log.ts";

const { assert, failures } = makeAssert();

// ── (a) a clean review with no fix round says `done`, not `fixed` ────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ adversarial: async () => result({ loopOutcome: "approved" }) }),
  );
  assert(
    threw === undefined && outcome?.kind === "done",
    `(a) a review that fixed nothing reports DONE, so the run keeps its direct edge to ci (got ${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
}

// ── (b) a fix round that pushed says `fixed` ────────────────────────────────
//
// The adversarial gate asks once and the six-lens round then clears, so the step
// completes with a pass AFTER integrating a fixer's commit — the shape where a
// missing `fixed` is invisible: the run looks healthy, goes to `ci`, and dies.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. the finding the fixer answers"),
      dispatch: fixerThatCommits("moved-head"),
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(b) THE KIND: a review whose fix round integrated commits says FIXED, so the table re-verifies before ci (got ${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
  assert(
    outcome?.dispatches?.some((r) => r.role === FIXER_ROLE) === true,
    "(b) and the precondition holds on the record the kind is derived from: this round really paid for a fixer",
  );
}

// ── (c) the six-lens arm says `fixed` as well ───────────────────────────────
//
// Two arms dispatch a fixer (the adversarial gate's findings and the six-lens
// round's findings). The kind must come from what happened, not from which gate
// asked — otherwise a run that needed lenses re-verifies and one that needed the
// reviewer does not, for no reason a reader could predict.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async (a) =>
        a.wave === "fix"
          ? resolvedLensRound(a, [blockingFinding()])
          : {
              ...lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
              findings: "- [HIGH] SECURITY a.ts:1: leak",
            },
      dispatch: fixerThatCommits("lens-arm"),
    }),
  );
  assert(
    threw === undefined && outcome?.kind === "fixed",
    `(c) and the kind is FIXED on this arm too — the routing cannot depend on which gate asked for the fix (got ${threw?.message ?? `kind ${String(outcome?.kind)}`})`,
  );
}

// ── (d) the derivation is the LOG's, so a resume gets it right ──────────────
//
// The closure is the wrong place for this fact and this case is the only thing
// that proves it. A crashed attempt's push stands on origin; the attempt that
// resumes has no memory of making it. `fixedFromLog` reads the decided entries,
// so the resumed pass still says `fixed`.
{
  const rows: DispatchUsageRow[] = [
    {
      role: FIXER_ROLE,
      ms: 1_000,
      ok: true,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
      runId: "1700000000000-a-1-0" as FixRunId,
    },
  ];
  const passed: Step = {
    key: "7:review:0",
    state: "review",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: "done", reason: "a pass that fixed", dispatches: rows },
  };
  // An `error` entry is a throw, and every throw in this step happens on a round
  // that moved nothing (`integrate`'s `fail()`, `assertFixAdvanced`). Counting one
  // would re-verify commits nobody wrote.
  const errored: Step = {
    ...passed,
    key: "7:review:1",
    outcome: { kind: "error", message: "the fixer died", dispatches: rows },
  };
  // The engine's replay marker: the undecided entry of the state being re-run. It
  // carries no outcome, so it can never be the pass a resume reads its verdict
  // from — and a log holding ONLY one claims nothing.
  const replay: Step = { key: "7:review:2", state: "review", startedAt: 3 };
  assert(
    fixedFromLog([passed]) === true,
    "(d1) a decided review pass carrying a fixer row is a run that fixed, which is what a resumed attempt reads its verdict from",
  );
  assert(
    fixedFromLog([errored]) === false,
    "(d2) and a THROWN round does not count — its fixer was billed and moved nothing, so re-verifying would certify a head nobody pushed",
  );
  assert(
    fixedFromLog([]) === false && fixedFromLog([replay]) === false,
    "(d3) an empty log and a bare replay marker both claim nothing",
  );
  assert(
    fixedFromLog([replay, errored, passed]) === true,
    "(d3b) and the pass is still read with noise on both sides of it",
  );
  // A row is only a COST record — it rides on the outcome whatever the kind — so
  // the reader must key on the state. The fixer's role IS the builder's, which
  // makes this the case that keeps a run whose CI went red from calling a build's
  // fixer a review fix and re-verifying a head its review never moved. The kind is
  // drawn from `PASS_KINDS`, not invented: with a kind the reader already rejects
  // (`ok`, `error`, …) the kind test alone makes this false and the `state` guard
  // is never reached — the case would pass with the guard deleted.
  const builder: Step = {
    key: "7:build:0",
    state: "build",
    startedAt: 1,
    endedAt: 2,
    outcome: { kind: PASS_KINDS[0] ?? "done", dispatches: rows },
  };
  assert(
    fixedFromLog([replay, builder]) === false,
    "(d4) a builder's row never answers for a review fix round — the role is shared, the state is not",
  );
}

cleanupRoots();
process.exit(failures());
