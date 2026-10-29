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
 * What a `command` may name is narrower than "a file": it states behaviour that
 * already held BEFORE this run, so the only file that can evidence it is one the
 * run's base commit already held, byte for byte, as a regular file. Two adversarial
 * shapes this pins, both reproduced against the shipped gate:
 *
 *   - a COMMITTED SYMLINK (mode 120000) pointing outside the worktree is
 *     porcelain-clean, and an `existsSync` probe follows it — so it was executed
 *     and recorded `passed`;
 *   - ANY file added at HEAD, so a developer-authored `src/wipe.sh` that deletes
 *     product code and exits 0 was recorded as a passing preservation criterion on
 *     a ready PR.
 *
 * The rules, all against the real `verifyOutcome` with real git and real processes
 * (`lib/lean-verify-command-fixture.ts`):
 *
 *   (a) an existing repo-relative test path — present at base, unchanged at HEAD —
 *       runs at HEAD through the same `verify.test` runner a frozen test uses, and
 *       exit 0 is its pass condition;
 *   (b) a non-zero exit is a RED whose reason is
 *       `criterion <id> (command <path>) failed: <detail>`;
 *   (c) a `command` that is not a repo test path (absolute, traversal,
 *       `node_modules/`, a shell string, a missing file, PADDED whitespace) is
 *       NEVER executed and is NEVER a verdict — no throw, no red, nothing recorded;
 *   (c2) a path-shaped command whose committed entry is a symlink, absent at base,
 *       or changed since base is NOT RUNNABLE, with its OWN reason;
 *   (d) an infra proof THROWS and names the command criterion, with no frozen test
 *       in front of it to blame;
 *   (e) an unreadable spec yields no command criteria and changes no verdict;
 *   (f) `specify`'s coverage rule asks for red tests of `verify: "test"` criteria
 *       ONLY — a command criterion never earns a `has no red test`.
 *
 * Three rules about what a `command` may NOT be, plus the coverage rule, are all
 * this file holds. The rest of the tier's contract is split along its own seams,
 * each with the fixture it needs:
 *
 *   - `test-lean-verify-command-tree.ts` — the tree and the working file: an
 *     on-disk rewrite the index hides, and a run that disturbs the tree;
 *   - `test-lean-verify-command-infra.ts` — what is INFRASTRUCTURE rather than a
 *     verdict: a runner nobody observed, a spec nobody could read, a tier that
 *     blew its bounds;
 *   - `test-lean-verify-command-body.ts` — which cell prints what, and whether
 *     reasons can trade rows.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandCriterionProblem } from "../src/lean/verify-commands.ts";
import {
  GREEN_FILE,
  ROOTS,
  bodyWith,
  cleanupRoots,
  commitDelete,
  commitEdit,
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

// ----------------- (a) an unchanged existing test of the base runs, and is green
{
  const r = await runCommandVerify({
    issue: 401,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE },
  });
  assert(
    r.outcome?.kind === "green",
    `(a) a green command criterion leaves verify green (got ${String(r.outcome?.kind)}: ${String(r.outcome?.reason ?? r.threw?.message)})`,
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === "passed" && r.outcome?.commandNotRunnable === undefined,
    "(a) the green record names AC2 as executed, and records no not-runnable reason",
  );
}

// --------------------------------------------- (b) a failing command criterion is red
{
  const r = await runCommandVerify({
    issue: 402,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: redFile(CMD_FILE) },
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "red" &&
      reason.includes(`criterion AC2 (command ${CMD_FILE}) failed:`) &&
      r.outcome?.commandCriteria?.AC2 === undefined,
    `(b) a non-zero exit is a red in the promised shape, and is not recorded as passed (${JSON.stringify(reason.slice(0, 160))})`,
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
    // A padded command is a string someone meant to be run as something other than
    // a path: it is refused on the RAW form, never quietly trimmed into a valid one.
    ["a padded absolute path", " /etc/passwd"],
    ["a padded path-shaped command", ` ${CMD_FILE} `],
    ["a newline-padded command", "\nfalse\n"],
  ];
  for (const [label, cmd] of notPaths) {
    const problem = commandCriterionProblem(cmd);
    assert(
      problem !== undefined,
      `(c) the validator refuses ${label} (${JSON.stringify(cmd)}) — ${JSON.stringify(problem)}`,
    );
  }
  assert(
    commandCriterionProblem(CMD_FILE) === undefined &&
      commandCriterionProblem("./tests//AC2-preserve.test.sh") !== undefined,
    "(c) the validator accepts a plain repo-relative path and refuses a non-normalised spelling",
  );
}

