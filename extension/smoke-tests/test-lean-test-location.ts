#!/usr/bin/env bun
/**
 * lean — the configured test location: `verify.testDir` + `verify.testGlob`.
 *
 * Epic #1883. The acceptance tests a lean run freezes are tests OF THE
 * PROJECT, so they have to live where the project's own CI looks for them. The
 * first trial wrote them into a new repo-root `tests/` folder because nothing in
 * the run's contract told the adversary where tests go. Three layers carry the
 * answer now, and each is pinned here against the failure it exists to prevent:
 *
 *   (1) the CONFIG (`config-test-location.ts` + `loadWorkConfig`): a directory
 *       that is not repo-relative, a pattern with two stars, or one half of the
 *       pair without the other, all refused at load. A config the loader
 *       accepted but the boundary could not read is a rule nobody enforces.
 *   (2) the PROMPTS: both adversaries are told the folder and the naming
 *       pattern, in the SAME const, with an example the boundary would accept.
 *       A child that is never told writes wherever it likes and every one of its
 *       files is then dropped.
 *   (3) the BOUNDARY (`validateSubmitRows`): a submitted test outside the folder
 *       — including a NESTED folder, which reads as "inside" to a prefix check —
 *       or under a name the pattern rejects, is refused with a reason, and a
 *       criterion whose only file was refused goes uncovered.
 *
 * The end-to-end cases drive the real steps through lib/lean-specify-fixture.ts
 * and lib/lean-challenge-fixture.ts against real temp repos, so "refused" means
 * the file was never frozen and never committed, not that a helper returned a
 * string.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { challengePrompt } from "../src/lean/challenge-prompt.ts";
import { ChallengeInfraError } from "../src/lean/challenge.ts";
import {
  testLocationOf,
  testLocationProblem,
  validateTestDir,
  validateTestGlob,
} from "../src/lean/config-test-location.ts";
import { LeanConfigError, defaultConfig, loadWorkConfig } from "../src/lean/config.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import {
  RED_PROOF_CONTRACT,
  specifyPrompt,
  testLocationInstruction,
} from "../src/lean/specify-prompt.ts";
import { validateSubmitRows } from "../src/lean/specify-tree.ts";
import {
  challengeFixture,
  greenEdge,
  put,
  redEdge,
  runChallenge,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  SpecifyInfraError,
  configWithLocation,
  git,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

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
    { id: "AC1", text: "retries a transient failure", verify: "test" },
    { id: "AC2", text: "documents the budget", verify: "manual" },
  ],
};
const WT = "/tmp/lean-test-dir/.worktrees/lean-1883";
const LOC = { testDir: "extension/smoke-tests", testGlob: "test-*.ts" };

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

  for (const good of ["test-*.ts", "*.test.ts", "spec-*.bats", "test_*"])
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

/**
 * A challenge edge case the runner can execute: `put` writes 0o644 and the
 * fixture's runner is `sh {file}`, so the script bit is set explicitly — the
 * same way `redEdge`'s own cases need it.
 */
