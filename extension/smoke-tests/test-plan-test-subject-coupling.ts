#!/usr/bin/env bun
/**
 * #483 — the plan step must not split a test from the file it exercises.
 *
 * `runDevelop` fans one developer per workstream into its own detached
 * worktree. When the plan puts a test in one workstream and its subject in
 * another, the test provably cannot run against the implementation: each
 * workstream passes its own develop gate, and the first verification that
 * sees both is the consolidated tree at commit-pr — after the full develop
 * and adversarial spend, with the same failure the split guaranteed.
 *
 * Observed live on issue #479: task-a → `build.sh`, task-b →
 * `extension/smoke-tests/test-build-list-dedup.ts`. The test asserted
 * against the shape of a file it had never seen.
 *
 * This is a plan-quality defect of exactly the shape `planQualityReason`
 * already models, so it becomes a fourth reason and inherits the existing
 * one-shot corrective re-dispatch. The planner can re-split; a halt would
 * be more code and a worse outcome.
 */

import { findTestSubjectSplits } from "../src/work-driver-plan-paths.ts";
// #679 — all plan-quality symbols from the canonical module (the stale
// duplicate copy in work-driver-plan-helpers.ts was deleted; work-driver-plan.ts
// re-exports it).
import { correctivePlanSteer, correctiveTestSubjectSplitSteer, planQualityReason } from "../src/work-driver-plan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = (paths: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(paths).map(([id, p]) => [id, { paths: p }]));

// A findings count that does not itself trigger "under-decomposed" for N>=2.
const OK_FINDINGS = 2;

// --------------------------------------------------------- the flagged split

{
  // The issue's own fixture: the implementation in one workstream, its test
  // in another. The test name names the module it exercises, so the coupling
  // is inferable from naming and the plan is flagged.
  const splits = findTestSubjectSplits(
    ws({ "task-a": ["build.sh"], "task-b": ["extension/smoke-tests/test-build-list-dedup.ts"] }),
  );
  assert(splits.length === 1, `the #479 fixture is a split (got ${splits.length})`);
  assert(
    splits[0]?.test === "task-b" && splits[0]?.subject === "task-a",
    "the split names which workstream owns the test and which owns the subject",
  );
  assert(
    planQualityReason(
      ws({ "task-a": ["build.sh"], "task-b": ["extension/smoke-tests/test-build-list-dedup.ts"] }),
      OK_FINDINGS,
    ) === "test-subject-split",
    "planQualityReason flags the flagged-split fixture — the corrective re-dispatch fires from here",
  );
}

{
  // Naming inference: `test-<x>.ts` ↔ `<x>.ts`, in any directory.
  assert(
    findTestSubjectSplits(ws({ a: ["src/foo.ts"], b: ["smoke-tests/test-foo.ts"] })).length === 1,
    "canary: test-<x>.ts in a test dir is coupled to <x>.ts in src",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["smoke-tests/test-foo.ts"], b: ["src/foo.ts"] })).length === 1,
    "…in either direction",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["src/foo.ts", "src/other.ts"], b: ["smoke-tests/test-foo.ts"] }))
      .length === 1,
    "a subject workstream with extra files is still the subject's owner",
  );
}

{
  // The fallback: a workstream whose ONLY file(s) are test(s) for a file owned
  // by a different workstream is flagged regardless of naming convention,
  // since that is the shape with no legitimate reading. "Regardless of naming
  // convention" means the test does NOT have to be named `test-<subject>` —
  // but the test must still be about a file in another workstream (by stem
  // token match or by the subject's path appearing in the test path).
  assert(
    findTestSubjectSplits(ws({ a: ["src/mystery.ts"], b: ["smoke-tests/test-mystery-extra.ts"] }))
      .length === 1,
    "canary: a test-only workstream whose stem names the subject is flagged even when the test is not `test-<subject>.ts`",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["build.sh"], b: ["smoke-tests/test-anything.ts"] })).length ===
      0,
    "canary: a test-only workstream whose test does NOT name any other workstream's file is NOT flagged (no legitimate reading of the split)",
  );
}

// -------------------------------------------------------------- not a split

