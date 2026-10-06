#!/usr/bin/env bun
/**
 * #966 — retry-note and blocked-banner rendering (restored from
 * test-lens-kill-ledger.ts, which moved to the mocked-appendLedgerEntry
 * seam; these assertions drive runLensReview with the REAL
 * writeLensLedgerEntry → appendLedgerEntry file-write path).
 *
 * Drives runLensReview end-to-end (offline, no real Pi children — spawn.ts
 * is stubbed BEFORE the lens modules load) with the spawner returning
 * failed / clean shapes:
 *   2a. retry note absent when no lens succeeded (all six fail) + no
 *       APPROVED verdict line
 *   2b. no false retry note (the failed lens is blocked; the clean ones
 *       had 1 attempt)
 *   2c. no retry note on a pre-aborted run
 *   3a. retry note absent when every lens is blocked (incident shape)
 *   3b. retry note names exactly the lenses that retried AND succeeded
 *
 * PI_ENSEMBLE_REVIEW_LEDGER_FILE points at a temp file; the write under test
 * is the REAL writeLensLedgerEntry → appendLedgerEntry path. The per-lens
 * failed-branch evidence rules (stderr vs findings vs thinking-only vs
 * cap-kill) live in test-lens-kill-child.ts.
 */

import { mock } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// #984 — the shared helper (lib/wait-for-ledger.ts) with a generous 30 s
// budget, so a loaded host has headroom for the writer's two git subprocess
// hops; the poll returns as soon as the file appears (the passing path stays
// fast) and a partial write keeps the poll going.
import { waitForLedger } from "./lib/wait-for-ledger.ts";

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

const { runLensReview } = await import("../src/lens-review.ts");
const { renderSummary } = await import("../src/lens-review-format.ts");
const { MAX_LENS_ATTEMPTS } = await import("../src/lens-review.ts");
type LensRunResult = import("../src/lens-review.ts").LensRunResult;
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
const { readLedgerAt } = await import("../src/review-ledger.ts");

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

