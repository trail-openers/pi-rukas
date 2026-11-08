#!/usr/bin/env bun
/**
 * #2127 (AC2, R3) — the lean review path's lens spawn carries the turn ceiling.
 *
 * AC2 names TWO paths to the lens spawn: the driver's lens arm and lean's
 * (`lean/review-deps.ts` → `runLensReview`). Both reach the same per-lens
 * spawner, `runLensChild`, where R1 puts the ceiling — but only one can be
 * observed through the seam the sibling suite uses. `test-lens-child-bound.ts`
 * already occupies `mock.module` on `src/spawn.ts` with a recorder for the
 * driver path, and a second `mock.module` of the same specifier does not
 * reliably replace the first, so the lean arm gets its own process and its own
 * recorder. THAT is the seam this suite observes — `spawnSpecialist` itself,
 * one level BELOW `deps.lensChildFn`, which is typed `typeof runLensChild` and
 * receives no spawn options at all and so could never have seen `budgetTurns`.
 *
 * Nothing is stubbed between lean's `lens` seam and the spawn apart from the
 * spawn: the seam hands its options to the REAL `runLensReview`, which resolves
 * the diff from the refs and fans out over the REAL `runLensChild`. The diff is
 * a real git read over a real temp clone, because `LensArgs` carries refs and
 * never a diff string — the caller cannot hand the ceiling a number.
 *
 * R4 is asserted in the same process: the adversarial arm of the same
 * `reviewDeps` keeps byte-identical SpawnOptions, so its capture carries no
 * `budgetTurns`.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { installLensSkills, stubLensSpawn } from "./lib/lens-stub-spawn.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const spawnCalls = stubLensSpawn();

// Imported AFTER the mock, so every lens module binds to the recorder.
const { runLensChild } = await import("../src/lens-review-child.ts");
const { lensTurnCeiling } = await import("../src/lens-turn-ceiling.ts");
const { reviewDeps } = await import("../src/lean/review-deps.ts");
const { runAdversarialLoop } = await import("../src/adversarial.ts");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = promisify(exec);
const G = (cwd: string, ...args: string[]) =>
  execp(`git ${args.map((a) => `'${a}'`).join(" ")}`, { cwd, maxBuffer: 64 * 1024 * 1024 });

/**
 * A real clone: `main` at the base commit, `lean/issue-2127` one commit past it.
 *
 * `added`/`removed` are the file's post- and pre-change line counts, written as
 * whole comment lines so `git diff base...head` reports exactly `added + removed`
 * changed lines for the one file it touches (a pure add of N lines is N added,
 * 0 removed; deleting M of the base file's lines is M removed). The changed-line
 * count the ceiling divides by is therefore a number this file states, not one
 * it hopes git produced — and the assertions below re-derive the expectation
 * from the curve rather than a literal.
 */
async function mkRunRepo(root: string, added: number, removed: number): Promise<string> {
  gitTestEnv();
  const dir = path.join(root, "repo");
  mkdirSync(dir, { recursive: true });
  await G(root, "init", "-q", "--bare", path.join(root, "origin.git"));
  await G(dir, "init", "-q", "-b", "main");
  await G(dir, "config", "user.email", "t@t");
  await G(dir, "config", "user.name", "T");
  // The base file carries `removed` lines, all of which the branch commit deletes.
  const baseLines = Array.from({ length: removed }, (_u, i) => `// base ${i}`).join("\n");
  writeFileSync(path.join(dir, "touched.ts"), `${baseLines}\n`);
  writeFileSync(path.join(dir, "keep.ts"), "export const keep = 1;\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "base");
  await G(dir, "remote", "add", "origin", path.join(root, "origin.git"));
  await G(dir, "push", "-q", "-u", "origin", "main");
  await G(dir, "checkout", "-qb", "lean/issue-2127");
  const addedLines = Array.from({ length: added }, (_u, i) => `// added ${i}`).join("\n");
  writeFileSync(path.join(dir, "grown.ts"), `${addedLines}\n`);
  if (removed > 0) rmSync(path.join(dir, "touched.ts"));
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "feat: the branch change");
  return dir;
}

/** The refs the lean seam is called with: the base commit, the branch tip. */
async function refs(dir: string): Promise<{ base: string; head: string }> {
  const base = (await G(dir, "rev-parse", "origin/main")).stdout.trim();
  const head = (await G(dir, "rev-parse", "HEAD")).stdout.trim();
  return { base, head };
}

const root = mkdtempSync(path.join(os.tmpdir(), "lens-turn-lean-"));
const skills = path.join(root, "skills");
installLensSkills(skills);
// `isolateLedger()` returns the UNDO, not an object with one.
const releaseLedger = isolateLedger();
const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;

/** One lean lens round over a repo whose diff is `added + removed` lines. */
async function leanRound(
  name: string,
  added: number,
  removed: number,
): Promise<{ budgetTurns?: number; childBoundMs?: number; lenses: number }> {
  const dir = await mkRunRepo(path.join(root, name), added, removed);
  const { base, head } = await refs(dir);
  spawnCalls.length = 0;
  await reviewDeps(false).lens({
    base,
    head,
    branch: "lean/issue-2127",
    cwd: dir,
    wave: "full",
    pr: undefined,
    context: "ctx",
    evidence: undefined,
    extraFindings: [],
    headless: false,
    budget: { opts: {}, fired: () => undefined },
  });
  const lens = spawnCalls.filter((c) => c.role === "code-review-specialist");
  return {
    lenses: lens.length,
    budgetTurns: lens[0]?.budgetTurns,
    childBoundMs: lens[0]?.childBoundMs,
  };
}

