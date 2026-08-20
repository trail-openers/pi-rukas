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

import {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  planQualityReason,
} from "../src/work-driver-plan.ts";
import { findTestSubjectSplits } from "../src/work-driver-plan-paths.ts";

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
    findTestSubjectSplits(ws({ a: ["src/mystery.ts"], b: ["smoke-tests/test-mystery-extra.ts"] })).length ===
      1,
    "canary: a test-only workstream whose stem names the subject is flagged even when the test is not `test-<subject>.ts`",
  );
  assert(
    findTestSubjectSplits(ws({ a: ["build.sh"], b: ["smoke-tests/test-anything.ts"] })).length === 0,
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
    findTestSubjectSplits(ws({ a: ["src/foo.ts"], b: ["smoke-tests/test-foobar.ts"] })).length === 0,
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

console.log(`\nexit ${exit}`);
process.exit(exit);
