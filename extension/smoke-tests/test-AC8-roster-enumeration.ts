#!/usr/bin/env bun
/**
 * #2439 AC1/AC2/R6/R7 — the roster's enumeration is RECURSIVE under `verify.testDir`, and the
 * 200-file ENUMERATION refusal is gone.
 *
 * The bench arm B carries graded tests one to five directories deep, and the flat boundary could
 * only ever reach the ones sitting directly inside `testDir`: every ls-tree entry whose path after
 * `testDir/` held another `/` was dropped, so `tests/unit/test-a.sh` was invisible and a
 * nested-only base enumerated empty — the hand-back the operator read as "the project has no
 * tests". Past 200 matches the same function refused outright, which is the other way a real repo
 * (scikit-learn, keras, moto) could not be judged at all.
 *
 * Both are asserted at the enumeration seam rather than through a whole verify run, because the
 * claim is about which paths one git listing yields: a step-level fixture would have to commit
 * hundreds of files to say what four lines of this function decide.
 *
 * R1 is pinned beside them: this recursion belongs to the ROSTER's enumeration ONLY.
 * `testLocationProblem` — where the run's submitted acceptance test may live — stays flat, so the
 * same nested path is a roster entry and a refused submission in the same case.
 */
import { listProjectTestFilesAtBase } from "../src/lean/verify-roster-base.ts";
import { testLocationProblem } from "../src/lean/config-test-location.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";

const SELF = "test-AC8-roster-enumeration.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const BASE = "0123456789abcdef0123456789abcdef01234567";

/**
 * An executor that answers the roster's ONE git question with the paths the case declares.
 *
 * `git ls-tree -r -z --name-only <base> -- <testDir>` is what the enumeration asks, so the case
 * states the tree the commit holds rather than building a repo per shape — and records the argv it
 * was asked with, so a case cannot pass on a listing nobody requested.
 */
function listing(argv: string[]): { exec: VerifyExec; asked: string[][] } {
  const asked: string[][] = [];
  const exec = ((_cmd: string, o: { argv?: string[] }) => {
    asked.push(o?.argv ?? []);
    return Promise.resolve({ stdout: argv.join("\0") + "\0", stderr: "" });
  }) as unknown as VerifyExec;
  return { exec, asked };
}

const list = (paths: string[], testDir = "tests", testGlob = "test-*.sh") => {
  const { exec, asked } = listing(paths);
  return {
    asked,
    run: listProjectTestFilesAtBase(exec, "/repo", BASE, testDir, testGlob),
  };
};

{
  // AC1: nested matches are pre-existing tests. A base whose only tests sit under `tests/unit/` and
  // `tests/integration/deep/` used to enumerate EMPTY, which the step turns into a hand-back.
  const { run, asked } = list([
    "tests/test-top.sh",
    "tests/unit/test-a.sh",
    "tests/integration/deep/test-b.sh",
    "tests/unit/helper.sh",
    "src/not-a-test.sh",
  ]);
  const r = await run;
  assert(
    !("reason" in r),
    `(nested) a base whose tests are nested yields an enumeration, not a refusal (${JSON.stringify(r).slice(0, 140)})`,
  );
  assert(
    JSON.stringify("files" in r ? r.files : []) ===
      JSON.stringify([
        "tests/test-top.sh",
        "tests/unit/test-a.sh",
        "tests/integration/deep/test-b.sh",
      ]),
    `(nested) every matching file at any depth is listed, repo-relative, in git's tree order (${JSON.stringify(
      "files" in r ? r.files : [],
    )})`,
  );
  assert(
    !("files" in r && r.files.includes("tests/unit/helper.sh")) &&
      !("files" in r && r.files.includes("src/not-a-test.sh")),
    "(nested) a non-matching basename and a path outside testDir are still not tests",
  );
  assert(
    asked.length === 1 &&
      asked[0]?.includes("ls-tree") === true &&
      asked[0]?.includes("-r") === true,
    `(nested) the enumeration is one recursive ls-tree of the base commit (${JSON.stringify(asked[0] ?? []).slice(0, 160)})`,
  );
}

