#!/usr/bin/env bun
/**
 * #966 — an all-failed or aborted lens review must never render as APPROVED
 * and must never write a passing review-ledger entry. #980 — tool-path
 * branch resolution: the #980 shared resolver recovers the branch from HEAD
 * (or a branch-named `head`) and `finishLensReview` keys the ledger write and
 * residual-disclosure post on that resolved value.
 *
 * Drives runLensReview end-to-end (offline, no real Pi children — spawn.ts
 * is stubbed BEFORE the lens modules load) with the spawner returning
 * failed / clean shapes:
 *   2a. all-fail        → REVIEW_INCOMPLETE + passed:false ledger entry
 *   2b. partial-fail    → REVIEW_INCOMPLETE + passed:false ledger entry
 *   2c. pre-aborted     → REVIEW_INCOMPLETE + passed:false ledger entry
 *   2d. empty roster    → REVIEW_INCOMPLETE (never a silent APPROVED)
 *   4.  lensPassed(REVIEW_INCOMPLETE, …) === false at every threshold
 *   5a. #980 tool path, no branch, named-branch checkout → HEAD-resolved key
 *   5b. #980 tool path, detached HEAD → visible NOT-posted note, no entry
 *
 * The ledger write under test is stubbed at the `appendLedgerEntry` seam:
 * the fire-and-forget write is deterministic (no file to sleep on) and the
 * recorded payload is run through the SAME `validEntries` validation the real
 * write applies. The REAL writeLensLedgerEntry → appendLedgerEntry file-write
 * path is covered in test-review-ledger.ts. The per-lens failed-branch
 * evidence rules (stderr vs findings vs thinking-only vs cap-kill) live in
 * test-lens-kill-child.ts. The retry-note / blocked-banner rendering
 * assertions (3a/3b and the per-case "no retry note" checks) live in
 * test-lens-retry-note.ts.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else { console.error(`✗ ${msg}`); exit = 1; }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`✓ ${msg}`);
  else { console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`); exit = 1; }
  return a === e;
}
// Mocks must be installed BEFORE the lens modules are imported (test-lens-skill-wiring
// pattern — bun's `mock.module` intercepts every import of the module that is
// evaluated after registration, including the static imports below, which are
// what load lens-review.ts).
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
let recordedLedgerWrites: unknown[] = [];
// Bun's `mock.module` factory must define every export with an INLINE value
// (referencing the real module's namespace breaks the mock — verified).
mock.module(new URL("../src/review-ledger.ts", import.meta.url).href, () => ({
  appendLedgerEntry: async (entry: unknown) => {
    recordedLedgerWrites.push(entry);
    return undefined;
  },
  workingTreePatchId: async () => ({ patchId: "test-patch-id-0000", warning: undefined }),
  lensPassed: (v: string, t: string) => v === "APPROVED" || (v === "ISSUES_FOUND" && t === "LOW"),
  adversarialPassed: () => false, branchPatchId: async () => undefined,
  bumpLensRound: (e: unknown) => e, dedupeLatest: (e: unknown[]) => e,
  latestEntry: () => undefined, ledgerPathFor: async () => undefined,
  lensBlockedByThreshold: () => true, readLedgerAt: () => [],
  readLedgerFile: () => ({ entries: [] }), remoteName: async () => undefined,
  validEntries: (e: unknown[]) => e,
}));
// Static imports — evaluated AFTER both mock registrations, so they pick up
// the mocked spawn and ledger seams (this is what loads lens-review.ts).
import {
  runLensReview,
  type LensRunResult,
} from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { finishLensReview } from "../src/lens-review-finish.ts";
import { lensPassed, validEntries } from "../src/review-ledger.ts";
type LedgerEntry = import("../src/review-ledger.ts").LedgerEntry;
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
function emptySkillsDir(name: string): { dir: string; cleanup: () => void } {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), `lens966-${name}-`)), "skills");
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
// #966 — the aborted-run case must not depend on the host's installed
// lens skills: a host WITHOUT ~/.pi/agent/skills/code-review-* used to see
// an EMPTY roster here, zero blocked rows, and an APPROVED verdict (the
// silent-approval this PR closes). Point the run at a deterministic fixture
// via the same env var runLensReview reads (piSkillsDir).
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
  return { repo, branch: "feature/x", cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function withLedgerEnv<T>(skillsDir: string, fn: () => Promise<T>): Promise<T> {
  const priorSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = skillsDir;
  recordedLedgerWrites = [];
  try {
    return await fn();
  } finally {
    if (priorSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = priorSkills;
  }
}
/**
 * The recorded ledger write's entries, run through the SAME `validEntries`
 * validation the real write applies (a corrupt row is dropped by both, so
 * the recorded shape and the written shape agree). `null` = no write was
 * recorded (the "no ledger entry written" assertion).
 */
