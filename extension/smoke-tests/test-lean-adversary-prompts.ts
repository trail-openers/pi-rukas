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
 *   (e) specify alone elicits IMPLIED requirements — the ones a bench reject
 *       missed because the issue never stated them. One exported const, its
 *       file quota interpolated from the boundary's own constant, and bounded
 *       in length, since the section costs the specify child context on every
 *       dispatch. Its EXAMPLES are pinned only by ABSENCE: the defects of the
 *       tasks this lever is measured on must not appear in the prompt, or the
 *       campaign score measures the prompt rather than the model.
 */

import { BUILD_SCOPE_CONTRACT } from "../src/lean/build-prompt.ts";
import { challengePrompt } from "../src/lean/challenge-prompt.ts";
import {
  LEAN_ISSUE_HEADING,
  LEAN_ISSUE_LEAD,
  leanIssueProseEnabled,
  leanIssueSection,
} from "../src/lean/issue-prose.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import {
  IMPLIED_REQUIREMENTS,
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
import { CONSTRAINT, INJECT_BODY, ISSUE_BODY, OVER_BODY } from "./lib/ticket-issue-fixture.ts";

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
  // One assertion for the three bounds, keeping the message that says WHY: the
  // numbers quoted in the prompt must BE the constants the boundary enforces.
  assert(
    prompt.includes(`at most ${MAX_TEST_LINES} lines`) &&
      prompt.includes(`at most ${MAX_TEST_LINES} lines and ${MAX_TEST_BYTES} bytes`) &&
      prompt.includes(`at most ${MAX_TEST_FILES_PER_CRITERION} files`),
    `${name}: the numbers the prompt quotes ARE the constants the boundary enforces (${MAX_TEST_LINES}/${MAX_TEST_BYTES}/${MAX_TEST_FILES_PER_CRITERION}), so a child is never dropped for a rule it was not told`,
  );
  assert(
    prompt.includes("reuse the project's existing test helpers"),
    `${name}: the prompt tells the adversary where the bytes come from — the project's own test helpers, not a new harness`,
  );
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
}
assert(
  BUILD_SCOPE_CONTRACT.includes("full test suite") && BUILD_SCOPE_CONTRACT.includes("cannot occur"),
  "the builder's contract names both first-trial failures: the full suite and guards for impossible states",
);

// ---------------------- (b3) the implied-requirement elicitation is specify's
{
  assert(
    specify.includes(IMPLIED_REQUIREMENTS) && !challenge.includes(IMPLIED_REQUIREMENTS),
    "specify interpolates the exported IMPLIED_REQUIREMENTS const verbatim; the challenge adversary already sees the implementation and is not asked again",
  );
  assert(
    IMPLIED_REQUIREMENTS.length <= 1200,
    `the section stays short — it costs the specify child context on every dispatch (${IMPLIED_REQUIREMENTS.length} chars, cap 1200)`,
  );
  assert(
    IMPLIED_REQUIREMENTS.startsWith("## "),
    "the elicitation is its own section, so a reordering cannot fold it into the contract above it",
  );
  assert(
    specify.indexOf(IMPLIED_REQUIREMENTS) < specify.indexOf("## What you report") &&
      specify.indexOf(IMPLIED_REQUIREMENTS) > specify.indexOf(TEST_SCOPE_CONTRACT),
    "the section sits between the scope contract and \"What you report\", so the child reads it before it freezes anything",
  );
  for (const [needle, why] of [
    ["ALREADY supports", "input forms the touched code already supports must keep working"],
    ["interacts with existing state", "interaction with existing state, modes and callers"],
    ["implies but never says", "the scope the issue implies and does not state"],
    ["extra test CASE", "an implied requirement is an extra case, never a replacement test"],
    ["opening no new file", "an implied case lives in the criterion's own file"],
    ["`path:line`", "what it keeps must be grounded in base-commit evidence"],
    ["no evidence, no case", "what it cannot ground is skipped"],
  ] as const) {
    assert(
      specify.includes(needle),
      `specify's elicitation names ${why} (${needle})`,
    );
  }
  // The examples are generic on purpose: naming a defect the measured bench
  // tasks actually have would hand the child the answer it is scored on finding,
  // and the campaign number would describe the prompt instead of the model. So
  // the assertion is on the structural phrases above plus this absence — never
  // on the example wording itself.
  for (const leaked of ["cache", "polyfill", "fallback"]) {
    assert(
      !IMPLIED_REQUIREMENTS.toLowerCase().includes(leaked),
      `the elicitation's examples stay generic — no ${leaked} in the const`,
    );
  }
  const noTests = specifyPrompt({
    issue: 1908,
    spec: { ...SPEC, criteria: [{ id: "AC3", text: "the docs name the new flag", verify: "manual" }] },
    testRunner: RUNNER,
    worktree: WT,
  });
  assert(
    !noTests.includes("Implied requirements") &&
      noTests.includes("Reply with a single sentence saying so"),
    "a spec with no test criterion stays exactly as it was: one sentence, no elicitation to answer",
  );
}

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

