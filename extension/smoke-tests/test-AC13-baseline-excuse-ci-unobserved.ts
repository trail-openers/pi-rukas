#!/usr/bin/env bun
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
/**
 * #2042 — `ci` never excuses a full-tier run that observed nothing.
 *
 * `verify` reaches its baseline excuse only behind `tierObserved`: a killed,
 * un-startable or buffer-overflowed run is not evidence about which tests failed, so
 * the tier's own red stands. `ci`'s full-tier arm had no equivalent guard: a run
 * that overflowed its output buffer rejects with `code: 1` AND an `overflow` stamp,
 * `ci-tier` reads the numeric code as an ordinary red, and the truncated stream was
 * handed straight to the excuse — so the names printed before the cut could grade a
 * green while the omitted half held the failure this run authored.
 *
 * Three no-observation shapes must stay RED with no record, and the observed pair
 * below is the control that keeps the guard from being a blanket refusal.
 */
import { ciTierObserved } from "../src/lean/ci-excuse.ts";
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";

const SELF = "test-AC13-baseline-excuse-ci-unobserved.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = ["tests/x_test.py::test_a", "tests/x_test.py::test_b"];
/** Both runs name the SAME tests — the shape that earns an excuse when both saw the work. */
const STREAM = NAMES.map((n) => `FAILED ${n} - AssertionError`).join("\n");
const FULL = "sh -c 'pytest'";

/** The record `verify` writes for an excused tier, so the reuse arm is the one asked. */
function record(): PreexistingTierRecord {
  return {
    cmd: FULL,
    names: NAMES,
    total: NAMES.length,
    baseSha: "b".repeat(40),
    baseNames: NAMES,
  };
}

/** Every shape `ciTierObserved` must say `false` for, while the stream names the base's tests.
 *  A kill or an un-startable command is `tierFailure`'s own infrastructure throw, so the
 *  shape that tests THIS guard is an overflow whose `code` is numeric — the one shape the
 *  step treats as an ordinary red and used to hand to the excuse. */
const UNOBSERVED: Record<string, unknown> = {
  // The executor's overflow stamp beside a numeric exit: `wasKilled` reads the
  // numeric `code` as no-signal and `timedOutKill` is absent, so this is a red, not
  // a throw, and it is the only route to the excuse from an unobserved run.
  overflow: Object.assign(new Error("maxBuffer exceeded"), {
    code: 1,
    overflow: "stdout",
    stdout: STREAM,
    stderr: "",
  }),
  killed: Object.assign(new Error("was killed"), { killed: true, code: 1, stdout: STREAM }),
  neverStarted: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT", stdout: STREAM }),
};

// A rejection that stamped NOTHING at all — no `code`, no kill, no `overflow`, no
// `ENOENT` — is not an observed run either. `wasKilled` and `neverStarted` both answer
// no for it, so the guard used to call it observed and hand its stream to the excuse:
// the same reading `verify`'s `confirmTierRedFrom` refuses by requiring a numeric `code`.
// It cannot be driven through the step, because `tierFailure` throws such a rejection
// back as an infrastructure error before the excuse is reached, so the predicate itself
// is asked.
// is asked. `JSON.stringify` renders all four the same, so the label is `String(shape)`.
for (const unstamped of [new Error("boom"), {}, null, undefined]) {
  assert(
    ciTierObserved(unstamped) === false,
    `(unstamped) ${String(unstamped)} is not an observed run`,
  );
}

for (const [shape, reject] of Object.entries(UNOBSERVED)) {
  const r = await run({
    full: FULL,
    // The reuse arm is what the guard governs: with a record on the log the tier
    // would otherwise be graded green off this very stream.
    reuseRecord: record(),
    tierFails: reject,
  });
  const rec = (r.outcome as { preexistingFailures?: Record<string, unknown> } | undefined)
    ?.preexistingFailures;
  assert(
    r.outcome?.kind === "red" || r.threw !== undefined,
    `(${shape}) an unobserved full tier stays red or hands back, never an excused green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  if (shape === "overflow") {
    // The overflow is the case this guard exists for: it must reach the step as a
    // RED (a throw would be tierFailure's kill arm answering, not this guard).
    assert(
      r.outcome?.kind === "red",
      `(overflow) the tier's red is a verdict the step records, not an infra throw (${r.threw?.message ?? r.outcome?.kind})`,
    );
    assert(
      (r.outcome?.reason ?? "").includes("exited 1"),
      `(overflow) and today's red reason stands (${(r.outcome?.reason ?? "").slice(0, 90)})`,
    );
  }
  assert(
    rec === undefined || rec.full === undefined,
    `(${shape}) nothing is recorded as pre-existing (${JSON.stringify(rec?.full ?? null)})`,
  );
}

// The positive control: the same streams, on a run that really exited 1, still excuse.
{
  const r = await run({ full: FULL, tierExit: 1, tierStdout: STREAM, reuseRecord: record() });
  assert(
    r.outcome?.kind === "green",
    `(observed) a full tier that really ran red still excuses (${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  assert(
    (r.outcome as { preexistingFailures?: Record<string, unknown> } | undefined)
      ?.preexistingFailures?.full !== undefined,
    "(observed) and the observed run's proof is recorded",
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
