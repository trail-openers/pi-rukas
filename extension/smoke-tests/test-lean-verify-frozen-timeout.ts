#!/usr/bin/env bun
/**
 * lean/verify — a frozen test that HANGS at head is a red, not a hand-back.
 *
 * `frozenTestFailure` runs every frozen file through `runTestFile`, and that
 * classifier calls a wall-clock kill `infra`. For an ordinary test that reading is
 * right — nothing was observed, so no verdict may be recorded. A FROZEN file is not
 * ordinary: `runTestPipeline` commits only files it proved red against the base, so
 * membership in the frozen contract is itself the proof that this file was red and
 * named when it was frozen. A build that makes the head's code hang therefore earns
 * a build round, exactly as a frozen test that exits non-zero does; handing the run
 * back ended it over a hang the developer can fix.
 *
 * What stays a hand-back is a run in which nobody ran anything else at all: a
 * runner that could not be STARTED (`ENOENT`) and a template with nothing to run.
 *
 *   (a) a hanging frozen test -> red whose reason leads with the timeout wording
 *   (b) the FIRST hang ends the tier: one runner invocation, and the reason counts
 *       the frozen file it did not run
 *   (c) an un-startable runner still throws
 *   (d) the baseline-excuse arm grades the same red instead of throwing, and does
 *       NOT pay a second bound for it
 *   (e) the other arm still hands back: an un-startable runner on a red base
 *   (f) a hang keeps the plainly-red frozen file it already judged, and still costs
 *       one bound
 *
 * The hang is a real `sh` spawn past a real bound (500ms), never a stubbed rejection,
 * so the kill, the `killed`/`timedOutKill` stamps and the classification all come
 * from the executor.
 */

import { FROZEN_TIMEOUT_HEAD } from "../src/lean/verify-steps.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";
import {
  PASS_TIER,
  RED_ACCEPTANCE_TEST,
  ROOTS,
  pytestFailTier,
  runVerify,
} from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A frozen test that echoes its own path and then never returns.
 *
 * It names itself before the hang so an `unclear` reading is impossible, and it is
 * committed with the record's own sha, so the step's tamper guard agrees it is the
 * file that was frozen and the only thing the case can observe is the hang.
 */
function hangingTest(rel: string): string {
  return `#!/bin/sh\necho "not ok - ${rel}" 1>&2\nsleep 30\n`;
}

/**
 * The frozen contract of the baseline-arm cases: it names itself and then never
 * returns. Unlike `RED_ACCEPTANCE_TEST`, whose non-zero exit the fixture's naming
 * runner reports, this file can reach the caller no way but a timeout — so the
 * reason the arm reports is unambiguously the graded hang and not a red exit.
 */
const HANGING_ACCEPTANCE_TEST = hangingTest("tests/AC1-retry.test.sh");

