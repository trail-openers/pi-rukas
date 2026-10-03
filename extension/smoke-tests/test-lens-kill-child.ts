#!/usr/bin/env bun
/**
 * #966 — the per-lens failed-branch evidence rules (runLensChild).
 *
 * Drives runLensChild (offline, no real Pi children — spawn.ts is stubbed
 * BEFORE the lens modules load) with a spawner that returns failed /
 * cap-killed / aborted child shapes, and asserts which shapes count as
 * review evidence:
 *   1a. stderr-only text (a kill's "text" fell back to stderr in
 *       collapseEvents) is NOT a summary — blocked.
 *   1b. findings from a failed child DO count (a finding is a tool call).
 *   1c. a thinking-only output is a genuine summary (#952 stays).
 *   1d. a cap-killed (loop) child's in-progress prose is the partial review
 *       #952 preserves — not blocked.
 *   1e. a failed child with empty output is blocked.
 *
 * The kill-cause rule (#966 Open Question, option (b)): a text-only
 * summary from a child killed with abort / timeout / inactivity /
 * tool-inactivity is disqualified (it is pre-kill narration); loop and
 * token-budget keep the #952 "already produced" semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import * as dispatchDeck from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

// Mock must be installed BEFORE the lens modules are imported (test-lens-skill-wiring pattern).
let spawnResponder: () => unknown = () => ({
  role: "code-review-specialist",
  ok: true,
  text: "Checked the diff; nothing in this lane.\n\nSkill Load Status: SUCCESS",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-966",
  spawnSpecialist: async () => spawnResponder(),
}));

const { NO_TEXT_PLACEHOLDER } = await import("../src/lens-review-format.ts");
const { runLensChild } = await import("../src/lens-review-child.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");

const ALL_SKILLS = LENS_ROSTER.map((l) => l.skill);

function fixtureSkillsDir(name: string): { dir: string; cleanup: () => void } {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), `lens966-${name}-`)), "skills");
  mkdirSync(dir, { recursive: true });
  let prec = 10;
  for (const s of ALL_SKILLS) {
    const skillDir = path.join(dir, s);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${s}\nprecedence: ${prec}\n---\n`);
    prec += 10;
  }
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

const childFixture = fixtureSkillsDir("child");
const childLens = { name: "SECURITY", skill: "code-review-security", precedence: 10 };

// (1a) Failed child, stderr-only text → blocked (the #966 leak)
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: "[pi-rukas] killed after 240000ms inactivity timeout",
    toolUses: [],
    ms: 240000,
    exitCode: 1,
    killCause: "inactivity" as const,
  });
  const r = await runLensChild({
    lens: childLens,
    runId: "run-966",
    skillsDir: childFixture.dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
  assert(
    r.blocked === true,
    "failed child with stderr-only text → blocked (stderr is not a summary)",
  );
  eq(r.summary, undefined, "stderr text is not kept as the lens summary");
  assert(r.findings.length === 0, "no findings invented from a failed child");
}

// (1b) Failed child WITH findings → not blocked (findings are tool calls, #952)
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: "[pi-rukas] killed after 240000ms inactivity timeout",
    toolUses: [
      {
        name: "report_finding",
        arguments: {
          severity: "MEDIUM",
          path: "src/a.ts",
          line: 3,
          title: "leak",
          description: "d",
          suggestion: "s",
        },
      },
    ],
    ms: 1000,
    exitCode: 1,
    killCause: "inactivity" as const,
  });
  const r = await runLensChild({
    lens: childLens,
    runId: "run-966",
    skillsDir: childFixture.dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
  assert(r.blocked === false, "failed child WITH findings → not blocked (findings count)");
  assert(r.findings.length === 1, "the finding is kept from a failed child");
}

// (1c) The real shape of a thinking-only failed child: `collapseEvents`
// substitutes NO_TEXT_PLACEHOLDER into `text`, and the placeholder is a
// description of the absence of output — not a reviewable summary — so the
// lens is blocked.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: NO_TEXT_PLACEHOLDER,
    thinkingOnly: true,
    toolUses: [],
    ms: 1000,
    exitCode: 1,
    killCause: "inactivity" as const,
  });
  const r = await runLensChild({
    lens: childLens,
    runId: "run-966",
    skillsDir: childFixture.dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
  assert(r.blocked === true, "failed thinking-only child (placeholder text, no findings) → blocked");
  eq(r.summary, undefined, "the placeholder is not kept as the lens summary");
}

// (1d) Cap-killed child (loop) with text-only output → NOT blocked (#952 unchanged)
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: "partial review — loop detected",
    toolUses: [],
    ms: 1000,
    exitCode: 1,
    killCause: "loop" as const,
    loopEvidence: { tool: "bash", count: 5 },
  });
  const r = await runLensChild({
    lens: childLens,
    runId: "run-966",
    skillsDir: childFixture.dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
  assert(r.blocked === false, "cap-killed child with prose output → NOT blocked (#952 unchanged)");
  eq(r.killCause, "loop", "killCause threaded for the cap-kill suffix");
}

// (1e) Failed child, empty text → blocked
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1000,
    exitCode: 1,
  });
  const r = await runLensChild({
    lens: childLens,
    runId: "run-966",
    skillsDir: childFixture.dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
  assert(r.blocked === true, "failed child with empty output → blocked");
}

// (2) #966 — an aborted run (signal aborted BEFORE start) records every lens
// blocked and leaves NO deck batch entry: the abort check in runLensReview
// runs before `startPersistentBatch`, so a dangling `code-review-specialist×N`
// batch row (and its ticker) never exists. Driven through the real
// `runLensReview` with a stubbed `lensChildFn` — an aborted run must never
// reach the spawner, and the deck batch snapshot is the observable seam.
{
  dispatchDeck.reset();
  dispatchDeck.startBatchEntry("run-966-2/leftover-batch", { label: "unrelated", size: 1 });
  const controller = new AbortController();
  controller.abort();
  let spawnerCalls = 0;
  const { runLensReview } = await import("../src/lens-review.ts");
  const summary = await runLensReview({
    diff: "d",
    signal: controller.signal,
    lensChildFn: async () => {
      spawnerCalls++;
      throw new Error("lensChildFn must not be called on an aborted run");
    },
  } as never);
  eq(spawnerCalls, 0, "aborted run never reaches the per-lens spawner");
  eq(
    dispatchDeck.batchSnapshot().filter((b) => b.key === "run-966/batch").length,
    0,
    "aborted run leaves no `run-966/batch` deck entry (no dangling batch, no running ticker)",
  );
  assert(
    dispatchDeck
      .batchSnapshot()
      .some((b) => b.key === "run-966-2/leftover-batch" && b.size === 1 && b.completed === 0),
    "canary: an unrelated pre-existing deck batch entry is untouched by the abort path",
  );
  eq(summary.verdict, "REVIEW_INCOMPLETE", "aborted run → REVIEW_INCOMPLETE (same finish path as all-fail)");
  assert(
    summary.lenses.length > 0 &&
      summary.lenses.every((l) => l.blocked && l.parseError === "aborted before start"),
    "every lens recorded blocked with `aborted before start`",
  );
  dispatchDeck.reset();
}

childFixture.cleanup();

console.log(`\nexit ${exit}`);
process.exit(exit);
