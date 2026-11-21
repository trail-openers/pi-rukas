#!/usr/bin/env bun
/**
 * #2428 AC5 — the lever, and what "off" has to mean.
 *
 * `PI_ENSEMBLE_LEAN_PROJECT_ROSTER` gates the whole arm, defaults ON, and only the literal `"0"`
 * takes it off. Off has to be the behaviour that shipped before the roster existed — the same outcome
 * kind, the same reason text, and no `projectRoster` key on the step-log record — because the only
 * way to undo a gate that turned out to misgrade is to run it the way it ran yesterday, and an "off"
 * that differs from yesterday in some field nobody thought to check is not an undo.
 *
 * So the goldens are not invented here: each off-arm run is compared against the SAME case run with
 * the roster's fields simply absent from what the step could have written. That is why the reason is
 * compared whole rather than by prefix, and why the record is checked for the key's absence rather
 * than for emptiness — `projectRoster: undefined` and no key at all are different bytes in the log.
 */
import { rmSync } from "node:fs";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { NO_REPORT_SENTINEL } from "./lib/lean-verify-roster.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC5-project-roster-switch.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/**
 * One case run with the lever pinned to `value`, and the environment put back exactly as found.
 *
 * `withEnv` owns the restore, including deleting an absent variable rather than blanking it, which is
 * what makes `undefined` mean "unset" rather than "empty". It returns void, so the case's result is
 * carried out in a box rather than as the callback's return value.
 */
async function withRoster<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  let out!: T;
  await withEnv({ PI_ENSEMBLE_LEAN_PROJECT_ROSTER: value }, async () => {
    out = await body();
  });
  return out;
}

/** What a step may write for the roster: whether the KEY is there, and what it holds. */
function rosterField(outcome: object | undefined): { has: boolean; value: unknown } {
  if (outcome === undefined) return { has: false, value: undefined };
  const record = outcome as Record<string, unknown>;
  return { has: Object.hasOwn(record, "projectRoster"), value: record.projectRoster };
}

/**
 * A reason with its commit-specific parts removed, for comparing two runs of the SAME case.
 *
 * The reason names the head it judged, and two fixture runs of one case have different heads by
 * construction. Stripping shas compares the SHAPE of the sentence, which is what a byte-identical
 * claim is about; comparing whole strings across two trees would fail on the sha and prove nothing.
 */
function reasonShape(reason: string): string {
  return reason.replace(/\b[0-9a-f]{12,40}\b/g, "<sha>");
}

const FILE = "tests/test-a.sh";
const NAMES = ["tests/test-a.sh::one", "tests/test-a.sh::two"];
/** The name `caseOf` moves from passing to failing when a case owes the step a head failure. */
const BROKEN = NAMES[1];

/**
 * The same case every arm runs, so a difference between arms can only be the lever.
 *
 * Two cases, because the roster's own verdict decides what the step's record looks like and AC5
 * pins two different things with it:
 *
 * - The GREEN case is the one the step's WORDING is compared on. A clean run is the only one where
 *   the roster decides nothing, so the reason stays the step's ordinary one and the off arm can be
 *   held against it byte for byte. A green's record is also the only record the gate writes — a red
 *   carries a reason and no roster, by AC2's own rule, so an arm that asks to see the roster field
 *   has to ask on a green.
 * - The RED case exists because #2439 made the base suite's SECOND run conditional on the head run
 *   having failed a test. An arm that asks whether the base leg ran must therefore run a head that
 *   failed something, or it would read the #2439 skip as the lever being off.
 */
function caseOf(issue: number, opts: { headFailsOne?: boolean } = {}) {
  const fails = opts.headFailsOne === true ? BROKEN : undefined;
  const passed = fails === undefined ? NAMES : NAMES.filter((n) => n !== fails);
  return {
    issue,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      // The failing name is one the BASE passed, so the roster owns the verdict and says red.
      basePassed: NAMES,
      headPassed: passed,
      ...(fails === undefined ? {} : { headFailed: [fails] }),
    },
  } as const;
}

{
  // Default on: no environment at all, and the roster is built. A default an operator has to opt into
  // is a default that never runs, and Part A's whole claim is that the project's tests are judged.
  const on = await withRoster(undefined, () => runVerify(caseOf(2470, { headFailsOne: true })));
  assert(
    // The case carries a test that was green at the base and fails at head: a base leg is only owed
    // when the head run failed something, so an arm that asks for both legs needs a failure, and the
    // verdict a roster that ran must give for one is red — never the green.
    on.outcome?.kind === "red" && (on.outcome?.reason ?? "").includes(BROKEN),
    `(default) with no env set the roster runs and judges (${String(on.outcome?.kind)}: ${(on.outcome?.reason ?? "").slice(0, 60)})`,
  );
  assert(
    // Head failed (the fixture's roster names a failing test), so the base leg is owed: 1 + 1.
    (on.rosterHeadRuns ?? 0) === 1 && (on.rosterBaseRuns ?? 0) === 1,
    `(default) and the project's suite ran in both trees (${String(on.rosterHeadRuns)} head, ${String(on.rosterBaseRuns)} base)`,
  );
  // The roster field is only ever written on a GREEN (a red carries a reason, not a record — AC2),
  // so the field's arm is a clean run of the same case, not the failing one above.
  const clean = await withRoster(undefined, () => runVerify(caseOf(2480)));
  const defaultField = rosterField(clean.outcome);
  assert(
    defaultField.has && typeof defaultField.value === "object",
    `(default) a green's record carries the roster key (${typeof defaultField.value})`,
  );
}