{
  // The gate's own behaviour on a shell-shaped command: no run, no verdict, no
  // throw. An executed `sh -c 'exit 1'` out of an issue body would be the injection
  // this rule exists to stop; a red would blame the developer for the spec.
  const r = await runCommandVerify({
    issue: 403,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "sh -c 'exit 1'" }]),
  });
  assert(
    r.outcome?.kind === "green" &&
      r.threw === undefined &&
      r.outcome?.commandCriteria?.AC2 === undefined,
    `(c) a shell-shaped command is never executed, never a verdict, never recorded (${String(r.outcome?.kind)})`,
  );
}

{
  // A path-shaped command naming a file neither tree holds: also never executed,
  // and the reason says the base commit does not hold it.
  const r = await runCommandVerify({
    issue: 404,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "tests/absent.test.sh" }]),
  });
  assert(
    r.outcome?.kind === "green" &&
      r.outcome?.commandCriteria?.AC2 === undefined &&
      r.outcome?.commandNotRunnable?.AC2 === "tests/absent.test.sh does not exist at base",
    `(c) a command naming a missing file is treated like manual, with its reason (${JSON.stringify(r.outcome?.commandNotRunnable)})`,
  );
}

// ---------------- (c2) the three tree shapes: symlink / added at HEAD / edited
{
  // THE reproduction: a committed mode-120000 symlink to a script outside the
  // worktree. `existsSync` follows it, so the shipped gate ran it and recorded
  // `passed`. The target creates a marker file, so "never executed" is observable
  // rather than inferred from the verdict.
  const root = ROOTS[ROOTS.length - 1] ?? "/tmp";
  const marker = path.join(root, "symlink-was-executed");
  const outside = path.join(root, "outside-wipe.sh");
  writeFileSync(outside, `#!/bin/sh\ntouch ${marker}\nexit 0\n`, { mode: 0o755 });
  const r = await runCommandVerify({
    issue: 410,
    implement: true,
    specBody: bodyWith([
      TEST_CRITERION,
      { ...COMMAND_CRITERION, command: "tests/AC2-link.test.sh" },
    ]),
    baseLinks: { "tests/AC2-link.test.sh": outside },
  });
  assert(
    r.outcome?.kind === "green" && r.threw === undefined,
    `(c2) a committed symlink is never executed: the run stays green, not red, not thrown (${JSON.stringify({ kind: r.outcome?.kind, threw: r.threw?.message })})`,
  );
  assert(
    existsSync(marker) === false,
    "(c2) the symlink's target never ran — the marker file it would have created is absent",
  );
  assert(
    r.outcome?.commandCriteria?.AC2 === undefined &&
      r.outcome?.commandNotRunnable?.AC2 === "tests/AC2-link.test.sh is a symlink",
    `(c2) a symlinked command is not recorded, and the reason names the symlink (${JSON.stringify(r.outcome?.commandNotRunnable)})`,
  );
}

{
  // A file that exists at HEAD and NOT at base: the `src/wipe.sh` shape. Whatever
  // it does, it is not evidence of behaviour that held before the run.
  const r = await runCommandVerify({
    issue: 411,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: "src/wipe.sh" }]),
    files: { "src/wipe.sh": "#!/bin/sh\nrm -rf src/*\nexit 0\n" },
  });
  assert(
    r.outcome?.kind === "green" &&
      r.outcome?.commandCriteria?.AC2 === undefined &&
      r.outcome?.commandNotRunnable?.AC2 === "src/wipe.sh does not exist at base",
    `(c2) a file added at HEAD is never executed, and the reason says it is absent at base (${JSON.stringify({ kind: r.outcome?.kind, why: r.outcome?.commandNotRunnable })})`,
  );
}

