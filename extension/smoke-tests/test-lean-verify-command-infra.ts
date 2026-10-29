#!/usr/bin/env bun
/**
 * lean/verify — what the `command` tier treats as INFRASTRUCTURE, not a verdict
 * (#1908).
 *
 * The rule the rest of the tier is built on: a result nobody observed is not
 * evidence that the code is wrong. So three shapes THROWS rather than recording
 * anything, each with the party it blames named in the message:
 *
 *   (d)  a runner that was killed, timed out or could not start — nobody saw the
 *        test, so there is no verdict to record, and the message must name the
 *        COMMAND criterion rather than the frozen test that ran first;
 *   (d2) a `git ls-tree` that cannot answer must not read as "the test is not
 *        there": the first is a machine to re-run, the second an issue to fix;
 *   (e2) a spec the gate cannot read (a forge read that rejects, a `pi-spec` block
 *        that will not parse) — running no criteria and reporting a green would be
 *        the gate claiming checks it never made, and publish would open a ready PR
 *        over criteria nobody evaluated;
 *   (e3) the tier's own bounds: more criteria than it will run, and a run that gets
 *        no share of the tier's wall clock.
 *
 * The mirror of (e2) is in `test-lean-verify-command-criteria.ts`: a body with no
 * `pi-spec` block at all is the ordinary "the spec asked for nothing" case, and
 * changes no verdict.
 */

import type { Criterion } from "../src/lean/spec.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import {
  GREEN_FILE,
  ROOTS,
  bodyWith,
  cleanupRoots,
  killedFile,
  runCommandVerify,
} from "./lib/lean-verify-command-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TEST_CRITERION = { id: "AC1", text: "a transient failure is retried", verify: "test" };
const COMMAND_CRITERION = {
  id: "AC2",
  text: "the existing reposition smoke tests still pass",
  verify: "command",
};
const CMD_FILE = "tests/AC2-preserve.test.sh";

// -------------------------------------- (d) an infra proof throws, as frozen tests do
{
  // THE command tier's own infra path, with no frozen test to blame. The frozen
  // test runs through `sh {file}` and exits 0; the command criterion's file kills
  // itself, so its runner dies on a SIGNAL with no exit status — the one shape
  // `runTestFile` returns as `kind: "infra"` (a plain non-zero exit is a verdict, a
  // kill is not). The throw can only have come from the command tier, so the
  // message must name the COMMAND criterion and not the frozen test that ran first.
  const r = await runCommandVerify({
    issue: 405,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: killedFile(CMD_FILE) },
    testTemplate: "sh {file}",
  });
  assert(
    r.threw !== undefined,
    `(d) a command criterion whose runner was killed THROWS (got outcome ${String(r.outcome?.kind)})`,
  );
  assert(
    r.threw?.message.includes("could not be judged") === true &&
      r.threw?.message.includes("AC2") === true &&
      r.threw?.message.includes("AC1-retry") === false,
    `(d) the throw names the COMMAND criterion, not the frozen test (${JSON.stringify(r.threw?.message)})`,
  );
}

{
  // Two more ways the tier's own machinery can fail, both infrastructure: no
  // runner template at all (`frozenTestFailure` would refuse first through the
  // step, so the tier is driven directly), and a `git ls-tree` that cannot answer.
  // "Could not tell" must never read as "the test is not there" — the first is a
  // machine to re-run, the second an issue to fix.
  const { commandCriteriaOutcome } = await import("../src/lean/verify-commands.ts");
  const criterion: Criterion[] = [
    { id: "AC9", text: "preserved", verify: "command", command: CMD_FILE },
  ];
  // Typed stubs, not `as never`: an executor the compiler can check still speaks
  // the step's own `VerifyExec` shape, so a signature change here fails here.
  const silent: VerifyExec = async () => ({ stdout: "", stderr: "" });
  const refusing: VerifyExec = async () => {
    throw new Error("git refused");
  };
  let noTemplate: Error | undefined;
  let unreadable: Error | undefined;
  try {
    await commandCriteriaOutcome(criterion, undefined, "/nonexistent-wt", "b".repeat(40), silent);
  } catch (err) {
    noTemplate = err as Error;
  }
  try {
    await commandCriteriaOutcome(
      criterion,
      "sh {file}",
      "/nonexistent-wt",
      "b".repeat(40),
      refusing,
    );
  } catch (err) {
    unreadable = err as Error;
  }
  assert(
    noTemplate?.message.includes("command criteria") === true,
    `(d) the tier's own no-template throw names the command criteria (${JSON.stringify(noTemplate?.message)})`,
  );
  assert(
    unreadable?.message.includes("could not read the tree entry") === true,
    `(d) an unreadable tree entry THROWS instead of reporting the test absent (${JSON.stringify(unreadable?.message)})`,
  );
}

{
  // The safety-critical direction of the not-runnable rule: a `command` whose text
  // IS a shell one-liner that would fail if it were ever run. The gate must leave
  // the run green — neither executing arbitrary text out of an issue body nor
  // red-lining the developer for a check it refused to make.
  const r = await runCommandVerify({
    issue: 407,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "false" }]),
  });
  assert(
    r.outcome?.kind === "green" &&
      r.threw === undefined &&
      r.outcome?.commandCriteria === undefined,
    `(d) an unrunnable command never turns a green run red, never throws, records nothing (${JSON.stringify({ kind: r.outcome?.kind, threw: r.threw?.message })})`,
  );
}