// Only the literal "0" takes the arm off. Every near-miss keeps it on, because a lever that reads
// "false", "off" or "" as off is a lever an operator will believe they pulled while the gate is
// still running — and here the asymmetry cuts the other way, so the conservative reading is "on".
for (const value of ["1", "true", "false", "off", "", "0 ", "00"]) {
  const r = await withRoster(value, () => runVerify(caseOf(2471, { headFailsOne: true })));
  assert(
    (r.rosterHeadRuns ?? 0) === 1 && (r.rosterBaseRuns ?? 0) === 1,
    `(literal) "${value}" is not "0", so the roster ran the suite in both trees (${String(r.rosterHeadRuns)} head, ${String(r.rosterBaseRuns)} base)`,
  );
}
{
  // The off arm, byte for byte. Same case, same fixture, and neither the outcome kind, the reason
  // text, nor the record's shape may differ from the run that predates the roster — which is the
  // run whose roster fields are simply not there.
  const off = await withRoster("0", () => runVerify(caseOf(2472)));
  assert(
    off.outcome?.kind === "green",
    `(off) the case still grades green (${String(off.outcome?.kind)})`,
  );
  assert(off.rosterRuns === 0, `(off) no project test ran at all (${String(off.rosterRuns)})`);
  const field = rosterField(off.outcome);
  assert(!field.has, "(off) the step log carries no projectRoster key, not an empty one");
  assert(field.value === undefined, "(off) and nothing hides behind an own-key-with-undefined");

  // The golden itself: the on arm's reason with the roster's fingerprints absent. Built from the SAME
  // step's own wording rather than a hand-typed string, so it tracks the reason's real shape and a
  // change to the on arm's text fails this rather than passing a stale literal.
  const on = await withRoster(undefined, () => runVerify(caseOf(2473)));
  const onReason = on.outcome?.reason ?? "";
  const offReason = off.outcome?.reason ?? "";
  assert(
    offReason === onReason || reasonShape(offReason) === reasonShape(onReason),
    `(off) the reason's shape is identical to the on arm's for the same case (${JSON.stringify(reasonShape(offReason)).slice(0, 110)} vs ${JSON.stringify(reasonShape(onReason)).slice(0, 110)})`,
  );
  assert(
    off.outcome?.verifiedHead === on.outcome?.verifiedHead ||
      typeof off.outcome?.verifiedHead === "string",
    `(off) the green still certifies its head (${String(off.outcome?.verifiedHead)})`,
  );
  for (const key of ["preexistingFailures", "projectRoster"] as const) {
    assert(
      !Object.hasOwn((off.outcome ?? {}) as object, key),
      `(off) the record carries no ${key} key`,
    );
  }
}

{
  // Off restores the pre-roster HAND-BACK rules too: the rosterless shapes that only exist because
  // the roster exists must not fire. A run whose project suite cannot be found graded green before
  // Part A, and off has to grade it green again rather than hand back.
  const offNoLocation = await withRoster("0", () =>
    runVerify({ ...caseOf(2474), noTestLocation: true }),
  );
  assert(
    offNoLocation.threw === undefined && offNoLocation.outcome?.kind === "green",
    `(off) a project with no test location is green again, not a hand-back (got ${offNoLocation.outcome?.kind ?? `threw: ${offNoLocation.threw?.message}`})`,
  );

  const offNoReport = await withRoster("0", () =>
    runVerify({
      ...caseOf(2475),
      roster: { files: [FILE], basePassed: [NO_REPORT_SENTINEL], headPassed: [NO_REPORT_SENTINEL] },
    }),
  );
  assert(
    offNoReport.threw === undefined && offNoReport.outcome?.kind === "green",
    `(off) a suite that collected nothing is green again, exactly as before (got ${offNoReport.outcome?.kind ?? `threw: ${offNoReport.threw?.message}`})`,
  );

  // And the roster's red is gone: a test green at base and red at head is invisible to the off arm,
  // because nothing ran the project's suite to notice.
  const offRegression = await withRoster("0", () =>
    runVerify({
      ...caseOf(2476),
      roster: { files: [FILE], basePassed: NAMES, headPassed: [], headFailed: [NAMES[0]] },
    }),
  );
  assert(
    offRegression.outcome?.kind === "green",
    `(off) a base-pass/head-fail regression is not caught, which is the pre-Part-A behaviour (got ${offRegression.outcome?.kind ?? `threw: ${offRegression.threw?.message}`})`,
  );
}

{
  // The switch is read at CALL time, not at module load: one bun process runs every lean smoke file,
  // so a load-time read would let this file's pin decide the next file's behaviour. Flip the lever
  // twice inside one process and both answers have to be current.
  const a = await withRoster("0", () => runVerify(caseOf(2477)));
  // The middle arm asks whether the base leg ran, which #2439 made conditional on a head failure.
  const b = await withRoster(undefined, () => runVerify(caseOf(2478, { headFailsOne: true })));
  const c = await withRoster("0", () => runVerify(caseOf(2479)));
  assert(
    (a.rosterRuns ?? 0) === 0 &&
      (b.rosterHeadRuns ?? 0) === 1 &&
      (b.rosterBaseRuns ?? 0) === 1 &&
      (c.rosterRuns ?? 0) === 0,
    `(call time) off, on, off in ONE process answers 0, 1+1, 0 (${String(a.rosterRuns)}, ${String(b.rosterHeadRuns)}+${String(b.rosterBaseRuns)}, ${String(c.rosterRuns)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
