/**
 * lib/lean-review-fixtures — the temp-repo harness the `lean/review` smoke
 * tests share.
 *
 * `review`'s claims are git claims ("origin holds the head the gates read",
 * "the fixer's commit is on the branch", "the frozen blob still hashes to its
 * record"), so a stub exec would test the stub. Here the repo, the branch and
 * the commits are real and `exec` shells out to the real `execp`; only the
 * models are stubs, behind the three injected seams of `ReviewDeps`. No child
 * process is spawned and no token is spent.
 *
 * One array of temp roots is shared by both suites and each cleans it at its
 * own end (`cleanupRoots` is idempotent), because the two files exercise the
 * same step from two angles and would otherwise duplicate all of this.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import { defaultConfig } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import { type ReviewDeps, ReviewInfraError, reviewOutcome } from "../../src/lean/review.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import type { DispatchResult, DispatchSpec } from "../../src/types.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { put } from "./lean-build-fixture.ts";

const ROOTS: string[] = [];

export function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** A repo with a base commit, a `main` branch, and a bare origin it pushes to. */
export function makeRepo(): { repoRoot: string; origin: string; baseSha: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-review-"));
  const origin = mkdtempSync(path.join(tmpdir(), "lean-review-origin-"));
  ROOTS.push(repoRoot, origin);
  git(repoRoot, "init", "-q", "-b", "main");
  git(origin, "init", "-q", "--bare");
  put(repoRoot, "a.ts", "export const a = 1;\n");
  put(repoRoot, "tests/AC1.test.ts", "// frozen\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  git(repoRoot, "remote", "add", "origin", origin);
  git(repoRoot, "push", "-q", "-u", "origin", "main");
  return { repoRoot, origin, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

export const USAGE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 10 };

export function result(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 5,
    exitCode: 0,
    usage: USAGE,
    ...over,
  };
}

/** The step under test, with the outside world replaced by these. */
export function depsWith(over: Partial<ReviewDeps>): ReviewDeps {
  return {
    headless: false,
    exec: (cmd, o) => execp(cmd, { ...(o ?? {}), env: { ...gitEnv(), ...(o?.env ?? {}) } }),
    adversarial: async () => result({ loopOutcome: "approved" }),
    lens: async () => ({ verdict: "APPROVED", findings: "", usage: USAGE }),
    dispatch: async () => result({ role: "developer" }),
    fetchIssueBody: async () => "body",
    loadConfig: async () => defaultConfig(),
    ...over,
  };
}

export function ctxFor(repoRoot: string, baseSha: string, branch: string): HandlerCtx {
  const run = createRun({ issue: 7, version: "test", models: {}, baseSha, branch });
  return { repoRoot, issue: 7, run, steps: run.steps, stepKey: "7:review:0", now: () => 1 };
}

/** Publish `branch` on origin and in the run's worktree, at a commit on `base`. */
export async function setup(opts: {
  repoRoot: string;
  baseSha: string;
  branch: string;
  /** A file the head commit adds, so the head is not the base. */
  feature?: string;
  /** A frozen test the head commit tampers with. */
  tamper?: boolean;
}): Promise<string> {
  const wt = path.join(opts.repoRoot, ".worktrees", "lean-7");
  git(opts.repoRoot, "worktree", "add", "-B", opts.branch, wt, opts.baseSha);
  if (opts.feature !== undefined) {
    put(wt, "feature.ts", opts.feature);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: the work");
  }
  if (opts.tamper === true) {
    put(wt, "tests/AC1.test.ts", "// edited by the fixer\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "fix: broke the contract");
  }
  git(wt, "push", "-q", "origin", `refs/heads/${opts.branch}`);
  return git(wt, "rev-parse", "HEAD");
}

export const BRANCH = "lean/issue-7";

/**
 * The frozen acceptance test's committed bytes at `ref`, byte for byte.
 *
 * The hash the step must be handed is the one `specify` froze, and that is a hash
 * of the COMMITTED bytes — so this reads them out of git rather than off a
 * working copy, which is whatever the last case in this file left behind. `latin1`
 * is the one encoding that round-trips every byte, so a frozen test holding
 * invalid UTF-8 still hashes to the record the freeze made (same reasoning as
 * `blobAt` in `src/lean/build-git.ts`). `trim()` is deliberately NOT applied —
 * that would change the bytes.
 */
export function frozenBlob(repoRoot: string, ref: string): string {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "show", `${ref}:tests/AC1.test.ts`], {
    cwd: repoRoot,
    encoding: "latin1",
    env: gitEnv(),
  });
  if (r.status !== 0)
    throw new Error(`git show ${ref}:tests/AC1.test.ts failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout ?? "";
}

/** Run the step; a throw comes back as the error so each case asserts on it. */
export async function runStep(
  ctx: HandlerCtx,
  deps: ReviewDeps,
): Promise<{ outcome?: Outcome; threw?: Error }> {
  try {
    return { outcome: await reviewOutcome(ctx, deps) };
  } catch (err) {
    return { threw: err as Error };
  }
}

/** Every temp dir this harness made, removed. Safe to call from each suite. */
export function cleanupRoots(): void {
  for (const dir of ROOTS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export { ReviewInfraError };
export type { DispatchSpec, Outcome, ReviewDeps };