{
  // Genuinely independent workstreams (different modules, no test/subject
  // relationship) are NOT flagged — the check must not collapse every plan
  // into N=1.
  assert(
    findTestSubjectSplits(ws({ a: ["src/a.ts"], b: ["src/b.ts"] })).length === 0,
    "disjoint non-test modules are fine",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["src/foo.ts", "smoke-tests/test-foo.ts"], b: ["src/bar.ts"] }))
      .length === 0,
    "test + subject in the SAME workstream is the correct shape, not a split",
  );
  assert(
    planQualityReason(
      ws({ a: ["src/foo.ts", "smoke-tests/test-foo.ts"], b: ["src/bar.ts"] }),
      OK_FINDINGS,
    ) === undefined,
    "an independent, correctly-coupled plan passes every rule",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["src/foo.ts"], b: ["src/bar.ts", "smoke-tests/test-bar.ts"] }))
      .length === 0,
    "canary: a test in the same workstream as its own subject is fine",
  );
}

{
  // Anti-false-positive canaries: the naming inference is a WORD match, not
  // a substring, and a self-named file is not a split.
  assert(
    findTestSubjectSplits(ws({ a: ["src/foo.ts"], b: ["smoke-tests/test-foobar.ts"] })).length ===
      0,
    "canary: a stem PREFIX (foo vs foobar) is not a split — one test module exercising several subjects is legitimate",
  );
  // The vipune-seam-live case: the test's stem DOES name the subject
  // (`vipune` is a token in both the test stem and the subject basename), so
  // the check correctly flags it as a split. This is the right behaviour —
  // a test that names its subject and is in a different workstream is a
  // split, and the corrective re-dispatch should move the test into the
  // subject's workstream.
  const vipuneSplits = findTestSubjectSplits(
    ws({ a: ["smoke-tests/test-vipune-seam-live.ts"], b: ["src/vipune.ts"] }),
  );
  assert(
    vipuneSplits.length === 1,
    "canary: a test whose stem names its subject IS flagged (this is a real split, not a false positive)",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["smoke-tests/test-miscellaneous.ts"], b: ["src/vipune.ts"] }))
      .length === 0,
    "canary: a test whose stem does NOT name its subject is NOT flagged (no legitimate reading of the split)",
  );
  assert(
    findTestSubjectSplits(
      ws({ a: ["src/a.ts", "smoke-tests/test-foo.ts"], b: ["smoke-tests/test-foo.ts"] }),
    ).length === 0,
    "the same path in both workstreams is an overlap (findPathCollisions' job), not a split",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["src/a.ts"], b: ["docs/README.md"] })).length === 0,
    "non-test files are never a split",
  );
}

// ----------------------------------------------------- the steer is actionable

{
  const splits = findTestSubjectSplits(
    ws({ "task-a": ["build.sh"], "task-b": ["extension/smoke-tests/test-build-list-dedup.ts"] }),
  );
  const steer = correctiveTestSubjectSplitSteer(splits);
  assert(/task-a/.test(steer) && /task-b/.test(steer), "the steer names both workstreams");
  assert(/test-build-list-dedup\.ts/.test(steer), "...and the test file it names");
  assert(/build\.sh/.test(steer), "...and the subject file it exercises");
  assert(
    /Corrective re-dispatch/.test(steer),
    "...in the shape the existing corrective dispatch expects",
  );
  assert(!steer.includes("undefined"), "canary: no 'undefined' leaks into the steer");
}

{
  // The steer degrades sensibly when called with no details — runPlan always
  // passes the real splits, but the function must not crash on an empty list.
  const s = correctiveTestSubjectSplitSteer([]);
  assert(
    /Corrective re-dispatch/.test(s) && !s.includes("undefined"),
    "the steer renders without specific details and still explains the rule",
  );
}

{
  // The pre-existing steers are untouched by the new reason.
  for (const r of ["under-decomposed", "empty-paths"] as const) {
    const s = correctivePlanSteer(r, 6, 1);
    assert(s.length > 0 && !s.includes("undefined"), `${r} still renders without details`);
  }
}

// ----------------------------------- #679: case-3 disjointness + integration-test