function executable(wt: string, rel: string, content: string): void {
  put(wt, rel, content);
  chmodSync(path.join(wt, rel), 0o755);
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

// ────────────────────────────────── (3a) the boundary refuses misplaced tests

{
  const present = new Set([
    "extension/smoke-tests/test-ac1.ts",
    "extension/smoke-tests/unit/test-nested.ts",
    "tests/test-wrong-dir.ts",
    "extension/smoke-tests/spec-wrong-name.ts",
  ]);
  const { kept, dropped } = validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/unit/test-nested.ts"] },
      { criterionId: "AC1", testFiles: ["tests/test-wrong-dir.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/spec-wrong-name.ts"] },
      // The same good file, spelled with a `./` and a `\`: normalisation runs
      // BEFORE the location check, so a dodge by punctuation is not a dodge.
      { criterionId: "AC1", testFiles: ["./extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension\\smoke-tests\\test-ac1.ts"] },
    ],
    { spec: SPEC, exists: (p) => present.has(p), testLocation: LOC },
  );
  assert(
    kept.length === 1 && kept[0]?.testFiles.join() === "extension/smoke-tests/test-ac1.ts",
    `only the correctly placed and named test survives (got ${JSON.stringify(kept)})`,
  );
  const reasons = dropped.map((d) => `${d.path}|${d.reason}`);
  assert(
    dropped.some(
      (d) =>
        d.path === "extension/smoke-tests/unit/test-nested.ts" &&
        d.reason.includes("not directly inside"),
    ) && reasons.some((r) => r.startsWith("tests/test-wrong-dir.ts|")),
    "a nested folder is refused with a reason naming the folder rule",
  );
  assert(
    dropped.some((d) => d.path === "tests/test-wrong-dir.ts" && d.reason.includes("testDir")),
    "a file in the wrong directory is refused naming verify.testDir",
  );
  assert(
    dropped.some(
      (d) => d.path === "extension/smoke-tests/spec-wrong-name.ts" && d.reason.includes("testGlob"),
    ),
    "a file with the wrong name is refused naming verify.testGlob",
  );
  assert(
    dropped.filter((d) => d.path === "./extension/smoke-tests/test-ac1.ts").length === 0 &&
      dropped.filter((d) => d.path === "extension\\smoke-tests\\test-ac1.ts").length === 0,
    "a `./` or `\\` spelling of the good path normalises to the kept file, not a refusal",
  );
  // Without the config, all four paths are judged only by the pre-existing rules
  // — the feature must not fire when unset.
  const unconfigured = validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/test-wrong-dir.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/spec-wrong-name.ts"] },
    ],
    { spec: SPEC, exists: (p) => present.has(p) },
  );
  assert(
    unconfigured.kept.length === 1 && unconfigured.dropped.length === 0,
    `no config → both files judged only by the existing rules (kept ${unconfigured.kept.length}, dropped ${unconfigured.dropped.length})`,
  );
}

