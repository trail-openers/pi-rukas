#!/usr/bin/env bun
/**
 * lean — the configured test location: the RULES (`verify.testDir` + `testGlob`).
 *
 * Epic #1883. The acceptance tests a lean run freezes are tests OF THE PROJECT,
 * so they must land where the project's own CI already looks; the first trial
 * wrote them into a new repo-root `tests/` folder because nothing in the run's
 * contract told the adversary where tests go.
 *
 * This file judges the three pure layers that decision rests on. The steps
 * themselves — a real worktree, a frozen commit, the reason a run reports — are
 * in `test-lean-test-location-steps.ts`, which shares this file's fixture.
 *
 *   (1a) the validators: a directory that is not repo-relative, one that ends in
 *        a slash, one inside a hidden directory, a pattern with two stars, a
 *        pattern with a slash. Each refusal NAMES its rule, because an operator
 *        editing `.pi/work.json` needs to know which of them they wrote.
 *   (1b) the pair: absent is today's behaviour; one half without the other is
 *        no location at all, and the loader refuses it rather than guessing.
 *   (1c) `testLocationProblem`: is the file DIRECTLY inside the folder and named
 *        to the pattern. A NESTED folder is the case a prefix check gets wrong —
 *        `tests/unit` starts with `tests` and the project's CI glob never
 *        reaches into it, so the run would freeze a test nothing executes.
 *   (1d) the loader: a bad pair on disk raises `LeanConfigError`, never a silent
 *        default, because a config the loader accepted and the boundary could
 *        not read is a rule nobody enforces.
 *   (2) the prompts: BOTH adversaries are told the folder and the pattern, in
 *       one shared function, with an example the boundary itself accepts. A
 *       child never told writes wherever it likes and loses every file to the
 *       drop. Unconfigured, none of that vocabulary appears — the default is
 *       today's behaviour, not an empty folder.
 */

import { execp } from "../src/exec.ts";
import { challengePrompt } from "../src/lean/challenge-prompt.ts";
import {
  testLocationOf,
  testLocationProblem,
  validateTestDir,
  validateTestGlob,
} from "../src/lean/config-test-location.ts";
import { LeanConfigError, loadWorkConfig } from "../src/lean/config.ts";
import {
  RED_PROOF_CONTRACT,
  specifyPrompt,
  testLocationInstruction,
} from "../src/lean/specify-prompt.ts";
import { makeRepo } from "./lib/lean-specify-fixture.ts";
import { assert, LOC, SPEC, WT, testLocationExit } from "./lib/lean-test-location-fixture.ts";

// ───────────────────────────────────── (1a) the validators, good and bad shapes

