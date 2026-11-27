#!/usr/bin/env bun
/**
 * lean/specify — the decline WORDS, and the two clauses that separate them.
 *
 * Split from `test-lean-specify-silent-reprompt.ts` for the 500-line gate (AGENTS
 * §12): that file pins WHEN the step re-dispatches a silent child; this one pins what
 * the operator then READS. The distinction only means something if both arms say what
 * actually happened, so each half gets a case: the child that declared nothing is
 * reported as never having submitted, and the child whose submission the boundary
 * refused is reported by the criterion it left uncovered plus the drop reason — never
 * by a clause that would be a lie about its turn.
 *
 *   (5) a child that DID submit a file the proof refused keeps v0.14.71's
 *       `criterion ACn has no red test` rule, and the reason never claims a
 *       submission-less run;
 *   (6) the boundary DROPPED the child's only row -> not silent either: the verdict
 *       the step observed says `silent: false` on both attempts, the decline leads
 *       with the coverage rule, and the retry quotes the drop rather than the nudge;
 *   (7) the nudge is fixed text, so the refusal channel keeps its own header.
 *
 * Real temp repos, real git, a fake child: no token spent.
 */

import { rmSync } from "node:fs";
import { refusalFeedback } from "../src/lean/specify-prompt.ts";
// The constants and the shared assertion come from the fixture the silent-reprompt
// pair also imports, so no two files can drift apart about what the nudge text or the
// decline clause is — a pair that disagrees about its needle asserts nothing.
import {
  CONFIG,
  NEVER_SUBMITTED,
  NUDGE,
  ROOTS,
  type RunResult,
  TEST_REL,
  greenScript,
  makeRepo,
  redScript,
  report as reportShared,
  runSpecify,
  submit,
  writeTest,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The assertions every case below shares, on one run, on this file's own tally. */
function report(r: RunResult, label: string): void {
  reportShared(r, label, assert);
}

/** The boundary's refusal for a submission against a `verify: "manual"` criterion. */
const NOT_A_TEST_CRITERION = "is not a test criterion";
const REFUSED = "Your previous submission was refused";


// ── (5) a child that DID submit keeps the old rule: the split is two-sided ───
{
  // The distinction only means something if the other arm still says what it always
  // said. A child that declared a file the red proof refused (here: green on the base)
  // submitted, so `never submitted` would be a lie about the run — and the criterion it
  // left uncovered is the fact the operator needs.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 16,
    config: CONFIG,
    writes: (wt) => {
      writeTest(wt, greenScript());
    },
    toolUses: () => [submit("AC1", [TEST_REL])],
  });
  report(r, "(5)");
  assert(
    r.outcome?.kind === "red-test-gap",
    `(5) a submitted green file still refuses (got ${r.outcome?.kind})`,
  );
  assert(
    r.outcome?.failedRules?.[0]?.startsWith("criterion AC1 has no red test") === true,
    `(5) and the rule is the coverage gap, not the never-submitted clause (got ${r.outcome?.failedRules?.[0]})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(NEVER_SUBMITTED) === false,
    `(5) and the reason never claims a submission that happened (got ${r.outcome?.reason})`,
  );
  assert(
    r.dispatched === 1,
    `(5) a submitted row is not silence, so no retry is spent on it (got ${r.dispatched})`,
  );
}

// ── (6) a drop the boundary made is not silence either ───────────────────────
{
  // The silence predicate has THREE conjuncts, and the third — `nothing the boundary
  // dropped` — needs a case of its own because it is what separates "the child declared
  // nothing" from "the child declared a test and something refused it". The two must not
  // be reported the same way: one is a child that has to be nudged to submit, the other
  // is a child that has to be TOLD WHAT IT DROPPED, and the retry gate reads this one
  // value to choose between them.
  //
  // The shape: the child's only submission is for AC2, the `verify: "manual"` criterion
  // of the fixture's spec — a test there is not a test this run can freeze, and the
  // boundary is the thing that says so. The child submitted, twice, the same way both
  // times, so the step must never call either attempt silent and must never spend its
  // one retry on a nudge.
  //
  // WHY THIS CASE CANNOT BE RED ON THE CONJUNCT ALONE, recorded because it is the
  // interesting part. `extractSubmitTests` counts every readable row, including one for
  // a non-test criterion, and the boundary can only drop a row it was GIVEN — so
  // `refused.length > 0` always implies `declaredRows.length > 0`. The third conjunct is
  // therefore redundant on every reachable state: no fixture shape has `declaredRows`
  // empty and `refused` non-empty. What this case does pin, and what a deletion of the
  // conjunct does NOT survive, is the pair the operator reads — the decline's leading
  // rule and the retry's prompt — through the observed verdict (`SpecifyDeps.observeVer-
  // dict`) rather than the folded outcome, because the drop labels make the outcome's
  // WORDING non-silent on their own and would let a weakened predicate pass on the
  // outcome alone.
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    // The byte the child's submission names, so the drop is the criterion rule and
    // not a missing file.
    [TEST_REL]: redScript(),
  });
  const prompts: string[] = [];
  const verdicts: { refused: string[]; silent: boolean }[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 17,
    config: CONFIG,
    prompts,
    observeVerdict: (v) => verdicts.push(v),
    writes: (wt) => {
      writeTest(wt, redScript());
    },
    // The same submission on both attempts, so neither keeps anything and no kept file
    // can hide the silence behind a real freeze.
    toolUses: [submit("AC2", [TEST_REL])],
  });
  report(r, "(6)");
  // THE pin: the predicate's own output, not the outcome it was folded into.
  assert(
    verdicts.length === 2 &&
      verdicts.every(
        (v) => v.refused.some((x) => x.includes(NOT_A_TEST_CRITERION)) === true &&
          v.silent === false,
      ),
    `(6) each attempt made a drop and neither was silent (got ${JSON.stringify(verdicts)})`,
  );
  assert(
    r.outcome?.kind === "red-test-gap",
    `(6) an attempt that kept nothing still refuses (got ${r.outcome?.kind})`,
  );
  assert(
    (r.outcome?.failedRules ?? []).every((x) => !x.startsWith(NEVER_SUBMITTED)) === true,
    `(6) the decline does NOT lead with the never-submitted clause (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.startsWith("criterion AC1 has no red test")) ===
      true,
    `(6) it leads with the coverage rule (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(NEVER_SUBMITTED) === false,
    `(6) and the reason never claims a submission that did happen (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(NOT_A_TEST_CRITERION) === true,
    `(6) the boundary's own drop reason reaches the operator (got ${r.outcome?.reason})`,
  );
  assert(
    r.dispatched === 2 && prompts.length === 2,
    `(6) the drop is retried — silence would not be (got ${r.dispatched})`,
  );
  assert(
    prompts[1]?.includes(REFUSED) === true && prompts[1]?.includes(NUDGE) !== true,
    `(6) the retry quotes the drop; it does not nag a child that submitted (got ${prompts[1]?.includes(NUDGE) === true ? "THE NUDGE" : "the refusal section"})`,
  );
  assert(
    prompts[1]?.includes(NOT_A_TEST_CRITERION) === true,
    `(6) and it quotes the reason the child has to act on (got ${prompts[1]?.includes(REFUSED) === true ? "the refusal section" : "no refusal section"})`,
  );
}

// ── (7) the nudge is fixed text, so the refusal channel keeps its own header ─
assert(refusalFeedback([]) === "", "(7) no reasons still means no refusal section to reuse");

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
