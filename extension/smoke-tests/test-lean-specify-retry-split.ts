#!/usr/bin/env bun
/**
 * #2058 — the specify retry tells an over-cap child HOW to fix.
 *
 * The bullets in the refusal section name the line count but offer no remedy,
 * and `TEST_SCOPE_CONTRACT` pushes the other way ("Prefer one focused file per
 * criterion"), so an adversary whose test ran to 154 lines against a cap of 150
 * had no legal way down and overshot on both attempts. These cases pin the four
 * things that make the retry a retry:
 *
 *   (a) a child over the cap on attempt 1 splits into two IN-CAP files on
 *       attempt 2 and the step reaches `ok` with BOTH frozen — the run that
 *       died at specify before this fix;
 *   (b) the split instruction is its own line, so a size reason over 300
 *       characters — clipped along with anything appended to its bullet —
 *       still yields it, and it names both constants;
 *   (c) a NON-size refusal gets no split line, so the remedy cannot become
 *       unconditional boilerplate; the `challenge` prompt never carries one;
 *   (d) a run that overshoots on both attempts declines with `failedRules`
 *       naming each dropped file and its line count, after the generic
 *       per-criterion rule.
 */

import { rmSync } from "node:fs";
import { challengePrompt } from "../src/lean/challenge-prompt.ts";
import { type PiSpec, renderPiSpec } from "../src/lean/spec.ts";
import { refusalFeedback } from "../src/lean/specify-prompt.ts";
import { MAX_TEST_LINES } from "../src/lean/test-size.ts";
import { withEnv } from "./lib/env-scope.ts";
import { CONSTRAINT } from "./lib/ticket-issue-fixture.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  git,
  makeRepo,
  put,
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

const SPLIT = "split each over-long test into at most";
const CONFIG = configWith({ fast: "true", test: RUNNER });
const OVER = "tests/AC1-retry.test.sh";
const SPLIT_A = "tests/AC1-retry-a.test.sh";
const SPLIT_B = "tests/AC1-retry-b.test.sh";

/**
 * The issue body case (a) hands the step: the fixture's own spec — same problem
 * and criteria, so the boundary's rules still apply unchanged — wrapped in the
 * prose a filed issue carries, with one constraint nothing but the body states.
 */
const SPLIT_BODY = `${renderPiSpec({
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [
    { id: "AC1", text: "retries a transient failure twice before failing", verify: "test" },
  ],
})}

Add retry handling to the meter, keeping the exception message it already raises.
${CONSTRAINT}`;

/** A red test of exactly `n` lines — the size is the only variable a case sets. */
function redOfLength(n: number): string {
  const body = ["#!/bin/sh", 'echo "not ok - $(basename "$0")" 1>&2', "exit 1"];
  const pad = Array.from({ length: Math.max(0, n - body.length) }, (_, i) => `// f${String(i)}`);
  return [...body, ...pad].join("\n");
}

/** Lines the way the boundary counts them: a trailing newline is not a line. */
function linesOf(text: string): number {
  const all = text.split("\n");
  return all.length > 1 && all[all.length - 1] === "" ? all.length - 1 : all.length;
}

// ── (a) over the cap on attempt 1, split into two in-cap files on attempt 2 ──
//
// The switch is PINED absent for this case, not read from the ambient environment:
// the two #2171 assertions at its end assert the issue section IS rendered, and
// `leanIssueProseEnabled()` reads `process.env` at call time, so an inherited
// `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` failed them red on an unrelated change.
await withEnv({ PI_ENSEMBLE_LEAN_ISSUE_PROSE: undefined }, async () => {
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const x = 1;\n" });
  const half = Math.floor(MAX_TEST_LINES / 2);
  const prompts: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2058,
    config: CONFIG,
    prompts,
    // The fixture's spec block, plus prose around it carrying one constraint the
    // adversary has to be able to read (#2171).
    specBody: `${SPLIT_BODY}\n\nThe exception rule: ${CONSTRAINT}\n`,
    writes: (wt, dispatch) => {
      if (dispatch === 1) put(wt, OVER, redOfLength(MAX_TEST_LINES + 4), 0o755);
      else {
        put(wt, SPLIT_A, redOfLength(half), 0o755);
        put(wt, SPLIT_B, redOfLength(half), 0o755);
      }
    },
    toolUses: (dispatch) =>
      dispatch === 1 ? [submit("AC1", [OVER])] : [submit("AC1", [SPLIT_A, SPLIT_B])],
  });
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.dispatched === 2, `(a) the child was dispatched twice (got ${r.dispatched})`);
  assert(r.outcome?.kind === "ok", `(a) the split attempt reaches ok (got ${r.outcome?.kind})`);
  const frozen = Object.keys(r.outcome?.frozen ?? {}).sort();
  assert(
    frozen.join(",") === [SPLIT_A, SPLIT_B].join(","),
    `(a) BOTH split files are frozen (got ${JSON.stringify(frozen)})`,
  );
  assert(
    (r.outcome?.tests?.AC1 ?? []).length === 2,
    `(a) the record holds two files for AC1 (got ${JSON.stringify(r.outcome?.tests)})`,
  );
  const committed = git(r.worktree, "show", "--name-only", "--format=", "HEAD").split("\n").sort();
  assert(
    committed.join(",") === [SPLIT_A, SPLIT_B].join(","),
    `(a) the commit contains exactly the two split files (got ${JSON.stringify(committed)})`,
  );
  assert(
    linesOf(redOfLength(MAX_TEST_LINES + 4)) === MAX_TEST_LINES + 4 &&
      linesOf(redOfLength(half)) === half,
    `(a) the fixture really is over the cap then in it (${MAX_TEST_LINES + 4} then ${half} lines)`,
  );
  assert(
    prompts.length === 2 && prompts[1]?.includes(SPLIT) === true,
    "(a) the retry prompt carries the split instruction",
  );
  // #2171 — the adversary is shown the issue prose, and both prompts carry the
  // SAME bytes the step fetched once. A retry that re-read the forge would cost
  // a `gh` call and could show attempt 2 an issue attempt 1 never saw.
  assert(r.fetched === 1, `(a) the issue was read once for two dispatches (got ${r.fetched})`);
  assert(
    prompts.length === 2 &&
      prompts.every((p) => p.includes("## The issue") && p.includes(CONSTRAINT)),
    "(a) BOTH prompts carry the fenced issue section with the body's own constraint",
  );
});