{
  for (const good of ["extension/smoke-tests", "tests", "a/b/c", "packages/core/test"])
    assert(
      validateTestDir(good) === undefined,
      `validateTestDir accepts \`${good}\` (got ${validateTestDir(good) ?? "accepted"})`,
    );
  // Each bad shape names the rule, so an operator fixing the config is told
  // which of the five they wrote.
  const bad: Array<[string, string]> = [
    [".", "must not sit inside a hidden directory"],
    ["..", 'must not contain ".."'],
    ["//", "not absolute"],
    ["", "must not be empty"],
    ["../outside", 'must not contain ".."'],
    ["tests/../outside", 'must not contain ".."'],
    ["/etc/tests", "repo-relative, not absolute"],
    ["C:\\tests", "not allowed"],
    ["tests/", "must not end in a slash"],
    ["tests\\", "not allowed"],
    [".hidden/tests", "hidden directory"],
    [".pi/tests", "hidden directory"],
    ["tests;rm", "not allowed"],
    ["tests $(x)", "not allowed"],
    ["tests/*", "no wildcard"],
    ["tests?", "no wildcard"],
  ];
  for (const [dir, why] of bad)
    assert(
      validateTestDir(dir)?.includes(why) === true,
      `validateTestDir refuses \`${dir}\` naming "${why}" (got ${validateTestDir(dir) ?? "accepted"})`,
    );
  // A padded value is used VERBATIM when the boundary compares a submitted
  // path's directory against it, so `" tests"` matches nothing and every test
  // the adversary writes is refused while the reason blames the child.
  for (const padded of [" tests", "tests ", "\textension/smoke-tests", "tests\n"])
    assert(
      validateTestDir(padded)?.includes("surrounding whitespace") === true,
      `validateTestDir refuses the padded \`${JSON.stringify(padded)}\` (got ${validateTestDir(padded) ?? "accepted"})`,
    );
  // ONE canonical form, and any other spelling is refused rather than quietly
  // accepted: `./tests`, `tests/` and `a//b` all NAME the same directory, but
  // the boundary compares `testDir` against a submitted path's normalised
  // directory, so a non-normalised value matches nothing and the child is told
  // its own tests are misplaced. Refusing the spelling is cheaper than silently
  // normalising it, because the message prints the form the author should write.
  for (const [spelling, normalised] of [
    ["./tests", "tests"],
    ["tests/./unit", "tests/unit"],
    ["././tests", "tests"],
    ["./a/b/./c", "a/b/c"],
    ["tests//unit", "tests/unit"],
  ] as Array<[string, string]>)
    assert(
      validateTestDir(spelling)?.includes(`write \`${normalised}\``) === true,
      `validateTestDir refuses \`${spelling}\` and names its normalised form \`${normalised}\` (got ${validateTestDir(spelling) ?? "accepted"})`,
    );

  for (const good of [
    "test-*.ts",
    "*.test.ts",
    "spec-*.bats",
    // A trailing wildcard with NO extension is refused (see `badGlob`); a
    // LEADING wildcard that still ends in an extension is not — `*.test.ts`
    // names a runnable file.
    "*.spec.ts",
    // Neither the extension nor the position of the star is fixed.
    "test_*.bats",
  ])
    assert(
      validateTestGlob(good) === undefined,
      `validateTestGlob accepts \`${good}\` (got ${validateTestGlob(good) ?? "accepted"})`,
    );
  const badGlob: Array<[string, string]> = [
    [".", 'exactly one "*"'],
    ["**", 'exactly one "*"'],
    ["", "must not be empty"],
    ["test.ts", 'exactly one "*"'],
    ["test-*.spec-*.ts", 'exactly one "*"'],
    ["tests/test-*.ts", "not a path"],
    ["tests\\test-*.ts", "not a path"],
    ['test-*.t"s', "not allowed"],
    ["test-*.ts;rm", "not allowed"],
    // The four that all mean "this pattern names no RUNNABLE TEST FILE". Each
    // passes every shape rule above and matches real files in the folder, so a
    // project could ship one, freeze tests its own CI never runs, and see
    // nothing wrong.
    ["*", 'must not be "*"'],
    ["test-*", "name a file extension"],
    // A dot INSIDE the pattern is the extension separator, so the text after
    // the `*` has to contain one: `test-*` could match `test-README`.
    ["test-*AC1", "name a file extension"],
    [".test-*.ts", 'must not start with "."'],
    [" test-*.ts", "surrounding whitespace"],
    ["test-*.ts ", "surrounding whitespace"],
    ["\ttest-*.ts", "surrounding whitespace"],
  ];
  for (const [glob, why] of badGlob)
    assert(
      validateTestGlob(glob)?.includes(why) === true,
      `validateTestGlob refuses \`${glob}\` naming "${why}" (got ${validateTestGlob(glob) ?? "accepted"})`,
    );
}

// ──────────────────────────── (1b) testLocationOf: absent means today's behaviour

