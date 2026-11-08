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
 *   (4) malformed calls or drops are not silence -> no nudge.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refusalFeedback } from "../src/lean/specify-prompt.ts";
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
    r.outcome?.failedRules?.[0]?.startsWith("criterion AC1 has no red test") === true,
    `(2) the leading rule is today's (got ${r.outcome?.failedRules?.[0]})`,
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
  assert(r.dispatched === 1, `(3) a no-test-criteria spec is not re-prompted (got ${r.dispatched})`);
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
  assert(
    prompts[1] === undefined,
    "(4a) and there was no second prompt at all",
  );
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

// ── (5) the nudge is fixed text, so the refusal channel keeps its own header ─
{
  assert(
    refusalFeedback([]) === "",
    "(5) no reasons still means no refusal section to reuse",
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
