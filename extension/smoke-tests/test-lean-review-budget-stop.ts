#!/usr/bin/env bun
/**
 * lean/review — a budget stop is the step's own throw, not a routed kind.
 *
 * `machine.ts` declares `review: ["done"]` and its comment is explicit: a review
 * that ran out of its budget is NOT a kind a handler returns — it is a throw, and
 * the engine records it as the infrastructure handback it is. But the three sites
 * that read a stopped child (`review.ts`'s gate arm and its two fix arms) returned
 * `budgetVerdictWithRows(...)`, i.e. `{kind: "budget"}`. The table has no arrow for
 * that pair, so `settle` ended the run with
 * `no transition for review + "budget"` and exit 10 — a cause that names neither
 * the lever that fired nor what the run spent on it.
 *
 * The three arms are driven separately, because they are three different reads of
 * three different children: the adversarial gate's stopped reviewer, the fixer the
 * adversarial arm dispatches, and the fixer the six-lens arm dispatches. Each is
 * armed through `armBudget` off `budgets.review`, and each reports its breach the
 * way `spawn.ts` leaves one — a `killCause: "child-bound"` for the minutes lever,
 * an aborted signal for the turns lever.
 *
 * What a throw owes the operator is named in the engine's own handback line, so the
 * assertions run the REAL engine (`runLean`) over the step rather than only the
 * step: a message the engine never prints is not a cause.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { runLean } from "../src/lean/engine.ts";
import { handbackOutcome, neededFromLog } from "../src/lean/handback.ts";
import { leanResultDocument } from "../src/headless/work-lean-result.ts";
import type { LeanHandlers } from "../src/lean/engine.ts";
import type { Budget } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { ReviewDeps } from "../src/lean/review.ts";
import { ReviewInfraError, reviewOutcome } from "../src/lean/review.ts";
import type { RunningState } from "../src/progress.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  LENS_ROLE,
  cleanupRoots,
  cleanLensRound,
  ctxFor,
  depsWith,
  makeRepo,
  rejectsThenClears,
  result,
  setup,
  runStep as run,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** The minutes lever's breach, as the wall clock leaves it on a dead child. */
function minutesStop(minutes: number): ReviewDeps {
  return depsWith({
    loadConfig: async () => cfgWith({ minutes }),
    adversarial: async () =>
      result({ loopOutcome: "approved", killCause: "child-bound", ms: (minutes + 1) * 60_000 }),
  });
}

/** A config with `budgets.review` replaced wholesale (the step arms off it). */
function cfgWith(budget: Partial<Budget>) {
  const cfg = defaultConfig();
  cfg.budgets.review = { turns: 0, tokens: 0, minutes: 0, ...budget };
  return cfg;
}

// ── (1) the adversarial arm: a stopped reviewer is a throw, and its rows ride ──
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { outcome, threw } = await run(ctxFor(repoRoot, baseSha, BRANCH), minutesStop(15));
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(1) a reviewer the ceiling stopped THROWS the step's own error — it is not a routed kind (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
  assert(
    threw?.name === "ReviewInfraError",
    `(1) and it is the review step's own error class, so \`errorOutcome\` bills its children (${threw?.name})`,
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.length > 0,
    `(1) and the child it paid for rides on the throw, so the handback can price the run (got ${String(rows.length)} rows)`,
  );
  assert(
    /review/i.test(String(threw?.message)) && /minutes/i.test(String(threw?.message)),
    `(1) and the cause names the review budget and its lever (${threw?.message})`,
  );
  assert(
    /15/.test(String(threw?.message)) && /16/.test(String(threw?.message)),
    `(1) and it carries both the ceiling and what the child used, so the operator knows which number to raise (${threw?.message})`,
  );
}

// ── (2) the adversarial arm's FIXER stopped mid-round ────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      loadConfig: async () => cfgWith({ minutes: 20 }),
      adversarial: rejectsThenClears("1. the finding that buys a fixer"),
      dispatch: async () => result({ role: FIXER_ROLE, killCause: "child-bound", ms: 21 * 60_000 }),
    }),
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(2) a fixer the ceiling stopped is a throw too, not a verdict on the arm that dispatched it (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /review/i.test(String(threw?.message)) && /minutes/i.test(String(threw?.message)),
    `(2) and the cause still names the review budget and its lever (${threw?.message})`,
  );
}

