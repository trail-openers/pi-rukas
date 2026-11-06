/**
 * #2066 — the clock rig and the stubs both review-step suites drive.
 *
 * The step's own wall clock reads the pending step's `startedAt` and the run's
 * `deadlineMs`, which no other review fixture sets: `ctxWithClock`/`ctxWithPr` supply
 * them, and every child here reports CHILD_MS — far inside its OWN per-child bound (lens
 * 30 min, gate 30, fixer 20) while the case's clock pushes the STEP past its ceiling.
 * That gap is the defect's signature: no child is ever over its own bound, so a case
 * that stopped on one would be measuring a child and not the step.
 */

import { type HandlerCtx, type LeanHandlers } from "../../src/lean/engine.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { ReviewDeps } from "../../src/lean/review-args.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import {
  FIXER_ROLE,
  blockingFinding,
  cleanLensRound,
  ctxFor,
  depsWith,
  lensRoundFor,
  lensRoundWith,
  parsedRound,
  result,
} from "./lean-review-fixtures.ts";

/** The harness with the step's clock under the case's control. The step's own wall clock
 * reads two things no other review fixture sets — the pending step's `startedAt` (the
 * engine writes it ahead of the handler; a hand-built context has none) and the run's
 * `deadlineMs` — and needs `now` to advance: every other review fixture freezes it at 1,
 * which is exactly why no case could ever make the step clock fire.
 */
export function ctxWithClock(
  repoRoot: string,
  baseSha: string,
  branch: string,
  opts: { startedAt?: number; now?: () => number; deadlineMs?: number } = {},
): HandlerCtx {
  const ctx = ctxFor(repoRoot, baseSha, branch);
  if (opts.now !== undefined) ctx.now = opts.now;
  if (opts.deadlineMs !== undefined) ctx.run = { ...ctx.run, deadlineMs: opts.deadlineMs };
  // The engine's write-ahead entry, so the step's clock measures from a start the
  // record holds rather than from "nothing has been spent".
  ctx.run.steps.push({ key: ctx.stepKey, state: "review", startedAt: opts.startedAt ?? 0 });
  return ctx;
}

/** The same context with the `publish` step's PR record, for the disclosure cases: a
 * case that asserts the step's disclosure post must put that record on the log the step
 * reads, since `prNumberFromLog` DERIVES the number from the URL, never takes it directly.
 */
export function ctxWithPr(
  repoRoot: string,
  baseSha: string,
  branch: string,
  opts: { startedAt?: number; now?: () => number; deadlineMs?: number; prUrl?: string } = {},
): HandlerCtx {
  const ctx = ctxWithClock(repoRoot, baseSha, branch, opts);
  ctx.run.steps.push({
    key: "7:publish:0",
    state: "publish",
    startedAt: 0,
    outcome: { kind: "ok", prUrl: opts.prUrl ?? "https://github.com/o/r/pull/42" },
  });
  return ctx;
}

/** The whole run with only `review` real, driven past its budget: the engine's error
 * path is where a pass-1 stop's record has to land, so a case that asserts the durable
 * record, the log line and the host's document all at once needs a cycle that reaches
 * `review` and nothing else real. */
export function boundHandlers(now: () => number, minutes: number): LeanHandlers {
  const pass = async (kind: string) => ({ kind });
  const ok = (kind: string) => () => pass(kind);
  return {
    ready: ok("ok"),
    specify: ok("ok"),
    build: ok("ok"),
    challenge: ok("none"),
    verify: ok("green"),
    publish: ok("ok"),
    review: async (ctx: HandlerCtx) => {
      const { reviewOutcome } = await import("../../src/lean/review.ts");
      return reviewOutcome({ ...ctx, now }, depsWith({ loadConfig: async () => cfg(minutes) }));
    },
    ci: ok("green"),
    land: ok("merged"),
    handback: ok("done"),
    decline: ok("done"),
  };
}