{
  assert(
    testLocationOf({}) === undefined,
    "no testDir and no testGlob → no location, which is today's behaviour",
  );
  assert(
    testLocationOf({ testDir: "tests" }) === undefined,
    "a lone testDir yields NO location — the pair is configured together or not at all",
  );
  assert(
    testLocationOf({ testGlob: "test-*.ts" }) === undefined,
    "a lone testGlob yields NO location",
  );
  const both = testLocationOf({ testDir: "tests", testGlob: "test-*.ts" });
  assert(
    both?.testDir === "tests" && both.testGlob === "test-*.ts",
    "the pair yields the location the prompts and boundary read",
  );
}

// ────────────────────────────── (1c) testLocationProblem: the rule itself

{
  const ok = testLocationProblem(LOC, "extension/smoke-tests/test-x.ts");
  assert(ok === undefined, `a test in the folder under a matching name is accepted (got ${ok})`);
  // An EMPTY testDir means "at the repo root", and it is still a directory the
  // child must not nest inside — otherwise a blank in the config would disable
  // the whole rule while looking like a configuration.
  assert(
    testLocationProblem({ testDir: "", testGlob: "test-*.ts" }, "test-x.ts") === undefined,
    "an empty testDir matches files at the repo root",
  );
  assert(
    testLocationProblem({ testDir: "", testGlob: "test-*.ts" }, "pkg/test-x.ts") !== undefined,
    "an empty testDir still refuses a nested file",
  );
  const outside = testLocationProblem(LOC, "tests/test-x.ts");
  assert(
    outside?.includes("not directly inside the configured test directory") === true &&
      outside.includes("extension/smoke-tests/"),
    `a test in another folder is refused naming the folder (got ${outside})`,
  );
  // The shape a prefix check would wave through: `extension/smoke-tests` is a
  // prefix of `extension/smoke-tests/unit`, yet the project's CI glob does not
  // reach into a subdirectory, so the run would freeze a test nothing runs.
  const nested = testLocationProblem(LOC, "extension/smoke-tests/unit/test-x.ts");
  assert(
    typeof nested === "string" && nested.includes("not directly inside"),
    `a NESTED folder is refused, not treated as inside (got ${nested})`,
  );
  const root = testLocationProblem(LOC, "test-x.ts");
  assert(
    root?.includes("not directly inside") === true,
    `a test at the repo root is refused (got ${root})`,
  );
  const wrongName = testLocationProblem(LOC, "extension/smoke-tests/spec-x.ts");
  assert(
    wrongName?.includes("does not match the configured test name pattern") === true &&
      wrongName.includes("test-*.ts"),
    `a wrong basename is refused naming the pattern (got ${wrongName})`,
  );
  // The regex is the glob, not a substring: a dot in the pattern must not match
  // an arbitrary character, and `*` must not cross a separator.
  assert(
    testLocationProblem({ testDir: "tests", testGlob: "test-*.ts" }, "tests/test-x.mts") !==
      undefined,
    "the trailing `.ts` is literal — `.mts` does not satisfy the pattern",
  );
  assert(
    testLocationProblem({ testDir: "tests", testGlob: "a*b" }, "tests/ab") === undefined,
    "a `*` matches the empty string, so `ab` matches `a*b`",
  );
}

// ─────────────────────────────────── (1d) the loader refuses a bad pair on disk

