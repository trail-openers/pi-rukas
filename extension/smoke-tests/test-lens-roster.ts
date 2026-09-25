#!/usr/bin/env bun
/**
 * #873 (epic #867 sub-issue 3) — the data-driven lens roster.
 * Offline, host-independent; `PI_ENSEMBLE_SKILLS_DIR` / `buildLensRoster`
 * point at mkdtemp fixtures or the REPO's own skill/ dir — never ~/.pi.
 *   (a) 7th lens via fixture (mocked spawn launches 7)
 *   (b) duplicate precedence blocks BOTH, verdict REVIEW_INCOMPLETE
 *   (c) missing precedence blocks that lens
 *   (d) `name:` ≠ directory blocks that lens
 *   (e) `code-review-*` dir without SKILL.md blocks it, no crash
 *   (f) the repo's skill/ dir yields exactly six, in today's order
 *   (g) prose-list gate (divergent fixture list must fail it)
 *   (h) CLAIM_SCAN outranks precedence 1 as well as 10
 *   (i) installed fixture has only 5 of the 6 bundled lenses → 6 rows,
 *       the missing one blocked, verdict never APPROVED
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";
import {
  buildLensRoster,
  deriveLensName,
  CLAIM_SCAN,
  CLAIM_SCAN_PRECEDENCE,
} from "../src/lens-roster.ts";
import { dedupeFindings } from "../src/lens-review-format.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO_SKILLS = path.join(REPO_ROOT, "skill");
const SEVEN_SKILLS = [
  "code-review-security",
  "code-review-error-handling",
  "code-review-type-safety",
  "code-review-performance",
  "code-review-architecture",
  "code-review-simplicity",
];

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

/** Copy the real code-review-* skills from the repo's skill/ into a fresh
 * mkdtemp skills dir (REAL files, not symlinks, so the test is host-independent). */
function fixtureSkillsDir(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "lens-roster-"));
  const dir = path.join(root, "skills");
  for (const skill of SEVEN_SKILLS)
    cpSync(path.join(REPO_SKILLS, skill), path.join(dir, skill), { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** The installed-dir override, restored by the caller in a finally. */
function setSkillsDir(v: string | undefined): () => void {
  const prior = process.env.PI_ENSEMBLE_SKILLS_DIR;
  if (v === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = v;
  return () => {
    if (prior === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = prior;
  };
}

/** A SKILL.md with a unique precedence, for adding a lens to a fixture. */
function addSkill(dir: string, skill: string, precedence: number | string, name?: string) {
  const skillDir = path.join(dir, skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name ?? skill}\nprecedence: ${precedence}\n---\n\n# ${skill}\n`,
  );
}

/** A `code-review-*` dir with NO SKILL.md (case e). */
function addSkillBareDir(dir: string, skill: string) {
  mkdirSync(path.join(dir, skill), { recursive: true });
}

// The clean-mock responder shared by cases (a) and (i). `mock.module` on an
// already-loaded URL is a no-op, so it is registered exactly once, here.
function mockLensSpawn(spawnCalls: Array<{ prompt: string }>): void {
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-873",
    spawnSpecialist: async (spec: { prompt: string }) => {
      spawnCalls.push({ prompt: spec.prompt });
      return {
        role: "code-review-specialist",
        ok: true,
        text: "Clean from this lens's perspective. Skill Load Status: SUCCESS",
        toolUses: [],
        ms: 10,
        exitCode: 0,
      };
    },
  }));
}

// The lens-review module (mocked spawn above is what runLensReview binds).
const { runLensReview } = await import("../src/lens-review.ts");

