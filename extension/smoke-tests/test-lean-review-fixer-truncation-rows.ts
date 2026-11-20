#!/usr/bin/env bun
/**
 * fixer-truncation — the ROWS a truncated wave bills: which one the operator's number comes from,
 * and what a child may report without deleting its own row.
 *
 * Split out of `test-lean-review-fix-reask-pure.ts` along the seam that file already draws: that suite
 * drives the DETECTOR (whether to ask at all) on a `DispatchResult`; this one drives the two functions
 * that turn a wave's billed rows into the record and the handback. Same no-git, no-child, no-token grain.
 *
 * Two load-bearing facts, neither settled by any other suite:
 *
 *   (1) `truncatedFixerOutputTokens` names the CUT child. Both rows are `developer` rows carrying the
 *       same `runId` (the step stamps the fixer and its continuation with the one `worktreeRunId`), so
 *       the sole discriminator between the child that hit the cap and the continuation that never did is
 *       FORWARD-SCAN ORDER. The wave suites assert the rendered clause, which is built from whatever this
 *       function returns, so a `findLastIndex` / `reverse()` edit or a role-blind read stays green there;
 *       the reversed-array case below is what goes red instead.
 *   (2) No child-authored field can make the wave's second row unrecordable. The loader
 *       (`validatedDispatches`) `continue`s past a row it cannot parse rather than rejecting the array,
 *       so one bad value silently deletes the row that PROVES a second child was paid for — the #1930
 *       under-billing shape arriving by the other door. The row boundary is where that is refused, so
 *       each arm is judged against the loader's own `dispatchesProblem`.
 */

import {
  continuationRow,
  truncatedFixerOutputTokens,
} from "../src/fixer-truncation.ts";
import { dispatchesProblem } from "../src/lean/state-dispatches.ts";
import type { DispatchResult, DispatchUsage } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** The CONTINUATION's turn: small, ordinary, and NOT the number the clause may quote. */
const CONT_USAGE: DispatchUsage = {
  input: 200,
  output: 400,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.02,
  turns: 1,
  toolCalls: 0,
  toolErrors: 0,
};

/** The field run's own numbers: the cut child spent the whole output cap. */
const CUT_CHILD_USAGE: DispatchUsage = {
  input: 10,
  output: 16_384,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.1,
  turns: 6,
};

/** The fixer's role, as the step bills it — the value `leanUsage` folds `byRole` on. */
const FIXER_ROLE = "developer";

/** The two rows of one round: the cut child's and the continuation's. The step stamps BOTH with the
 *  same fix-tree identity (`runFixer` and `runFixerContinuation` pass the one `worktreeRunId`), so the
 *  pair the clause reads really is ambiguous but for order. The names differ only in the suffix the
 *  loader's grammar admits, purely so a case can tell which row its assertion looked at. */
const CUT_RUN_ID = "1700000000000-a-full-0" as never;
const CONT_RUN_ID = "1700000000000-a-full-0c" as never;
const RUN_ID = CUT_RUN_ID;

/** A truncated fixer's result: `developer`, clean exit, the field run's token count. */
function fixer(): DispatchResult {
  return {
    role: FIXER_ROLE,
    ok: true,
    text: "",
    toolUses: [],
    ms: 1000,
    exitCode: 0,
    stopReason: "length",
    usage: CUT_CHILD_USAGE,
  };
}

/** The first child's row, built the way `step-budget.ts` builds a dispatch row, plus the tree identity
 *  `runFixer` stamps onto it. A fixture rather than the production builder, because this file is about
 *  WHICH row the clause reads, not how a row is built — the builder is exercised on the real step by
 *  `test-lean-review-row-roundtrip.ts`. */
function dispatchUsageRowFor(
  result: DispatchResult,
  usage: DispatchUsage,
): {
  role: string;
  ms: number;
  ok: boolean;
  usage: DispatchUsage;
  stopReason?: string;
  runId: typeof RUN_ID;
} {
  return {
    role: result.role,
    ms: result.ms ?? 0,
    ok: result.ok,
    usage,
    ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}),
    runId: RUN_ID,
  };
}

