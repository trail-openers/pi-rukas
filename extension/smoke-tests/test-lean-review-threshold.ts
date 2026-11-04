#!/usr/bin/env bun
/**
 * lean/review-deps — the lens gate must receive the project's blocking bar.
 *
 * Lean's `review` step called `runLensReview` with no `threshold`, so the review
 * layer judged every round at `DEFAULT_REVIEW_THRESHOLD` whatever the project's
 * doctrine said. The consequence is not cosmetic: an ISSUES_FOUND round buys a
 * FIX ROUND, so lean spent children repairing findings the project called
 * disclosable — while the `/work` driver, reading the same doctrine, ran the
 * same code at the project's own bar.
 *
 * Every assertion is on what the seam ACTUALLY DELIVERED to the lens engine,
 * captured off the call — never on what was handed to `reviewDeps`. An assertion
 * on the input cannot fail: the input was correct in the bug, and only what
 * reached `runLensReview` was wrong. Same reasoning as `test-lean-review-deps-bound.ts`.
 *
 * Two things are pinned beyond the value itself: the bar travels ONLY when the
 * step supplies one (an absent bar must stay absent rather than become a literal
 * MEDIUM here, which would silently re-tighten or loosen a project's rule at the
 * wiring layer), and it is resolved ONCE per step at the run's base commit — not
 * per round, which would pay a judge child per round and let two rounds of one
 * step be judged against two different bars.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { reviewDeps } from "../src/lean/review-deps.ts";
import type { LensArgs } from "../src/lean/review.ts";
import type { BudgetArms } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  cleanLensRound,
  ctxFor,
  depsWith,
  fixerThatCommits,
  makeRepo,
  rejectsThenClears,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

const BASE = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "0123456789abcdef0123456789abcdef01234568";

/** What one case drives, and what the lens engine was actually handed. */
async function deliver(over: {
  threshold?: LensArgs["threshold"];
  reviewThreshold?: (repoRoot: string, baseSha: string) => Promise<never>;
}): Promise<{ delivered?: Record<string, unknown>; calls: number }> {
  const calls: Record<string, unknown>[] = [];
  const deps = reviewDeps(false);
  deps.lensEngine = (async (opts: Record<string, unknown>) => {
    calls.push(opts);
    // The round's shape as the seam's renderer consumes it: the verdict, the
    // per-lens rows and the usage. Nothing here reads them — inventing a verdict
    // would be a fixture agreeing with itself.
    return { verdict: "APPROVED", findings: [], lenses: [], usage: undefined } as never;
  }) as never;
  if (over.reviewThreshold !== undefined) deps.reviewThreshold = over.reviewThreshold;
  const budget = { opts: {}, fired: () => undefined } as unknown as BudgetArms;
  await deps.lens({
    base: BASE,
    head: HEAD,
    branch: "lean/issue-7",
    cwd: "/tmp",
    wave: "full",
    pr: undefined,
    context: "ctx",
    evidence: undefined,
    extraFindings: [],
    headless: false,
    budget,
    ...(over.threshold === undefined ? {} : { threshold: over.threshold }),
  });
  return { delivered: calls[0], calls: calls.length };
}

// ── (1) THE BAR TRAVELS. A step that resolved HIGH must hand HIGH to the lens
// engine; with the bug the key never reached the call at all.
{
  const { delivered, calls } = await deliver({ threshold: "HIGH" });
  assert(calls === 1, `(1) precondition: the lens engine was called once (${String(calls)})`);
  assert(
    delivered?.threshold === "HIGH",
    `(1) THE PROJECT'S BAR SURVIVES TO THE LENS CALL: the engine received HIGH, the value the step resolved from doctrine (captured ${String(delivered?.threshold)}) — with the defect it received nothing and the round was judged at MEDIUM, which is the bar the project's own §1 rejects`,
  );
  assert(
    delivered?.threshold !== undefined,
    `(1) and the key is PRESENT rather than defaulted elsewhere: an absent option is what made every lean round MEDIUM (captured ${JSON.stringify(delivered?.threshold)})`,
  );
}

// ── (2) A TIGHTENED BAR TRAVELS TOO. CRITICAL is the bar a project may state,
// and the wiring must not clamp or normalise it.
{
  const { delivered } = await deliver({ threshold: "CRITICAL" });
  assert(
    delivered?.threshold === "CRITICAL",
    `(2) a bar tighter than the default reaches the engine unchanged (captured ${String(delivered?.threshold)})`,
  );
}

// ── (3) NO BAR STAYS NO BAR. The review layer owns the default; the wiring must
// not invent one, or a value stated in this file silently replaces the layer's.
{
  const { delivered } = await deliver({});
  assert(
    delivered !== undefined && !("threshold" in delivered),
    `(3) with no bar from the step, the lens call carries NO threshold key at all — the default belongs to the review layer, not to this wiring (keys: ${JSON.stringify(Object.keys(delivered ?? {})).slice(0, 200)})`,
  );
}

// ── (4) RESOLVED ONCE PER STEP, AT THE RUN'S BASE COMMIT. The step's deps own
// the doctrine read; the step asks once. Asserted on the call the step makes, so
// a per-round resolution (which pays a judge child per round) is visible here.
{
  let resolved = 0;
  const seen: Array<[string, string]> = [];
  const deps = reviewDeps(false);
  deps.reviewThreshold = async (repoRoot: string, baseSha: string) => {
    resolved++;
    seen.push([repoRoot, baseSha]);
    return "HIGH";
  };
  // The step under test, with both gates and the fixer stubbed: the adversarial
  // pass clears and the lens round reports findings, so the loop buys a fix round
  // and comes back for a second lens round. If the bar were resolved per round,
  // `resolved` would reach 2; the step's contract is one resolution.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The wave is bought by a BLOCKING verdict: `rejectsThenClears` carries a
  // `CRITICAL_ISSUES_FOUND` record on the first pass and clears on the second, so
  // the step buys one fix round and comes back for a second lens round. A lens
  // round that merely reported findings would no longer buy the second round at
  // all, and this case would measure nothing.
  deps.adversarial = rejectsThenClears("1. the finding the fixer answers");
  deps.dispatch = fixerThatCommits("threshold");
  deps.fetchIssueBody = async () => "body";
  deps.loadConfig = async () => defaultConfig();
  let rounds = 0;
  deps.lens = async () => {
    rounds++;
    return {
      ...cleanLensRound(),
      verdict: "ISSUES_FOUND" as const,
      findings: `- [HIGH] SECURITY a.ts:1: leak (round ${String(rounds)})`,
    };
  };
  const { threw } = await runStep(ctxFor(repoRoot, baseSha, BRANCH), deps);
  assert(
    rounds >= 2,
    `(4) precondition: the loop ran at least two lens rounds (${String(rounds)})`,
  );
  assert(
    resolved === 1,
    `(4) the bar was resolved ONCE for the whole step, not once per round — a per-round read pays a judge child per round and lets two rounds of one step be judged against two bars (resolved ${String(resolved)}x over ${String(rounds)} rounds)${threw ? ` [threw: ${threw.message.slice(0, 80)}]` : ""}`,
  );
  assert(
    seen.length === 1 && seen[0]?.[1] === baseSha,
    `(4) and it was read at the RUN'S BASE COMMIT — not the working tree, which the fixer rewrites between rounds (base passed: ${String(seen[0]?.[1])}, expected ${baseSha})`,
  );
}

process.exit(failures());
