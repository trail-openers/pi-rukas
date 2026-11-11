#!/usr/bin/env bun
/**
 * lean/specify — the re-prompt for a child that ends without submitting.
 *
 * A child can write its red tests, commit them, and end its turn without ever
 * calling `submit_tests`. Nothing then reaches the boundary, so nothing was
 * dropped, and the old retry gate (`refused.length > 0`) never fires: the step
 * declined on the first silent end. When the spec has test criteria that is the
 * one case where a second dispatch is cheap and likely to work, so the step
 * re-dispatches once with a fixed note. Driven through the real fixture; the
 * fake child is the only stub.
 *
 *   (1) attempt 1 writes a red file and submits nothing; attempt 2 submits it
 *       -> ok, dispatched twice, TWO dispatch rows, and the second prompt
 *       carries the nudge while the first does not;
 *   (2) both attempts silent -> no-red-test carrying the retry marker, twice;
 *   (3) a spec with no `verify: "test"` criterion and a silent child -> one
 *       dispatch, ok, no nudge;
 *   (4) malformed calls or drops are not silence -> no nudge;
 *   (5) a child that DID submit a file the proof refused keeps the old
 *       `criterion ACn has no red test` rule — the never-submitted clause names
 *       the child that declared nothing, and nothing else;
 *   (6) the boundary DROPPED the child's only row -> not silent either. The
 *       silence predicate has three conjuncts and the third (`nothing was
 *       dropped`) is the one no case reached from the outside: with no row at
 *       all there are no drops to count, so a predicate that dropped that
 *       conjunct would pass every other case in this file.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IMPLIED_REQUIREMENTS, refusalFeedback } from "../src/lean/specify-prompt.ts";
import { MAX_TEST_LINES } from "../src/lean/test-size.ts";
import {
  ROOTS,
  RUNNER,
  type RunResult,
  TWO_AC_BODY,
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
 * The decline a child that never declared a test earns. Its FIRST clause, in
 * every rule it appears in — the same invariant `criterion <id> has no red test`
 * carries — because the decline comment clips each rule and the run's reason is
 * what an operator reads first.
 */
const NEVER_SUBMITTED = "the child never submitted a test";
/**
 * The boundary's newness refusal, as the step's drop note renders it. The child's
 * one row dies on this rule in case (6) — the byte is in the base commit, which is
 * the one place a submitted test may not come from.
 */
/** The boundary's refusal for a submission against a `verify: "manual"` criterion. */
const NOT_A_TEST_CRITERION = "is not a test criterion";
const OVERSIZE = "lines; an acceptance test is at most";
const REFUSED = "Your previous submission was refused";
const CONFIG = configWith({ fast: "true", test: RUNNER });
const TEST_REL = "tests/AC1-retry.test.sh";

/** A test file over `MAX_TEST_LINES`, which the boundary drops. */
function oversize(): string {
  return `${Array.from({ length: MAX_TEST_LINES + 1 }, (_, i) => `# line ${i}`).join("\n")}\n`;
}

/** Write `body` at the test path, as the child's own write would. */
function writeTest(wt: string, body: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), body, { mode: 0o755 });
}

/** A spec whose only criterion is `verify: "manual"` — nothing to submit. */
const NO_TEST_BODY = `\`\`\`pi-spec v1
${JSON.stringify(
  {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [{ id: "AC1", text: "documents the retry budget", verify: "manual" }],
  },
  null,
  2,
)}
\`\`\``;

/** The four assertions every case below shares, on one run. */
function report(r: RunResult, label: string): void {
  assert(r.threw === undefined, `${label}: no throw (${r.threw?.message ?? "clean"})`);
}

