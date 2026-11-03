#!/usr/bin/env bun
/**
 * lean/review — the adversarial leg's budget stop is the step's own throw, at the
 * PRODUCTION seam.
 *
 * `test-lean-review-budget-stop.ts` drives the adversarial arm with
 * `depsWith({adversarial})`: it stubs the seam, so it proves what the step does
 * with a result it is handed and nothing about whether the production loop ever
 * HANDS one. That gap is the bug this file closes: `armBudget`'s `fired()` reports
 * the minutes lever only on a result whose `killCause` is `"child-bound"`, and the
 * loop's report-only result carried none, so a reviewer the step's own
 * `budgets.review.minutes` killed came back as an ordinary verdict, `gate.stop`
 * stayed `undefined`, and the step merged a head its operator's ceiling had
 * stopped.
 *
 * So the arm under test is the real `reviewDeps().adversarial` — the same function
 * the command wires — with only `spawnSpecialist` stubbed. The chain a real lean
 * run walks is intact: `armBudget(budgets.review)` → the arms `review-deps.ts`
 * destructures → `makeRunPhase`'s reviewer branch → the child. The stub records
 * what the child was given and returns what a killed child returns, and the
 * assertion is on the sentence the step THROWS.
 *
 * No model, no child, no token.
 */

import { mock } from "bun:test";
import type { ReviewDeps } from "../src/lean/review.ts";
import type { RunningState } from "../src/progress.ts";
import type { DispatchResult } from "../src/types.ts";
import type { Outcome } from "../src/lean/state.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

type ChildCall = {
  role: string;
  tag?: string;
  childBoundMs?: number;
  signal?: AbortSignal;
  onProgress?: (s: RunningState) => void;
};

const childCalls: ChildCall[] = [];
/** What the stubbed child dies of, and how long it ran, per case. */
let childDeath: { killCause?: DispatchResult["killCause"]; ms: number } = { ms: 1 };
/** The turns the stub reports on its progress tick, so a case can cross a lever. */
let childTurns = 0;
/** The reply the reviewer child prints. */
let childText = "VERDICT: APPROVED";
/** Set by the case whose killed child still prints its reply. */
let childPrintsVerdict = false;

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1978-lean-budget",
  spawnSpecialist: async (
    spec: { role: string },
    opts: {
      tag?: string;
      childBoundMs?: number;
      signal?: AbortSignal;
      onProgress?: (s: RunningState) => void;
    },
  ) => {
    childCalls.push({
      role: spec.role,
      tag: opts.tag,
      childBoundMs: opts.childBoundMs,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    if (childTurns > 0)
      opts.onProgress?.({
        role: spec.role,
        turns: childTurns,
        toolUses: 0,
        totalTokens: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        elapsedMs: childDeath.ms,
        done: false,
      });
    const killed = childDeath.killCause !== undefined;
    return {
      role: spec.role,
      // A killed child never completed its assignment (`failedByKill` in spawn.ts).
      // The child's own wall clock: what `minutesUsed` divides, and what the
      // budget sentence prints as "used".
      ms: childDeath.ms,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 3 },
      ok: !killed,
      // A killed child has no verdict — that is `failedByKill`'s rule in `spawn.ts`
      // — but the round it was killed on must still be the round the loop ends, so
      // the child prints its verdict and the kill, not an empty reply, is what the
      // loop refuses.
      text: killed && !childPrintsVerdict ? "" : childText,
      toolUses: [],
      exitCode: 0,
      ...(killed ? { killCause: childDeath.killCause } : {}),
    };
  },
}));

const deck = await import("../src/dispatch-deck.ts");
mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...deck,
  startEntry: () => {},
  updateEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));
const registry = await import("../src/async-jobs-registry.ts");
mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...registry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));
const ledger = await import("../src/adversarial-ledger.ts");
mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
  ...ledger,
  writeAdversarialLedgerEntry: () => undefined,
}));

const { reviewDeps } = await import("../src/lean/review-deps.ts");
const { defaultConfig } = await import("../src/lean/config.ts");
const { ReviewInfraError } = await import("../src/lean/review.ts");
const { adversarialChildBoundMs } = await import("../src/review-bounds.ts");

/** The step, driven with the PRODUCTION deps and `budgets.review` replaced. */
async function runReview(opts: {
  minutes: number;
  turns?: number;
  tokens?: number;
  env?: Record<string, string | undefined>;
  lens?: ReviewDeps["lens"];
}) {
  childCalls.length = 0;
  const deps = reviewDeps(false);
  const cfg = defaultConfig();
  cfg.budgets.review = {
    turns: opts.turns ?? 0,
    tokens: opts.tokens ?? 0,
    minutes: opts.minutes,
  };
  deps.loadConfig = async () => cfg;
  // The issue body is a `gh` read in production and this is a temp repo with no
  // issue 7; the arm under test is the adversarial leg, not the fetch.
  deps.fetchIssueBody = async () => "body";
  // The lens leg is not what this file tests (its own delivered-value test is
  // `test-lean-review-deps-bound.ts`), and the step's clean pass requires a round
  // that ran lens children with usage, which a bare child stub does not produce.
  if (opts.lens) deps.lens = opts.lens;
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  let res: { outcome?: Outcome; threw?: Error };
  try {
    // `withEnv` pins the case's env for the whole pass and puts back EXACTLY
    // what was there, an absent variable included.
    await withEnv(opts.env ?? {}, async () => {
      res = await runStep(ctxFor(repoRoot, baseSha, BRANCH), deps);
    });
    return res;
  } finally {
    cleanupRoots();
  }
}