{
  // An inferred test-subject split (the #479 shape: one workstream's test
  // file exercises another's file) is a MORE SPECIFIC decomposition error
  // than the case-3 rule: it must be fixed by moving the test into the
  // subject's workstream, and an integration-test line does NOT fix it. So
  // the test-subject-split rule fires (as before #679), NOT
  // interdependent-no-integration-test.
  const splitNoIt = {
    "task-a": { paths: ["build.sh"] },
    "task-b": { paths: ["extension/smoke-tests/test-build-list-dedup.ts"] },
  };
  assert(
    planQualityReason(splitNoIt, 2) === "test-subject-split",
    "#679 case 3: an inferred test-subject split → test-subject-split (the more specific #479 rule fires, not interdependent-no-integration-test)",
  );

  // The same split with an integration-test line still fires
  // test-subject-split (an integration-test line does not fix a
  // test/subject split — the fix is to move the test into the subject's
  // workstream). This pins the precedence: test-subject-split runs before
  // and is not absorbed by the case-3 rule.
  const splitWithIt = {
    "task-a": { paths: ["build.sh"] },
    "task-b": {
      paths: ["extension/smoke-tests/test-build-list-dedup.ts"],
      integrationTest: "extension/smoke-tests/test-build-integration.ts",
    },
  };
  assert(
    planQualityReason(splitWithIt, 2) === "test-subject-split",
    "#679 case 3: the same split WITH an integration-test line still → test-subject-split (the line does not fix a test/subject split)",
  );

  // The case-3 rule (interdependent-no-integration-test) fires for an
  // EXPLICIT depends-on between disjoint-file workstreams with no
  // integration-test line.
  const depNoIt = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
  };
  assert(
    planQualityReason(depNoIt, 2) === "interdependent-no-integration-test",
    "#679 case 3: explicit depends-on, disjoint files, no integration-test → interdependent-no-integration-test",
  );

  // The same pair WITH an integration-test line passes the gate.
  const depWithIt = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"], integrationTest: "src/test-ab.ts" },
  };
  assert(
    planQualityReason(depWithIt, 2) === undefined,
    "#679 case 3: the same pair WITH an integration-test line → passes the gate",
  );

  // A literal same-file collision (overlapping-paths) is DISJOINT from the
  // new case-3 rule: two workstreams declaring the SAME file do NOT raise
  // interdependent-no-integration-test (that rule is for different files).
  const sameFile = {
    "task-a": { paths: ["src/shared.ts"] },
    "task-b": { paths: ["src/shared.ts"], dependsOn: ["task-a"] },
  };
  assert(
    planQualityReason(sameFile, 2) === "overlapping-paths",
    "#679 case 3: a literal same-file collision → overlapping-paths (not interdependent-no-integration-test — the rules are disjoint)",
  );
}

// ------------------------------------------------------- #679 case 3: inferred coupling
{
  // Inferred test-subject coupling (one workstream declares a test file whose
  // subject file is declared by a DIFFERENT workstream) without an
  // integration-test line raises interdependent-no-integration-test.
  const inferred = {
    "task-a": { paths: ["src/foo.ts"] },
    "task-b": { paths: ["smoke-tests/test-foo.ts"] },
  };
  // The inferred-coupling rule fires when the plan has a test-subject split.
  // In this case the split is detected, and the plan-quality gate requires an
  // integration-test line. The split itself is flagged as test-subject-split
  // (the more specific rule runs first), so the integration-test check only
  // fires when the split is not present — but the depends-on check still
  // applies independently.
  const inferredWithDep = {
    "task-a": { paths: ["src/foo.ts"] },
    "task-b": { paths: ["smoke-tests/test-foo.ts"], dependsOn: ["task-a"] },
  };
  // With a depends-on AND the split, the split rule fires first (more specific).
  assert(
    planQualityReason(inferredWithDep, 2) === "test-subject-split",
    "#679 case 3: inferred test-subject coupling + depends-on → test-subject-split (the more specific rule fires first)",
  );

  // A pure depends-on pair (no test file, no split) without integration-test
  // raises interdependent-no-integration-test.
  const pureDep = {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"], dependsOn: ["task-a"] },
  };
  assert(
    planQualityReason(pureDep, 2) === "interdependent-no-integration-test",
    "#679 case 3: pure depends-on pair (no test file) without integration-test → interdependent-no-integration-test",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
