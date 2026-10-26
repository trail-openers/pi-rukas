#!/usr/bin/env bun
/**
 * #1634 — the adversarial gate must NOT approve a diff it could not read.
 *
 * The defect: `fetchDiff` returned `""` for every failure — no worktree path, a
 * directory that is not a repository, a `git diff` that threw or exited
 * non-zero — and the fan-out's `!diff.trim()` guard read that as a clean tree:
 * `adversarial-skipped-empty-diff` + `adversarial-approved {rounds: 0}`. A
 * killed develop round whose worktree nobody could read was reported approved
 * and merged. #384 removed exactly this from the lens path; this is the same
 * rule on the pre-commit read.
 *
 * Covers:
 * - `readWorktreeDiff`: missing cwd, a non-repository directory, a throwing
 *   `git diff` → ok:false; a real clean tree → ok:true with an EMPTY diff;
 *   a real dirty tree → ok:true with the change.
 * - The gate end-to-end: none of the three failure shapes produce
 *   `adversarial-approved`, `adversarial-skipped-empty-diff`, or a reviewer
 *   spawn; the two healthy shapes still skip / still get reviewed exactly as
 *   before.
 *
 * The git trees are real and live under the OS temp dir, so nothing here
 * depends on the host home path.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { readWorktreeDiff } from "../src/work-driver-diff-read.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";

const git = (cwd: string, ...args: string[]) => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
};

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "APPROVED after round 1",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
    ...overrides,
  };
}

/** A bare directory — NOT a repository. */
function plainDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `adv-diff-${label}-`));
}

/** A real git worktree: one commit, then `dirty` adds an uncommitted change. */
function repoDir(label: string, dirty: boolean): string {
  const dir = plainDir(label);
  git(dir, "init", "-q", ".");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  if (dirty) {
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    git(dir, "add", "a.ts");
  }
  return dir;
}

async function seed(dir: string, issue: number, worktrees: Record<string, string>) {
  const workstreams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> = {};
  for (const id of Object.keys(worktrees)) {
    workstreams[id] = { id, scope: id, paths: [], outOfScope: [] };
  }
  const s = {
    ...initialState(issue, 1_000_000),
    pipelineState: {
      ...initialState(issue, 1_000_000).pipelineState,
      currentStep: "adversarial" as const,
      lastCompletedStep: "develop" as const,
      worktrees,
      workstreams,
      branchName: `feature/issue-${issue}`,
    },
  };
  await writeState(dir, s);
}

function ctxFor(dir: string, issue: number, spawns: { n: number }): DriverContext {
  return {
    host: makeFakePi(),
    repoRoot: dir,
    issue,
    issueBodyFetcherFn: async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nbody" }),
    adversarialLoopFn: async () => {
      spawns.n++;
      return mkResult();
    },
    dispatchFn: async (_pi, spec, opts) => {
      if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
      if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
      throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
    },
  } as unknown as DriverContext;
}

const approveKinds = ["adversarial-approved", "adversarial-skipped-empty-diff"] as const;

// ───────────────────────────── readWorktreeDiff, the unit ─────────────────────────────

{
  const r = await readWorktreeDiff(undefined);
  assert(!r.ok, "missing cwd → the read says it could not tell (never an empty diff)");
}