// ── (b) the remedy is its own line, so a >300-char size reason cannot clip it ─
{
  const deep = `tests/deep/${"dir/".repeat(90)}AC1-retry.test.sh`;
  const reason = `AC1 ${deep}: ${MAX_TEST_LINES + 4} lines; an acceptance test is at most ${MAX_TEST_LINES}`;
  const text = refusalFeedback([reason]);
  assert(reason.length > 300, `(b) the fixture reason is over the clip bound (${reason.length})`);
  const bullet = text.split("\n").find((l) => l.startsWith("- ")) ?? "";
  assert(bullet.endsWith("…"), "(b) the reason bullet itself IS clipped");
  assert(text.includes(SPLIT), "(b) the split instruction survives the clipped reason");
  assert(
    text.includes(`at most ${MAX_TEST_LINES} lines each`) && text.includes("into at most 2 files"),
    "(b) the line names both constants the boundary enforces",
  );
  assert(
    text.includes("Write ONE test file for each criterion") &&
      text.includes("Prefer one focused file per criterion"),
    "(b) the line says which two sentences of the contract it supersedes for this attempt",
  );
  const splitLine = text.split("\n").find((l) => l.includes(SPLIT)) ?? "";
  assert(
    splitLine.length > 300,
    `(b) the remedy is not itself clipped (${splitLine.length} chars)`,
  );
}

// ── (c) the remedy stays specify's, and stays about size ─────────────────────
{
  const green = refusalFeedback(["AC1 tests/AC1-a.test.ts: exited 0, so it proves nothing"]);
  assert(!green.includes(SPLIT), "(c) a green-test refusal gets no split instruction");
  const misplaced = refusalFeedback([
    "AC1 docs/AC1-a.test.ts: not directly inside the configured test folder",
  ]);
  assert(!misplaced.includes(SPLIT), "(c) a misplaced-file refusal gets no split instruction");
  const quota = refusalFeedback([
    "AC1 tests/AC1-c.test.ts: criterion AC1 already has 2 test files; one focused test per criterion is the norm",
  ]);
  assert(!quota.includes(SPLIT), "(c) a quota drop gets no split instruction");
  assert(
    green.includes("Fix exactly these problems"),
    "(c) a non-size refusal still gets the rest of the section unchanged",
  );

  const spec: PiSpec = {
    problem: "p",
    size: "S",
    criteria: [{ id: "AC1", text: "retries", verify: "test" }],
  };
  const challenge = challengePrompt({
    issue: 2058,
    spec,
    frozenPaths: ["tests/AC1-frozen.test.sh"],
    worktree: "/tmp/wt",
    testRunner: RUNNER,
  });
  assert(!challenge.includes(SPLIT), "(c) the challenge prompt carries no split instruction");
  assert(
    challenge.includes("at most 2 files"),
    "(c) the challenge prompt still states the file bound, just not the remedy",
  );
}

// ── (d) both attempts overshoot: the decline names each dropped file ─────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const x = 1;\n" });
  const over = MAX_TEST_LINES + 7;
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2059,
    config: CONFIG,
    prompts: [],
    writes: (wt) => put(wt, OVER, redOfLength(over), 0o755),
    toolUses: () => [submit("AC1", [OVER])],
  });
  assert(r.outcome?.kind === "no-red-test", `(d) the run declines (got ${r.outcome?.kind})`);
  assert(r.dispatched === 2, `(d) both attempts ran (got ${r.dispatched})`);
  const rules = r.outcome?.failedRules ?? [];
  assert(
    rules[0]?.startsWith("criterion AC1 has no red test") === true,
    `(d) the rule still LEADS with the criterion (got ${JSON.stringify(rules)})`,
  );
  assert(
    rules.some((x) => x.includes(OVER) && x.includes(`${over} lines`)),
    `(d) failedRules names the dropped file AND its line count, not only the criterion (got ${JSON.stringify(rules)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(`${over} lines`),
    "(d) the reason carries the same count",
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
