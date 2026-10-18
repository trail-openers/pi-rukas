#!/usr/bin/env bun
/**
 * #872 (epic #867 sub-issue 1) — skill wiring for the six-pass lens review.
 *
 * Two holes, both on the honor system:
 *
 *   1. `runLensChild` passed `path.join(skillsDir, lens.skill)` straight to
 *      `--skill` with no stat — a missing skill (fresh install without
 *      install.sh, a custom PI_ENSEMBLE_SKILLS_DIR, a deleted/renamed skill
 *      leaving a dangling symlink) was spawned and retried 4x before the
 *      lens blocked with a generic "spawn failed".
 *   2. The child's self-reported `Skill Load Status: [SUCCESS|FAILED]`
 *      (agents-base/code-review-specialist.md) was never parsed — an
 *      explicit FAILED could still ride through to APPROVED.
 *
 * This test drives the REAL `runLensReview` (lens-review.ts) with
 * `spawnSpecialist` mocked the way test-loop-detector.ts F1(h) does, and
 * `PI_ENSEMBLE_SKILLS_DIR` pointed at mkdtemp fixtures:
 *
 *   (a) one lens skill missing  → that lens blocked with its absolute
 *       path, 0 spawns for it, 5 spawned, REVIEW_INCOMPLETE
 *   (b) the skills dir missing  → all 6 blocked with the install message,
 *       0 spawns total
 *   (c) dir exists but empty /  → same as (b)
 *       only an unrelated skill
 *   (d) a dangling symlink for  → that lens blocked
 *       one skill
 *   (e) a reply with `**Skill Load Status:** FAILED` → that lens blocked,
 *       findings KEPT, verdict not APPROVED
 *   (f) a reply without the marker, clean with a summary →
 *       APPROVED-eligible (verdict APPROVED when all six are clean)
 *
 * `mock.module` isolation (per the F1(h) pattern): the mock is installed
 * BEFORE the first `await import("../src/lens-review.ts")`, so the lens
 * modules cache the mock from that point on. Each case re-installs the
 * mock with a fresh `spawnSpecialist` closure — `mock.module` on an
 * already-loaded module URL is a no-op for the cached lens binding, so
 * the first install wins (this is the same shape as F1(h), which installs
 * one mock and relies on the cached module). To get per-case behavior
 * without re-importing, we route through a module-level `spawnResponder`
 * variable that the installed `spawnSpecialist` closure reads.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

// #1069 — isolate before any src import: the real runLensReview write must
// land in a temp file, not the main clone's .git (worktree common dir).
// #1449 — the value this file finds in the environment is captured BEFORE the
// helper replaces it, and asserted to be what the file leaves behind (the last
// case below), so a leak out of this process into a sibling or parent is a
// failing assertion rather than a green run that silently poisons the tree.
//
// The release is CAPTURED and called explicitly at the end of this file, not
// left to the helper's process-exit handler: the exit handler runs after the
// last statement, so an assertion that reads the env at the end of the file
// would still see this file's own isolation and report it as a leak. Calling it
// makes the assertion measure what the file actually leaves behind.
const ledgerEnvAtEntry = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const releaseLedgerIsolation = isolateLedger();

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

/*
 * Module-level responder: the installed `spawnSpecialist` closure reads
 * this on every call. Cases set it before calling `runLensReview`.
 * `spawnCalls` records every call (prompt + extraArgs) so the test can
 * assert "spawnSpecialist was never called for the missing skill".
 */
type Responder = (spec: { prompt: string }, opts?: { extraArgs?: string[] }) => unknown;
let spawnResponder: Responder = () => ({
  role: "code-review-specialist",
  ok: true,
  text: "",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});
const spawnCalls: Array<{ prompt: string; extraArgs: string[] }> = [];
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-872",
  spawnSpecialist: async (spec: { prompt: string }, opts?: { extraArgs?: string[] }) => {
    spawnCalls.push({ prompt: spec.prompt, extraArgs: opts?.extraArgs ?? [] });
    return spawnResponder(spec, opts);
  },
}));

