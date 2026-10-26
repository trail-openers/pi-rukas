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

/**
 * #1634 — the two git reads the adversarial gate makes of a worktree, matched
 * on the argv prefix `readWorktreeDiff` issues through the driver's exec seam
 * (`execFn("git", { argv, cwd })`). That argv form is the only transport
 * production uses, so it is the only form matched here.
 */
const GATE_ARGV_READS = [
  ["rev-parse", "--show-toplevel"],
  ["diff", "--end-of-options"],
] as const;

function gateArgvRead(argv: string[] | undefined): (typeof GATE_ARGV_READS)[number] | undefined {
  if (!argv) return undefined;
  return GATE_ARGV_READS.find((read) => read.every((part, i) => argv[i] === part));
}

/**
 * #1634 — wrap a fixture's scripted `verifyExecFn` so it answers the
 * adversarial gate's two reads HONESTLY instead of falling through to the
 * fake's catch-all `""`.
 *
 * The gate (`readWorktreeDiff`) runs `git rev-parse --show-toplevel` in the
 * worktree — which must name the worktree itself — and then
 * `git diff --end-of-options <base>..HEAD` with a `HEAD` fallback. A fake that
 * answers those with `""` (which is what a catch-all `return { stdout: "" }`
 * does) is REFUSED: the gate cannot tell a fake's silence from git's, so it
 * parks with `adversarial-diff-unreadable` and the cycle never reaches
 * commit-pr. A fixture that scripts git therefore has to answer the toplevel
 * probe as what the tree is (`cwd` itself) and the diff reads as what the tree
 * holds. Every other command passes through untouched, so the fixture's own
 * scripted answers — cherry-pick, push, `gh pr create` — are unaffected.
 *
 * `diffFor` lets a fixture return the diff it wants the gate to see (non-empty
 * = the reviewer actually runs instead of skipping on an empty diff). No caller
 * uses it yet; it is kept because STEP 3's kill-cause fixture is the case it
 * exists for. The SHELL-FORM branch this once carried is gone: production's
 * `readWorktreeDiff` reaches the seam only as `execFn("git", { argv, cwd })`,
 * and a branch no caller exercises is a branch no test proves.
 */
export function answerDiffReads<F extends (cmd: any, o?: any) => Promise<any>>(
  exec: F,
  diffFor?: (cwd: string, range: string) => string,
): F {
  // A real `git diff <range>` prints nothing when the range is empty, so an
  // absent range reads as a clean tree — not as "the fake was never asked".
  const diff = (cwd: string, range: string | undefined) => ({
    stdout: diffFor && range ? diffFor(cwd, range) : "",
  });
  return (async (cmd: any, o?: any) => {
    const read = gateArgvRead(o?.argv);
    if (cmd !== "git" || !read) return exec(cmd, o);
    const range = o.argv.find((a: string) => a.includes(".."));
    return read[0] === "rev-parse" ? { stdout: `${o.cwd}\n` } : diff(o.cwd, range);
  }) as unknown as F;
}
