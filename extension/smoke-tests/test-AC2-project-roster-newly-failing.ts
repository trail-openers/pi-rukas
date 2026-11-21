#!/usr/bin/env bun
/**
 * #2428 AC2 — a test the base passed and head fails is a builder-fixable RED naming the test, and a
 * test that already failed at the base is not charged to this run.
 *
 * The whole value of a per-test roster over a tier's exit code is this pair. An exit code says the
 * suite is red; only the per-test comparison says whether THIS run made it red. Without it, either
 * half fails: charge base-failing tests and every run on a project with a flaky suite dies before it
 * builds; don't charge base-passing ones and the run that broke a test lands green.
 *
 * "Builder-fixable" is the point of the wording: the reason must name the test the developer can go
 * and look at, and the run must come back as a red the engine bills as a build round rather than an
 * infra hand-back it cannot act on.
 */
import { rmSync } from "node:fs";
import type { ProjectRosterRecord } from "../src/lean/state-outcome-maps.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { PASS_TIER } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC2-project-roster-newly-failing.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const FILE = "tests/test-a.sh";
/** The base ran three and one of them was already broken there. */
const BASE_PASSED = ["tests/test-a.sh::green_at_base", "tests/test-a.sh::also_green"];
const BASE_FAILED = ["tests/test-a.sh::broken_before_this_run"];
const NEWLY_FAILING = "tests/test-a.sh::green_at_base";

{
  // The regression: green at the base, red at head. The run is red, the reason names the test, and
  // the record keeps the base-failing name out of what this run is charged for.
  const r = await runVerify({
    issue: 2440,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: BASE_PASSED,
      baseFailed: BASE_FAILED,
      headPassed: ["tests/test-a.sh::also_green"],
      headFailed: [NEWLY_FAILING, ...BASE_FAILED],
    },
  });
  assert(
    r.outcome?.kind === "red",
    `(regression) base-pass then head-fail is red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  const reason = r.outcome?.reason ?? "";
  assert(
    reason.includes(NEWLY_FAILING),
    `(regression) the reason names the test the builder must fix (${reason.slice(0, 160)})`,
  );
  assert(
    !reason.includes(BASE_FAILED[0]),
    `(regression) the reason does not blame this run for a test the base already failed (${reason.slice(0, 160)})`,
  );
  assert(
    /base/i.test(reason) && /broke|broke them|this run/i.test(reason),
    `(regression) the reason says the RUN broke it, not the project (${reason.slice(0, 160)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    roster === undefined || !roster.passed.includes(NEWLY_FAILING),
    `(regression) the red's roster never records the failing test as passed`,
  );
  assert(
    r.outcome !== undefined && r.outcome.verifiedHead === undefined,
    `(regression) a red certifies no head (${String(r.outcome.verifiedHead)})`,
  );
}

{
  // The pre-existing half: everything head failed, the base also failed. No regression exists, so no
  // red may be charged for one, and the tier's own red is what the baseline excuse already governs.
  const r = await runVerify({
    issue: 2441,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      basePassed: [],
      baseFailed: [...BASE_PASSED, ...BASE_FAILED],
      headPassed: [],
      headFailed: [...BASE_PASSED, ...BASE_FAILED],
    },
  });
  assert(
    r.outcome?.kind === "green",
    `(pre-existing) a suite red at base and identically red at head is not charged to this run (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 140)})`,
  );
  const roster = r.outcome?.projectRoster as ProjectRosterRecord | undefined;
  assert(
    JSON.stringify(roster?.baseFailed) === JSON.stringify([...BASE_PASSED, ...BASE_FAILED]),
    `(pre-existing) the record still shows what the base failed, so the green is honest (${JSON.stringify(roster?.baseFailed)})`,
  );
  assert(
    (roster?.failed.length ?? 0) === [...BASE_PASSED, ...BASE_FAILED].length,
    "(pre-existing) and shows head failed the same names, without hiding them",
  );
}

{
  // The distinction that makes it a roster and not an exit code: the SAME failing name, once charged
  // and once not, decided only by what the base did. Flip one name's base verdict and the answer flips.
  // The pair runs head-failing the SAME name; only the base's verdict on it differs. Charging one and
  // not the other is the whole difference between a roster and an exit code, so the two runs have to
  // answer differently — and neither may be the lazy answer of "everything failing is this run's".
  const headFails = [NEWLY_FAILING, ...BASE_FAILED];
  const charged = await runVerify({
    issue: 2442,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      // The base ran all three and passed all three, so nothing head failed was already broken.
      basePassed: [NEWLY_FAILING, ...BASE_FAILED],
      baseFailed: [],
      headPassed: [],
      headFailed: headFails,
    },
  });
  const spared = await runVerify({
    issue: 2443,
    implement: true,
    config: { fast: PASS_TIER },
    roster: {
      files: [FILE],
      // The same two failures, but the base was already red on both of them.
      basePassed: [],
      baseFailed: headFails,
      headPassed: [],
      headFailed: headFails,
    },
  });
  assert(
    charged.outcome?.kind === "red",
    `(flip) a name the base passed and head fails is charged (got ${charged.outcome?.kind ?? `threw: ${charged.threw?.message}`})`,
  );
  assert(
    spared.outcome?.kind === "green",
    `(flip) the same failing name the base also failed is not charged (got ${spared.outcome?.kind ?? `threw: ${spared.threw?.message}`}; ${(spared.outcome?.reason ?? "").slice(0, 120)})`,
  );
  assert(
    (charged.outcome?.reason ?? "").includes(NEWLY_FAILING) &&
      (spared.outcome?.reason ?? "").includes(NEWLY_FAILING) === false,
    "(flip) the name appears in the charged reason and not the spared one",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