// ------------------------------------- (e) an unreadable spec changes no verdict
{
  const r = await runCommandVerify({
    issue: 406,
    implement: true,
    specBody: "there is no pi-spec block here at all",
  });
  assert(
    r.outcome?.kind === "green" &&
      r.threw === undefined &&
      r.outcome?.commandCriteria === undefined,
    `(e) an unusable spec yields no command criteria, no record, and no changed verdict (got ${String(r.outcome?.kind)})`,
  );
}

// ----------------- (e2) a spec the gate CANNOT read is infrastructure, not silence
//
// The other direction from (e). A read that rejects tells the gate nothing about
// which command criteria the spec asked for; running none and reporting a green
// would be the gate claiming a check it did not make, and `publish` would open a
// ready PR over criteria nobody evaluated. So both unreadable forms throw.
{
  const unreadable = await runCommandVerify({
    issue: 416,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE },
    specFetchThrows: true,
  });
  assert(
    unreadable.threw !== undefined &&
      /could not read the issue's spec/.test(unreadable.threw.message),
    `(e2) an issue body the gate cannot fetch THROWS, naming the read (got ${String(unreadable.outcome?.kind)}: ${String(unreadable.threw?.message)})`,
  );
  assert(
    unreadable.outcome === undefined,
    "(e2) no verdict is recorded when the spec could not be read",
  );
  const broken = await runCommandVerify({
    issue: 417,
    implement: true,
    specBody: '```pi-spec v1\n{ "problem": "x", "criteria": [\n```',
  });
  assert(
    broken.threw !== undefined &&
      /could not be read for the command criteria/.test(broken.threw.message),
    `(e2) a pi-spec block that fails to parse THROWS instead of running nothing quietly (got ${String(broken.outcome?.kind)}: ${String(broken.threw?.message)})`,
  );
}

// ------------------- (e3) the tier is bounded, and says so rather than truncating
//
// Thirty-three command criteria is not a spec anyone can review, and quietly
// running the first thirty-two would report a green over a criterion nobody
// checked; the count is named so the operator can cut the spec. And the whole tier
// shares one wall clock, so a slow file cannot hand the next one a fresh timeout.
{
  const { COMMAND_CRITERION_MAX, commandCriteriaOutcome } = await import(
    "../src/lean/verify-commands.ts"
  );
  const many: Criterion[] = Array.from({ length: COMMAND_CRITERION_MAX + 1 }, (_, i) => ({
    id: `AC${i + 1}`,
    text: `the suite ${i + 1} still passes`,
    verify: "command",
    command: CMD_FILE,
  }));
  const quiet: VerifyExec = async () => ({ stdout: "", stderr: "" });
  let tooMany: Error | undefined;
  try {
    await commandCriteriaOutcome(many, "sh {file}", "/tmp", "b".repeat(40), quiet);
  } catch (err) {
    tooMany = err as Error;
  }
  assert(
    tooMany?.message.includes(String(many.length)) === true &&
      tooMany?.message.includes(String(COMMAND_CRITERION_MAX)) === true,
    `(e3) more command criteria than the gate will run THROWS and names the count (${JSON.stringify(tooMany?.message)})`,
  );
  // The tier's budget is wall clock, so a file that never exits cannot hold it
  // open: the run gets the time the budget still has, and when that is no time at
  // all the runner dies on the timeout — infra, because nobody observed the test.
  const starved = await runCommandVerify({
    issue: 418,
    implement: true,
    specBody: bodyWith([
      TEST_CRITERION,
      { ...COMMAND_CRITERION, command: CMD_FILE },
      { id: "AC3", text: "the other suite still passes", verify: "command", command: CMD_FILE },
    ]),
    baseFiles: { [CMD_FILE]: "#!/bin/sh\nsleep 30\nexit 0\n" },
    timeoutMs: 200,
  });
  assert(
    starved.threw !== undefined && /could not be judged/.test(starved.threw.message),
    `(e3) a command run that gets no share of the tier's budget is infrastructure, not a verdict (got ${String(starved.outcome?.kind)}: ${String(starved.threw?.message)})`,
  );
    // A caller that names no timeout is NOT licence for a run to fall back to the
    // runner's own default. `TEST_TIMEOUT_MS` (120s) past the point where the tier's
    // 600s is spent is time the gate never agreed to wait, so every run is bounded by
    // what the budget still has. A real `sleep` fills the budget first, so the run
    // that follows it is genuinely late: it must die in well under a second, not the
    // runner's default two minutes.
    const { TEST_TIMEOUT_MS } = await import("../src/lean/specify-proof.ts");
    const lateStarted = Date.now();
    const late = await runCommandVerify({
      issue: 419,
      implement: true,
      specBody: bodyWith([
        TEST_CRITERION,
        { ...COMMAND_CRITERION, command: CMD_FILE },
        { id: "AC3", text: "the other suite still passes", verify: "command", command: CMD_FILE },
      ]),
      baseFiles: { [CMD_FILE]: "#!/bin/sh\nsleep 30\nexit 0\n" },
      timeoutMs: 1_000,
    });
    const lateElapsed = Date.now() - lateStarted;
    assert(
      late.threw !== undefined &&
        /could not be judged/.test(late.threw.message) &&
        lateElapsed < TEST_TIMEOUT_MS / 4,
      `(e3) a late run with no caller timeout gets the budget's remaining time, never the runner's default ${TEST_TIMEOUT_MS}ms (threw ${String(late.threw?.message)}, after ${lateElapsed}ms)`,
    );
}

// ------------- (f) specify's coverage rule asks for reds of TEST criteria only
cleanupRoots();
assert(ROOTS.length === 0, "the fixture removed its temp roots");

process.exit(exit);