function recordedEntries(): LedgerEntry[] | null {
  if (recordedLedgerWrites.length === 0) return null;
  return validEntries(recordedLedgerWrites);
}
const allFail = () => ({
  role: "code-review-specialist",
  ok: false,
  text: "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code",
  toolUses: [],
  ms: 500,
  exitCode: 1,
});
// (2a) ALL six lenses fail → REVIEW_INCOMPLETE + passed:false ledger entry
{
  const fix = fixtureSkillsDir("allfail");
  const repo = setupRepo();
  spawnResponder = allFail;
  try {
    const s = await withLedgerEnv(fix.dir, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        branch: repo.branch,
      }),
    );
    const entries = recordedEntries();
    eq(s.verdict, "REVIEW_INCOMPLETE", "(2a) all six lenses fail → REVIEW_INCOMPLETE");
    assert(s.lenses.every((l) => l.blocked), "(2a) every lens is blocked");
    assert(entries !== null && entries.length === 1, "(2a) exactly one ledger entry written");
    const e = entries?.[0];
    assert(e !== undefined && e.kind === "lens", "(2a) the entry is a lens entry");
    assert(e?.passed === false, "(2a) the ledger entry is passed:false");
    assert(
      e?.detail === "REVIEW_INCOMPLETE",
      "(2a) the ledger detail is REVIEW_INCOMPLETE (not APPROVED)",
    );
    assert(
      typeof e?.patchId === "string" && e.patchId.length > 0,
      "(2a) the entry carries the working-tree patchId (the guard's patchId check)",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// (2b) One lens missing from skills dir → blocked pre-spawn; five clean → REVIEW_INCOMPLETE
{
  const fix = fixtureSkillsDir("partial");
  const { rmSync: rm1 } = await import("node:fs");
  rm1(path.join(fix.dir, "code-review-security"), { recursive: true, force: true });
  const repo = setupRepo();
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "Checked the diff; nothing in this lane.\n\nSkill Load Status: SUCCESS",
    toolUses: [],
    ms: 500,
    exitCode: 0,
  });
  try {
    const s = await withLedgerEnv(fix.dir, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        branch: repo.branch,
      }),
    );
    const entries = recordedEntries();
    eq(
      s.verdict,
      "REVIEW_INCOMPLETE",
      "(2b) partial failure (one lens missing, five clean) → REVIEW_INCOMPLETE",
    );
    assert(
      s.lenses.filter((l) => l.blocked).length === 1,
      "(2b) exactly one lens is blocked (the missing-skill lens)",
    );
    assert(
      s.lenses.find((l) => l.blocked)?.parseError?.includes("skill not installed"),
      "(2b) the blocked lens's parseError names the missing skill",
    );
    assert(entries?.[0]?.passed === false, "(2b) ledger entry is passed:false");
    assert(
      entries?.[0]?.detail === "REVIEW_INCOMPLETE",
      "(2b) ledger detail is REVIEW_INCOMPLETE",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// (2c) Pre-aborted signal (dispatch_kill shape) → REVIEW_INCOMPLETE + passed:false ledger
{
  const fix = fixtureSkillsDir("abort");
  const repo = setupRepo();
  const ac = new AbortController();
  ac.abort(); // already aborted — killJob's abort shape
  try {
    const s = await withSkillsDir(fix.dir, async () =>
      withLedgerEnv(fix.dir, async () =>
        runLensReview({
          diff: "diff --git a/a b/a\n+x",
          cwd: repo.repo,
          branch: repo.branch,
          signal: ac.signal,
        }),
      ),
    );
    const entries = recordedEntries();
    eq(s.verdict, "REVIEW_INCOMPLETE", "(2c) aborted run → REVIEW_INCOMPLETE");
    assert(s.lenses.length === ALL_SKILLS.length, "(2c) one blocked row per expected lens");
    assert(s.lenses.every((l) => l.blocked), "(2c) every lens row is blocked");
    assert(
      entries !== null && entries.length === 1,
      "(2c) the aborted run still writes a ledger entry (same path as a non-aborted all-fail run)",
    );
    assert(entries?.[0]?.passed === false, "(2c) aborted run's ledger entry is passed:false");
    assert(
      entries?.[0]?.detail === "REVIEW_INCOMPLETE",
      "(2c) the aborted run's ledger detail is REVIEW_INCOMPLETE (never a passing entry)",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// (2d) #966 — an empty roster (no installed lens skills) must be
// REVIEW_INCOMPLETE, never APPROVED: `computeVerdict` over zero lens rows
// passes every precedence rule, so an empty review used to be a silent
// approval. The empty-roster guard in runLensReview blocks every expected
// lens with the install message; the ledger entry is passed:false.
{
  const fix = emptySkillsDir("empty");
  const repo = setupRepo();
  try {
    const s = await withSkillsDir(fix.dir, async () =>
      withLedgerEnv(fix.dir, async () =>
        runLensReview({
          diff: "diff --git a/a b/a\n+x",
          cwd: repo.repo,
          branch: repo.branch,
        }),
      ),
    );
    const entries = recordedEntries();
    eq(s.verdict, "REVIEW_INCOMPLETE", "(2d) empty roster (no installed lens skills) → REVIEW_INCOMPLETE");
    assert(
      s.lenses.length >= 1,
      "(2d) at least one blocked row (never zero rows → never APPROVED)",
    );
    assert(s.lenses.every((l) => l.blocked), "(2d) every lens row is blocked");
    assert(
      entries !== null && entries.length === 1 && entries[0].passed === false,
      "(2d) the empty-roster run writes a passed:false ledger entry",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// #980 — tool-path branch resolution: `dispatch_lens_review` never supplies
// `opts.branch`; the shared resolver (review-branch.ts) recovers the branch
// from HEAD (or from a branch-named `head`) and `finishLensReview` keys both
// the ledger write and the residual-disclosure post on that resolved value.
// (5a) Tool path, no branch, cwd on a named branch → ledger entry is written
// under the HEAD-resolved branch (mocked seam, deterministic — no sleep+poll).
{
  const fix = fixtureSkillsDir("toolpath-named");
  const repo = setupRepo();
  try {
    const s = await withLedgerEnv(fix.dir, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        // NO branch — the tool path's shape (lensChildFn stub keeps it
        // offline; the roster comes from the fixture skills dir).
        lensChildFn: async () => ({
          lens: "SIMPLICITY",
          ok: true,
          ms: 10,
          startMs: 0,
          findings: [],
          summary: "Checked the diff; nothing in this lane.",
          attempts: 1,
          blocked: false,
        }) as unknown as LensRunResult,
      }),
    );
    const entries = recordedEntries();
    eq(
      s.verdict,
      "APPROVED",
      "(5a) tool path (no branch, named-branch checkout) → APPROVED (clean review)",
    );
    assert(
      entries !== null && entries.length === 1,
      "(5a) exactly one ledger entry written (the tool path resolves the branch from HEAD)",
    );
    assert(
      entries?.[0]?.branch === "feature/x",
      "(5a) the ledger entry is keyed on the HEAD-resolved branch `feature/x`",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// (5b) Tool path, no branch, detached HEAD, no branch-named head → the
// summary carries the VISIBLE "disclosure NOT posted" note on ISSUES_FOUND
// (the pre-#980 silent skip is now a visible note), and no ledger entry is
// written (nothing to record without a branch).
{
  const fix = fixtureSkillsDir("toolpath-detached");
  const repo = setupRepo();
  execSync("git checkout -q --detach HEAD", { cwd: repo.repo, stdio: "ignore" });
  try {
    const s = await withLedgerEnv(fix.dir, async () =>
      runLensReview({
        diff: "diff --git a/a b/a\n+x",
        cwd: repo.repo,
        lensChildFn: async () => ({
          lens: "SIMPLICITY",
          ok: true,
          ms: 10,
          startMs: 0,
          findings: [
            {
              severity: "MEDIUM" as const,
              path: "src/a.ts",
              line: 10,
              title: "a finding",
              lens: "SIMPLICITY",
            },
          ],
          summary: "Found one issue.",
          attempts: 1,
          blocked: false,
        }) as unknown as LensRunResult,
      }),
    );
    const entries = recordedEntries();
    eq(s.verdict, "ISSUES_FOUND", "(5b) tool path, detached HEAD → ISSUES_FOUND");
    assert(
      typeof s.note === "string" && s.note.length > 0,
      "(5b) the summary carries the VISIBLE not-posted note (never a silent skip)",
    );
    assert(
      /NOT posted/.test(s.note ?? ""),
      "(5b) the note says the disclosure was NOT posted",
    );
    assert(
      /merge guard/.test(s.note ?? ""),
      "(5b) the note names the merge guard refusal",
    );
    assert(
      entries === null || entries.length === 0,
      "(5b) no ledger entry written (no branch resolvable)",
    );
  } finally {
    fix.cleanup();
    repo.cleanup();
  }
}
// #984 — the deterministic-await seam: `finishLensReview` returns
// `{ summary, ledgerWrite }`; awaiting `ledgerWrite` lets an offline test
// read the ledger file after the run. The case below asserts that the
// summary is byte-identical before and after awaiting `ledgerWrite`.
// Resolution-independence (the summary resolving without the write) is a
// structural property of `finishLensReview`, not something this case proves.
{
  const fix = fixtureSkillsDir("deterministic");
  const repo = setupRepo();
  const blockedSummary = {
    verdict: "REVIEW_INCOMPLETE" as const,
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [
      {
        lens: "SIMPLICITY",
        ok: false,
        ms: 10,
        startMs: 0,
        findings: [],
        attempts: 1,
        blocked: true,
        parseError: "spawn failed",
      },
    ],
    findings: [],
  };
  const r = await finishLensReview(blockedSummary, "MEDIUM", repo.repo, repo.branch, { hasCritical: false });
  eq(r.summary.verdict, "REVIEW_INCOMPLETE", "(2e) finish returns REVIEW_INCOMPLETE");
  // Await the ledger write — the seam the issue's deterministic-await option
  // requires. It must not throw (the catch(trace) inside writeLensLedgerEntry
  // swallows every failure) and must not change the already-resolved summary.
  await r.ledgerWrite;
  // The summary is byte-identical across the await (the #912 rule — the
  // ledger write is a side effect, never a gate on the result).
  assert(
    JSON.stringify(r.summary) === JSON.stringify({ ...blockedSummary, note: r.summary.note }),
    "(2e) the summary is byte-identical across the ledgerWrite await",
  );
  fix.cleanup();
  repo.cleanup();
}

{
  for (const th of ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const) {
    assert(
      lensPassed("REVIEW_INCOMPLETE", th) === false,
      `(4) lensPassed(REVIEW_INCOMPLETE, ${th}) === false — the guard can never pass an incomplete review`,
    );
  }
  assert(lensPassed("APPROVED", "MEDIUM") === true, "(4) APPROVED still passes (control)");
}
console.log(`\nexit ${exit}`);
process.exit(exit);
