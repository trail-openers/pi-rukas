#!/usr/bin/env bun
/**
 * lean — several acceptance-test roots (`verify.testDirs`) for a multi-package repo.
 *
 * A cargo workspace keeps one `tests/` per crate, so one `verify.testDir` can only ever freeze tests for
 * one crate. `testDirs` is `testDir` with several roots and the same per-entry rules, exclusive of it.
 * What this file pins: the loader's refusals, the location rule over every root, the roster's union
 * listing at base, the prompt naming every root, the preflight probe landing in a root on the tree, and
 * the docs line on in-file tests.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { testLocationOf, testLocationProblem } from "../src/lean/config-test-location.ts";
import { LeanConfigError, loadWorkConfig } from "../src/lean/config.ts";
import { testLocationInstruction } from "../src/lean/specify-prompt.ts";
import { listProjectTestFilesAtBase } from "../src/lean/verify-roster-base.ts";
import { buildProjectRoster } from "../src/lean/verify-roster.ts";
import { PY_PROBE, runPreflight, runner } from "./lib/lean-preflight-probe-fixture.ts";
import { makeRepo } from "./lib/lean-specify-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

const DIRS = ["crates/a/tests", "crates/b/tests"];
const LOC = { testDirs: DIRS, testGlob: "*.rs" };

// ── the loader: accepted as testDir's alternative, each entry validated, never both

{
  const load = async (verify: Record<string, unknown>) => {
    const r = makeRepo({ ".pi/work.json": JSON.stringify({ version: 1, verify }) });
    try {
      return await loadWorkConfig(execp, r.repoRoot, r.baseSha);
    } catch (err) {
      return err as Error;
    }
  };
  const ok = await load({ testDirs: DIRS, testGlob: "*.rs" });
  const loc = ok instanceof Error ? undefined : testLocationOf(ok.verify);
  assert(
    JSON.stringify(loc) === JSON.stringify(LOC),
    `testDirs + testGlob loads into a location over every root (got ${ok instanceof Error ? ok.message : JSON.stringify(loc)})`,
  );
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["both set", { testDir: "tests", testDirs: DIRS, testGlob: "*.rs" }, "exclusive"],
    ["an empty list", { testDirs: [], testGlob: "*.rs" }, "non-empty array"],
    ["a string, not a list", { testDirs: "tests", testGlob: "*.rs" }, "non-empty array"],
    [
      "a non-string entry",
      { testDirs: ["tests", 7], testGlob: "*.rs" },
      "testDirs[1] must be a string",
    ],
    [
      "a bad entry",
      { testDirs: ["tests", "/abs"], testGlob: "*.rs" },
      "testDirs[1] must be repo-relative",
    ],
    ["no testGlob", { testDirs: DIRS }, "verify.testDirs requires verify.testGlob"],
  ];
  for (const [name, verify, why] of refusals) {
    const got = await load(verify);
    assert(
      got instanceof LeanConfigError && got.message.includes(why),
      `${name}: refused at load naming "${why}" (got ${got instanceof Error ? got.message : "loaded"})`,
    );
  }
}

// ── the location rule: directly inside ANY root; the refusal names them all

{
  assert(
    testLocationProblem(LOC, "crates/b/tests/retry.rs") === undefined,
    "a test directly inside the second root is accepted",
  );
  const outside = testLocationProblem(LOC, "crates/c/tests/retry.rs") ?? "";
  assert(
    DIRS.every((d) => outside.includes(`${d}/`)),
    `a test outside every root is refused naming each of them (got ${outside})`,
  );
}

// ── the roster lists every root at base, a union, empty only when all are

{
  const { repoRoot, baseSha } = makeRepo({
    "crates/a/src/lib.rs": "",
    "crates/b/tests/retry.rs": "",
    "crates/b/tests/deep/more.rs": "",
    "crates/c/tests/other.rs": "",
  });
  const listed = await listProjectTestFilesAtBase(execp, repoRoot, baseSha, LOC);
  assert(
    "files" in listed &&
      JSON.stringify(listed.files) ===
        JSON.stringify(["crates/b/tests/deep/more.rs", "crates/b/tests/retry.rs"]),
    `an empty first root does not empty the listing, and nothing outside the roots joins it (got ${JSON.stringify(listed)})`,
  );
}

{
  // Empty in every root: the roster reads `testDirs` off the config and names each root it searched.
  const { repoRoot, baseSha } = makeRepo({ "crates/c/tests/other.rs": "" });
  const none = await buildProjectRoster({
    exec: execp,
    repoRoot,
    wt: repoRoot,
    baseSha,
    issue: 2494,
    timeoutMs: 30_000,
    config: { test: "cargo test {file}", testDirs: DIRS, testGlob: "*.rs" },
    frozen: {},
  });
  const reason = none.status === "none" ? none.reason : "";
  assert(
    DIRS.every((d) => reason.includes(`${d}/*.rs`)),
    `the roster reports empty only after searching every root, naming each (got ${none.status}: ${reason})`,
  );
}

// ── the prompt names every root; the preflight probes a root that is on the tree

{
  const line = testLocationInstruction(LOC);
  assert(
    DIRS.every((d) => line.includes(`\`${d}/\``)),
    `the adversary is told every root (got ${line})`,
  );
  const { repoRoot } = makeRepo({ "crates/b/tests/.keep": "" });
  const template = runner(repoRoot, "pyrunner.sh", "exit 5");
  const got = await runPreflight({
    wt: repoRoot,
    template,
    testLocation: { testDirs: DIRS, testGlob: "test_*.py" },
  });
  assert(
    got.written[0] === `crates/b/tests/${PY_PROBE}`,
    `a python probe skips a root missing from the tree and sits in one that exists (got ${got.written[0] ?? got.threw?.message})`,
  );
}

// ── docs: why a test inside an implementation file cannot be frozen

{
  const lean = readFileSync(path.join(import.meta.dir, "../../docs/lean.md"), "utf8");
  assert(
    /#\[cfg\(test\)\][\s\S]{0,200}cannot be frozen/.test(lean),
    "docs/lean.md says an in-file test (#[cfg(test)]) cannot be frozen",
  );
}

console.log(testLocationExit() === 0 ? "\nverify.testDirs is pinned." : "\nFAILED");
process.exit(testLocationExit());