// #966 — the run must not depend on the host's installed lens skills.
// Point the run at a deterministic fixture via the same env var
// runLensReview reads (piSkillsDir).
async function withSkillsDir<T>(skillsDir: string, fn: () => Promise<T>): Promise<T> {
  const priorSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skillsDir;
  try {
    return await fn();
  } finally {
    if (priorSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkills;
  }
}

function setupRepo(): { repo: string; branch: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lens966-repo-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  execSync(`git init -q ${origin}`, { stdio: "ignore" });
  execSync(`git clone -q ${origin} ${repo}`, { stdio: "ignore" });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore" });
  git("git config user.email t@t.t");
  git("git config user.name t");
  git("echo base > base.txt");
  git("git add base.txt");
  git('git commit -qm "base"');
  git("git branch -M dev");
  git("git push -q origin dev");
  git("git remote set-head origin dev");
  git("git checkout -qb feature/x dev");
  git("echo change > change.txt");
  git("git add change.txt");
  git('git commit -qm "change"');
  git("git push -q origin feature/x");
  return {
    repo,
    branch: "feature/x",
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function withLedgerEnv<T>(
  skillsDir: string,
  ledgerFile: string,
  fn: () => Promise<T>,
): Promise<T> {
  const priorSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skillsDir;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  try {
    return await fn();
  } finally {
    if (priorSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkills;
    if (priorLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = priorLedger;
  }
}

const allFail = () => ({
  role: "code-review-specialist",
  ok: false,
  text: "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code",
  toolUses: [],
  ms: 500,
  exitCode: 1,
});

// (2a) ALL six lenses fail → no retry note + no APPROVED verdict line
{
  const fix = fixtureSkillsDir("allfail");
  const repo = setupRepo();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "lens966-ledger-"));
  const ledgerFile = path.join(ledgerDir, "review-ledger.json");
  spawnResponder = allFail;
  try {
    const s = await withLedgerEnv(fix.dir, ledgerFile, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        branch: repo.branch,
      }),
    );
    eq(s.verdict, "REVIEW_INCOMPLETE", "(2a) all six lenses fail → REVIEW_INCOMPLETE");
    const rendered = renderSummary(s, MAX_LENS_ATTEMPTS);
    assert(
      !rendered.includes("eventually succeeded"),
      "(2a) no 'eventually succeeded' retry note when no lens succeeded",
    );
    assert(!rendered.includes("APPROVED"), "(2a) no APPROVED verdict line in the report");
  } finally {
    fix.cleanup();
    repo.cleanup();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

// (2b) One lens missing from skills dir → blocked pre-spawn; five clean →
// no false retry note (the failed lens is blocked; the clean ones had 1 attempt)
{
  const fix = fixtureSkillsDir("partial");
  const { rmSync: rm1 } = await import("node:fs");
  rm1(path.join(fix.dir, "code-review-security"), { recursive: true, force: true });
  const repo = setupRepo();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "lens966-ledger-"));
  const ledgerFile = path.join(ledgerDir, "review-ledger.json");
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "Checked the diff; nothing in this lane.\n\nSkill Load Status: SUCCESS",
    toolUses: [],
    ms: 500,
    exitCode: 0,
  });
  try {
    const s = await withLedgerEnv(fix.dir, ledgerFile, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        branch: repo.branch,
      }),
    );
    assert(
      s.lenses.filter((l) => l.blocked).length === 1,
      "(2b) exactly one lens is blocked (the missing-skill lens)",
    );
    const rendered = renderSummary(s, MAX_LENS_ATTEMPTS);
    assert(
      !rendered.includes("eventually succeeded"),
      "(2b) no false retry note (the failed lens is blocked; the clean ones had 1 attempt)",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

// (2c) Pre-aborted signal (dispatch_kill shape) → no retry note
{
  const fix = fixtureSkillsDir("abort");
  const repo = setupRepo();
  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), "lens966-ledger-"));
  const ledgerFile = path.join(ledgerDir, "review-ledger.json");
  const ac = new AbortController();
  ac.abort(); // already aborted — killJob's abort shape
  try {
    const s = await withSkillsDir(fix.dir, async () =>
      withLedgerEnv(fix.dir, ledgerFile, async () =>
        runLensReview({
          diff: "diff --git a/a b/a\n+x",
          cwd: repo.repo,
          branch: repo.branch,
          signal: ac.signal,
        }),
      ),
    );
    const rendered = renderSummary(s, MAX_LENS_ATTEMPTS);
    assert(!rendered.includes("eventually succeeded"), "(2c) no retry note on an aborted run");
  } finally {
    fix.cleanup();
    repo.cleanup();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

const row = (name: string, over: Partial<LensRunResult>): LensRunResult =>
  ({
    lens: name,
    ok: true,
    ms: 100,
    startMs: 0,
    findings: [],
    attempts: 1,
    blocked: false,
    ...over,
  }) as unknown as LensRunResult;

// (3a) incident shape (all rows fail, attempts>1) → NO retry note
{
  const incidentShape: LensRunResult[] = ALL_SKILLS.map((s) =>
    row(s, { ok: false, blocked: true, attempts: 2, parseError: "attempt 2/4: exit 1" }),
  );
  const incident = renderSummary(
    {
      verdict: "REVIEW_INCOMPLETE",
      totalFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      lenses: incidentShape,
      findings: [],
    },
    MAX_LENS_ATTEMPTS,
  );
  assert(
    !incident.includes("eventually succeeded"),
    "(3a) incident shape (all rows fail, attempts>1) → NO retry note",
  );
  assert(incident.includes("REVIEW INCOMPLETE"), "(3a) the blocked banner is present");
}

// (3b) retry note names exactly the lens that retried AND succeeded
{
  const oneRetried = ALL_SKILLS.map((s) =>
    row(s, { attempts: s === "code-review-security" ? 2 : 1 }),
  );
  const ok = renderSummary(
    {
      verdict: "APPROVED",
      totalFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      lenses: oneRetried,
      findings: [],
    },
    MAX_LENS_ATTEMPTS,
  );
  assert(
    ok.includes("1 lens(es) needed retries but eventually succeeded — code-review-security(×2)"),
    "(3b) retry note names exactly the lens that retried AND succeeded (ok, not blocked)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