// ── (1) THE MINUTES LEVER: the reviewer's bound is the budget, and its kill
// stops the step ──────────────────────────────────────────────────────────────
{
  // The reviewer child is killed at the budget's bound and, like every killed
  // child, has no verdict to speak. `childText` is what a SURVIVING child would
  // print, so the round still ends on the loop's own no-verdict path.
  childDeath = { killCause: "child-bound", ms: 15 * 60_000 + 61_000 };
  childPrintsVerdict = true;
  const { outcome, threw } = await runReview({ minutes: 15 });

  childPrintsVerdict = false;
  childDeath = { ms: 1 };

  const reviewer = childCalls.find((c) => c.role === "adversarial-developer");
  assert(
    reviewer !== undefined,
    "(1) precondition: the production seam dispatched the reviewer child",
  );
  assert(
    reviewer?.childBoundMs === 15 * 60_000,
    `(1) THE ARM REACHED THE CHILD: the reviewer was bounded by budgets.review.minutes (15 min = ${String(900_000)}ms), not the 30-min operator knob — captured ${String(reviewer?.childBoundMs)}`,
  );
  assert(
    reviewer?.childBoundMs !== adversarialChildBoundMs(),
    `(1) and specifically NOT the reviewer's own knob, which is what it was while the arms died in the spread (knob ${String(adversarialChildBoundMs())})`,
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(1) a reviewer the step's own minutes ceiling killed THROWS the step's error — it is not a merged head (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
  assert(
    threw?.name === "ReviewInfraError",
    `(1) and it is the review step's own error class, so \`errorOutcome\` bills its children (${threw?.name})`,
  );
  assert(
    /review/i.test(String(threw?.message)) && /minutes/i.test(String(threw?.message)),
    `(1) and the cause names the review budget and the minutes lever, which is what makes it a budget stop rather than infrastructure (${threw?.message})`,
  );
  // The rows the step billed for this child: the same wall clock the budget
  // sentence reports, carried on the throw so the handback can price the run.
  const rows = (threw as ReviewInfraError | undefined)?.dispatches ?? [];
  assert(
    rows.length > 0,
    `(1) and the child the ceiling killed is billed on the throw, so the handback can price the run (got ${String(rows.length)} rows)`,
  );
  assert(
    /15/.test(String(threw?.message)),
    `(1) and the sentence names the ceiling the operator set, so they know which number to raise (${String(threw?.message)})`,
  );
}

// ── (2) THE TURNS LEVER: the child is aborted mid-round and the step stops ────
{
  childDeath = { ms: 60_000 };
  childTurns = 401;
  const { outcome, threw } = await runReview({ minutes: 0, turns: 400 });
  childTurns = 0;
  childDeath = { ms: 1 };

  const reviewer = childCalls.find((c) => c.role === "adversarial-developer");
  assert(
    reviewer?.signal !== undefined,
    "(2) THE ARM REACHED THE CHILD: the reviewer was given the abort the turns lever fires",
  );
  assert(
    reviewer?.signal?.aborted === true,
    "(2) and that signal WAS aborted — the child's own tick crossed budgets.review.turns and nothing was armed by the caller",
  );
  assert(
    outcome === undefined && threw instanceof ReviewInfraError,
    `(2) a reviewer the turns lever aborted stops the step rather than merging (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
}

// ── (3) NO BREACH IS NOT A BUDGET STOP: the step merges, and says so ─────────
// The MEDIUM finding's other half: a projection that over-reads would turn every
// rejected review into a budget handback. With an honest verdict and an un-breached
// ceiling the step must take its normal route, and the throw must not name a lever.
{
  childDeath = { ms: 60_000 };
  childText = "VERDICT: APPROVED";
  const { outcome, threw } = await runReview({
    minutes: 15,
    turns: 400,
    // The clean round the fixtures' production shape gives the step: six lens
    // children, each with its own usage.
    lens: async () => cleanLensRound(),
  });
  childDeath = { ms: 1 };
  assert(
    threw === undefined && outcome !== undefined,
    `(3) a clean review under an un-breached budget is a normal pass, not a budget stop (${threw?.message ?? `outcome kind ${String(outcome?.kind)}`})`,
  );
}

process.exit(failures());
