#!/usr/bin/env bun
/**
 * #973 — the AUTOMATIC delta base (design decision 6).
 *
 * When no explicit `since` is given, a follow-up review on a branch
 * defaults its `since` to the branch's latest lens ledger entry's `headSha`
 * when that SHA is a strict ancestor of HEAD; otherwise the review is FULL.
 *
 * Covers (real git repos via `git init -q -b main`, lens children stubbed):
 *   - no ledger → full review
 *   - a ledger entry whose headSha is an ancestor of HEAD → delta over
 *     exactly that range
 *   - headSha not an ancestor (e.g. after a rebase) → full
 *   - headSha == HEAD → no-review (decision 4)
 *   - `full: true` → full
 *   - explicit `since` → that range
 *
 * Uses PI_ENSEMBLE_REVIEW_LEDGER_FILE for an isolated ledger.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execp = promisify(exec);

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

// Mock spawn.ts BEFORE the lens modules load (test-lens-kill-child pattern).
let spawnResponder: () => unknown = () => ({
  role: "code-review-specialist",
  ok: true,
  text: "Checked the diff; nothing in this lane.\n\nSkill Load Status: SUCCESS",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});
await import("../src/lens-review-diff.ts"); // ensure module is loaded
// Mock module via dynamic import to avoid import-order issues.
const { mock } = await import("bun:test");
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-973-delta",
  spawnSpecialist: async () => spawnResponder(),
}));

const { resolveDeltaSince, resolveReviewDiff } = await import("../src/lens-review-diff.ts");
const { runLensReview } = await import("../src/lens-review.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");

// --- fixture: skills dir with all bundled lens skills ---
function fixtureSkillsDir(name: string): { dir: string; cleanup: () => void } {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), `lens973-${name}-`)), "skills");
  mkdirSync(dir, { recursive: true });
  let prec = 10;
  for (const s of LENS_ROSTER) {
    const skillDir = path.join(dir, s.skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${s.skill}\nprecedence: ${prec}\n---\n`);
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

const skillsFixture = fixtureSkillsDir("delta");

// --- repo fixture: origin/main → c0, feature/work → c0 → c1 → c2 ---
async function mkRepo(): Promise<{
  dir: string;
  c0: string;
  c1: string;
  c2: string;
  ledgerFile: string;
}> {
  const base = mkdtempSync(path.join(os.tmpdir(), "pi-973-"));
  const dir = path.join(base, "repo");
  mkdirSync(dir, { recursive: true });
  const ledgerFile = path.join(base, "review-ledger.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  await execp("git init -q -b main", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m c0", { cwd: dir, shell: "/bin/bash" });
  const c0 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  await execp("git checkout -qb feature/work", { cwd: dir });
  writeFileSync(path.join(dir, "first.txt"), "one\n");
  await execp("git add first.txt && git commit -q -m c1", { cwd: dir, shell: "/bin/bash" });
  const c1 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  writeFileSync(path.join(dir, "second.txt"), "two\n");
  await execp("git add second.txt && git commit -q -m c2", { cwd: dir, shell: "/bin/bash" });
  const c2 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  return { dir, c0, c1, c2, ledgerFile };
}

function writeLedger(
  file: string,
  entries: Array<Record<string, unknown>>,
): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}

function cleanup(dir: string, ledgerFile: string): void {
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
  rmSync(dir, { recursive: true, force: true });
  try {
    rmSync(path.dirname(ledgerFile), { recursive: true, force: true });
  } catch {}
}

const branch = "feature/work";

// (1) No ledger → full review
{
  const r = await mkRepo();
  try {
    await runLensReview({
      base: "main",
      head: "feature/work",
      cwd: r.dir,
      branch,
      lensChildFn: async () => ({
        lens: "SECURITY",
        ok: true,
        ms: 0,
        startMs: Date.now(),
        findings: [],
        attempts: 1,
        blocked: false,
        summary: "clean",
      } as never),
    });
    assert(true, "no ledger → full review (no crash)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (2) Ledger entry whose headSha is an ancestor of HEAD → delta over that range
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1, // c1 is an ancestor of c2 (HEAD)
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, r.c1, "auto since resolves to the ledger entry's headSha (c1)");
    // Verify the diff covers exactly c1..c2
    const d = await resolveReviewDiff({
      base: "main",
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "delta review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta?.auto, true, "delta is marked auto");
      eq(d.delta?.since, r.c1, "delta since is the auto-resolved headSha");
      const expected = (
        await execp(`git diff ${r.c1}..${r.c2}`, { cwd: r.dir })
      ).stdout;
      eq(d.diff, expected, "delta diff matches git diff c1..c2 byte-for-byte");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (3) headSha not an ancestor → full review
{
  const r = await mkRepo();
  // Create a divergent commit from c0, then use that as headSha in the ledger
  await execp(`git checkout -qb feature/diverged ${r.c0}`, { cwd: r.dir });
  writeFileSync(path.join(r.dir, "diverged.txt"), "div\n");
  await execp("git add diverged.txt && git commit -q -m div", {
    cwd: r.dir,
    shell: "/bin/bash",
  });
  const diverged = (await execp("git rev-parse HEAD", { cwd: r.dir })).stdout.trim();
  await execp("git checkout -q feature/work", { cwd: r.dir });
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: diverged, // not an ancestor of c2
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, undefined, "non-ancestor headSha → no auto since (full review)");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (4) headSha == HEAD → no-review (decision 4)
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c2, // == HEAD (c2)
      round: 1,
    },
  ]);
  try {
    const since = await resolveDeltaSince(branch, undefined, r.dir);
    eq(since, undefined, "headSha == HEAD → no auto since (sha === head → full/no-review)");
    // When headSha == HEAD, the delta is empty → noReview
    const d = await resolveReviewDiff({
      since: r.c2,
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "noReview", "headSha == HEAD → no-review outcome");
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (5) full: true → full review
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1,
      round: 1,
    },
  ]);
  try {
    const d = await resolveReviewDiff({
      full: true,
      base: "main",
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "full: true → full review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta, undefined, "full: true → no delta (full review)");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

// (6) Explicit since → that range
{
  const r = await mkRepo();
  writeLedger(r.ledgerFile, [
    {
      branch,
      kind: "lens",
      patchId: "p1",
      passed: true,
      at: 1000,
      detail: "APPROVED",
      hasCritical: false,
      headSha: r.c1,
      round: 1,
    },
  ]);
  try {
    // Explicit since = c0 (different from the auto c1)
    const d = await resolveReviewDiff({
      since: r.c0,
      head: "feature/work",
      branch,
      cwd: r.dir,
      runId: "run-973-delta",
      roster: [],
      extraFindings: undefined,
      threshold: "MEDIUM",
    });
    assert(d.kind === "ok", "explicit since → delta review resolves to ok");
    if (d.kind === "ok") {
      eq(d.delta?.since, r.c0, "explicit since wins over auto");
      eq(d.delta?.auto, undefined, "explicit since is not marked auto");
      const expected = (await execp(`git diff ${r.c0}..${r.c2}`, { cwd: r.dir })).stdout;
      eq(d.diff, expected, "delta diff matches git diff c0..c2 byte-for-byte");
    }
  } finally {
    cleanup(r.dir, r.ledgerFile);
  }
}

skillsFixture.cleanup();
console.log(`\nexit ${exit}`);
process.exit(exit);