{
  // AC2 + R6: past the cap the enumeration no longer refuses, and it stays WHOLE. The 200-file
  // ENUMERATION refusal is what made a big repo unjudgeable (scikit-learn, keras, moto each carry
  // far more than 200 test files); the cap is now a RECORD rule applied at assembly, so the listing
  // this function hands its caller is the full one and `fileCount` states its size. The truncation
  // itself, and an edited file sorting past entry 200 still having its base version run, are
  // asserted at the step in `test-AC9` — a unit case could only assert about a list it made itself.
  const many = Array.from({ length: 205 }, (_, i) => `tests/test-${String(i).padStart(3, "0")}.sh`);
  const r = await list(many).run;
  assert(
    !("reason" in r),
    `(past cap) 205 matching files is an enumeration, not the refusal it was (${JSON.stringify(r).slice(0, 160)})`,
  );
  assert(
    "files" in r && r.files.length === 205 && r.fileCount === 205,
    `(past cap) the enumeration the caller receives is the whole listing (${String("files" in r ? r.files.length : -1)} entries, count ${String("fileCount" in r ? r.fileCount : -1)})`,
  );
  assert(
    "files" in r && r.files[0] === many[0] && r.files[204] === many[204],
    "(past cap) in git's tree order, including the entry a truncated list would have lost — which is the file a truncated list would also have hidden from edited-file detection",
  );
}

{
  // R7: `testDir` may itself be multi-segment (`test/units`, per the bench's package-internal test
  // dirs), and matching stays prefix-based on the normalised value.
  const { run } = list(
    ["test/units/test-a.sh", "test/units/nested/deep/test-b.sh", "test/other/test-c.sh"],
    "test/units",
  );
  const r = await run;
  assert(
    "files" in r &&
      JSON.stringify(r.files) ===
        JSON.stringify(["test/units/test-a.sh", "test/units/nested/deep/test-b.sh"]),
    `(multi-segment testDir) matches under test/units at any depth, and nothing outside it (${JSON.stringify(
      "files" in r ? r.files : [],
    )})`,
  );
}

{
  // A `testGlob` matches the BASENAME only, at any depth: a nested file whose basename matches is a
  // test, and one whose basename does not is not, whatever its directory looks like.
  const { run } = list(
    ["tests/unit/test-a.sh", "tests/unit/conftest.sh", "tests/unit/test-x.sh"],
    "tests",
    "test-*.sh",
  );
  const r = await run;
  assert(
    "files" in r &&
      JSON.stringify(r.files) === JSON.stringify(["tests/unit/test-a.sh", "tests/unit/test-x.sh"]),
    `(basename glob) the pattern is applied to the basename at every depth (${JSON.stringify(
      "files" in r ? r.files : [],
    )})`,
  );
}

{
  // A sibling whose name merely STARTS with the testDir prefix is not inside it: `tests_backup/` is
  // a different directory, and a prefix test without the separator would draft its files as tests.
  const { run } = list(["tests/test-a.sh", "tests_backup/test-b.sh"]);
  const r = await run;
  assert(
    "files" in r && JSON.stringify(r.files) === JSON.stringify(["tests/test-a.sh"]),
    `(prefix) tests_backup/ is not tests/ (${JSON.stringify("files" in r ? r.files : [])})`,
  );
}

{
  // R1: the asymmetry, pinned. The roster's enumeration reaches into subdirectories;
  // `testLocationProblem` — where the adversary's submitted acceptance test may live — does not.
  // The two used to share one flat boundary and one comment claiming they were the same boundary.
  const nested = "tests/unit/test-a.sh";
  const { run } = list([nested]);
  const roster = await run;
  assert(
    "files" in roster && roster.files.includes(nested),
    `(R1) the roster enumerates ${nested}`,
  );
  assert(
    testLocationProblem({ testDir: "tests", testGlob: "test-*.sh" }, nested) !== undefined,
    `(R1) and a submitted acceptance test at the same path is still refused — recursion is the roster's alone`,
  );
  assert(
    testLocationProblem({ testDir: "tests", testGlob: "test-*.sh" }, "tests/test-a.sh") ===
      undefined,
    "(R1) the flat submission boundary still accepts a file directly inside testDir",
  );
}

{
  // A listing git refused is still `reason`, never an empty enumeration: the fail-closed rule the
  // recursion must not have weakened.
  const refusing = (async () => {
    const exec = (() => Promise.reject(new Error("bad object"))) as unknown as VerifyExec;
    return listProjectTestFilesAtBase(exec, "/repo", BASE, "tests", "test-*.sh");
  })();
  const r = await refusing;
  assert(
    "reason" in r,
    `(unreadable listing) a rejected git read is a refusal, not "the project has no tests" (${JSON.stringify(r).slice(0, 120)})`,
  );
}

console.log(`\nexit ${String(exit)}`);
if (exit !== 0) process.exit(exit);