{
  const dir = plainDir("unit-nonrepo");
  try {
    const r = await readWorktreeDiff(dir);
    assert(!r.ok, `non-repository directory → not ok (${r.ok ? "returned a diff" : r.reason.slice(0, 60)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = plainDir("unit-throw");
  try {
    const r = await readWorktreeDiff(dir, undefined, async () => {
      throw new Error("simulated git failure");
    });
    assert(!r.ok, "a `git` that throws → not ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = plainDir("unit-empty");
  try {
    // A clean tree answers both reads successfully and prints nothing: the
    // read establishes empty POSITIVELY, so it is `ok` with an empty diff.
    const r = await readWorktreeDiff(dir, undefined, async (cmd, opts) => {
      const line = [cmd, ...(opts?.argv ?? [])].join(" ");
      if (line.includes("--show-toplevel")) return { stdout: `${opts?.cwd}\n` };
      return { stdout: "" };
    });
    assert(r.ok && r.diff === "", "a clean worktree (both reads succeed, diff empty) → ok + empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = plainDir("unit-parent");
  try {
    // A plain directory UNDER a repo: git resolves the parent. Naming a
    // different toplevel is a failure, not an empty tree.
    const r = await readWorktreeDiff(dir, undefined, async (cmd, opts) => {
      const line = [cmd, ...(opts?.argv ?? [])].join(" ");
      if (line.includes("--show-toplevel")) return { stdout: "/somewhere/else\n" };
      return { stdout: "" };
    });
    assert(!r.ok, "a directory that is not its own worktree root → not ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = repoDir("unit-clean", false);
  try {
    const r = await readWorktreeDiff(dir);
    assert(r.ok && r.diff === "", "a real clean worktree → ok + empty (established positively)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = repoDir("unit-dirty", true);
  try {
    const r = await readWorktreeDiff(dir);
    assert(
      r.ok && r.diff.includes("export const a = 1;"),
      "a real dirty worktree → ok + the change",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ───────── #1634: the base is a full sha, and the path is a real directory ─────────

{
  // A baseSha that is not a 40-hex object id NEVER reaches git's argv. The old
  // ref-shaped pattern admitted a leading `-` — which git reads as an OPTION —
  // and any symbolic ref, whose movement silently changes what the gate
  // compared. The read must fall back to `git diff HEAD` without ever handing
  // git the rejected value.
  const dir = repoDir("unit-badsha", true);
  try {
    const argvs: string[][] = [];
    const r = await readWorktreeDiff(dir, "--output=/tmp/pwned", async (_cmd, opts) => {
      const argv = opts?.argv ?? [];
      argvs.push(argv);
      if (argv.includes("--show-toplevel")) return { stdout: `${opts?.cwd}\n` };
      return { stdout: "diff --git a/a.ts b/a.ts\n" };
    });
    assert(r.ok, "a non-sha baseSha still reads the uncommitted diff");
    assert(
      argvs.length > 0 &&
        argvs.every((a) => a.every((t) => !t.includes("pwned") && !t.startsWith("--output"))),
      "a non-sha baseSha never reaches git's argv",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A real 40-hex base IS used, so the pinned comparison is the primary read.
  const dir = repoDir("unit-goodsha", false);
  try {
    const sha = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(path.join(dir, "c.ts"), "export const c = 3;\n");
    git(dir, "add", "c.ts");
    git(dir, "commit", "-q", "-m", "the change under review");
    const argvs: string[][] = [];
    const r = await readWorktreeDiff(dir, sha, async (_cmd, opts) => {
      const argv = opts?.argv ?? [];
      argvs.push(argv);
      if (argv.includes("--show-toplevel")) return { stdout: `${opts?.cwd}\n` };
      return { stdout: "diff --git a/c.ts b/c.ts\n+export const c = 3;\n" };
    });
    assert(
      r.ok && r.diff.includes("export const c = 3;"),
      "a full 40-hex baseSha → the committed range is read",
    );
    assert(
      argvs.some((a) => a.some((t) => t === `${sha}..HEAD`)),
      "a full 40-hex baseSha → git is asked for <sha>..HEAD",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // #1634 — a worktree reached through a SYMLINK (or with a trailing slash) is
  // still its own toplevel. The old check compared the two STRINGS, so a
  // perfectly readable tree rejected itself as "not its own worktree root".
  // `realpathSync` resolves both sides, and an unresolvable path fails closed.
  const parent = plainDir("unit-paths");
  const repo = path.join(parent, "real");
  const link = path.join(parent, "link");
  try {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main", ".");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    symlinkSync(repo, link);
    const fakeGit = async (_cmd: string, opts?: { argv?: string[]; cwd?: string }) => {
      const argv = opts?.argv ?? [];
      // Answer as git does: the toplevel is the REAL directory, not the link.
      if (argv.includes("--show-toplevel")) return { stdout: `${repo}\n` };
      return { stdout: "" };
    };
    const viaLink = await readWorktreeDiff(link, undefined, fakeGit);
    assert(
      viaLink.ok,
      `a symlinked worktree whose toplevel resolves to the same directory → ok (${viaLink.ok ? "ok" : viaLink.reason})`,
    );
    const trailing = await readWorktreeDiff(`${repo}/`, undefined, fakeGit);
    assert(
      trailing.ok,
      `a worktree path with a trailing slash → ok (${trailing.ok ? "ok" : trailing.reason})`,
    );
    const gone = await readWorktreeDiff(path.join(parent, "nope"), undefined, fakeGit);
    assert(!gone.ok, "an unresolvable worktree path → not ok (fails closed, never a pass)");
    // The negative still holds after resolving: a DIFFERENT directory is not
    // this one's toplevel, and that is what the whole probe exists to catch.
    const other = await readWorktreeDiff(repo, undefined, async (_cmd, opts) => {
      const argv = opts?.argv ?? [];
      if (argv.includes("--show-toplevel")) return { stdout: `${parent}\n` };
      return { stdout: "" };
    });
    assert(!other.ok, "a path whose toplevel is a different directory → still not ok");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// ─────────────────────────── the gate, end to end ───────────────────────────

{
  // Missing worktree path: the map has the id, the value is undefined, so the
  // gate falls back to repoRoot — which here is a plain directory.
  const dir = plainDir("gate-norepo");
  try {
    await seed(dir, 1634, { default: dir });
    const spawns = { n: 0 };
    await runWorkDriver(ctxFor(dir, 1634, spawns)).catch(() => {});
    const after = await readState(dir, 1634);
    const events = after?.eventLog ?? [];
    assert(
      !events.some((e) => (approveKinds as readonly string[]).includes(e.kind)),
      "non-repository worktree → NO approval and NO empty-diff skip",
    );
    assert(spawns.n === 0, "non-repository worktree → the reviewer was never spawned");
    assert(
      events.some(
        (e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable",
      ),
      "non-repository worktree → parks with `adversarial-diff-unreadable`",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A git failure on the read (fake exec throws), with a real repo underneath.
  const dir = repoDir("gate-throws", true);
  try {
    await seed(dir, 1635, { default: dir });
    const spawns = { n: 0 };
    const ctx = ctxFor(dir, 1635, spawns);
    ctx.verifyExecFn = async () => {
      throw new Error("simulated git failure");
    };
    await runWorkDriver(ctx).catch(() => {});
    const after = await readState(dir, 1635);
    const events = after?.eventLog ?? [];
    assert(
      !events.some((e) => (approveKinds as readonly string[]).includes(e.kind)),
      "a throwing `git diff` → NO approval",
    );
    assert(spawns.n === 0, "a throwing `git diff` → the reviewer was never spawned");
    assert(
      events.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable"),
      "a throwing `git diff` → parks with `adversarial-diff-unreadable`",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A real CLEAN worktree still skips and approves exactly as before (#286).
  const dir = repoDir("gate-clean", false);
  try {
    await seed(dir, 1636, { default: dir });
    const spawns = { n: 0 };
    await runWorkDriver(ctxFor(dir, 1636, spawns)).catch(() => {});
    const after = await readState(dir, 1636);
    const events = after?.eventLog ?? [];
    assert(spawns.n === 0, "clean worktree → no reviewer spawn (the #286 skip stands)");
    assert(
      events.some((e) => e.kind === "adversarial-skipped-empty-diff"),
      "clean worktree → still records the empty-diff skip",
    );
    const approved = events.find((e) => e.kind === "adversarial-approved");
    assert(approved?.kind === "adversarial-approved" && approved.rounds === 0, "clean worktree → still approved with rounds 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A real DIRTY worktree is reviewed, not skipped.
  const dir = repoDir("gate-dirty", true);
  try {
    await seed(dir, 1637, { default: dir });
    const spawns = { n: 0 };
    await runWorkDriver(ctxFor(dir, 1637, spawns)).catch(() => {});
    const after = await readState(dir, 1637);
    const events = after?.eventLog ?? [];
    assert(spawns.n === 1, `dirty worktree → the reviewer WAS spawned (got ${spawns.n})`);
    assert(
      !events.some((e) => e.kind === "adversarial-skipped-empty-diff"),
      "dirty worktree → no empty-diff skip",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