try {
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;
  delete process.env.PI_ENSEMBLE_LENS_BOUND_MS;

  // ── (1) SMALL DIFF: the floor reaches the spawn of every lean lens child.
  {
    const r = await leanRound("small", 10, 0);
    assert(r.lenses > 0, `(1) precondition: the lean lens arm reached spawnSpecialist (${String(r.lenses)} lens spawns)`);
    assert(
      r.budgetTurns === lensTurnCeiling(10),
      `(1) the lean lens child was spawned with budgetTurns ${String(lensTurnCeiling(10))} — the ceiling computed from the 10-changed-line diff the round read (captured ${String(r.budgetTurns)})`,
    );
    assert(
      r.childBoundMs !== undefined,
      "(1) and the wall clock is still armed beside it — the turn ceiling is advisory, not a replacement",
    );
  }

  // ── (2) LARGE DIFF: the ceiling moves with the diff, and is not a constant.
  {
    const r = await leanRound("large", 1000, 200);
    assert(
      r.lenses > 0 && r.budgetTurns === lensTurnCeiling(1200),
      `(2) on the 1 200-changed-line diff the lean lens child got ${String(lensTurnCeiling(1200))} turns (captured ${String(r.budgetTurns)})`,
    );
    assert(
      lensTurnCeiling(1200) !== lensTurnCeiling(10),
      "(2) and that is a different ceiling from (1)'s, so the value tracks the diff rather than being a constant",
    );
  }

  // ── (3) EVERY LENS, NOT JUST THE FIRST. One round fans out over the roster;
  // a ceiling threaded onto one dispatch only would leave the rest unpaced.
  {
    const dir = await mkRunRepo(path.join(root, "all"), 10, 0);
    const { base, head } = await refs(dir);
    spawnCalls.length = 0;
    await reviewDeps(false).lens({
      base,
      head,
      branch: "lean/issue-2127",
      cwd: dir,
      wave: "full",
      pr: undefined,
      context: "ctx",
      evidence: undefined,
      extraFindings: [],
      headless: false,
      budget: { opts: {}, fired: () => undefined },
    });
    const lens = spawnCalls.filter((c) => c.role === "code-review-specialist");
    assert(
      lens.length > 1 && lens.every((c) => c.budgetTurns === lensTurnCeiling(10)),
      `(3) EVERY lens child of the round carried the same ceiling (captured ${JSON.stringify(lens.map((c) => c.budgetTurns))})`,
    );
  }

  // ── (4) R4 — THE ADVERSARIAL ARM IS UNTOUCHED. Same `reviewDeps` file, the
  // arm beside the lens one: its SpawnOptions stay byte-identical, so a change
  // that armed the turns lever for the reviewer too fails here rather than
  // quietly pacing a second role.
  {
    const dir = await mkRunRepo(path.join(root, "adv"), 10, 0);
    spawnCalls.length = 0;
    await runAdversarialLoop(
      {
        base: "HEAD~1",
        head: "HEAD",
        workCwd: dir,
        context: "ctx",
        issueBody: "body",
        reportOnly: true,
        reportVerdict: "routed",
        reportRound: 1,
        branch: "lean/issue-2127",
        processGroup: true,
      } as never,
      new AbortController().signal,
      "job-2127",
    );
    const reviewer = spawnCalls.filter((c) => c.role === "adversarial-developer");
    assert(
      reviewer.length > 0,
      `(4) precondition: the adversarial arm reached spawnSpecialist (${String(reviewer.length)} reviewer spawns)`,
    );
    assert(
      reviewer.every((c) => c.budgetTurns === undefined),
      `(4) R4: no adversarial reviewer spawn carried budgetTurns — its SpawnOptions are byte-identical (captured ${JSON.stringify(reviewer.map((c) => c.budgetTurns))})`,
    );
    assert(
      reviewer.every((c) => c.childBoundMs !== undefined),
      "(4) and the reviewer keeps the wall clock it had before this change",
    );
  }

  // ── (5) THE CHILD COMPUTES IT, THE CALLER DOES NOT PASS IT. Driven straight
  // through `runLensChild` with a diff no lean caller handed anyone — the shape
  // that separates R1 (computed in the child from its own diff) from a ceiling
  // threaded in from outside, which would leave this call with none. The diff is
  // deliberately NOT one the builder above made, so a fixture-shaped coupling
  // cannot be what makes this pass.
  {
    const dir = await mkRunRepo(path.join(root, "child"), 10, 0);
    const ADDED_LINES = 700;
    spawnCalls.length = 0;
    await runLensChild({
      lens: { name: "SECURITY", skill: "code-review-security", precedence: 10 },
      runId: "run-2127",
      skillsDir: skills,
      context: "",
      roster: [],
      opts: {
        diff: `diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -0,0 +1 @@\n${"+x\n".repeat(ADDED_LINES)}`,
        cwd: dir,
      },
      bumpBatch: () => {},
    });
    const call = spawnCalls.find((c) => c.role === "code-review-specialist");
    assert(
      call?.budgetTurns === lensTurnCeiling(ADDED_LINES),
      `(5) runLensChild computed the ceiling from its own diff (${String(ADDED_LINES)} added lines → ${String(lensTurnCeiling(ADDED_LINES))}); captured ${String(call?.budgetTurns)}`,
    );
  }
} finally {
  if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
  releaseLedger();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