// The lens modules must be imported AFTER the mock is installed so they
// bind to the mocked `spawn.ts`.
const { runLensReview } = await import("../src/lens-review.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
const { skillsDirUsable } = await import("../src/lens-review-skills.ts");
const { readEnumMarker } = await import("../src/reply-markers.ts");
// #995 moved the pure-`lensPromptFor` cases (the composed prompt's explicit
// `read` instruction and the Skill Load Status semantics it defines) to
// `test-lens-prompt-skill-read.ts`. They need no spawn mock, and this file was
// heading for the 500-line cap with them in it.

const SIX_SKILLS = LENS_ROSTER.map((l) => l.skill);
const MISSING_SKILL = "code-review-security";
const PRESENT_SKILLS = SIX_SKILLS.filter((s) => s !== MISSING_SKILL);

/** Build a fixture skills dir; `present` controls which lens skill dirs
 * exist inside it. Returns the fixture root (and a cleanup fn). */
function fixtureSkillsDir(present: string[], name: string): { dir: string; cleanup: () => void } {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), `lens872-${name}-`)), "skills");
  mkdirSync(dir, { recursive: true });
  // #873 — fixtures carry a `precedence:` because the lens roster is data
  // (parsed from SKILL.md frontmatter); the values are arbitrary unique
  // integers (this test does not exercise the dedup order, only the
  // skill-wiring behaviour).
  let prec = 10;
  for (const s of present) {
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

function setSkillsDir(v: string | undefined): () => void {
  const prior = process.env.PI_ENSEMBLE_SKILLS_DIR;
  if (v === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = v;
  return () => {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = prior;
  };
}

async function runCase(diff: string, env: string | undefined) {
  const restore = setSkillsDir(env);
  try {
    return await runLensReview({ diff } as never);
  } finally {
    restore();
  }
}

/** A clean, marker-bearing summary for a non-SECURITY lens. */
const CLEAN_SUMMARY =
  "Active Lens: LENS\nSkill Loaded: code-review-foo\nSkill Load Status: SUCCESS\n\nStatus: APPROVED\nChecked the diff; nothing in this lens's lane.";

/* (a) one lens skill missing → that lens blocked, 0 spawns for it,
 * 5 spawned, REVIEW_INCOMPLETE.
 */
{
  const { dir, cleanup } = fixtureSkillsDir(PRESENT_SKILLS, "a");
  try {
    const missingPath = path.join(dir, MISSING_SKILL);
    spawnCalls.length = 0;
    spawnResponder = () => ({
      role: "code-review-specialist",
      ok: true,
      text: CLEAN_SUMMARY,
      toolUses: [],
      ms: 10,
      exitCode: 0,
    });
    const summary = await runCase("diff --git a/a b/a", dir);
    const blockedLens = summary.lenses.find((l) => l.lens === "SECURITY");
    const others = summary.lenses.filter((l) => l.lens !== "SECURITY");
    eq(spawnCalls.length, 5, "(a) 5 lenses spawned, 1 blocked pre-spawn");
    assert(
      !spawnCalls.some((c) => c.extraArgs.includes(missingPath)),
      "(a) spawnSpecialist never called for the missing skill",
    );
    assert(blockedLens?.blocked === true, "(a) the missing-skill lens is blocked");
    assert(
      blockedLens?.parseError === `skill not installed: ${missingPath} (not spawned)`,
      "(a) blocked parseError names the absolute skill path",
    );
    eq(blockedLens?.attempts, 0, "(a) no spawn attempts were made");
    assert(
      others.every((l) => !l.blocked && l.attempts === 1 && l.findings.length >= 0),
      "(a) the other five lenses ran once and completed",
    );
    eq(summary.verdict, "REVIEW_INCOMPLETE", "(a) verdict is REVIEW_INCOMPLETE");
  } finally {
    cleanup();
  }
}

/* (b) the skills dir doesn't exist → all 6 blocked with the install
 * message, 0 spawns total.
 */
{
  const missingDir = path.join(os.tmpdir(), "lens872-missing-xyz");
  spawnCalls.length = 0;
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: CLEAN_SUMMARY,
    toolUses: [],
    ms: 10,
    exitCode: 0,
  });
  const summary = await runCase("diff --git a/a b/a", missingDir);
  eq(spawnCalls.length, 0, "(b) zero spawns with a missing skills dir");
  assert(
    summary.lenses.every(
      (l) =>
        l.blocked &&
        l.attempts === 0 &&
        l.parseError === `skills dir ${missingDir} missing or empty — run ./install.sh`,
    ),
    "(b) all six lenses blocked with the single install message",
  );
  eq(summary.verdict, "REVIEW_INCOMPLETE", "(b) verdict is REVIEW_INCOMPLETE");
  eq(summary.lenses.length, 6, "(b) one row per lens (six identical blocked rows, one message)");
  assert(
    skillsDirUsable(missingDir) === `skills dir ${missingDir} missing or empty — run ./install.sh`,
    "(b) skillsDirUsable flags a missing dir with the install message",
  );
}