/**
 * Which boundary rule answers first, pinned directly. `validateSubmitRows` asks
 * in a fixed order — path shape, then the configured location, then "already
 * frozen", then existence — and the reason an operator reads is whichever rule
 * fired. Two arms, because an E2E run only ever reports the one that fired:
 *
 *   - a path that is BOTH misplaced and frozen reports the LOCATION: the child
 *     has two problems and the frozen one is not at stake (it never wrote the
 *     file, so it replaced nothing);
 *   - a path that is well placed but already frozen reports FROZEN, and never
 *     "misplaced" — that reading would tell an operator to move a file the run
 *     must not touch.
 */
{
  const ordered = validateSubmitRows(
    [
      { criterionId: "AC1", testFiles: ["tests/AC1-retry.test.sh"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] },
      { criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac2-missing.ts"] },
    ],
    {
      spec: SPEC,
      exists: (p) => p === "extension/smoke-tests/test-ac1.ts",
      testLocation: LOC,
      frozenPaths: new Set(["tests/AC1-retry.test.sh", "extension/smoke-tests/test-ac1.ts"]),
    },
  );
  const reasonFor = (rel: string): string =>
    ordered.dropped.find((d) => d.path === rel)?.reason ?? "";
  assert(
    ordered.kept.length === 0,
    `nothing survives when every path is frozen or unwritten (got ${JSON.stringify(ordered.kept)})`,
  );
  assert(
    reasonFor("tests/AC1-retry.test.sh").includes("not directly inside"),
    `a misplaced path reports the LOCATION rule even though the path is also frozen (got ${reasonFor("tests/AC1-retry.test.sh")})`,
  );
  assert(
    reasonFor("extension/smoke-tests/test-ac1.ts").includes("frozen acceptance test") &&
      reasonFor("extension/smoke-tests/test-ac1.ts").includes("not directly inside") === false,
    `a well-placed frozen path reports FROZEN and never "misplaced" (got ${reasonFor("extension/smoke-tests/test-ac1.ts")})`,
  );
  assert(
    reasonFor("extension/smoke-tests/test-ac2-missing.ts").includes("does not exist"),
    `a well-placed file the child never wrote reports EXISTENCE (got ${reasonFor("extension/smoke-tests/test-ac2-missing.ts")})`,
  );
}

// ───────────────────────── (3b) specify end-to-end: a misplaced test is refused

{
  const good = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot: good.repoRoot,
    baseSha: good.baseSha,
    issue: 1883,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/test-ac1-retry.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/test-ac1-retry.ts"])],
  });
  assert(r.threw === undefined, `(specify) correctly placed test: no throw (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "ok" &&
      Object.keys(r.outcome.frozen ?? {}).join() === "extension/smoke-tests/test-ac1-retry.ts",
    `(specify) the test in the configured folder freezes (got ${JSON.stringify(r.outcome)})`,
  );

  // Same repo, same red test, one directory off: the criterion goes uncovered
  // and nothing is frozen — the same refusal an invalid path earns. A run that
  // froze it anyway would hand the project a test its own CI never runs.
  const bad = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const refused = await runSpecify({
    repoRoot: bad.repoRoot,
    baseSha: bad.baseSha,
    issue: 1884,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/test-ac1-retry.ts"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/test-ac1-retry.ts"])],
  });
  assert(
    refused.threw === undefined,
    `(specify) a misplaced test is a VERDICT, not infra (${refused.threw?.message})`,
  );
  assert(
    refused.outcome?.kind === "no-red-test",
    `(specify) misplaced test → no-red-test (got ${refused.outcome?.kind})`,
  );
  assert(
    refused.outcome?.kind === "no-red-test" &&
      refused.outcome.failedRules?.[0]?.startsWith("criterion AC1 has no red test") === true,
    `(specify) the rule still leads with the uncovered criterion (got ${JSON.stringify(refused.outcome?.failedRules)})`,
  );
  assert(
    (refused.outcome?.reason ?? "").includes("not directly inside the configured test directory"),
    `(specify) the reason says WHY the file was refused (got ${refused.outcome?.reason})`,
  );
  assert(
    git(refused.worktree, "rev-list", "--count", "HEAD").trim() === "1",
    `(specify) a refused round commits nothing — the tree still holds only its base (got ${git(refused.worktree, "rev-list", "--count", "HEAD")})`,
  );

  // The wrong NAME, in the right folder: same refusal, different reason.
  const wrongName = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const named = await runSpecify({
    repoRoot: wrongName.repoRoot,
    baseSha: wrongName.baseSha,
    issue: 1885,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/spec-ac1-retry.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/spec-ac1-retry.ts"])],
  });
  assert(
    named.outcome?.kind === "no-red-test" &&
      (named.outcome.reason ?? "").includes("does not match the configured test name pattern"),
    `(specify) a right-folder/wrong-name test is refused naming the pattern (got ${named.outcome?.kind} / ${named.outcome?.reason})`,
  );

  // And the prompt the step actually sent named the folder — the config is not
  // enforced silently while the child is still told to write anywhere.
  const prompts: string[] = [];
  const told = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  await runSpecify({
    repoRoot: told.repoRoot,
    baseSha: told.baseSha,
    issue: 1886,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: () => {},
    toolUses: [],
    prompts,
  });
  assert(
    prompts.length === 1 &&
      prompts[0]?.includes("directly inside `extension/smoke-tests/`") === true,
    "(specify) the dispatched prompt carried the configured folder",
  );
  assert(ROOTS.length > 0, "the temp repos this case created are registered for cleanup");
}

// ─────────────────────────── (3c) challenge end-to-end: the same boundary holds

{
  const EDGE_DIR = "extension/smoke-tests";
  const EDGE = `${EDGE_DIR}/test-ac1-edge-second-failure.ts`;
  const r = await runChallenge({
    issue: 201,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => executable(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw === undefined, `(challenge) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome.frozen ?? {}).join() === EDGE,
    `(challenge) an edge case in the configured folder freezes (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    r.prompts[0]?.includes("directly inside `extension/smoke-tests/`") === true,
    "(challenge) the adversary was TOLD the folder, not just policed by it",
  );

  // A misplaced edge case earns `none` — the round found nothing the step may
  // freeze — and the reason says the file was refused for its location, so it
  // is never mistaken for "the builder handles this case".
  const off = await runChallenge({
    issue: 202,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => executable(wt, "tests/test-ac1-edge.ts", redEdge("tests/test-ac1-edge.ts")),
    toolUses: [submit("AC1", ["tests/test-ac1-edge.ts"])],
  });
  assert(
    off.threw === undefined,
    `(challenge) misplaced edge case is a verdict (${off.threw?.message})`,
  );
  assert(
    off.outcome?.kind === "none",
    `(challenge) a misplaced edge case freezes nothing → none (got ${off.outcome?.kind})`,
  );
  assert(
    (off.outcome?.reason ?? "").includes("not directly inside the configured test directory"),
    `(challenge) the reason names the location rule, not "already handled" (got ${off.outcome?.reason})`,
  );
  assert(
    off.outcome?.kind === "none" && off.dispatched === 1,
    "(challenge) the adversary was paid once and the round simply found nothing freezable",
  );

  // The frozen contract this fixture committed lives OUTSIDE the configured
  // folder (`tests/AC1-retry.test.sh`), and the run must still start: the rule
  // governs what the adversary SUBMITS, it never retroactively refuses the
  // contract the run inherited — `assertFrozenIntact` has to keep reading that
  // blob at the head, or a project adopting the setting would break its own
  // in-flight runs.
  const legacy = await runChallenge({
    issue: 203,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) => executable(wt, EDGE, redEdge(EDGE)),
    toolUses: [
      submit("AC1", [EDGE]),
      submit("AC1", ["tests/AC1-retry.test.sh", "extension/smoke-tests/test-ac1-misplaced.ts"]),
    ],
    built: challengeFixture(203),
  });
  assert(
    legacy.outcome?.kind === "new-tests" &&
      Object.keys(legacy.outcome.frozen ?? {}).join() === EDGE,
    `(challenge) a pre-existing frozen test outside the folder does not break the round (got ${JSON.stringify(legacy.outcome?.frozen)})`,
  );
  // The two refusals each carry their OWN reason: the frozen path is refused
  // because the run already froze it (the contract predates the setting), and
  // the new file is refused for never having been written. A third spelling — a
  // frozen path in the RIGHT folder — is pinned in (3a) below, so the frozen
  // rule's precedence over the location rule is proven rather than assumed.
  assert(
    legacy.outcome?.kind === "new-tests" &&
      (legacy.outcome.reason ?? "").includes("does not exist") &&
      (legacy.outcome.reason ?? "").includes("test-ac1-misplaced.ts"),
    `(challenge) one round reports a not-written refusal and the inherited contract stays intact (got ${legacy.outcome?.reason})`,
  );
  const frozenInPlace = validateSubmitRows(
    [{ criterionId: "AC1", testFiles: ["extension/smoke-tests/test-ac1.ts"] }],
    {
      spec: SPEC,
      exists: () => true,
      testLocation: LOC,
      frozenPaths: new Set(["extension/smoke-tests/test-ac1.ts"]),
    },
  );
  assert(
    frozenInPlace.kept.length === 0 &&
      frozenInPlace.dropped[0]?.reason.includes("frozen acceptance test") === true &&
      frozenInPlace.dropped[0]?.reason.includes("misplaced") === false &&
      frozenInPlace.dropped[0]?.reason.includes("not directly inside") === false,
    `a frozen path that sits INSIDE the configured folder is refused as frozen, never as misplaced (got ${frozenInPlace.dropped[0]?.reason})`,
  );

  // A green edge case in the RIGHT place is still dropped for being green —
  // the location rule must not have become the only rule the boundary applies.
  const green = await runChallenge({
    issue: 204,
    config: configWithLocation(EDGE_DIR, "test-*.ts"),
    child: (wt) =>
      executable(wt, `${EDGE_DIR}/test-ac1-green.ts`, greenEdge(`${EDGE_DIR}/test-ac1-green.ts`)),
    toolUses: [submit("AC1", [`${EDGE_DIR}/test-ac1-green.ts`])],
  });
  assert(
    green.outcome?.kind === "none" && (green.outcome.reason ?? "").includes("exited 0 on base"),
    `(challenge) a well-placed GREEN test is dropped for being green, not for its path (got ${green.outcome?.reason})`,
  );
  // Both steps' infra error classes are in scope deliberately: a misplaced
  // test is a verdict, and asserting these cases throw NOTHING is only
  // meaningful if the throw type the assertion would have accepted is imported.
  assert(
    typeof SpecifyInfraError === "function" && typeof ChallengeInfraError === "function",
    "both infra error classes are in scope — a misplaced test threw neither",
  );
}

for (const root of ROOTS) rmSync(root, { recursive: true, force: true });

console.log(exit === 0 ? "\nConfigured test location is enforced." : "\nFAILED");
process.exit(exit);
