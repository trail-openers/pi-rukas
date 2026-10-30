#!/usr/bin/env bun
/**
 * lean/specify-prompt + lean/challenge-prompt — the adversary's contract, pinned.
 *
 * Both steps pay a child to write test files, and both then decide whether each
 * file is a REAL red by executing it (`specify-proof.ts`): a file counts as
 * proof only when it exited non-zero AND its output named the file, by path or
 * by basename. Anything else is `unclear` and dropped — and under `specify`'s
 * `all-criteria` rule a dropped file is a refused run (`criterion ACn has no
 * red test`), which is exactly what happened on the third headless run of #1908:
 * this repo's smoke tests print `✗ <message>` and exit 1 and never name their
 * own file, so a genuine red read as unclear.
 *
 * The fix is in the PROMPT, not the proof rule: the child is told to make its
 * failure output name its own file. These assertions pin the two things that
 * make that true and the one thing that must NOT change:
 *
 *   (a) BOTH prompts carry the red-proof contract — the sentence that says a
 *       failing file prints its own basename and exits non-zero, and says what
 *       happens when it does not (dropped as unclear). A child that is never
 *       told the rule produces runners that do not satisfy it.
 *   (b) the two prompts share ONE const for that sentence, so a rewrite to one
 *       prompt cannot quietly un-tell the other step's adversary.
 *   (c) the proof rule itself is unchanged: `runTestFile` still requires the
 *       non-zero exit AND the name in the output. A prompt edit that had been
 *       paired with a loosened classifier would approve unattributable reds.
 *   (d) the prompts still carry the rest of the load-bearing lines the steps
 *       depend on (the runner template, the verbatim problem, the no-non-test-
 *       edits fence, the `submit_tests` protocol, the frozen-list fence).
 */

import { BUILD_SCOPE_CONTRACT } from "../src/lean/build-prompt.ts";
import { challengePrompt } from "../src/lean/challenge-prompt.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import {
  RED_PROOF_CONTRACT,
  TEST_SCOPE_CONTRACT,
  specifyPrompt,
  testCriteria,
} from "../src/lean/specify-prompt.ts";
import { runTestFile } from "../src/lean/specify-proof.ts";
import {
  MAX_TEST_BYTES,
  MAX_TEST_FILES_PER_CRITERION,
  MAX_TEST_LINES,
} from "../src/lean/test-size.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SPEC: PiSpec = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "a transient failure is retried", verify: "test" },
    { id: "AC2", text: "the existing suite still passes", verify: "command", command: "tests/x" },
    { id: "AC3", text: "the docs name the new flag", verify: "manual" },
  ],
};

const WT = "/tmp/lean-prompt-contract/.worktrees/lean-1908";
const RUNNER = "bun run {file}";
const FROZEN = ["tests/AC1-retry.test.ts", "tests/AC2-bound.test.ts"];

const specify = specifyPrompt({ issue: 1908, spec: SPEC, testRunner: RUNNER, worktree: WT });
const challenge = challengePrompt({
  issue: 1908,
  spec: SPEC,
  frozenPaths: FROZEN,
  worktree: WT,
  testRunner: RUNNER,
});

// ------------------------------------------------- (a) the red-proof contract
for (const [name, prompt] of [
  ["specify", specify],
  ["challenge", challenge],
] as const) {
  assert(
    prompt.includes("print its own file basename"),
    `${name}: the prompt tells the adversary a failing test prints its own basename`,
  );
  assert(
    prompt.includes("exit non-zero"),
    `${name}: the prompt pairs that with exiting non-zero — a printed message alone is not a red`,
  );
  assert(
    /FAIL\s+<basename>/.test(prompt) || prompt.includes("FAIL "),
    `${name}: the prompt shows the FAIL <basename>: <reason> shape`,
  );
  assert(
    prompt.includes("dropped as unclear"),
    `${name}: the prompt says a failing file whose output never names it is dropped as unclear`,
  );
  assert(
    prompt.includes(RED_PROOF_CONTRACT),
    `${name}: the prompt carries the shared RED_PROOF_CONTRACT sentence verbatim`,
  );
}

// ------------------------------------------------ (b) one const, both prompts
assert(
  specify.includes(RED_PROOF_CONTRACT) && challenge.includes(RED_PROOF_CONTRACT),
  "both prompts interpolate the SAME const, so the two adversaries cannot be told different rules",
);
assert(
  RED_PROOF_CONTRACT.includes("basename") && RED_PROOF_CONTRACT.includes("unclear"),
  "the const names both halves of the rule: what to print, and what happens if you do not",
);