// ── (3) the six-lens arm's FIXER stopped mid-round ───────────────────────────
//
// This arm needs more care than the other two, because `runFixer` reads the
// budget's verdict BEFORE its "the fix child failed" throw: a child that comes
// back `killCause: "abort"` is a dead child unless the turns lever actually
// fired, and the throw would then be a coincidence rather than the budget path.
// So the ceiling is armed, the lens round's own children tick UNDER it (a round
// is billed through `lensRows`, not through `fired`, so their progress cannot
// fire the lever), and only the fixer ticks past it.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const CEILING = 40;
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      loadConfig: async () => cfgWith({ turns: CEILING }),
      adversarial: async () => result({ loopOutcome: "approved" }),
      lens: async () => ({
        ...cleanLensRound(),
        verdict: "ISSUES_FOUND" as const,
        findings: "- [HIGH] SECURITY a.ts:1: leak",
      }),
      dispatch: async (spec, opts) => {
        // The fixer ticks past the ceiling on the step's own armed hook, which is
        // what aborts its signal and makes the breach this step's verdict.
        opts?.onProgress?.({
          role: FIXER_ROLE,
          turns: CEILING + 6,
          toolUses: CEILING + 6,
          totalTokens: 1_000,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: CEILING + 6,
          },
        } as RunningState);
        return result({ role: FIXER_ROLE, killCause: "abort" });
      },
    }),
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(3) and so is the fixer the six-lens round dispatched (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /turns/.test(String(threw?.message)),
    `(3) and its cause names the turns lever that stopped it, not "the fix child failed" (${threw?.message})`,
  );
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.some((r) => r.role === LENS_ROLE) && rows.some((r) => r.role === FIXER_ROLE),
    `(3) with the lens round AND the fixer both billed (${JSON.stringify(rows.map((r) => r.role))})`,
  );
}

// ── (4) the turns lever: a reviewer that passes its ceiling stops the run ────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const CEILING = 40;
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      loadConfig: async () => cfgWith({ turns: CEILING }),
      adversarial: async (a) => {
        a.budget.opts.onProgress?.({
          role: FIXER_ROLE,
          turns: CEILING + 6,
          toolUses: CEILING + 6,
          totalTokens: 1_000,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: CEILING + 6,
          },
        } as RunningState);
        return result({ loopOutcome: "approved", killCause: "abort" });
      },
    }),
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(4) a child the turns lever aborted is the step's throw as well (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
  assert(
    /turns/.test(String(threw?.message)),
    `(4) and the cause names the turns lever, not a generic failure (${threw?.message})`,
  );
}

// ── (5) the ENGINE hands back naming the review budget, not a table miss ─────
//
// This is the defect's observable. A `{kind: "budget"}` return reached `settle`,
// found no arrow for `review + "budget"`, and stamped the run with
// `no transition for review + "budget"` — exit 10 with a cause that reads as a
// broken table. Through the throw the run still exits 10, but the reason the engine
// records names the ceiling that fired and what the child spent.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const handlers: LeanHandlers = {
    ready: async () => ({ kind: "ok" }),
    specify: async () => ({ kind: "ok" }),
    build: async () => ({ kind: "ok" }),
    challenge: async () => ({ kind: "none" }),
    verify: async () => ({ kind: "green" }),
    publish: async () => ({ kind: "ok" }),
    // The step's entry gate refuses a mainline branch before any child is paid,
    // so the branch the engine drives on is the run's own lean ref — the same one
    // `setup` pushed and `ctxFor` names.
    review: (ctx) => reviewOutcomeOrThrow(ctx, minutesStop(15)),
    ci: async () => ({ kind: "green" }),
    land: async () => ({ kind: "merged" }),
    handback: async () => ({ kind: "done" }),
    decline: async () => ({ kind: "done" }),
  };
  const result5 = await runLean({
    repoRoot,
    issue: 7,
    handlers,
    now: () => 1,
    // `specifyBranch` passes a non-empty branch through and the step's entry
    // gate refuses anything the run may not push, so this is the run's own lean
    // ref — the same one `setup` pushed and `ctxFor` names.
    seed: { baseSha, branch: BRANCH },
  });
  assert(
    result5.code === 10,
    `(5) the run still ends handed-back at 10 — a stopped review is not a landing (${String(result5.code)})`,
  );
  const reason = result5.run.result?.reason ?? "";
  assert(
    !/no transition for review/.test(reason),
    `(5) and the cause is NOT a table miss: the table has no review+budget arrow precisely because a budget is a throw (${reason})`,
  );
  assert(
    /review/i.test(reason) && /turns|minutes|tokens/.test(reason),
    `(5) the handback reason names the review budget and its lever (${reason})`,
  );
  const reviewStep = result5.run.steps.find((s) => s.state === "review");
  assert(
    reviewStep?.outcome?.kind === "error",
    `(5) the step records an error outcome, which is what \`handback\` reads its cause from (${String(reviewStep?.outcome?.kind)})`,
  );
  assert(
    (reviewStep?.outcome?.dispatches?.length ?? 0) > 0,
    "(5) and the cost of the child that stopped is on that record",
  );
}

