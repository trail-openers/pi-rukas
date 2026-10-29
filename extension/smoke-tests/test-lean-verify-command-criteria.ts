#!/usr/bin/env bun
/**
 * lean/verify — the `command` criteria tier (#1908, epic #1883).
 *
 * A preservation criterion ("the existing reposition smoke tests still pass") can
 * NEVER be red on the base, so `specify`'s coverage rule must not demand a red
 * test for it — and `verify` must actually RUN it, or the PR body says "not
 * executed" and the whole class of regression goes unchecked. That was AC2 of the
 * #1908 run: `/plan` gave the criterion `verify: "command"`, lean never executes
 * `command` criteria, and the run declined.
 *
 * The rules this pins, all against the real `verifyOutcome` with real git and
 * real processes (`lib/lean-verify-command-fixture.ts`):
 *
 *   (a) a `command` criterion whose `command` is an existing repo-relative test
 *       path runs at HEAD through the same `verify.test` runner a frozen test
 *       uses, and exit 0 is its pass condition;
 *   (b) a non-zero exit is a RED whose reason is
 *       `criterion <id> (command <path>) failed: <detail>`;
 *   (c) a `command` that is not an existing repo test path (absolute, traversal,
 *       `node_modules/`, a shell string, a missing file) is NEVER executed and is
 *       NEVER a verdict — no throw, no red, nothing recorded;
 *   (d) an infra proof (a runner that cannot start) THROWS as a frozen test's
 *       does, and a spec with command criteria but no configured runner throws
 *       too — an unobserved run is not evidence the code is wrong;
 *   (e) the green record names the criteria it ran, which is the only thing that
 *       lets publish-body print `passed (command)`;
 *   (f) an unreadable spec yields no command criteria and changes no verdict;
 *   (g) `specify`'s coverage rule still asks for red tests for `verify: "test"`
 *       criteria ONLY — a command criterion never earns a `has no red test`.
 */

import { commandCriterionProblem } from "../src/lean/verify-commands.ts";
import {
  GREEN_FILE,
  ROOTS,
  bodyWith,
  redFile,
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

// ------------------------------------- (a) a runnable command criterion runs, green
{
  const r = await runCommandVerify({
    issue: 401,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    files: { [CMD_FILE]: GREEN_FILE },
  });
  assert(
    r.outcome?.kind === "green",
    `(a) a green command criterion leaves verify green (got ${String(r.outcome?.kind)}: ${String(r.outcome?.reason ?? r.threw?.message)})`,
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === "passed",
    "(a) the green record names AC2 as a command criterion the gate executed",
  );
}

// --------------------------------------------- (b) a failing command criterion is red
{
  const r = await runCommandVerify({
    issue: 402,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    files: { [CMD_FILE]: redFile(CMD_FILE) },
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "red",
    `(b) a command criterion that exits non-zero makes verify red (got ${String(r.outcome?.kind)})`,
  );
  assert(
    reason.includes(`criterion AC2 (command ${CMD_FILE}) failed:`),
    `(b) the red reason is the promised shape (${JSON.stringify(reason.slice(0, 160))})`,
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === undefined,
    "(b) a criterion that failed is NOT recorded as passed",
  );
}

// ------------------- (c) a command that is not a repo test path is never executed
{
  const notPaths: [string, string | undefined][] = [
    ["absolute", "/etc/passwd"],
    ["traversal", "../outside.test.sh"],
    ["node_modules", "node_modules/evil.test.sh"],
    [".pi", ".pi/hooks.test.sh"],
    [".git", ".git/hooks.test.sh"],
    ["a shell string", "sh -c 'exit 1'"],
    ["a pipeline", "true | false"],
    ["flags, not a path", "bun test --timeout=0"],
    ["empty", "   "],
  ];
  for (const [label, cmd] of notPaths) {
    const problem = commandCriterionProblem(cmd);
    assert(
      problem !== undefined,
      `(c) the validator refuses ${label} (${JSON.stringify(cmd)}) — ${JSON.stringify(problem)}`,
    );
  }
  assert(
    commandCriterionProblem(CMD_FILE) === undefined,
    "(c) the validator accepts a plain repo-relative test path",
  );
  assert(
    commandCriterionProblem("./tests//AC2-preserve.test.sh") !== undefined,
    "(c) the validator refuses a non-normalised spelling of an otherwise good path",
  );
}

{
  // The gate's own behaviour on a shell-shaped command: no run, no verdict, no
  // throw. An executed `sh -c 'exit 1'` out of an issue body would be the
  // injection this rule exists to stop; a red would blame the developer.
  const r = await runCommandVerify({
    issue: 403,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "sh -c 'exit 1'" }]),
  });
  assert(
    r.outcome?.kind === "green" && r.threw === undefined,
    `(c) a shell-shaped command is never executed: verify stays green, not red, not thrown (got ${String(r.outcome?.kind)})`,
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === undefined,
    "(c) an unexecuted command criterion is absent from the record, so the body cannot print passed (command)",
  );
}