{
  function repoWith(verify: Record<string, unknown>): { repoRoot: string; baseSha: string } {
    return makeRepo({ ".pi/work.json": JSON.stringify({ version: 1, verify }) });
  }
  const good = repoWith({ test: "bun {file}", testDir: "tests", testGlob: "test-*.ts" });
  const cfg = await loadWorkConfig(execp, good.repoRoot, good.baseSha);
  assert(
    cfg.verify.testDir === "tests" && cfg.verify.testGlob === "test-*.ts",
    "a valid pair loads through",
  );

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["testDir without testGlob", { testDir: "tests" }, "requires verify.testGlob"],
    ["testGlob without testDir", { testGlob: "test-*.ts" }, "requires verify.testDir"],
    ["an absolute testDir", { testDir: "/tmp/t", testGlob: "t*" }, "not absolute"],
    ["a trailing slash", { testDir: "tests/", testGlob: "t*" }, "end in a slash"],
    ["two stars", { testDir: "tests", testGlob: "a*b*c" }, 'exactly one "*"'],
    ["a slashed glob", { testDir: "tests", testGlob: "tests/t*" }, "not a path"],
    ["a non-string testDir", { testDir: 7, testGlob: "t*" }, "must be a string"],
  ];
  for (const [name, verify, why] of cases) {
    const r = repoWith(verify);
    let thrown: unknown;
    try {
      await loadWorkConfig(execp, r.repoRoot, r.baseSha);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof LeanConfigError,
      `${name}: rejected with LeanConfigError, not silently defaulted`,
    );
    assert(
      thrown instanceof Error && thrown.message.includes(why),
      `${name}: names "${why}" (got ${(thrown as Error)?.message ?? "no throw"})`,
    );
  }
}

// ──────────────────────────────────────── (2) the prompts tell both adversaries

{
  const specify = specifyPrompt({
    issue: 1883,
    spec: SPEC,
    testRunner: "bun {file}",
    testLocation: LOC,
    worktree: WT,
  });
  const challenge = challengePrompt({
    issue: 1883,
    spec: SPEC,
    frozenPaths: ["extension/smoke-tests/test-frozen.ts"],
    worktree: WT,
    testRunner: "bun {file}",
    testLocation: LOC,
  });
  for (const [name, prompt] of [
    ["specify", specify],
    ["challenge", challenge],
  ] as const) {
    assert(
      prompt.includes("directly inside `extension/smoke-tests/`"),
      `${name}: the prompt names the configured directory, with its trailing slash`,
    );
    assert(
      prompt.includes("named to match `test-*.ts`"),
      `${name}: the prompt states the naming pattern verbatim`,
    );
    assert(
      prompt.includes("`extension/smoke-tests/test-AC1-example.ts`"),
      `${name}: the prompt's example is a path INSIDE the folder that the boundary accepts`,
    );
    assert(
      prompt.includes("importing the project's code with paths relative to that folder"),
      `${name}: the prompt tells the child how to import the code under test from there`,
    );
    assert(
      prompt.includes("a subdirectory of it") && prompt.includes("leaves its criterion uncovered"),
      `${name}: the prompt warns what a refused test costs, so a drop is never a surprise`,
    );
    assert(
      prompt.includes(RED_PROOF_CONTRACT),
      `${name}: adding a section did not evict the red-proof contract`,
    );
    // The shared sentence is one function's output in both prompts — a rewrite
    // to one prompt cannot un-tell the other step's adversary.
    assert(
      prompt.includes(testLocationInstruction(LOC)),
      `${name}: the prompt interpolates the SHARED testLocationInstruction text`,
    );
  }

  // Unconfigured → none of that vocabulary appears, and the old generic example
  // stays: the default must be today's behaviour, not an empty folder.
  const bare = specifyPrompt({ issue: 1883, spec: SPEC, testRunner: "bun {file}", worktree: WT });
  const bareChallenge = challengePrompt({
    issue: 1883,
    spec: SPEC,
    frozenPaths: ["tests/AC1-frozen.test.sh"],
    worktree: WT,
    testRunner: "bun {file}",
  });
  for (const [name, prompt] of [
    ["specify (unconfigured)", bare],
    ["challenge (unconfigured)", bareChallenge],
  ] as const) {
    assert(
      !prompt.includes("directly inside") && !prompt.includes("testLocation"),
      `${name}: no testDir configured → no folder instruction in the prompt`,
    );
    assert(
      prompt.includes("criterion id it covers"),
      `${name}: the criterion-id naming rule is still stated without a configured folder`,
    );
  }
}

console.log(testLocationExit() === 0 ? "\nConfigured test location rules are pinned." : "\nFAILED");
process.exit(testLocationExit());