// ── (1) silent on the first attempt, submits on the re-prompt ────────────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 11,
    config: CONFIG,
    prompts,
    writes: (wt, dispatch) => {
      // Attempt 1 writes its red test and submits nothing, as the field runs did.
      writeTest(wt, redScript());
      if (dispatch === 1) return;
    },
    toolUses: (dispatch) => (dispatch === 1 ? [] : [submit("AC1", [TEST_REL])]),
  });
  report(r, "(1)");
  assert(r.dispatched === 2, `(1) re-dispatched once (got ${r.dispatched})`);
  assert(r.outcome?.kind === "ok", `(1) the re-prompted test freezes (got ${r.outcome?.kind})`);
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === TEST_REL,
    `(1) the frozen path is the submitted one (got ${Object.keys(r.outcome?.frozen ?? {}).join()})`,
  );
  assert(
    (r.outcome?.dispatches ?? []).length === 2,
    `(1) both dispatches are on the step record (got ${(r.outcome?.dispatches ?? []).length})`,
  );
  assert(
    prompts.length === 2 && prompts[0]?.includes(NUDGE) !== true,
    "(1) the first prompt carries no nudge",
  );
  assert(prompts[1]?.includes(NUDGE) === true, "(1) the re-prompt carries the nudge");
  // Same pin as case (g) of test-lean-specify-retry.ts, for the OTHER retry arm:
  // the resubmit prompt is built by the same builder, and a reordering that
  // pushed the section past the appended nudge would un-tell this child the one
  // rule that makes its implied cases worth writing.
  assert(
    prompts[0]?.includes(IMPLIED_REQUIREMENTS) === true,
    "(1) the kickoff prompt the step built carries the implied-requirement section",
  );
  assert(
    prompts[1]?.includes(IMPLIED_REQUIREMENTS) === true,
    "(1) the nudge-carrying resubmit prompt still carries the section — a re-prompt does not un-tell the rule",
  );
  assert(
    prompts[1] !== undefined &&
      prompts[1].indexOf(IMPLIED_REQUIREMENTS) < prompts[1].indexOf("## What you report"),
    "(1) on the resubmit too the section precedes the report protocol",
  );
  assert(
    prompts[1]?.includes(REFUSED) !== true,
    "(1) the nudge is not the refusal section: nothing was refused",
  );
}

// ── (2) silent after the re-prompt too: the step still declines ──────────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 12,
    config: CONFIG,
    prompts,
    writes: (wt) => {
      writeTest(wt, redScript());
    },
    toolUses: () => [],
  });
  report(r, "(2)");
  assert(
    r.outcome?.kind === "no-red-test",
    `(2) still no-red-test after the retry (got ${r.outcome?.kind})`,
  );
  assert(r.dispatched === 2, `(2) exactly two dispatches, never a third (got ${r.dispatched})`);
  assert(
    r.outcome?.reason?.includes(RETRY_NOTE) === true,
    `(2) the reason carries the retry marker (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.failedRules?.[0]?.startsWith(NEVER_SUBMITTED) === true,
    `(2) the leading rule says NEVER SUBMITTED, not "no red test" (got ${r.outcome?.failedRules?.[0]})`,
  );
  assert(
    (r.outcome?.failedRules ?? []).some((x) => !x.startsWith(NEVER_SUBMITTED)) === false,
    `(2) no "no red test" rule is left standing for a child that declared nothing (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    r.outcome?.reason?.startsWith(NEVER_SUBMITTED) === true,
    `(2) the reason leads with the same clause, so either field tells the truth (got ${r.outcome?.reason})`,
  );
}

// ── (3) a spec with no test criterion is never re-prompted ──────────────────
{
  // A `verify: "command"` criterion needs no runner, so the step dispatches
  // with no test criteria at all — the state specifyPrompt tells the child to
  // reply in one sentence and submit nothing. Nudging that child would burn a
  // second dispatch on a run that has already done everything it can.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 13,
    config: CONFIG,
    prompts,
    specBody: NO_TEST_BODY,
    writes: () => {},
    toolUses: () => [],
  });
  report(r, "(3)");
  assert(
    r.dispatched === 1,
    `(3) a no-test-criteria spec is not re-prompted (got ${r.dispatched})`,
  );
  assert(
    r.outcome?.kind === "no-red-test",
    `(3) it declines exactly as it does today (got ${r.outcome?.kind})`,
  );
  assert(prompts[1] === undefined, "(3) there was no second prompt at all");
}

