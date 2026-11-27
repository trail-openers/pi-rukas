#!/usr/bin/env bun
/**
 * The project roster always runs: with no environment at all, and with the retired
 * `PI_ENSEMBLE_LEAN_PROJECT_ROSTER` set to anything — `"0"` included, which is ignored rather than
 * refused — `verify` builds the roster and judges the project's own tests.
 */
import { rmSync } from "node:fs";
import { withEnv } from "./lib/env-scope.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
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
 * One case run with the retired switch pinned to `value`, and the environment put back exactly as found.
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

const FILE = "tests/test-a.sh";
const NAMES = ["tests/test-a.sh::one", "tests/test-a.sh::two"];
/** The name `caseOf` moves from passing to failing when a case owes the step a head failure. */
const BROKEN = NAMES[1];

/**
 * The same case every run uses. Two shapes:
 *
 * - The GREEN case: a green's record is the only record the gate writes — a red carries a reason
 *   and no roster — so a run that asks to see the roster field has to ask on a green.
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

// The retired switch is ignored whatever it holds, "0" included: it is never an error and never
// takes the roster out.
for (const value of ["0", "1", "false", "off", ""]) {
  const r = await withRoster(value, () => runVerify(caseOf(2471, { headFailsOne: true })));
  assert(
    (r.rosterHeadRuns ?? 0) === 1 && (r.rosterBaseRuns ?? 0) === 1,
    `(retired) "${value}" is ignored: the roster ran the suite in both trees (${String(r.rosterHeadRuns)} head, ${String(r.rosterBaseRuns)} base)`,
  );
}
for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
