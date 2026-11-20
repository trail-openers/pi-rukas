#!/usr/bin/env bun
/**
 * The OFF arm: `PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK=0` is byte-identical to the pre-change build.
 *
 * The switch is the only thing a reviewer or an operator can pull when the continuation misbehaves, so
 * what it buys has to be verifiable: with the literal `0` set there is no detection, no continuation,
 * and the handback cause and the headless `failure.message` are the exact bytes this repo wrote before
 * the continuation existed. "Byte-identical" is only a claim against bytes that did NOT come from the
 * code under change — so the two goldens below were captured from the base commit's own source (see
 * `lib/lean-review-fixtures-golden-note.ts`), and the comparison is `===` on the message with the head
 * sha substituted, never `includes` on a phrase.
 *
 *   (1) the off arm's no-change cause is the golden, character for character — including a fixer whose
 *       recorded turn WAS truncated, which is the arm a switch that leaked its clause would fail
 *   (2) the on arm's message is NOT the golden, and contains the clause — the pair that makes the
 *       off-arm equality mean something (a golden equal to the new behaviour is a missing test)
 *   (3) the headless `failure.message` for a truncated no-change wave carries the same cause on both
 *       arms, so the host channel cannot disagree with the handback
 *   (4) the switch's truth table: only the literal `0` turns it off, and it is read per wave — an
 *       operator can flip it between waves without a restart
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { leanResultDocument } from "../src/headless/work-lean-result.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import { leanFixerTruncationReaskEnabled } from "../src/lean/fixer-truncation-reask-switch.ts";
import { handbackOutcome, neededFromLog } from "../src/lean/handback.ts";
import { truncationClause } from "../src/lean/review-progress.ts";
import { ReviewInfraError } from "../src/lean/review.ts";
import { reviewOutcome } from "../src/lean/review.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import type { DispatchResult } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { GOLDEN_OFF_CAUSE, ON_TRUNCATION_CLAUSES } from "./lib/lean-review-fixtures-golden-note.ts";
import {
  BRANCH,
  CAUSE_NO_CHANGE,
  type ReviewDeps,
  cleanupRoots,
  ctxFor,
  depsWith,
  frozenBlob,
  git,
  lensRoundFor,
  makeRepo,
  rejectsThenClears,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/** The field run's truncation, in the shape the fixer's result carries it. */
const TRUNCATED_FIXER = (): DispatchResult =>
  result({
    role: "developer",
    ok: true,
    exitCode: 0,
    ms: 90_000,
    stopReason: "length",
    toolUses: [],
    transcriptPath: "/tmp/pi-rukas-test/golden-fixer.json",
    usage: { input: 4_000, output: 16_384, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 7 },
  });

/** A wave whose fixer changes nothing, on either arm. */
async function wave(over: { off: boolean; truncated: boolean }): Promise<{
  repoRoot: string;
  head: string;
  message: string;
  threw?: Error;
}> {
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const ctx: HandlerCtx = ctxFor(repoRoot, baseSha, BRANCH);
  ctx.run.steps.push({
    key: "7:specify:0",
    state: "specify",
    startedAt: 1,
    endedAt: 2,
    outcome: {
      kind: "ok",
      frozen: { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, "HEAD")) },
      tests: { AC1: ["tests/AC1.test.ts"] },
    },
  } as never);
  if (over.off) process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK = "0";
  else delete process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK;
  const deps: ReviewDeps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer must answer", 1),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    dispatch: async () => (over.truncated ? TRUNCATED_FIXER() : result({ role: "developer" })),
    // Present on BOTH arms: with the switch off the detector must refuse on the switch alone. A seam
    // that was also absent would pass for the wrong reason and prove nothing about the knob.
    continueSession: async () => ({ ok: true, text: "asked and changed nothing" }),
  });
  const { threw } = await runStep(ctx, deps);
  delete process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK;
  return { repoRoot, head, message: threw?.message ?? "", threw };
}

// ── (1) THE OFF ARM IS THE GOLDEN, EVEN ON A TRUNCATED FIXER ─────────────────
{
  const off = await wave({ off: true, truncated: true });
  assert(
    off.threw instanceof ReviewInfraError,
    `(1) the off arm still hands back the no-change way (${off.threw?.message ?? "no throw"})`,
  );
  // The golden is captured with the head's 12-char prefix as a placeholder, because the sha is the one
  // part of the sentence this run cannot predict. Substituting it keeps the comparison exact.
  const expected = GOLDEN_OFF_CAUSE.replace("{HEAD12}", off.head.slice(0, 12));
  assert(
    off.message === expected,
    `(1) and the cause is the PRE-CHANGE bytes, character for character — a truncated fixer with the switch at 0 must read exactly as a build without the continuation ever did\n     got: ${off.message}\n want: ${expected}`,
  );
  assert(
    off.message.startsWith(CAUSE_NO_CHANGE),
    "(1) and the named cause is still the head of the sentence — three surfaces match on it",
  );
  assert(
    ON_TRUNCATION_CLAUSES.every((c) => !off.message.includes(c)),
    `(1) and NO clause of the new behaviour leaked into the off arm (${off.message})`,
  );
  assert(
    git(off.repoRoot, "rev-parse", `origin/${BRANCH}`) === off.head,
    "(1) and with the switch off nothing was continued and nothing reached origin",
  );
}

