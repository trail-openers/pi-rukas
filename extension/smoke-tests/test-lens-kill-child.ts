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

// (1c) Failed child, thinking-only output → NOT blocked (#952 genuine summary)
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: false,
    text: "I examined the diff carefully and found nothing in this lane.",
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
  assert(r.blocked === false, "failed child with thinking-only output → NOT blocked (#952)");
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

childFixture.cleanup();

console.log(`\nexit ${exit}`);
process.exit(exit);