// ── (4) malformed calls and drops are not silence ────────────────────────────
{
  // Malformed `submit_tests` calls already print their own suffix, so the
  // nudge would be a second, wrong explanation of the same run.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 14,
    config: CONFIG,
    prompts,
    writes: (wt) => {
      writeTest(wt, redScript());
    },
    toolUses: () => [{ name: "submit_tests", arguments: { criterionId: "AC1" } }],
  });
  report(r, "(4a)");
  assert(
    r.dispatched === 1,
    `(4a) malformed calls are not silence — no nudge (got ${r.dispatched})`,
  );
  assert(prompts[1] === undefined, "(4a) and there was no second prompt at all");
}
{
  // A submission the boundary DROPPED is the existing retry's case: the child
  // is told what it dropped, not merely to submit again.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 15,
    config: CONFIG,
    prompts,
    specBody: TWO_AC_BODY,
    writes: (wt) => {
      // Over the line cap, so the boundary drops the row and the retry carries
      // its reason rather than the nudge.
      writeTest(wt, oversize());
    },
    toolUses: () => [submit("AC1", [TEST_REL])],
  });
  report(r, "(4b)");
  assert(r.dispatched === 2, `(4b) the dropped row is retried (got ${r.dispatched})`);
  assert(
    prompts[1]?.includes(REFUSED) === true && prompts[1]?.includes(NUDGE) !== true,
    "(4b) its prompt is the refusal section, not the nudge",
  );
}

// ── (5) a child that DID submit keeps the old rule: the split is two-sided ───
{
  // The distinction only means something if the other arm still says what it
  // always said. A child that declared a file the red proof refused (here: green
  // on the base) submitted, so `never submitted` would be a lie about the run —
  // and the criterion it left uncovered is the fact the operator needs.
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
  // The silence predicate has THREE conjuncts, and the third — `nothing the
  // boundary dropped` — needs a case of its own because it is what separates "the
  // child declared nothing" from "the child declared a test and something refused
  // it". The two must not be reported the same way: one is a child that has to be
  // nudged to submit, the other is a child that has to be TOLD WHAT IT DROPPED, and
  // the retry gate reads this one value to choose between them.
  //
  // The shape: the child's only submission is for AC2, the `verify: "manual"`
  // criterion of the fixture's spec — a test there is not a test this run can
  // freeze, and the boundary is the thing that says so. The child submitted, twice,
  // the same way both times, so the step must never call either attempt silent and
  // must never spend its one retry on a nudge.
  //
  // WHY THIS CASE CANNOT BE RED ON THE CONJUNCT ALONE, recorded because it is the
  // interesting part. `extractSubmitTests` counts every readable row, including one
  // for a non-test criterion, and the boundary can only drop a row it was GIVEN —
  // so `refused.length > 0` always implies `declaredRows.length > 0`. The third
  // conjunct is therefore redundant on every reachable state: no fixture shape has
  // `declaredRows` empty and `refused` non-empty. What this case does pin, and what
  // a deletion of the conjunct does NOT survive, is the pair the operator reads —
  // the decline's leading rule and the retry's prompt — through the observed verdict
  // (`SpecifyDeps.observeVerdict`) rather than the folded outcome, because the drop
  // labels make the outcome's WORDING non-silent on their own and would let a
  // weakened predicate pass on the outcome alone.
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
    // The same submission on both attempts, so neither keeps anything and no kept
    // file can hide the silence behind a real freeze.
    toolUses: [submit("AC2", [TEST_REL])],
  });
  report(r, "(6)");
  // THE pin: the predicate's own output, not the outcome it was folded into.
  assert(
    verdicts.length === 2 &&
      verdicts.every(
        (v) => v.refused.some((x) => x.includes(NOT_A_TEST_CRITERION)) === true && v.silent === false,
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

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