/** Run the step for the engine case, letting the throw reach the engine. */
async function reviewOutcomeOrThrow(
  ctx: Parameters<typeof run>[0],
  deps: ReviewDeps,
): Promise<{ kind: string }> {
  const outcome = await reviewOutcome(ctx, deps);
  throw new Error(`(5) the step returned ${JSON.stringify(outcome.kind)} where it must throw`);
}

// ── (6) the two RENDERERS print the sentence, not a generic crash line ──────
//
// The step's message is only worth its wording if the surfaces an operator and a
// host actually read carry it. `lean/handback.ts` builds a breach sentence from the
// typed `limit`/`value`/`used` trio (`budgetTrio`), which a review throw cannot
// carry — that trio belongs to a `budget` kind, and `review` has none. So the only
// channel to either surface is the message the engine stamped on the step. These
// cases are what stop that channel degrading, unnoticed, into "review step
// reported error": the wording is the only place the lever and its number survive.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  const handlers: LeanHandlers = {
    ready: async () => ({ kind: "ok" }),
    specify: async () => ({ kind: "ok" }),
    build: async () => ({ kind: "ok" }),
    challenge: async () => ({ kind: "none" }),
    verify: async () => ({ kind: "green" }),
    publish: async () => ({ kind: "ok" }),
    review: (ctx) => reviewOutcomeOrThrow(ctx, minutesStop(15)),
    ci: async () => ({ kind: "green" }),
    land: async () => ({ kind: "merged" }),
    // Posted, because an unposted run is not the shape whose surfaces are under
    // test; the two surfaces are read off the finished run below.
    handback: (ctx) => handbackOutcome(ctx, async () => {}),
    decline: async () => ({ kind: "done" }),
  };
  const result6 = await runLean({
    repoRoot,
    issue: 7,
    handlers,
    now: () => 1,
    seed: { baseSha, branch: BRANCH },
  });
  const needed = neededFromLog(result6.run.steps);
  assert(
    /review stopped: minutes budget 15 exceeded \(used 16\)/.test(needed),
    `(6) the handback's NEEDING line — the text the run posts as its cause — carries the shared budget sentence verbatim, which is how the operator learning about this stop learns WHICH lever to raise (${JSON.stringify(needed)})`,
  );
  const { doc } = leanResultDocument(result6.run, result6.code);
  // The checked shape `test-headless-work-lean-result.ts` uses for the same
  // document: `doc.issues` is `unknown` at the seam, so it is narrowed through an
  // array test rather than cast straight to the shape this case expects — a cast
  // here reads the field off whatever the projection happened to emit.
  const issues = doc.issues as Record<string, unknown>[] | undefined;
  const i0 = Array.isArray(issues) ? (issues[0] ?? {}) : {};
  // `issues[0].failure` IS the `ResultFailure` — one level, not two: it carries
  // `kind` and `message` directly (see `ResultFailure` in `headless/failure.ts`).
  const failure = i0.failure as { message?: string; kind?: string } | undefined;
  assert(
    /review stopped: minutes budget 15 exceeded \(used 16\)/.test(failure?.message ?? ""),
    `(6) and so does the host contract's failure.message, which is the half a machine reads (${JSON.stringify(failure)})`,
  );
  assert(
    failure?.kind === "crashed",
    `(6) and it is still honestly a crashed handler: the sentence rides the message, it does not relabel a throw as a timeout the run did not have (got ${String(failure?.kind)})`,
  );
}

cleanupRoots();
process.exit(failures());
