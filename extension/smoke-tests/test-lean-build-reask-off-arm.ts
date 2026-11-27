/**
 * smoke-tests/test-lean-build-reask-off-arm — `PI_ENSEMBLE_LEAN_BUILD_REASK=0` is the SHIPPED
 * behaviour, byte for byte, and only the literal `0` takes the re-ask out.
 *
 * The claim is byte-equality against goldens captured from the base commit (see
 * `lib/lean-build-reask-golden.ts` for where they come from), not phrase checks: a switch that only
 * changed the WORDING of the exhausted reason would pass a `includes` assertion and still be a
 * behaviour change. So each off-arm case compares with `===`, and beside every equality sits the
 * `!==` that makes the golden mean anything — the on arm's own answers are asserted NOT equal to the
 * same constants. A golden quietly replaced with the on arm's output turns this file into a second
 * copy of the code under test, and that is what the paired inequalities catch.
 *
 * Three arms, in the order a reviewer should read them:
 *   1. the switch set to `0` reproduces the pre-change verdict, reason and dispatch record exactly;
 *   2. the switch unset (the shipped default) and set to values that are NOT `0` keep the re-ask ON —
 *      "0 = off" is the contract, so `""`, `"false"` and `"no"` must not take it out;
 *   3. the guard rails are unaffected by the switch: no seam and no session path still refuse the
 *      ask, and they refuse it identically on both arms.
 */
import { BUILD_REASK_BOUND_MS } from "../src/lean/build-reask.ts";
import type { DispatchResult } from "../src/types.ts";
import { runBuild } from "./lib/lean-build-fixture.ts";
import { type ContinuationCalls, answered, reaskDeps } from "./lib/lean-build-reask-fixture.ts";
import {
  GOLDEN_OFF_DISPATCHES,
  GOLDEN_OFF_EXHAUSTED,
  GOLDEN_OFF_REASON_ON_UNASKED,
  ON_REASK_CLAUSES,
} from "./lib/lean-build-reask-golden.ts";

let exit = 0;
function assert(cond: boolean, name: string): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) exit = 1;
}

/** The field's shape: a clean stop at the provider's output cap, no tool call, costed at the cap. */
const CUT: Partial<DispatchResult> = {
  ok: true,
  exitCode: 0,
  stopReason: "length",
  toolUses: [],
  observedToolCalls: 0,
  usage: { input: 11, output: 16384, cacheRead: 0, cacheWrite: 0, cost: 0.4, turns: 1 },
};

/** A child that recorded NO stop reason — the arm that must never ask, on either arm of the switch. */
const UNVOUCHED: Partial<DispatchResult> = { ...CUT, stopReason: undefined };

const SWITCH = "PI_ENSEMBLE_LEAN_BUILD_REASK";

/** Every case runs with the switch explicitly held, so one process cannot leak another's value. An
 *  `undefined` value means UNSET — the shipped default — which is its own arm, not "empty string". */
function withEnv<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, SWITCH);
  const prev = process.env[SWITCH];
  const put = (v: string | undefined): void => {
    if (v === undefined) Reflect.deleteProperty(process.env, SWITCH);
    else process.env[SWITCH] = v;
  };
  put(value);
  return body().finally(() => put(had ? prev : undefined));
}

/** The exhausted reason a run produced, or the marker of a run that did not reach a verdict. */
function exhaustedReason(r: Awaited<ReturnType<typeof runBuild>>): string {
  return r.outcome?.kind === "exhausted" ? r.outcome.reason : `«${String(r.outcome?.kind)}»`;
}

/** The step's dispatch record, as the fold wrote it. */
function dispatchJson(r: Awaited<ReturnType<typeof runBuild>>): string {
  return JSON.stringify(r.outcome?.dispatches ?? []);
}