/* (c) dir exists but empty / only an unrelated skill → same as (b). */
{
  spawnCalls.length = 0;
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: CLEAN_SUMMARY,
    toolUses: [],
    ms: 10,
    exitCode: 0,
  });
  const empty = fixtureSkillsDir([], "c-empty");
  try {
    const summary = await runCase("diff --git a/a b/a", empty.dir);
    eq(spawnCalls.length, 0, "(c) empty dir: zero spawns");
    assert(
      summary.lenses.every(
        (l) =>
          l.blocked &&
          l.parseError === `skills dir ${empty.dir} missing or empty — run ./install.sh`,
      ),
      "(c) empty dir: all six blocked with the install message",
    );
    eq(summary.verdict, "REVIEW_INCOMPLETE", "(c) empty dir: REVIEW_INCOMPLETE");
  } finally {
    empty.cleanup();
  }
}
{
  spawnCalls.length = 0;
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: CLEAN_SUMMARY,
    toolUses: [],
    ms: 10,
    exitCode: 0,
  });
  const unrelated = fixtureSkillsDir([], "c-unrelated");
  try {
    // A skills dir that exists but holds ONLY an unrelated skill.
    mkdirSync(path.join(unrelated.dir, "some-other-skill"), { recursive: true });
    writeFileSync(
      path.join(unrelated.dir, "some-other-skill", "SKILL.md"),
      "---\nname: some-other-skill\n---\n",
    );
    const summary = await runCase("diff --git a/a b/a", unrelated.dir);
    eq(spawnCalls.length, 0, "(c) unrelated-only dir: zero spawns");
    assert(
      summary.lenses.every(
        (l) =>
          l.blocked &&
          l.parseError === `skills dir ${unrelated.dir} missing or empty — run ./install.sh`,
      ),
      "(c) unrelated-only dir: all six blocked with the install message (unrelated skills tolerated, lens skills required)",
    );
    eq(summary.verdict, "REVIEW_INCOMPLETE", "(c) unrelated-only dir: REVIEW_INCOMPLETE");
    assert(
      skillsDirUsable(unrelated.dir) ===
        `skills dir ${unrelated.dir} missing or empty — run ./install.sh`,
      "(c) skillsDirUsable flags a dir that has no lens skill",
    );
  } finally {
    unrelated.cleanup();
  }
}

/* (d) a dangling symlink for one skill → that lens blocked. */
{
  const { dir, cleanup } = fixtureSkillsDir(PRESENT_SKILLS, "d");
  try {
    const dangling = path.join(dir, MISSING_SKILL);
    symlinkSync(path.join(dir, "does-not-exist"), dangling);
    spawnCalls.length = 0;
    spawnResponder = () => ({
      role: "code-review-specialist",
      ok: true,
      text: CLEAN_SUMMARY,
      toolUses: [],
      ms: 10,
      exitCode: 0,
    });
    const summary = await runCase("diff --git a/a b/a", dir);
    const blockedLens = summary.lenses.find((l) => l.lens === "SECURITY");
    eq(spawnCalls.length, 5, "(d) 5 spawns, 1 blocked on the dangling symlink");
    assert(
      blockedLens?.parseError === `skill not installed: ${dangling} (not spawned)`,
      "(d) dangling symlink counts as missing — parseError names the abs path",
    );
    eq(blockedLens?.attempts, 0, "(d) no spawn attempts for the dangling-skill lens");
    eq(summary.verdict, "REVIEW_INCOMPLETE", "(d) REVIEW_INCOMPLETE");
  } finally {
    cleanup();
  }
}

/* (e) a reply with `**Skill Load Status:** FAILED` → that lens blocked,
 * findings KEPT, verdict not APPROVED. */
{
  const { dir, cleanup } = fixtureSkillsDir(SIX_SKILLS, "e");
  try {
    spawnCalls.length = 0;
    spawnResponder = (spec) => {
      const isSecurity = spec.prompt.includes("**SECURITY**");
      if (isSecurity) {
        return {
          role: "code-review-specialist",
          ok: true,
          text: "**Skill Load Status:** FAILED\nThe skill failed to load — blocking this lens.\n",
          toolUses: [
            {
              name: "report_finding",
              arguments: {
                severity: "MEDIUM",
                path: "src/a.ts",
                line: 1,
                title: "kept finding",
              },
            },
          ],
          ms: 10,
          exitCode: 0,
        };
      }
      return {
        role: "code-review-specialist",
        ok: true,
        text: CLEAN_SUMMARY,
        toolUses: [],
        ms: 10,
        exitCode: 0,
      };
    };
    const summary = await runCase("diff --git a/a b/a", dir);
    const blockedLens = summary.lenses.find((l) => l.lens === "SECURITY");
    assert(blockedLens?.blocked === true, "(e) FAILED marker → that lens is blocked");
    assert(
      blockedLens?.parseError === "skill load reported FAILED by the child (code-review-security)",
      "(e) parseError names the child's FAILED status + skill",
    );
    eq(blockedLens?.attempts, 1, "(e) the spawn happened once (child reported FAILED)");
    eq(blockedLens?.findings.length, 1, "(e) FAILED lens's findings are KEPT (not discarded)");
    eq(summary.verdict, "REVIEW_INCOMPLETE", "(e) verdict is not APPROVED");
    assert(
      summary.lenses.filter((l) => l.lens !== "SECURITY").every((l) => !l.blocked),
      "(e) the other five lenses are clean",
    );
  } finally {
    cleanup();
  }
}