{
  // A file the base held and HEAD changed is no longer the test that already
  // passed; a deletion is the same fact — HEAD's tree simply has no entry for it.
  const edited = await runCommandVerify({
    issue: 412,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE },
    mutate: (wt) => commitEdit(wt, CMD_FILE, "#!/bin/sh\nexit 0\n"),
  });
  assert(
    edited.outcome?.kind === "green" &&
      edited.outcome?.commandCriteria?.AC2 === undefined &&
      edited.outcome?.commandNotRunnable?.AC2 === `${CMD_FILE} changed since base`,
    `(c2) a test modified since base is not runnable, with its own reason (${JSON.stringify({ kind: edited.outcome?.kind, why: edited.outcome?.commandNotRunnable })})`,
  );
  const deleted = await runCommandVerify({
    issue: 413,
    implement: true,
    specBody: bodyWith([TEST_CRITERION, { ...COMMAND_CRITERION, command: CMD_FILE }]),
    baseFiles: { [CMD_FILE]: GREEN_FILE },
    mutate: (wt) => commitDelete(wt, CMD_FILE),
  });
  assert(
    deleted.outcome?.commandCriteria?.AC2 === undefined &&
      deleted.outcome?.commandNotRunnable?.AC2 === `${CMD_FILE} changed since base`,
    `(c2) a test deleted at HEAD is not runnable, with the same reason (${JSON.stringify(deleted.outcome?.commandNotRunnable)})`,
  );
}

{
  // Two declined criteria of different kinds each keep their own reason — the
  // single-slot record could print only one, and the operator then fixed one of
  // two problems.
  const r = await runCommandVerify({
    issue: 414,
    implement: true,
    specBody: bodyWith([
      TEST_CRITERION,
      { ...COMMAND_CRITERION, command: "src/wipe.sh" },
      {
        id: "AC3",
        text: "the other suite still passes",
        verify: "command",
        command: "tests/nope.test.sh",
      },
    ]),
    files: { "src/wipe.sh": "#!/bin/sh\nexit 0\n" },
  });
  assert(
    r.outcome?.commandNotRunnable?.AC2 === "src/wipe.sh does not exist at base" &&
      r.outcome?.commandNotRunnable?.AC3 === "tests/nope.test.sh does not exist at base",
    `(c2) each declined criterion carries its own reason (${JSON.stringify(r.outcome?.commandNotRunnable)})`,
  );
}

{
  // The reasons the GATE produced, read back off the record — the same values
  // `publish` forwards to the body. A gate that traced them without recording them
  // would leave every blank cell silent.
  const declined = await runCommandVerify({
    issue: 408,
    implement: true,
    specBody: bodyWith([
      TEST_CRITERION,
      { ...COMMAND_CRITERION, command: "tests/absent.test.sh" },
      { id: "AC3", text: "the docs build", verify: "command", command: "tests/doc-link.test.sh" },
    ]),
    baseLinks: { "tests/doc-link.test.sh": "/bin/true" },
  });
  assert(
    declined.outcome?.commandNotRunnable?.AC2 === "tests/absent.test.sh does not exist at base" &&
      declined.outcome?.commandNotRunnable?.AC3 === "tests/doc-link.test.sh is a symlink" &&
      declined.outcome?.commandCriteria === undefined,
    `(c2) the gate records one reason per declined criterion, and neither as executed (${JSON.stringify(declined.outcome?.commandNotRunnable)})`,
  );
}

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
  assert(parsed.ok === true, "(f) the three-kind spec parses");
  const wanted = testCriteria((parsed as { spec: { criteria: unknown[] } }).spec);
  assert(
    wanted.length === 1 && wanted[0]?.id === "AC1" && wanted.every((c) => c.verify === "test"),
    `(f) a red test is required of the verify:"test" criteria alone — never of a command or manual one (got ${wanted.map((c) => `${c.id}/${c.verify}`).join(", ")})`,
  );
}

cleanupRoots();
assert(ROOTS.length === 0, "the fixture removed its temp roots");

process.exit(exit);