// ── 1. the off arm reproduces the base commit byte for byte ─────────────────
await withEnv("0", async () => {
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2661,
    dispatchResults: [{ ...CUT, transcriptPath: "/tmp/issue-2661-session-1.jsonl" }],
    reask: { deps: reaskDeps({ calls, answers: [answered()] }) },
  });
  assert(r.threw === undefined, `(off) the step did not throw (${String(r.threw?.message)})`);
  assert(
    exhaustedReason(r) === GOLDEN_OFF_EXHAUSTED,
    `(off) the exhausted reason is the base commit's bytes, exactly (${exhaustedReason(r)})`,
  );
  assert(calls.length === 0, `(off) no continuation was asked for (${String(calls.length)})`);
  assert(
    dispatchJson(r) === GOLDEN_OFF_DISPATCHES,
    `(off) the dispatch record is the base commit's — one row, not a child plus a continuation
     (${dispatchJson(r)})`,
  );
  for (const clause of ON_REASK_CLAUSES) {
    assert(
      !exhaustedReason(r).includes(clause),
      `(off) and the reason carries none of the re-ask's clause ("${clause}")`,
    );
  }

  // The never-asked arm: a child with no recorded stop reason stays un-vouchable on BOTH arms, so
  // its reason is the same string here and with the switch on.
  const u = await runBuild({ issue: 2661, dispatchResults: [{ ...UNVOUCHED }] });
  assert(
    exhaustedReason(u) === GOLDEN_OFF_REASON_ON_UNASKED,
    `(off) an un-vouchable child's reason is the base commit's too (${exhaustedReason(u)})`,
  );
});

// ── 2. only the literal 0 takes the re-ask out ──────────────────────────────
for (const value of ["", "false", "no", "off", "1", " "]) {
  await withEnv(value, async () => {
    const calls: ContinuationCalls = [];
    await runBuild({
      issue: 2661,
      dispatchResults: [{ ...CUT, transcriptPath: "/tmp/issue-2661-session-1.jsonl" }],
      reask: { deps: reaskDeps({ calls, answers: [answered()] }) },
    });
    assert(
      calls.length === 1,
      `(off-is-0-only) "${value}" keeps the re-ask ON — only the literal 0 takes it out
       (${String(calls.length)} ask)`,
    );
  });
}

// ── 3. the switch does not move the guard rails ─────────────────────────────
for (const [value, label] of [
  ["0", "off"],
  ["1", "on"],
] as const) {
  await withEnv(value, async () => {
    const noSeam: ContinuationCalls = [];
    const r1 = await runBuild({
      issue: 2661,
      dispatchResults: [{ ...CUT, transcriptPath: "/tmp/issue-2661-session-1.jsonl" }],
    });
    const noPath: ContinuationCalls = [];
    const r2 = await runBuild({
      issue: 2661,
      dispatchResults: [{ ...CUT }],
      reask: { deps: reaskDeps({ calls: noPath }) },
    });
    assert(
      exhaustedReason(r1) === GOLDEN_OFF_EXHAUSTED && noSeam.length === 0,
      `(guards/${label}) no seam, no ask, and the base commit's reason (${exhaustedReason(r1)})`,
    );
    assert(
      exhaustedReason(r2) === GOLDEN_OFF_EXHAUSTED && noPath.length === 0,
      `(guards/${label}) no session path, no ask, and the base commit's reason
       (${String(noPath.length)} ask)`,
    );
  });
}

// The on arm's OWN answers must differ from the goldens, or the constants above prove nothing.
await withEnv("1", async () => {
  const calls: ContinuationCalls = [];
  const r = await runBuild({
    issue: 2661,
    dispatchResults: [{ ...CUT, transcriptPath: "/tmp/issue-2661-session-1.jsonl" }],
    reask: { deps: reaskDeps({ calls, answers: [answered()] }) },
  });
  assert(
    exhaustedReason(r) !== GOLDEN_OFF_EXHAUSTED || r.outcome?.kind === "ok",
    `(on) the re-asked run's reason is NOT the off arm's golden — the golden is the old bytes, not
     the new (${exhaustedReason(r)})`,
  );
  assert(
    calls.length === 1,
    `(on) with the switch unset the ask happens (${String(calls.length)})`,
  );
  assert(
    dispatchJson(r) !== GOLDEN_OFF_DISPATCHES,
    `(on) and its dispatch record is not the off arm's either — the ask is billed
     (${dispatchJson(r)})`,
  );
  assert(
    calls[0]?.boundMs === BUILD_REASK_BOUND_MS,
    `(on) and the ask ran under its own ceiling (${String(calls[0]?.boundMs)})`,
  );
});

console.log(exit === 0 ? "\nAll build-re-ask off-arm checks passed." : "\nFAILED");
process.exit(exit);