// ── (2) THE ON ARM IS NOT THE GOLDEN — the pair that makes (1) mean something ─
{
  const on = await wave({ off: false, truncated: true });
  const expected = GOLDEN_OFF_CAUSE.replace("{HEAD12}", on.head.slice(0, 12));
  assert(
    on.message !== expected,
    `(2) the on arm's message is NOT the golden — if these two were ever equal, (1) would be asserting nothing (${on.message})`,
  );
  for (const clause of ON_TRUNCATION_CLAUSES) {
    assert(
      on.message.includes(clause),
      `(2) and the on arm names the cut beside the cause: missing ${JSON.stringify(clause)} (${on.message})`,
    );
  }
  assert(
    on.message.includes("16384"),
    `(2) and it quotes the truncated turn's own output-token count (${on.message})`,
  );
  // The clause is a SUFFIX on a cause the handback clips from the end, so a long clause would eat the
  // sentence it belongs to. 2000 is the reason clip the handback applies.
  assert(
    on.message.length < 2_000,
    `(2) and the whole cause still fits the reason clip the handback applies (${String(on.message.length)})`,
  );
}

// ── (3) THE TWO SURFACES AN OPERATOR AND A HOST READ, ON BOTH ARMS ───────────
//
// The step's message only matters if the run's two renderers carry it. Both are driven through the
// engine here — the handback's own NEEDING line and the headless `issues[0].failure.message` — so a
// clause that stopped reaching either surface fails this rather than passing (5).
{
  for (const off of [true, false]) {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 6;\n" });
    if (off) process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK = "0";
    else delete process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK;
    const deps: ReviewDeps = depsWith({
      adversarial: rejectsThenClears("1. the finding the fixer must answer", 1),
      lens: async (a) => lensRoundFor(a, "APPROVED", []),
      dispatch: async () => TRUNCATED_FIXER(),
      continueSession: async () => ({ ok: true, text: "asked and changed nothing" }),
    });
    const run = await runLean({
      repoRoot,
      issue: 7,
      handlers: {
        ready: async () => ({ kind: "ok" }),
        specify: async () => ({ kind: "ok" }),
        build: async () => ({ kind: "ok" }),
        challenge: async () => ({ kind: "none" }),
        verify: async () => ({ kind: "green" }),
        publish: async () => ({ kind: "ok" }),
        review: async (ctx) => await reviewOutcome(ctx, deps),
        ci: async () => ({ kind: "green" }),
        land: async () => ({ kind: "merged" }),
        handback: (ctx) => handbackOutcome(ctx, async () => {}),
        decline: async () => ({ kind: "done" }),
      },
      now: () => 1,
      seed: { baseSha, branch: BRANCH },
    });
    delete process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK;
    const needed = neededFromLog(run.run.steps);
    const { doc } = leanResultDocument(run.run, run.code);
    const issues = doc.issues as Record<string, unknown>[] | undefined;
    const i0 = Array.isArray(issues) ? (issues[0] ?? {}) : {};
    const failure = i0.failure as { message?: string } | undefined;
    const arm = off ? "off" : "on";
    assert(
      needed.includes(CAUSE_NO_CHANGE),
      `(3) the handback's NEEDING line carries the named cause on the ${arm} arm (${JSON.stringify(needed)})`,
    );
    assert(
      (failure?.message ?? "").includes(CAUSE_NO_CHANGE),
      `(3) and so does the host contract's failure.message, the half a machine reads (${JSON.stringify(failure)})`,
    );
    assert(
      needed.includes("output-token limit") === !off,
      `(3) the clause reaches the NEEDING line on the ${arm} arm and not the other (${JSON.stringify(needed)})`,
    );
    assert(
      (failure?.message ?? "").includes("output-token limit") === !off,
      `(3) and reaches failure.message on the ${arm} arm and not the other (${JSON.stringify(failure)})`,
    );
    if (off) {
      // The off arm's two renderers are what the base commit rendered; the golden equality is asserted
      // on the step's own message in (1), and here that the renderers add nothing of their own.
      assert(
        !needed.includes(truncationClause(16_384)),
        `(3) and the off arm's NEEDING line is not the on arm's sentence with a clause hidden in it (${JSON.stringify(needed)})`,
      );
    }
  }
}

// ── (4) THE SWITCH'S TRUTH TABLE, READ PER WAVE ───────────────────────────────
{
  const table: Array<[string, boolean]> = [
    ["0", false],
    ["", true],
    ["1", true],
    ["0 ", true],
    ["no", true],
    ["false", true],
    ["00", true],
    ["/", true],
  ] as const;
  for (const [value, want] of table) {
    process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK = value;
    assert(
      leanFixerTruncationReaskEnabled() === want,
      `(4) ${JSON.stringify(value)} reads as ${String(want)} (${String(leanFixerTruncationReaskEnabled())}) — only the literal "0" is off`,
    );
  }
  // Read at CALL time, per wave: an operator flips it between waves without restarting anything.
  process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK = "0";
  assert(leanFixerTruncationReaskEnabled() === false, "(4) read at call time: 0");
  process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK = "1";
  assert(leanFixerTruncationReaskEnabled() === true, "(4) and the flip is seen without a restart");
  delete process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK;
  assert(leanFixerTruncationReaskEnabled() === true, "(4) and the default is on");
}

cleanupRoots();
process.exit(failures());