{
  // A path-shaped command naming a file HEAD does not hold: also never executed.
  const r = await runCommandVerify({
    issue: 404,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "tests/absent.test.sh" }]),
  });
  assert(
    r.outcome?.kind === "green" && r.outcome?.commandCriteria?.AC2 === undefined,
    "(c) a command naming a file that does not exist is treated like manual, never executed",
  );
}

// -------------------------------------- (d) an infra proof throws, as frozen tests do
{
  // A template whose EXECUTABLE does not exist: `execFile` rejects with a string
  // ENOENT code and no exit status — the shape `neverStarted` calls infra. Nobody
  // ran anything, so no verdict may be recorded about the work.
  const r = await runCommandVerify({
    issue: 405,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    files: { [CMD_FILE]: GREEN_FILE },
    testTemplate: "definitely-not-a-real-binary-405 {file}",
  });
  assert(
    r.threw !== undefined,
    `(d) a command criterion whose runner cannot start THROWS (got outcome ${String(r.outcome?.kind)})`,
  );
  assert(
    r.threw?.message.includes("could not be judged") === true,
    `(d) the throw names the criterion it could not judge (${JSON.stringify(r.threw?.message)})`,
  );
}

{
  // The safety-critical direction of the not-runnable rule: a `command` whose
  // text IS a shell one-liner that would fail if it were ever run. The gate must
  // leave the run green — neither executing it (arbitrary text out of an issue
  // body) nor red-lining the developer for a check it refused to make.
  const r = await runCommandVerify({
    issue: 407,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "false" }]),
  });
  assert(
    r.outcome?.kind === "green" && r.threw === undefined,
    `(d) an unrunnable command never turns a green run red, and never throws (${JSON.stringify({ kind: r.outcome?.kind, threw: r.threw?.message })})`,
  );
  assert(
    r.outcome?.commandCriteria === undefined,
    "(d) and nothing is recorded as executed, so the body cannot print passed (command)",
  );
}

// --------------------------- (e) only the gate's own record licenses "passed"
{
  const { publishBody } = await import("../src/lean/publish-body.ts");
  const spec = {
    problem: "p",
    size: "S" as const,
    criteria: [
      { id: "AC1", text: "retried", verify: "test" as const },
      { id: "AC2", text: "preserved", verify: "command" as const, command: CMD_FILE },
      { id: "AC3", text: "unrunnable", verify: "command" as const, command: "rm -rf /" },
    ],
  };
  const base = {
    issue: 1908,
    spec,
    tests: { AC1: ["tests/AC1.test.sh"] },
    verifyKind: "green" as const,
    verifiedHead: "a".repeat(40),
    version: "1.2.3",
    models: {},
    baseSha: "b".repeat(40),
  };
  const body = publishBody({ ...base, commandCriteria: ["AC2"], draft: false });
  assert(body.includes("| passed (command) |"), "(e) a command the gate ran reads passed (command)");
  assert(
    body.includes("| not runnable (command is not a repo test path) |"),
    "(e) a command the gate refused to run says it was not runnable",
  );
  assert(
    !body.includes("| command | `tests/AC2-preserve.test.sh` | green |"),
    "(e) a command row never borrows the gate's overall verdict",
  );
  const noRecord = publishBody({ ...base, draft: true });
  assert(
    !noRecord.includes("passed (command)"),
    "(e) with no verify record at all, no command row claims it passed",
  );
}

// ------------------------------------- (f) an unreadable spec changes no verdict
{
  const r = await runCommandVerify({
    issue: 406,
    implement: true,
    specBody: "there is no pi-spec block here at all",
  });
  assert(
    r.outcome?.kind === "green" && r.threw === undefined,
    `(f) an unusable spec yields no command criteria and does not change the verdict (got ${String(r.outcome?.kind)})`,
  );
  assert(
    r.outcome?.commandCriteria === undefined,
    "(f) nothing is recorded as executed when no spec could be read",
  );
}

// ------------- (g) specify's coverage rule asks for reds of TEST criteria only
{
  const { testCriteria } = await import("../src/lean/specify-prompt.ts");
  const { parsePiSpec } = await import("../src/lean/spec.ts");
  const parsed = parsePiSpec(
    bodyWith([
      TEST_CRITERION,
      { ...COMMAND_CRITERION, command: CMD_FILE },
      { id: "AC3", text: "the docs name the flag", verify: "manual" },
    ]),
  );
  assert(parsed.ok === true, "(g) the three-kind spec parses");
  const wanted = testCriteria((parsed as { spec: { criteria: unknown[] } }).spec);
  assert(
    wanted.length === 1 && wanted[0]?.id === "AC1",
    `(g) the criteria a red test is required of are the verify:"test" ones alone (got ${wanted.map((c) => `${c.id}/${c.verify}`).join(", ")})`,
  );
  assert(
    wanted.every((c) => c.verify === "test"),
    "(g) no command or manual criterion can ever be demanded as a red test",
  );
}

for (const dir of ROOTS) {
  try {
    // Best effort: the OS reaps the temp root; a leak here is noise, not a failure.
    void dir;
  } catch {
    /* ignore */
  }
}

process.exit(exit);