// --------------------------- (b2) the scope contracts: builder + adversary
assert(
  specify.includes(TEST_SCOPE_CONTRACT) && challenge.includes(TEST_SCOPE_CONTRACT),
  "both adversary prompts interpolate the SAME TEST_SCOPE_CONTRACT const, so neither can be told a different sizing rule",
);
for (const [name, prompt] of [
  ["specify", specify],
  ["challenge", challenge],
] as const) {
  assert(
    prompt.includes(`at most ${MAX_TEST_LINES} lines`) &&
      prompt.includes(`at most ${MAX_TEST_FILES_PER_CRITERION} files`),
    `${name}: the prompt states BOTH size bounds the boundary enforces, so a child is never dropped for a rule it was not told`,
  );
  assert(
    prompt.includes("reuse the project's existing test helpers"),
    `${name}: the prompt tells the adversary where the bytes come from — the project's own test helpers, not a new harness`,
  );
}
for (const [name, prompt] of [
  ["specify", specify],
  ["challenge", challenge],
] as const) {
  assert(
    prompt.includes("smallest test that proves the criterion"),
    `${name}: the prompt asks for the smallest test that proves the criterion`,
  );
  assert(
    prompt.includes("observable behaviour") && prompt.includes("implementation details"),
    `${name}: the prompt fences the adversary out of hypothetical misuse and implementation details`,
  );
  assert(
    prompt.includes("one focused file per criterion"),
    `${name}: the prompt prefers one focused file per criterion`,
  );
  assert(
    prompt.includes(`at most ${MAX_TEST_LINES} lines`) &&
      prompt.includes(`${MAX_TEST_BYTES} bytes`) &&
      prompt.includes(`at most ${MAX_TEST_FILES_PER_CRITERION} files`),
    `${name}: the numbers the prompt quotes ARE the constants the boundary enforces (${MAX_TEST_LINES}/${MAX_TEST_BYTES}/${MAX_TEST_FILES_PER_CRITERION})`,
  );
}
assert(
  BUILD_SCOPE_CONTRACT.includes("full test suite") && BUILD_SCOPE_CONTRACT.includes("cannot occur"),
  "the builder's contract names both first-trial failures: the full suite and guards for impossible states",
);

// ------------------------------- (c) the proof rule itself is UNCHANGED by this
{
  // An exec that reports the way THIS repo's smoke tests do — `✗ <message>`,
  // exit 1, the file's name nowhere in the output — is still `unclear`, never
  // promoted to red because the prompt now asks the child to print the name.
  const silent = await runTestFile(
    async () => {
      const err = new Error("exited 1") as Error & { code: number };
      err.code = 1;
      err.stdout = "✗ expected 3 retries, got 1\n";
      throw err;
    },
    { wt: WT, template: "bun run {file}", file: "tests/AC1-retry.test.ts" },
  );
  assert(
    silent.kind === "unclear",
    `the proof rule is untouched: an unattributable non-zero exit is still unclear (got ${silent.kind})`,
  );

  const naming = await runTestFile(
    async () => {
      const err = new Error("exited 1") as Error & { code: number };
      err.code = 1;
      err.stderr = "FAIL AC1-retry.test.ts: expected 3 retries, got 1\n";
      throw err;
    },
    { wt: WT, template: "bun run {file}", file: "tests/AC1-retry.test.ts" },
  );
  assert(
    naming.kind === "red",
    `a failure whose output prints the basename is the red the contract asks the child to produce (got ${naming.kind})`,
  );

  const green = await runTestFile(async () => ({ stdout: "ok\n", stderr: "" }), {
    wt: WT,
    template: "bun run {file}",
    file: "tests/AC1-retry.test.ts",
  });
  assert(green.kind === "green", `an exit 0 is still green, not proof (got ${green.kind})`);
}

// ------------------------------------- (d) the rest of the contract survives
assert(
  specify.includes(RUNNER) && challenge.includes(RUNNER),
  "both prompts still carry the project's verify.test runner template",
);
assert(
  specify.includes(SPEC.problem) && challenge.includes(SPEC.problem),
  "both prompts carry the spec's problem VERBATIM",
);
assert(
  specify.includes("Do not edit, create or delete any non-test file") &&
    challenge.includes("Do not edit, create or delete any non-test file"),
  "both prompts still fence the child out of non-test files",
);
assert(
  specify.includes("submit_tests") && challenge.includes("submit_tests"),
  "both prompts still state the submit_tests protocol",
);
assert(
  FROZEN.every((p) => challenge.includes(p)) && !specify.includes(FROZEN[0] as string),
  "only challenge names the frozen files — specify runs before any exist",
);
assert(
  testCriteria(SPEC).every((c) => c.verify === "test") && testCriteria(SPEC).length === 1,
  'testCriteria still asks for red tests for verify:"test" criteria alone',
);
assert(
  !specify.includes('Write ONE test file for each `verify: "test"` criterion: AC1, AC2'),
  "specify's write instruction names only the test criterion, never AC2 or AC3",
);

process.exit(exit);