// ───────────────── (f) the issue section: the oracle seat finally sees the issue
//
// Both steps FETCHED the issue body and dropped it after parsing the pi-spec, so
// the adversary that writes and attacks the frozen tests was told nothing but one
// clipped `problem` line and the criteria. A frozen test that invented a
// behaviour the task statement never had was never contradicted. These assertions
// are made at the PROMPT-FUNCTION boundary for the same `spec` object, which is
// the only place "equal the pre-change prompt" can mean anything: the /plan
// `problem` change is separate and is not switch-gated.
{
  const withBody = (issueBody: string) => ({
    specify: specifyPrompt({
      issue: 1908,
      spec: SPEC,
      testRunner: RUNNER,
      worktree: WT,
      issueBody,
    }),
    challenge: challengePrompt({
      issue: 1908,
      spec: SPEC,
      frozenPaths: FROZEN,
      worktree: WT,
      testRunner: RUNNER,
      issueBody,
    }),
  });
  const plain = withBody(ISSUE_BODY);
  const bare = specifyPrompt({ issue: 1908, spec: SPEC, testRunner: RUNNER, worktree: WT });
  const bareChallenge = challengePrompt({
    issue: 1908,
    spec: SPEC,
    frozenPaths: FROZEN,
    worktree: WT,
    testRunner: RUNNER,
  });

  for (const [name, prompt] of [
    ["specify", plain.specify],
    ["challenge", plain.challenge],
  ] as const) {
    assert(
      prompt.includes("## The issue") && prompt.includes(CONSTRAINT),
      `${name}: the prompt carries the fenced issue section with the body's own constraint`,
    );
    assert(
      prompt.includes(LEAN_ISSUE_LEAD),
      `${name}: the prompt says plainly that the fenced text is data, not instructions`,
    );
    assert(
      prompt.indexOf("## The problem") < prompt.indexOf("## The issue") &&
        prompt.indexOf("## The issue") < prompt.indexOf("## The acceptance criteria"),
      `${name}: the section sits after the problem and before the criteria`,
    );
    assert(
      prompt.includes("```text"),
      `${name}: the body is printed through the fence renderer, never raw`,
    );
  }

  // The pi-spec block is stripped — the criteria are already in the brief above,
  // and the JSON printed twice is a second contract nobody keeps in step.
  for (const [name, prompt] of [
    ["specify", plain.specify],
    ["challenge", plain.challenge],
  ] as const) {
    assert(
      !prompt.includes("pi-spec v1") && !prompt.includes('"verify": "test"'),
      `${name}: the spec block itself never appears in the issue section`,
    );
  }

  // The switch off is the pre-change render byte for byte: the same spec, the
  // same options, no body — that is what the prompts looked like before the body
  // was threaded in.
  const saved = process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
  process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE = "0";
  try {
    const off = withBody(ISSUE_BODY);
    assert(
      off.specify === bare,
      "specify: PI_ENSEMBLE_LEAN_ISSUE_PROSE=0 renders byte-identically to a prompt built with no body",
    );
    assert(
      off.challenge === bareChallenge,
      "challenge: PI_ENSEMBLE_LEAN_ISSUE_PROSE=0 renders byte-identically to a prompt built with no body",
    );
    assert(
      !off.specify.includes("## The issue") && !off.challenge.includes("## The issue"),
      "the off render carries no section heading at all, not an empty one",
    );
    assert(
      leanIssueProseEnabled() === false,
      "the exported reader reports the switch off",
    );
  } finally {
    if (saved === undefined) delete process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE;
    else process.env.PI_ENSEMBLE_LEAN_ISSUE_PROSE = saved;
  }
  assert(
    leanIssueProseEnabled() === true,
    "unset (restored) means the section is ON — only the literal 0 turns it off",
  );

  // An injected heading or fence must stay inside the fence: no line of the
  // prompt outside the section's own fence may read as a heading or open a fence.
  const injected = withBody(INJECT_BODY);
  for (const [name, prompt] of [
    ["specify", injected.specify],
    ["challenge", injected.challenge],
  ] as const) {
    const outside = prompt
      .split("```text\n")
      .slice(1)
      .map((part) => part.split("```")[0] ?? "");
    const outsideLines = new Set(outside.flatMap((block) => block.split("\n")));
    const headingsOutside = prompt
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line) && !outsideLines.has(line));
    assert(
      headingsOutside.every((line) => !line.includes("INJECT")) &&
        prompt.includes("INJECT") &&
        prompt.includes("not a fence"),
      `${name}: the injected heading and fence are IN the brief as text and open no section outside the fence (${headingsOutside.filter((l) => l.includes("INJECT")).join(" | ") || "no heading outside the fence"})`,
    );
    assert(
      !/^### INJECT/m.test(prompt.replace(/```text[\s\S]*?```/g, "")),
      `${name}: strip the fenced blocks and no injected heading survives in the prompt prose`,
    );
    assert(
      !prompt.includes("undefined"),
      `${name}: no "undefined" reaches the brief from the issue section`,
    );
  }

  // One truncation marker, and never the fence renderer's own clip notice. The
  // body is bounded by `boundedIssueBody` BEFORE the fence, so the cap can cut
  // the tail off — an assertion of its own, stated as an absence below.
  const over = withBody(OVER_BODY);
  for (const [name, prompt] of [
    ["specify", over.specify],
    ["challenge", over.challenge],
  ] as const) {
    assert(
      (prompt.match(/…\(issue truncated\)/g) ?? []).length === 1,
      `${name}: an over-cap issue prints exactly one truncation marker (saw ${(prompt.match(/…\(issue truncated\)/g) ?? []).length})`,
    );
    assert(
      !prompt.includes("[truncated at "),
      `${name}: the fence's own clip marker never appears — the body bound is the one in force`,
    );
    assert(
      !prompt.includes(CONSTRAINT),
      `${name}: the cap really did cut — OVER_BODY's tail constraint is gone, so the marker above is not decoration`,
    );
  }

  // Blank bodies render no section, and the renderer itself is the shared one.
  for (const empty of [undefined, "", "   \n  ", "```pi-spec v1\n{}\n```"]) {
    const p = specifyPrompt({
      issue: 1908,
      spec: SPEC,
      testRunner: RUNNER,
      worktree: WT,
      issueBody: empty,
    });
    assert(
      !p.includes("## The issue") && !p.includes("undefined"),
      `specify: a ${JSON.stringify(empty)} body renders no section (${LEAN_ISSUE_HEADING} absent)`,
    );
    assert(leanIssueSection(empty) === "", `the renderer returns "" for ${JSON.stringify(empty)}`);
  }
}

process.exit(exit);