/* (f) a reply without the marker, clean with a summary → APPROVED-eligible
 * (verdict APPROVED when all six are clean). */
{
  const { dir, cleanup } = fixtureSkillsDir(SIX_SKILLS, "f");
  // #1105 — (e)'s finding is still open on this branch in the shared findings
  // store; give (f) its own store so only this reply's review is judged.
  // #1449 — SAVED AND RESTORED. This case used to overwrite the suite's
  // isolation target with no undo, so the value outlived the file: every later
  // case in this process — and, when this file was imported rather than run, a
  // parent process — wrote its real reviews into this temp path. That is the
  // leak that made a hand-run `dispatch_lens_review` land its rows in /tmp
  // while the clone's real ledger sat untouched (#1449).
  const priorLedgerFile = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(
    mkdtempSync(path.join(os.tmpdir(), "skill-wiring-f-")),
    "review-ledger.json",
  );
  try {
    spawnCalls.length = 0;
    spawnResponder = () => ({
      role: "code-review-specialist",
      ok: true,
      text: "Checked the diff; nothing in my lane. Summary: clean.",
      toolUses: [],
      ms: 10,
      exitCode: 0,
    });
    const summary = await runCase("diff --git a/a b/a", dir);
    eq(summary.verdict, "APPROVED", "(f) clean no-marker replies → APPROVED");
    assert(
      summary.lenses.every((l) => !l.blocked && l.attempts === 1),
      "(f) all six unblocked and APPROVED-eligible (absence is traced, not blocked)",
    );
  } finally {
    cleanup();
    // #1449 — the env this case found is the env it leaves. `delete`, never
    // `= undefined`: assigning undefined stores the string "undefined", which
    // `ledgerPathFor`'s `?.trim()` truthiness test reads as a real path.
    // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
    if (priorLedgerFile === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorLedgerFile;
  }
}

/* #1449 — the env this file leaves is the env it found. Case (f) reassigns the
 * ledger override for its own store, and every earlier case relies on the
 * import-time `isolateLedger()`; if either leaks, the next test file in this
 * process — or the parent that imported it, or a real `dispatch_lens_review`
 * running in this tree — writes its rows to a temp path the merge guard never
 * reads. That is precisely the #1431/#1449 incident.
 *
 * The isolation is released HERE, deliberately, before the assertion: the
 * helper's own process-exit handler runs after this statement, so asserting
 * against the env without releasing first would read this file's own legitimate
 * isolation and call it a leak. Releasing explicitly is what makes the
 * assertion measure what the file actually leaves behind — and it is idempotent,
 * so the exit handler re-running it is harmless. */
releaseLedgerIsolation();
{
  const left = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  assert(
    left === ledgerEnvAtEntry,
    `the file leaves PI_ENSEMBLE_REVIEW_LEDGER_FILE exactly as it found it (found ${
      ledgerEnvAtEntry === undefined ? "<unset>" : ledgerEnvAtEntry
    }, left ${left === undefined ? "<unset>" : left})`,
  );
  // A leak that matters is a leak of a path that exists: the (f) temp dir is
  // the one this file created last, so a value still naming it is the leak.
  assert(
    !/skill-wiring-f-/.test(left ?? ""),
    "no case-(f) ledger path survives into the process's environment",
  );
}

/* Cases (g) and (h) — the `readEnumMarker` tolerance and rule-prose arms —
 * moved to test-lens-skill-marker-tolerance.ts for the 500-line gate
 * (AGENTS.md §12). They exercise one pure function and need none of this
 * file's mocked-spawn machinery. */

console.log(`\nexit ${exit}`);
process.exit(exit);
