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
 *   (7) the nudge is fixed text, so the refusal channel keeps its own header;
 *   (8) `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` — the same two silent runs decline on
 *       v0.14.71's wording, with the one silent retry unchanged: the switch reaches
 *       this rule's WORDING only, never the silence predicate or the retry it gates.
 *
 * Real temp repos, real git, a fake child: no token spent.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refusalFeedback } from "../src/lean/specify-prompt.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  ROOTS,
  RUNNER,
  type RunResult,
  configWith,
  greenScript,
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

const RETRY_NOTE = "(after one retry)";
const NUDGE = "Your previous turn ended without calling submit_tests";
/**
 * The decline a child that never declared a test earns. Its FIRST clause, in every
 * rule it appears in — the same invariant `criterion <id> has no red test` carries —
 * because the decline comment clips each rule and the run's reason is what an operator
 * reads first.
 */
const NEVER_SUBMITTED = "the child never submitted a test";
/** The boundary's refusal for a submission against a `verify: "manual"` criterion. */
const NOT_A_TEST_CRITERION = "is not a test criterion";
const REFUSED = "Your previous submission was refused";
const CONFIG = configWith({ fast: "true", test: RUNNER });
const TEST_REL = "tests/AC1-retry.test.sh";

/** Write `body` at the test path, as the child's own write would. */
function writeTest(wt: string, body: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), body, { mode: 0o755 });
}

/** The assertions every case below shares, on one run. */
function report(r: RunResult, label: string): void {
  assert(r.threw === undefined, `${label}: no throw (${r.threw?.message ?? "clean"})`);
}

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
    r.outcome?.kind === "no-red-test",
    `(5) a submitted green file still declines (got ${r.outcome?.kind})`,
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
    r.outcome?.kind === "no-red-test",
    `(6) an attempt that kept nothing still declines (got ${r.outcome?.kind})`,
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
{
  assert(refusalFeedback([]) === "", "(7) no reasons still means no refusal section to reuse");
}

// ── (8) the switch off: the same two silent runs decline on v0.14.71's wording
{
  // Only the WORDING of the generic decline rule is switched. The silence predicate and
  // the one retry it gates already exist in v0.14.71, so both must hold UNCHANGED on
  // this arm: same dispatch count, same nudge on the second prompt, same `no-red-test`
  // kind. What differs is the rule the operator reads, and it must be the release's —
  // `criterion AC1 has no red test`, with no trace of the never-submitted clause in
  // either field.
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    // (8a) the both-attempts-silent shape: decline on the release's rule.
    const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
    const prompts: string[] = [];
    const r = await runSpecify({
      repoRoot,
      baseSha,
      issue: 18,
      config: CONFIG,
      prompts,
      writes: (wt) => {
        writeTest(wt, redScript());
      },
      toolUses: () => [],
    });
    report(r, "(8a)");
    assert(
      r.outcome?.kind === "no-red-test",
      `(8a) still no-red-test after the retry (got ${r.outcome?.kind})`,
    );
    assert(
      r.dispatched === 2,
      `(8a) the silent retry is UNCHANGED by the switch — exactly two dispatches (got ${r.dispatched})`,
    );
    assert(
      prompts.length === 2 &&
        prompts[0]?.includes(NUDGE) !== true &&
        prompts[1]?.includes(NUDGE) === true,
      "(8a) and the nudge still fires once, on the re-prompt only, as it does on",
    );
    assert(
      r.outcome?.failedRules?.[0] === "criterion AC1 has no red test",
      `(8a) the leading rule is v0.14.71's, not the never-submitted clause (got ${r.outcome?.failedRules?.[0]})`,
    );
    assert(
      (r.outcome?.failedRules ?? []).every((x) => !x.includes(NEVER_SUBMITTED)) === true,
      `(8a) and no rule mentions a submission the switch just suppressed (got ${JSON.stringify(r.outcome?.failedRules)})`,
    );
    assert(
      (r.outcome?.reason ?? "").startsWith("criterion AC1 has no red test") === true,
      `(8a) the reason leads with the same clause (got ${r.outcome?.reason})`,
    );
    assert(
      (r.outcome?.reason ?? "").includes(RETRY_NOTE) === true,
      `(8a) and still carries the retry marker (got ${r.outcome?.reason})`,
    );

    // (8b) the silent-then-submits shape: the freeze must be identical on both arms —
    // the switch never reaches a successful run.
    const submitRoot = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
    const prompts2: string[] = [];
    const ok = await runSpecify({
      repoRoot: submitRoot.repoRoot,
      baseSha: submitRoot.baseSha,
      issue: 19,
      config: CONFIG,
      prompts: prompts2,
      writes: (wt) => {
        writeTest(wt, redScript());
      },
      toolUses: (dispatch) => (dispatch === 1 ? [] : [submit("AC1", [TEST_REL])]),
    });
    report(ok, "(8b)");
    assert(ok.dispatched === 2, `(8b) re-dispatched once, exactly as on (got ${ok.dispatched})`);
    assert(
      ok.outcome?.kind === "ok",
      `(8b) the re-prompted test freezes on this arm too (got ${ok.outcome?.kind})`,
    );
    assert(
      Object.keys(ok.outcome?.frozen ?? {}).join() === TEST_REL,
      `(8b) and the frozen set is identical (got ${Object.keys(ok.outcome?.frozen ?? {}).join()})`,
    );
    assert(prompts2[1]?.includes(NUDGE) === true, "(8b) and the re-prompt carries the same nudge");

    // (8c) the boundary's drop notes are NOT switched: with a row the boundary refused,
    // the decline still names the drop rather than a generic clause, so a mutant that
    // gated the whole `generic` computation on the switch (rather than the silence arm)
    // would not survive here.
    const dropRoot = makeRepo({
      "src/retry.ts": "export const retry = () => {};\n",
      [TEST_REL]: redScript(),
    });
    const drop = await runSpecify({
      repoRoot: dropRoot.repoRoot,
      baseSha: dropRoot.baseSha,
      issue: 20,
      config: CONFIG,
      writes: (wt) => {
        writeTest(wt, redScript());
      },
      toolUses: [submit("AC2", [TEST_REL])],
    });
    report(drop, "(8c)");
    assert(
      (drop.outcome?.failedRules ?? []).some((x) => x.startsWith("criterion AC1 has no red test")),
      `(8c) the coverage rule survives off, exactly as it does on (got ${JSON.stringify(drop.outcome?.failedRules)})`,
    );
    assert(
      (drop.outcome?.reason ?? "").includes(NOT_A_TEST_CRITERION) === true,
      `(8c) and the boundary's own drop reason still reaches the operator (got ${drop.outcome?.reason})`,
    );
  });
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