export const MIN = 60_000;
/** Every child stays well inside its own per-child bound (lens 30, gate 30, fixer 20 min). */
export const CHILD_MS = 90_000;
/** Six lens children at the same honest duration — one round's worth. */
export const SLOW_LENS = Array.from({ length: 6 }, () => ({ ms: CHILD_MS }));
/** `budgets.review` with the step bound the case wants; turns/tokens stay shipped,
 * since zeroing them makes `armBudget` abort the CHILD and the case would then
 * measure a child arm rather than the step clock it names. */
export function cfg(minutes: number) {
  const cfg = defaultConfig();
  const shipped = cfg.budgets.review ?? { turns: 400, tokens: 60_000_000, minutes: 30 };
  cfg.budgets.review = { turns: shipped.turns, tokens: shipped.tokens, minutes };
  return cfg;
}

/** A clean roster: one approved gate pass and one six-lens round, both counted — so a
 * case can say the step bought NOBODY, and not infer it from an absent verdict. */
export function slowDeps(over: Partial<ReviewDeps> = {}): ReviewDeps & { gates: number; lenses: number } {
  const counts = { gates: 0, lenses: 0 };
  const deps = depsWith({
    adversarial: async () => {
      counts.gates++;
      return result({
        loopOutcome: "approved",
        ms: CHILD_MS,
        adversarialRounds: parsedRound("APPROVED"),
      });
    },
    lens: async () => {
      counts.lenses += 6;
      return cleanLensRound({ lenses: SLOW_LENS });
    },
    dispatch: async () => result({ role: FIXER_ROLE, ms: CHILD_MS }),
    ...over,
  });
  // The counters are READ AT ASSERTION TIME, never snapshotted by a spread: a case
  // that builds its deps with `{ ...slowDeps(), loadConfig }` would otherwise read
  // the zeros the copy carried when the stubs had not yet run.
  return Object.defineProperties(deps as ReviewDeps & { gates: number; lenses: number }, {
    gates: { get: () => counts.gates },
    lenses: { get: () => counts.lenses },
  });
}

/** Where the PR comment landed, so a case can assert the disclosure reached the forge. */
export type Posts = { pr: number; body: string }[];

/** The blocking first round that buys the fix wave, and the re-review that ANSWERS
 * the fix (an empty round stamped with the range the step named — the production
 * layer's own shape). One `adversarial` seam serves both passes, so the wave is
 * asked by verdict and not by call order. `posts` catches the disclosure comment. */
export function waveDeps(
  commit: (spec: DispatchSpec) => Promise<DispatchResult>,
  minutes: number,
  posts: Posts = [],
): ReviewDeps {
  return depsWith({
    loadConfig: async () => cfg(minutes),
    adversarial: async (a) =>
      result({
        loopOutcome: a.wave === "full" ? "rejected" : "approved",
        text: "1. leak",
        adversarialRounds: parsedRound(a.wave === "full" ? "CRITICAL_ISSUES_FOUND" : "APPROVED"),
        ms: CHILD_MS,
      }),
    lens: async (a) =>
      a.wave === "fix"
        ? lensRoundFor(a, "ISSUES_FOUND", [])
        : lensRoundWith("CRITICAL_ISSUES_FOUND", [blockingFinding()]),
    dispatch: async (spec) => commit(spec),
    prComment: async (_repo, pr, body) => {
      posts.push({ pr, body });
    },
  });
}

/** Capture what `traceWarn` printed while `body` ran — the ungated log a stop must
 * reach. The hits land in the CALLER's array, so a case can assert on them from
 * inside the very body that produced them (a returned value would not exist yet). */
export async function captureWarns(
  needle: string,
  into: string[],
  body: () => Promise<void>,
): Promise<void> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (text.includes(needle)) into.push(text.trim());
    return write(chunk as string | Uint8Array);
  }) as typeof process.stderr.write;
  try {
    await body();
  } finally {
    process.stderr.write = write;
  }
}
