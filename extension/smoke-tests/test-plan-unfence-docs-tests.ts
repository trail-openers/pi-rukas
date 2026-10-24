#!/usr/bin/env bun
/**
 * #1250 change 1 — a single-workstream plan must not fence out the project's
 * documentation and tests.
 *
 * The field failure (measured, in the brief): for N=1 cycles the planner wrote
 * documentation pages and test files into the one workstream's `outOfScope` on
 * its own initiative — the plan prompt demands a non-empty fence, and when the
 * issue names nothing to fence, docs and tests are what gets fenced. A developer
 * following the project's own rules (every change updates its tests and its
 * documentation page) touched one, and the develop gate parked
 * `verify-failed:develop` with `touched out-of-scope path <file> — declared
 * fence violated (issue-fenced)` after 90–170 minutes of develop.
 *
 * These tests drive the pass the way the plan step does — `runPlanUnfencePass`
 * in work-driver-plan-coupling-pass.ts, with the issue body cached to an
 * artifact — so N, the escape hatch and the summary are all exercised through
 * the wiring that actually runs, not only through the unit.
 *
 * Paths are synthetic (`docs/`, `host/docs/`, `test/`, `src/`, `lib/`): this
 * repo is public and no real host path belongs in a fixture.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  docsOrTestReason,
  isDocsPathEntry,
  isTestPathEntry,
} from "../src/plan-docs-test-path.ts";
import { runPlanUnfencePass } from "../src/work-driver-plan-coupling-pass.ts";
import { unfenceSummary } from "../src/work-driver-plan-unfence-notes.ts";
import { unfenceDocsTestPaths } from "../src/work-driver-plan-unfence-docs-tests.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** An exec stub that resolves nothing: these cases are all shape + prose. */
const NO_EXEC = async () => ({ stdout: "" });

/**
 * Run the pass exactly as the plan step does: body cached to an artifact, a
 * fresh WorkState pointing at it, no git (the stub never resolves a symbol).
 */
