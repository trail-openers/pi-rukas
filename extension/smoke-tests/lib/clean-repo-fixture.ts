/**
 * clean-repo-fixture — make a fixture directory answer the adversarial gate's
 * diff reads as what it is: a clean worktree.
 *
 * Why this exists (#1634). Before it, a smoke test that wanted to drive the
 * driver to the adversarial step would `mkdir` a temp dir, point
 * `pipelineState.worktrees` at it, and rely on `fetchDiff` returning `""` —
 * which it did for EVERY failure, including "this directory is not a
 * repository". The old gate read that empty string as a clean tree and skipped
 * the review. #1634 replaced that read with `readWorktreeDiff`, which refuses
 * (`{ ok: false }`) when `git rev-parse --show-toplevel` fails, does not name
 * the cwd, or when `git diff` fails: the no-signal answer is never approval.
 * So a bare `mkdir` is now a refusal, and a fixture that meant "clean tree"
 * has to say so TO GIT rather than to the fixture.
 *
 * `initCleanRepo` is that statement: one commit, nothing dirty, so both reads
 * genuinely answer — toplevel names the directory, `git diff HEAD` is empty.
 * The alternative (an env switch in production code that answers the gate's
 * reads as a clean tree) was rejected: production must not carry a knob whose
 * only effect is to make a gate see what a test wanted.
 *
 * Isolation: every git call threads `gitTestEnv()` (see lib/git-test-env.ts
 * #1145 — the four levers that keep a fixture repo from reading the operator's
 * global config) and carries its identity with per-call `-c` flags, so nothing
 * here depends on the host's home path or on a global git identity existing.
 * The dirs themselves come from `os.tmpdir()`, never from `$HOME`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** The identity every fixture commit carries, so a CI runner with no global
 *  git identity still commits (#1016 hit this through the safety net). */
const IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t"] as const;

/** Run one git command in `dir`; throws with the stderr on failure. */
function run(dir: string, args: string[]): string {
  const r = spawnSync("git", [...IDENTITY, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: gitTestEnv(),
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr || "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

/**
 * Make `dir` a real git repository whose working tree is CLEAN: `git init`,
 * one empty commit, `HEAD` at that commit. Idempotent in effect (a second call
 * on an already-initialised dir adds nothing), so a fixture may call it twice.
 *
 * Returns the commit SHA, which a fixture that wants `git diff <baseSha>..HEAD`
 * to be NON-empty then commits a change on top of — the shape each caller
 * builds itself, in the words its own case needs. A helper for that second
 * step was dropped once no caller used it: an unused export in a shared lib is
 * a second way to build a fixture that can drift from the first.
 */
export function initCleanRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  // A fixture branch is named, not git's default: some fixtures assert on the
  // branch they set up, and the default varies with the host's init.defaultBranch.
  run(dir, ["init", "-q", "-b", "main", "."]);
  // The driver's state file lives under .pi/work-state; a real cycle excludes
  // it (and an earlier fixture shape pre-created .git/info for exactly this
  // reason), so a fixture that leaves it UNTRACKED still reads as a clean tree.
  mkdirSync(path.join(dir, ".pi", "work-state"), { recursive: true });
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "info", "exclude"), ".pi/\ntmp/\n");
  run(dir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return run(dir, ["rev-parse", "HEAD"]);
}