// ── (1) WHICH row the operator's number comes from ─
//
// Two load-bearing facts about the truncated wave's rows, neither of which any other suite settles:
//
//   (1a) `truncatedFixerOutputTokens` names the CUT child. Both rows are `developer` rows carrying the
//         same `runId`, so the sole discriminator between the child that hit the cap and the continuation
//         that never did is FORWARD-SCAN ORDER. A `findLastIndex` / `reverse()` edit would otherwise stay
//         green on every wave-level assertion, which reads the rendered clause rather than the row that
//         fed it — and the number that reaches the handback would belong to a turn that was never cut.
//   (2) A child-authored field can never make the wave's second row unrecordable. The loader
//         (`validatedDispatches`) `continue`s past a row it cannot parse, so a `usage` carrying
//         `Infinity` or a `stopReason` of `""` silently deletes the row that PROVES a second child was
//         paid for. The row boundary is where that is refused, so it is judged here against the loader's
//         own `dispatchesProblem`.
{
  // The cut child's row carries the 16 384 the field run spent; the continuation's carries its own 400.
  const cut = dispatchUsageRowFor(fixer(), CUT_CHILD_USAGE);
  const cont = continuationRow(
    { ok: true, ms: 900, usage: CONT_USAGE, stopReason: "end_turn" },
    FIXER_ROLE,
    RUN_ID,
  );
  // The discriminator is order alone, so the fixture has to look ambiguous: same role, same tree
  // identity (the step stamps both rows with the one `worktreeRunId`), differing only in the count.
  assert(
    cut.role === cont.role && cut.runId === cont.runId && cut.usage.output !== cont.usage.output,
    `(1) precondition: the two rows differ ONLY in order — role and tree identity are shared, so nothing but the scan tells them apart (${cut.role}/${cont.role}, ${String(cut.runId)})`,
  );
  assert(
    truncatedFixerOutputTokens([cut, cont]) === 16_384,
    `(1) the clause's number is the CUT child's own output, forward (${String(truncatedFixerOutputTokens([cut, cont]))})`,
  );
  // The DETECTOR for the two mutants this rule is exposed to, and why a "scan the other row"
  // assertion cannot be the one that catches them: with the rows the way the wave actually bills
  // them, the LAST fixer row IS the continuation, so quoting the last row answers 400 here and no
  // other assertion in the suite would notice (the wave suites read the rendered clause, which is
  // built from whatever this function returns). Same for a scan that ignored `role` and took the
  // first row's `stopReason === "length"`, or the largest count: this array is the shape that
  // distinguishes "names the child that was cut" from "names the row that came first, whatever it is".
  assert(
    truncatedFixerOutputTokens([cont, cut]) === 400,
    `(1) and a back-scan (or any read that does not ask for the FIXER row in wave order) answers the CONTINUATION's 400 — the number of the child that was never cut; this line is the one that goes red when the scan is reversed or made role-blind (${String(truncatedFixerOutputTokens([cont, cut]))})`,
  );
  // The two rows must be the only thing the function can see: an unrelated row of another role
  // cannot be the source, or a lens child's count could reach the operator's line.
  const lens = {
    role: "code-review-specialist",
    ms: 1,
    ok: true,
    usage: { ...CONT_USAGE, output: 999_999 },
    runId: CONT_RUN_ID,
  };
  assert(
    truncatedFixerOutputTokens([lens, cut]) === 16_384,
    `(1) and a non-fixer row ahead of it is not read — only the wave's fixer row may name the cut (${String(truncatedFixerOutputTokens([lens, cut]))})`,
  );
  // The zero arm is the no-fixer-row arm, and ONLY that arm: a lone continuation row IS a `developer`
  // row carrying the fix tree's identity (the step stamps both children with the one `worktreeRunId`),
  // so the scan must answer its count rather than invent a zero. "Report zero whenever the
  // continuation is present" would look like the same rule and delete the number the clause exists to
  // print, which is why the wave-order case above and this one are asserted separately.
  assert(
    truncatedFixerOutputTokens([
      continuationRow({ ok: true, ms: 1, usage: CONT_USAGE }, FIXER_ROLE, CONT_RUN_ID),
    ]) === CONT_USAGE.output,
    "(1) and a lone fixer row is still read on its own merits — the zero arm belongs to a wave that billed no fixer at all",
  );
  assert(
    truncatedFixerOutputTokens([lens]) === 0,
    "(1) and a wave that billed no fixer row reports zero (and traces) rather than reading a lens child",
  );

  // (2) — the malformed-child arms, each judged by the loader that would have deleted the row.
  // One field broken at a time, in a report whose other fields are all DISTINCT non-zero values: an
  // assertion that read "the broken field came out zero" off a fixture that was zero anyway would stay
  // green with the normalisation deleted entirely. `good` is what the same child answers unbroken.
  const good: DispatchUsage = {
    input: 200,
    output: 400,
    cacheRead: 3,
    cacheWrite: 4,
    cost: 0.02,
    turns: 1,
    toolCalls: 5,
    toolErrors: 2,
  };
  // `ms` is child-authored too; the loader refuses a non-finite one outright, so it rides here rather
  // than in the table below (whose arms all assert one usage field at a time).
  const badMs = continuationRow({ ok: true, ms: Number.NaN, usage: CONT_USAGE }, FIXER_ROLE, RUN_ID);
  assert(
    badMs.ms === 0 && dispatchesProblem([badMs]) === undefined,
    `(2) and a child that reported no usable duration bills zero rather than a row the loader refuses (${String(badMs.ms)})`,
  );
  const broken: Array<[string, Partial<DispatchUsage> | undefined, string | undefined]> = [
    ["an infinite output", { output: Number.POSITIVE_INFINITY }, undefined],
    ["an output that is not a number at all", { output: "400" as never }, undefined],
    ["a negative output", { output: -7 }, undefined],
    ["a negative cost", { cost: -1 }, undefined],
    ["an infinite cost", { cost: Number.POSITIVE_INFINITY }, undefined],
    ["a fractional turn count", { turns: 1.5 }, undefined],
    ["a malformed tool-call count", { toolCalls: -1 }, undefined],
    ["a blank stop reason", undefined, ""],
    ["a padded stop reason", undefined, " end_turn"],
    ["a stop reason carrying a newline", undefined, "end\n_turn"],
    ["a stop reason past the record's bound", undefined, "x".repeat(41)],
  ];
  for (const [name, usageOver, badReason] of broken) {
    const row = continuationRow(
      {
        ok: true,
        ms: 1_000,
        usage: { ...good, ...(usageOver ?? {}) } as DispatchUsage,
        ...(badReason === undefined ? { stopReason: "end_turn" } : { stopReason: badReason }),
      },
      FIXER_ROLE,
      RUN_ID,
    );
    assert(
      dispatchesProblem([row]) === undefined,
      `(2) a child reporting ${name} still leaves a recordable row — the loader drops an unparseable row SILENTLY, so the wave would lose its proof that a second child was paid for (${JSON.stringify(row)} → ${String(dispatchesProblem([row]))})`,
    );
    const field = (Object.keys(usageOver ?? {}) as (keyof DispatchUsage)[])[0];
    assert(
      // An optional tool count is DROPPED when malformed rather than zeroed, so the row never claims
      // "made no tool calls" about a child whose report was unreadable; a required count is billed zero.
      (field === undefined || row.usage[field] === 0 || !(field in row.usage)) &&
        (Object.keys(good) as (keyof DispatchUsage)[])
          .filter((k) => k !== field)
          .every((k) => good[k] === row.usage[k]),
      `(2) and the ONE unreadable field is billed as zero while every other count survives (${JSON.stringify(row.usage)})`,
    );
    assert(
      row.stopReason === (badReason === undefined ? "end_turn" : undefined),
      `(2) and a malformed stop reason is DROPPED rather than recorded — an empty value on the record reads as "the child stopped" (${JSON.stringify(row.stopReason)})`,
    );
  }
  // The well-formed row still carries everything, so the normalisation above is a filter and not a wipe.
  const whole = continuationRow(
    { ok: true, ms: 1_000, usage: CONT_USAGE, stopReason: "length" },
    FIXER_ROLE,
    RUN_ID,
  );
  assert(
    whole.stopReason === "length" &&
      whole.usage.output === 400 &&
      whole.usage.turns === 1 &&
      whole.usage.cost === 0.02 &&
      whole.ms === 1_000,
    `(2) a well-formed child loses nothing to the normalisation (${JSON.stringify(whole)})`,
  );
}


process.exit(failures());