// ---------------- (a) a frozen test that hangs at head is a red naming the timeout
{
  const r = await runVerify({
    issue: 401,
    config: { fast: PASS_TIER },
    extraFrozen: { "tests/AC2-hang.test.sh": hangingTest("tests/AC2-hang.test.sh") },
    timeoutMs: 500,
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.threw === undefined && r.outcome?.kind === "red",
    `(a) a frozen test that hangs is graded red, not thrown (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_TIMEOUT_HEAD),
    `(a) the reason leads with the timeout wording, so it survives a clip (${reason.slice(0, 120)})`,
  );
  assert(
    reason.includes("the head's code may hang"),
    `(a) the reason tells the next builder to look for a hang (${reason.slice(0, 120)})`,
  );
  assert(
    reason.includes("tests/AC2-hang.test.sh"),
    `(a) the reason names the frozen file that hung (${reason.slice(0, 160)})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(a) a red records no verified head");
}

// ---------------- (b) the first hang ends the tier: one bound, the rest counted
{
  // A wall-clock kill costs the WHOLE bound, and the files after it would each cost
  // another, serially, for a reason that says the same thing about all of them. So the
  // tier stops at the first kill. Counted by INVOCATIONS rather than wall clock: timing
  // this would pay the second bound to prove it was not paid.
  const r = await runVerify({
    issue: 402,
    config: { fast: PASS_TIER },
    extraFrozen: {
      "tests/AC2-hang-a.test.sh": hangingTest("tests/AC2-hang-a.test.sh"),
      "tests/AC3-hang-b.test.sh": hangingTest("tests/AC3-hang-b.test.sh"),
    },
    timeoutMs: 500,
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "red",
    `(b) two hung frozen files are still one red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.frozenRuns === 2,
    `(b) exactly one kill: the fixture's own test plus the hung one, and the second hang was never run (got ${String(r.frozenRuns)} frozen runs)`,
  );
  assert(
    reason.includes("tests/AC2-hang-a.test.sh"),
    `(b) the reason still names the frozen file that hung (${reason.slice(0, 200)})`,
  );
  assert(
    reason.includes("1 other frozen file not run"),
    `(b) the reason says a frozen file was skipped rather than implying all ran (${reason.slice(0, 200)})`,
  );
  assert(
    !reason.includes("tests/AC3-hang-b.test.sh"),
    `(b) a file nobody ran is not accused of hanging (${reason.slice(0, 200)})`,
  );
}

// ---------------------- (c) a runner that never started still throws: infra
{
  const r = await runVerify({
    issue: 403,
    config: { fast: PASS_TIER },
    frozenRunner: "no-such-test-runner {file}",
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(c) a runner that cannot start still throws VerifyInfraError (got ${r.outcome?.kind ?? `${r.threw?.name}: ${r.threw?.message}`})`,
  );
  assert(
    (r.threw?.message ?? "").includes("could not be judged"),
    `(c) the throw still says the frozen test could not be judged (${r.threw?.message})`,
  );
  assert(r.outcome === undefined, "(c) an un-startable runner records no verdict");
}

// ------------- (d) the baseline-excuse arm grades the same red instead of throwing
{
  // A tier red at HEAD twice, over a base that carries OTHER bytes at the run's
  // frozen path: the probe sees a red base, and the arm re-runs the frozen
  // contract before it may excuse the tier. The same hang recurs there, so the
  // graded red has to be applied at that call site too or the run throws anyway.
  const r = await runVerify({
    issue: 404,
    frozenText: HANGING_ACCEPTANCE_TEST,
    // A mainline that carries a failing copy of the run's own gate is the only
    // answer that takes the run down this arm; without the bytes at the frozen path
    // the probe says "the base never had this contract" and the tier's own red is
    // what stands, which is a different case and not this one.
    baseRedContract: true,
    config: { fast: pytestFailTier("hang", ["tests/base-red.test.py::test_fails"]) },
    headTierRedRuns: 2,
    headTierOutput: "FAILED tests/base-red.test.py::test_fails - AssertionError",
    baseTierOutput: "FAILED tests/base-red.test.py::test_fails - AssertionError",
    baseBlobBytes: "a different gate the mainline authored\n",
    timeoutMs: 500,
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.threw === undefined && r.outcome?.kind === "red",
    `(d) a hung frozen test on the baseline arm is graded red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_TIMEOUT_HEAD),
    `(d) the baseline arm's red carries the timeout wording too (${reason.slice(0, 120)})`,
  );
  assert(
    reason.includes("tests/AC1-retry.test.sh"),
    `(d) the arm's red names the frozen file it hung on (${reason.slice(0, 160)})`,
  );
  assert(
    !reason.startsWith("baseline red:"),
    `(d) a contract nobody could run is not excused as the mainline's own (${reason.slice(0, 120)})`,
  );
  // The arm sits behind the main path's own frozen run, which hung here. A re-run of
  // the contract would pay the bound a second time in the same verify for a verdict
  // already observed — so the arm reuses it, and the counter is the evidence.
  assert(
    r.frozenRuns === 1,
    `(d) a hang already graded by the main path is not run again by the baseline arm (got ${String(r.frozenRuns)} frozen run(s))`,
  );
}

// ------------ (e) the other arm still hands back: an un-startable runner on a red base
{
  const r = await runVerify({
    issue: 405,
    frozenText: RED_ACCEPTANCE_TEST,
    alwaysRedFrozen: true,
    config: { fast: pytestFailTier("hang", ["tests/base-red.test.py::test_fails"]) },
    headTierRedRuns: 2,
    headTierOutput: "FAILED tests/base-red.test.py::test_fails - AssertionError",
    baseTierOutput: "FAILED tests/base-red.test.py::test_fails - AssertionError",
    baseBlobBytes: "a different gate the mainline authored\n",
    frozenRunner: "no-such-test-runner {file}",
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(e) the baseline arm still throws for an un-startable runner (got ${r.outcome?.kind ?? `${r.threw?.name}: ${r.threw?.message}`})`,
  );
}

// ------- (f) a hang keeps the plain failure it already judged, and costs one bound
{
  // The fixture's own frozen test (which exits 1) sorts before the hang, so it is
  // judged first and its clause must ride along with the timeout wording: a second
  // defect nobody was told about waits for a whole round to be paid for it. The file
  // sorted after the hang is named by count, not run.
  const r = await runVerify({
    issue: 406,
    config: { fast: PASS_TIER },
    extraFrozen: {
      // Names ITSELF as it fails, so it is a plain red and not an `unclear`.
      "tests/AC2-plain-red.test.sh":
        "#!/bin/sh\necho 'not ok - tests/AC2-plain-red.test.sh' 1>&2\nexit 1\n",
      "tests/AC3-hang.test.sh": hangingTest("tests/AC3-hang.test.sh"),
    },
    timeoutMs: 500,
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.threw === undefined && r.outcome?.kind === "red",
    `(f) a hang beside a plain red is still one red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    reason.startsWith(FROZEN_TIMEOUT_HEAD),
    `(f) the reason still leads with the timeout wording (${reason.slice(0, 120)})`,
  );
  assert(
    reason.includes("tests/AC3-hang.test.sh") && reason.includes("tests/AC2-plain-red.test.sh"),
    `(f) the reason names the hung file AND the plainly-red one it had already judged (${reason.slice(0, 220)})`,
  );
  // The three frozen files this case holds are the fixture's own (which exits 1), the
  // plainly-red one, and the hang — so three runs, ONE of them a kill, is the whole
  // claim: the plain verdicts before the hang were collected, and nothing ran after it.
  assert(
    r.frozenRuns === 3,
    `(f) both plain reds ran, the hang was the ONE kill, and nothing ran past it (got ${String(r.frozenRuns)} frozen runs)`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
