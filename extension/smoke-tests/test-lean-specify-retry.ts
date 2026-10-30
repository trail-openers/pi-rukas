#!/usr/bin/env bun
/**
 * lean/specify — one retry with the refusal reasons.
 *
 * A submission the boundary drops is invisible to the child: it sees "no red
 * test" and nothing else, so a 130-line test and a fixable green one look the
 * same. The step retries ONCE when an attempt dropped a row, with the reasons
 * appended to the prompt. Driven through the real fixture (lib/lean-specify-
 * fixture.ts), the fake child is the only stub.
 *
 *   (a) attempt 1 submits a 130-line test (dropped); attempt 2 submits a red
 *       one -> ok, and the reason says `(after one retry)`;
 *   (b) both attempts submit over-size tests -> no-red-test, the adversary ran
 *       exactly twice, and the second prompt carries the refusal and "130 lines";
 *   (c) attempt 1 succeeds -> one dispatch, no retry note;
 *   (c2) attempt 1 is refused with NOTHING dropped (a green test) -> no retry;
 *   (d) attempt 1 hits its budget -> no retry, the outcome is `budget`;
 *   (e) `refusalFeedback` names at most 20 reasons, each clipped to 300 chars.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BUDGETS } from "../src/lean/config.ts";
import { refusalFeedback } from "../src/lean/specify-prompt.ts";
import {
  ROOTS,
  RUNNER,
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
const REFUSED = "Your previous submission was refused";
const CONFIG = configWith({ fast: "true", test: RUNNER });
const TEST_REL = "tests/AC1-retry.test.sh";

/** A test file over `MAX_TEST_LINES` (120): 130 comment lines. */
function oversize(): string {
  return `${Array.from({ length: 130 }, (_, i) => `# line ${i}`).join("\n")}\n`;
}

/** The child's writes for one attempt: the given body at the test path. */
function writeTest(wt: string, body: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), body, { mode: 0o755 });
}

/** A child whose `n`th dispatch writes `bodies[n]`, and submits `TEST_REL` each time. */
function scripted(bodies: string[]) {
  let n = 0;
  return {
    writes: (wt: string) => {
      writeTest(wt, bodies[Math.min(n, bodies.length - 1)] as string);
      n++;
    },
    toolUses: () => [submit("AC1", [TEST_REL])],
  };
}

// ── (a) the retry turns a dropped submission into an ok ──────────────────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  // Attempt 1 leaves an untracked stray file behind; the retry must not see it.
  let n = 0;
  let strayAtRetry = true;
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 1,
    config: CONFIG,
    prompts: [],
    writes: (wt) => {
      n++;
      if (n === 1) {
        writeTest(wt, oversize());
        writeFileSync(path.join(wt, "src/stray.ts"), "stray\n");
        return;
      }
      strayAtRetry = existsSync(path.join(wt, "src/stray.ts"));
      writeTest(wt, redScript());
    },
    toolUses: () => [submit("AC1", [TEST_REL])],
  });
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.dispatched === 2, `(a) the adversary was dispatched twice (got ${r.dispatched})`);
  assert(!strayAtRetry, "(a) the worktree was reset to the base before the retry");
  assert(
    r.outcome?.kind === "ok",
    `(a) the second attempt's red test is ok (got ${r.outcome?.kind})`,
  );
  assert(
    r.outcome?.reason?.includes(RETRY_NOTE) === true,
    `(a) the reason says the retry happened (got ${r.outcome?.reason})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === TEST_REL,
    `(a) the frozen file is the second attempt's (got ${Object.keys(r.outcome?.frozen ?? {}).join()})`,
  );
}

// ── (b) both attempts refused: the step's result is the second, with the feedback ─
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2,
    config: CONFIG,
    prompts,
    ...scripted([oversize(), oversize()]),
  });
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "no-red-test", `(b) no-red-test, got ${r.outcome?.kind}`);
  assert(
    r.dispatched === 2,
    `(b) the adversary was dispatched exactly twice (got ${r.dispatched})`,
  );
  assert(
    r.outcome?.reason?.includes(RETRY_NOTE) === true,
    `(b) the second attempt's reason says the retry happened (got ${r.outcome?.reason})`,
  );
  assert(
    prompts.length === 2 && !prompts[0]?.includes(REFUSED),
    "(b) the first prompt carries no refusal section",
  );
  assert(
    prompts[1]?.includes(REFUSED) === true,
    "(b) the second prompt carries the refusal section",
  );
  assert(
    prompts[1]?.includes("130 lines") === true,
    "(b) the second prompt names the size reason (130 lines)",
  );
}

// ── (c) a first attempt that succeeds is dispatched once, with no note ───────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 3,
    config: CONFIG,
    prompts: [],
    ...scripted([redScript()]),
  });
  assert(r.outcome?.kind === "ok", `(c) ok on the first attempt (got ${r.outcome?.kind})`);
  assert(r.dispatched === 1, `(c) the adversary was dispatched exactly once (got ${r.dispatched})`);
  assert(
    r.outcome?.reason?.includes(RETRY_NOTE) !== true,
    "(c) no retry note on a first-attempt success",
  );
}

// ── (c2) a refusal that dropped no row is final: nothing to tell the child ───
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  // A green test is dropped at the RED PROOF, not at the boundary, so no row
  // was refused and there is no reason to hand back.
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 4,
    config: CONFIG,
    prompts: [],
    ...scripted([greenScript()]),
  });
  assert(r.outcome?.kind === "no-red-test", `(c2) no-red-test (got ${r.outcome?.kind})`);
  assert(r.dispatched === 1, `(c2) no retry without a dropped row (got ${r.dispatched})`);
}

// ── (d) a budget stop on the first attempt is final ──────────────────────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const config = {
    ...CONFIG,
    budgets: { ...DEFAULT_BUDGETS, specify: { turns: 2, tokens: 0, minutes: 0 } },
  };
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 5,
    config,
    prompts: [],
    progressTurns: 3,
    ...scripted([oversize(), redScript()]),
  });
  assert(r.threw === undefined, `(d) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "budget",
    `(d) the outcome is the budget verdict (got ${r.outcome?.kind})`,
  );
  assert(r.dispatched === 1, `(d) the budget stop is not retried (dispatched ${r.dispatched})`);
}

// ── (e) the feedback section is capped and clipped ───────────────────────────
{
  const reasons = Array.from({ length: 25 }, (_, i) => `reason ${i + 1}`);
  const text = refusalFeedback(reasons);
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert(lines.length === 20, `(e) at most 20 reason lines (got ${lines.length})`);
  assert(text.includes("- reason 20"), "(e) the twentieth reason is the last one named");
  assert(!text.includes("reason 21"), "(e) the twenty-first reason is not named");
  assert(text.startsWith(`## ${REFUSED}`), "(e) the section is headed by the refusal title");
  assert(
    text.includes("Fix exactly these problems and call submit_tests again for every criterion."),
    "(e) the section asks for exactly these problems to be fixed",
  );
  const long = refusalFeedback(["x".repeat(400)]);
  const longLine = long.split("\n").find((l) => l.startsWith("- ")) ?? "";
  assert(
    longLine.length === 302,
    `(e) a reason is clipped to 300 characters (line ${longLine.length})`,
  );
  assert(longLine.endsWith("…"), "(e) a clipped reason ends in an ellipsis");
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