// ---------------------------------------------------------------------------
// (a) a seventh lens is configuration, not a code change

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    addSkill(dir, "code-review-data-privacy", 70);
    const roster = buildLensRoster(dir);
    const NAMES = [
      "SECURITY",
      "ERROR_HANDLING",
      "TYPE_SAFETY",
      "PERFORMANCE",
      "ARCHITECTURE",
      "SIMPLICITY",
      "DATA_PRIVACY",
    ];
    eq(
      roster.map((e) => e.name),
      NAMES,
      "(a) 7 lenses, the seventh derived from its directory name",
    );
    eq(roster.length, 7, "(a) exactly seven roster entries");
    assert(
      roster.every((e) => e.error === undefined),
      "(a) no entry blocked",
    );
    eq(
      deriveLensName("code-review-data-privacy"),
      "DATA_PRIVACY",
      "(a) name derivation: strip code-review-, hyphens → underscore, uppercase",
    );

    const spawnCalls: Array<{ prompt: string }> = [];
    const restore = setSkillsDir(dir);
    try {
      mockLensSpawn(spawnCalls);
      const s = await runLensReview({ diff: "diff --git a/a b/a" } as never);
      eq(spawnCalls.length, 7, "(a) mocked spawn launches 7");
      eq(s.lenses.length, 7, "(a) seven lens rows in the summary");
      assert(
        s.lenses.some((l) => l.lens === "DATA_PRIVACY" && !l.blocked),
        "(a) the seventh lens is named DATA_PRIVACY and ran",
      );
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (b) duplicate precedence blocks BOTH, both names in the error

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    addSkill(dir, "code-review-architecture", "10"); // same as SECURITY
    const roster = buildLensRoster(dir);
    const blocked = roster.filter((e) => e.error !== undefined);
    eq(blocked.length, 2, "(b) duplicate precedence blocks BOTH lenses");
    const errors = blocked.map((e) => e.error ?? "").join(" | ");
    assert(
      errors.includes("code-review-security") && errors.includes("code-review-architecture"),
      `(b) the error names both offending skills (${errors})`,
    );
    assert(/duplicate precedence 10/.test(errors), "(b) the error states the problem");
    const restore = setSkillsDir(dir);
    try {
      const s = await runLensReview({ diff: "diff --git a/a b/a" } as never);
      eq(s.verdict, "REVIEW_INCOMPLETE", "(b) the verdict is REVIEW_INCOMPLETE");
      const sec = s.lenses.find((l) => l.lens === "SECURITY");
      const arch = s.lenses.find((l) => l.lens === "ARCHITECTURE");
      assert(
        sec?.blocked && arch?.blocked && (sec?.parseError ?? "").includes("duplicate precedence"),
        "(b) both blocked rows carry the duplicate-precedence error",
      );
      assert(
        s.lenses.filter((l) => !l.blocked).length === 4,
        "(b) the other four lenses still ran",
      );
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (c) a missing precedence blocks that lens

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    const skillDir = path.join(dir, "code-review-simplicity");
    const fm = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(
      /^precedence:[^\n]*\r?\n/m,
      "",
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), fm);
    const roster = buildLensRoster(dir);
    const blocked = roster.filter((e) => e.error !== undefined);
    eq(blocked.length, 1, "(c) exactly one lens blocked");
    eq(blocked[0]?.name, "SIMPLICITY", "(c) the blocked lens is SIMPLICITY");
    assert(
      /missing or invalid/.test(blocked[0]?.error ?? ""),
      `(c) the error names the skill and the problem (${blocked[0]?.error})`,
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (d) `name:` ≠ directory blocks that lens

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    const skillDir = path.join(dir, "code-review-performance");
    const fm = readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(
      /name: code-review-performance/m,
      "name: code-review-something-else",
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), fm);
    const roster = buildLensRoster(dir);
    const blocked = roster.filter((e) => e.error !== undefined);
    eq(blocked.length, 1, "(d) exactly one lens blocked");
    eq(blocked[0]?.name, "PERFORMANCE", "(d) the blocked lens is PERFORMANCE");
    assert(
      /code-review-something-else/.test(blocked[0]?.error ?? "") &&
        /code-review-performance/.test(blocked[0]?.error ?? ""),
      `(d) the error names the mismatch (${blocked[0]?.error})`,
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (e) a `code-review-*` dir without SKILL.md blocks it, no crash

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    addSkillBareDir(dir, "code-review-foo");
    const roster = buildLensRoster(dir);
    eq(roster.length, 7, "(e) the stray dir joins the roster as its own entry");
    const blocked = roster.find((e) => e.skill === "code-review-foo");
    eq(blocked?.name, "FOO", "(e) name derived from the directory");
    assert(
      blocked?.error !== undefined && /no readable SKILL\.md/.test(blocked.error),
      `(e) blocked with a named error, no crash (${blocked?.error})`,
    );
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (f) the repo's skill/ dir yields exactly six, in today's order

{
  const roster = buildLensRoster(REPO_SKILLS);
  eq(roster.length, 6, "(f) the repo roster is exactly six");
  assert(
    roster.every((e) => e.error === undefined),
    "(f) no repo entry blocked",
  );
  eq(
    roster.map((e) => e.name),
    ["SECURITY", "ERROR_HANDLING", "TYPE_SAFETY", "PERFORMANCE", "ARCHITECTURE", "SIMPLICITY"],
    "(f) the six repo lenses keep today's relative order",
  );
  eq(
    roster.map((e) => e.precedence),
    [10, 20, 30, 40, 50, 60],
    "(f) the repo precedences are 10..60 as declared",
  );
}

// ---------------------------------------------------------------------------
// (g) the prose-list gate

/** The prose-list gate over one tree: every roster lens (name AND skill)
 * appears in the PM launch list and the specialist lens list, and the PM
 * launch list contains no extra lens lines. */
function checkProseList(repoRoot: string): string[] {
  const out: string[] = [];
  const roster = buildLensRoster(path.join(repoRoot, "skill"));
  const healthy = roster.filter((e) => e.error === undefined);
  if (healthy.length === 0) {
    out.push(`no healthy roster entries under ${repoRoot}/skill`);
    return out;
  }
  const pm = readFileSync(path.join(repoRoot, "agents-base", "project-manager.md"), "utf8");
  const cr = readFileSync(path.join(repoRoot, "agents-base", "code-review-specialist.md"), "utf8");
  for (const e of healthy) {
    if (!pm.includes(`lens: ${e.name}, skill: ${e.skill}`)) {
      out.push(`project-manager.md launch list is missing \`${e.name}\` / \`${e.skill}\``);
    }
    if (!pm.includes(e.name) || !pm.includes(e.skill)) {
      out.push(`project-manager.md does not mention \`${e.name}\`/\`${e.skill}\` at all`);
    }
    if (!cr.includes(e.name) || !cr.includes(e.skill)) {
      out.push(`code-review-specialist.md lens list is missing \`${e.name}\` / \`${e.skill}\``);
    }
  }
  // Nothing extra: every launch-list line in the PM prose maps to a roster lens.
  const launchLines =
    pm.match(/^@code-review-specialist \(lens: ([A-Z_]+), skill: ([a-z0-9-]+)\)/gm) ?? [];
  for (const line of launchLines) {
    const m = line.match(/\(lens: ([A-Z_]+), skill: ([a-z0-9-]+)\)/);
    if (!m) continue;
    const [, name, skill] = m;
    if (!healthy.some((e) => e.name === name && e.skill === skill)) {
      out.push(`project-manager.md launch list has an extra lens not in the roster: ${line}`);
    }
  }
  return out;
}

{
  const pm = path.join(REPO_ROOT, "agents-base", "project-manager.md");
  const cr = path.join(REPO_ROOT, "agents-base", "code-review-specialist.md");
  const repoFailures = checkProseList(REPO_ROOT);
  if (repoFailures.length === 0) {
    assert(
      true,
      "(g) repo: every roster lens (name AND skill) is in both prose lists, nothing extra",
    );
  } else {
    for (const f of repoFailures) assert(false, `(g) ${f}`);
  }
  assert(existsSync(pm) && existsSync(cr), "(g) both prose files exist in the repo");

  // The gate CAN fail: a fixture tree whose prose list diverges (one lens
  // missing, one extra) must be reported. Roster: SECURITY+SIMPLICITY;
  // prose: SECURITY missing from launch list, DATA_PRIVACY extra.
  const root = mkdtempSync(path.join(os.tmpdir(), "lens-roster-prose-"));
  try {
    mkdirSync(path.join(root, "skill", "code-review-security"), { recursive: true });
    mkdirSync(path.join(root, "skill", "code-review-simplicity"), { recursive: true });
    mkdirSync(path.join(root, "agents-base"), { recursive: true });
    for (const [s, p] of [
      ["code-review-security", 10],
      ["code-review-simplicity", 20],
    ]) {
      writeFileSync(
        path.join(root, "skill", s, "SKILL.md"),
        `---\nname: ${s}\nprecedence: ${p}\n---\nbody\n`,
      );
    }
    writeFileSync(
      path.join(root, "agents-base", "project-manager.md"),
      "You MUST launch exactly 2 parallel @code-review-specialist tasks:\n\n" +
        "@code-review-specialist (lens: SIMPLICITY, skill: code-review-simplicity)\n" +
        "@code-review-specialist (lens: DATA_PRIVACY, skill: code-review-data-privacy)\n",
    );
    writeFileSync(
      path.join(root, "agents-base", "code-review-specialist.md"),
      "lens mapping (SECURITY→code-review-security, SIMPLICITY→code-review-simplicity)\n",
    );
    const failures = checkProseList(root);
    assert(
      failures.length >= 2,
      `(g) canary: a divergent fixture list fails the gate (${failures.length} findings)`,
    );
    assert(
      failures.some((f) => f.includes("code-review-security") && f.includes("missing")),
      `(g) canary: the missing lens is named (${JSON.stringify(failures)})`,
    );
    assert(
      failures.some((f) => f.includes("extra") && f.includes("code-review-data-privacy")),
      "(g) canary: the extra launch-list lens is named",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (i) the installed fixture has only 5 of the 6 bundled lenses → 6 rows,
// the missing one blocked with the installed path, verdict never APPROVED

{
  const { dir, cleanup } = fixtureSkillsDir();
  try {
    // Remove one of the six bundled skills from the INSTALLED fixture.
    const removed = path.join(dir, "code-review-simplicity");
    rmSync(removed, { recursive: true, force: true });

    const spawnCalls: Array<{ prompt: string }> = [];
    const restore = setSkillsDir(dir);
    try {
      mockLensSpawn(spawnCalls);
      const s = await runLensReview({ diff: "diff --git a/a b/a" } as never);
      eq(s.lenses.length, 6, "(i) six rows: five installed + one blocked");
      const b = s.lenses.find((l) => l.lens === "SIMPLICITY");
      assert(b?.blocked === true, "(i) the missing bundled lens is blocked");
      assert(
        b?.parseError === `skill not installed: ${removed} (not spawned)`,
        `(i) blocked row names the installed path (${b?.parseError})`,
      );
      eq(b?.attempts, 0, "(i) no spawn attempts");
      eq(spawnCalls.length, 5, "(i) the other five lenses spawned once each");
      eq(s.verdict, "REVIEW_INCOMPLETE", "(i) verdict REVIEW_INCOMPLETE — never APPROVED");
    } finally {
      restore();
    }
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// (h) CLAIM_SCAN outranks every declared precedence

{
  type HF = { lens: string; severity: "HIGH"; path: string; line: number; title: string };
  const f = (lens: string): HF => ({
    lens,
    severity: "HIGH",
    path: "a.ts",
    line: 1,
    title: "same finding",
  });
  const rosterTen = buildLensRoster(REPO_SKILLS); // SECURITY at precedence 10
  eq(
    dedupeFindings([f("SIMPLICITY"), f(CLAIM_SCAN)], rosterTen)[0]?.lens,
    CLAIM_SCAN,
    "(h) CLAIM_SCAN beats SIMPLICITY (precedence 60)",
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "lens-roster-prec1-"));
  try {
    const sd = path.join(root, "code-review-ultra");
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      path.join(sd, "SKILL.md"),
      "---\nname: code-review-ultra\nprecedence: 1\n---\nbody\n",
    );
    const rosterOne = buildLensRoster(root);
    eq(
      rosterOne.map((e) => e.name),
      ["ULTRA"],
      "(h) a precedence-1 lens sorts above all ten-step lenses",
    );
    eq(
      dedupeFindings([f("SIMPLICITY"), f(CLAIM_SCAN), f("ULTRA")], [...rosterOne, ...rosterTen])[0]
        ?.lens,
      CLAIM_SCAN,
      "(h) CLAIM_SCAN outranks precedence 1 as well as 10",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  eq(
    CLAIM_SCAN_PRECEDENCE,
    Number.NEGATIVE_INFINITY,
    "(h) the CLAIM_SCAN pseudo-lens is NEGATIVE_INFINITY, not a fixed -1",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