async function runPass(
  workstreams: Record<string, Workstream>,
  body: string,
): Promise<{
  workstreams: Record<string, Workstream>;
  summary?: ReturnType<typeof unfenceSummary>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "pi-unfence-docs-"));
  const artifact = join(dir, "issue.md");
  try {
    writeFileSync(artifact, body, "utf8");
    const state = initialState(1250, "synthetic: stop fencing docs and tests");
    state.pipelineState.issueBodyArtifact = artifact;
    return await runPlanUnfencePass(workstreams, state, {
      repoRoot: "/repo",
      execFn: NO_EXEC,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PLAIN_BODY = "## Resolved decisions\n\nThe change adds a flag to the entry point.\n";

// The five entries the brief names, in one plan — the measured shape.
const measuredPlan = (): Record<string, Workstream> => ({
  default: WS("default", ["src/app.ts"], [
    "docs/guide.md",
    "host/docs/",
    "test/helper.sh",
    "src/a_test.go",
    "lib/x.sh",
  ]),
});

process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = "1";

// ------------------------------------------- AC: N=1 opens docs and tests

{
  const out = await runPass(measuredPlan(), PLAIN_BODY);
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(!fence.includes("docs/guide.md"), "N=1: docs/guide.md is no longer fenced");
  assert(!fence.includes("host/docs/"), "N=1: the docs directory fence host/docs/ is opened");
  assert(!fence.includes("test/helper.sh"), "N=1: test/helper.sh is no longer fenced");
  assert(!fence.includes("src/a_test.go"), "N=1: src/a_test.go is no longer fenced");
  assert(fence.includes("lib/x.sh"), "N=1: lib/x.sh — neither doc nor test — keeps its fence");
  assert(fence.length === 1, `only lib/x.sh survives (got ${JSON.stringify(fence)})`);
  assert(
    (out.workstreams.default?.paths ?? []).length === 1,
    "the pass adds no docs/test path to the workstream's declared paths",
  );
  assert(out.summary?.docsTests === 4, `the summary counts 4 docs/test openings (${out.summary?.docsTests})`);
  assert(
    (out.summary?.notes ?? []).some((n) => n.includes("docs-or-test path, N=1")),
    "each removal's note names the rule that made it",
  );
}

// ------------------------------------- AC: an explicit prohibition is kept

{
  const body = `${PLAIN_BODY}\n## Out of scope\n\nDo not touch docs/guide.md in this change.\n`;
  const out = await runPass(measuredPlan(), body);
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(fence.includes("docs/guide.md"), "an issue that forbids docs/guide.md keeps it fenced");
  assert(!fence.includes("host/docs/"), "the prohibition is per-path — host/docs/ still opens");
  assert(
    (out.summary?.notes ?? []).some((n) => n.startsWith("unfenced host/docs/")),
    "the kept entry's siblings are still recorded as opened",
  );
  assert(out.summary?.docsTests === 3, `three openings recorded, not four (${out.summary?.docsTests})`);
}

// ------------------------------------------------ AC: N>1 changes nothing

{
  const two: Record<string, Workstream> = {
    a: WS("a", ["src/app.ts"], ["docs/guide.md", "test/helper.sh", "src/a_test.go", "lib/x.sh"]),
    b: WS("b", ["src/other.ts"], ["host/docs/"]),
  };
  const before = JSON.stringify(two);
  const out = await runPass(two, PLAIN_BODY);
  assert(JSON.stringify(out.workstreams) === before, "N=2: the plan is returned byte-identical");
  assert(out.summary?.docsTests === undefined, "N=2: no docs/test openings recorded");
  assert(
    out.workstreams.a?.outOfScope.includes("test/helper.sh") === true,
    "N=2: a sibling's test fence is the cross-declaration contract and stays",
  );
}

// --------------------------------------------- AC: the escape hatch

{
  process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = "0";
  const out = await runPass(measuredPlan(), PLAIN_BODY);
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(fence.length === 5, `hatch off: all five fences are exactly as written (${fence.length})`);
  assert(
    fence.includes("docs/guide.md") &&
      fence.includes("host/docs/") &&
      fence.includes("test/helper.sh") &&
      fence.includes("src/a_test.go"),
    "hatch off: today's behaviour — docs and test fences untouched",
  );
  assert(out.summary?.docsTests === undefined, "hatch off: the summary claims no docs/test openings");
  process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = "1";
}

// ------------------------------------ AC: a broader fence is not opened

{
  const plan: Record<string, Workstream> = {
    default: WS("default", ["src/app.ts"], ["host/", "vendor/", "docs/"]),
  };
  const out = await runPass(plan, PLAIN_BODY);
  const fence = out.workstreams.default?.outOfScope ?? [];
  assert(fence.includes("host/"), "host/ — a broader fence that merely CONTAINS docs — is kept");
  assert(fence.includes("vendor/"), "an unrelated fence is kept");
  assert(!fence.includes("docs/"), "docs/ is a docs fence by its own shape and opens");
}

// -------------------------------------- AC: the summary records each removal

{
  const plan = measuredPlan();
  const res = unfenceDocsTestPaths(plan, PLAIN_BODY);
  assert(res.removed.length === 4, `four removal records (${res.removed.length})`);
  const kinds = res.removed.map((r) => `${r.docsTest}:${r.entry}`).sort();
  assert(
    JSON.stringify(kinds) ===
      JSON.stringify(["docs:docs/guide.md", "docs:host/docs/", "test:src/a_test.go", "test:test/helper.sh"]),
    `each record names its kind and entry (${kinds.join(", ")})`,
  );
  assert(
    res.removed.every((r) => r.workstream === "default"),
    "every record names the workstream the fence came from",
  );
  const summary = unfenceSummary(res);
  assert(summary.docsTests === 4, "unfenceSummary counts the docs/test openings");
  // `removed` is the union total (removed.length - rolledBack) and `docsTests`
  // is the subset this rule opened, so with no issue-named removals they are
  // equal. A plan that had BOTH is covered by the wiring cases above.
  assert(summary.removed === 4, `the union count includes them (${summary.removed})`);
  assert(summary.docsTests === summary.removed, "the docs/test subset equals the union here");
  assert(summary.rolledBack === 0, "nothing was rolled back — this rule grants no scope");
  assert(
    (summary.notes ?? []).length === 4,
    `one note per removal (${(summary.notes ?? []).length})`,
  );
}

// ------------------------------------------- the predicates: positives

for (const [p, want] of [
  ["docs/guide.md", "docs"],
  ["host/docs/", "docs"],
  ["README.mdx", "docs"],
  ["docs/intro.rst", "docs"],
  ["manual/usage.adoc", "docs"],
  ["docs/notes.txt", "docs"],
  ["man/section.7", "docs"],
  ["test/helper.sh", "test"],
  ["src/a_test.go", "test"],
  ["src/a.test.ts", "test"],
  ["src/a.spec.ts", "test"],
  ["test_x.py", "test"],
  ["test-x.sh", "test"],
  ["__tests__/unit.ts", "test"],
  ["spec/models.rb", "test"],
  ["smoke-tests/test-foo.ts", "test"],
] as Array<[string, "docs" | "test"]>) {
  assert(docsOrTestReason(p) === want, `positive: ${p} is ${want}`);
}

// ------------------------------------------- the predicates: negatives

for (const p of [
  "docs.ts", // a source file named docs, not a doc — the extension wins
  "latest.ts", // contains "test" as a substring, is not a test
  "contest/x.ts", // a directory containing "test", not named one
  "lib/x.sh",
  "src/app.ts",
  "host/",
  "vendor/",
  "package.json",
  "",
  "src/a.ts",
]) {
  assert(docsOrTestReason(p) === undefined, `negative: ${p || "(empty)"} is neither docs nor test`);
}

assert(isDocsPathEntry("docs.ts") === false, "isDocsPathEntry: docs.ts is not a doc");
assert(isTestPathEntry("latest.ts") === false, "isTestPathEntry: latest.ts is not a test");
assert(isTestPathEntry("contest/x.ts") === false, "isTestPathEntry: contest/x.ts is not a test");
assert(isTestPathEntry("src/a_test.go") === true, "isTestPathEntry: *_test with any extension");
assert(isDocsPathEntry("host/docs/") === true, "isDocsPathEntry: a bare docs directory counts");
assert(isDocsPathEntry("host/") === false, "isDocsPathEntry: a broad directory does not");

// ----------------------------------- the prohibition grammar is the shared one

{
  // The issue NAMES the path without forbidding it — that must not keep the
  // fence, or the rule would be disabled by any mention of docs at all.
  const mentioning = `${PLAIN_BODY}\n## Out of scope\n\ndocs/guide.md describes the flag.\n`;
  const out = await runPass(measuredPlan(), mentioning);
  assert(
    !(out.workstreams.default?.outOfScope ?? []).includes("docs/guide.md"),
    "a non-prohibiting mention of the path does not keep the fence",
  );
}

process.exit(exit);
