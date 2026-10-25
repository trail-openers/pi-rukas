/**
 * #1634 — making (or NOT making) a scratch directory something `git diff` can
 * answer, for tests that exercise the adversarial diff read.
 *
 * `readWorktreeDiff` (work-driver-diff.ts) distinguishes "this tree is clean,
 * there is nothing to review" from "this tree could not be read", and the
 * adversarial gate routes the second case as an infrastructure failure rather
 * than the empty-diff approval #286 introduced. A fixture built with
 * `mkdtempSync` and no `git init` is the SECOND case: there is no repository,
 * so the gate must refuse to approve it. That is the correct production answer
 * — a worktree that is not a git repo must never be auto-approved — so the
 * fixtures, not the gate, are what changed.
 *
 * `initScratchRepo` gives a fixture tree the two things the read needs: one
 * commit on `main` (so `HEAD` resolves and `git diff HEAD` answers), and an
 * identity so `git commit` works from a bare temp directory — the developer's
 * global config is not present on every host and CI's runner has none. It
 * commits nothing else, so the tree's diff against `HEAD` stays whatever the
 * test put there.
 *
 * The other half is the fixtures that must STAY unreadable: `withGitBroken`
 * makes every git invocation fail (a broken or uninstalled binary), and
 * `scratchDirWithoutGit` builds a directory with files in it and no repository.
 * Both are unreadable and neither is approvable; a test that only exercises one
 * of the two proves half the gate.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh temp directory, not a repository — the caller cleans it up. */
export function scratchDir(prefix = "pi-ens-gitfix-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Run `cmd` (argv, never a shell string) in `cwd`, throwing its stderr on failure. */
function run(cmd: string, args: string[], cwd: string): void {
  try {
    execFileSync(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}: ${stderr ?? String(err)}`);
  }
}

/** Run git in `cwd`, throwing with git's own message on failure. */
function git(cwd: string, args: string[]): void {
  run("git", args, cwd);
}

/**
 * Make `dir` a git working tree with one empty commit on `main`, so `git diff
 * HEAD`, `git diff --quiet HEAD` and `git status --porcelain -z` all answer.
 * Idempotent: a directory that already has a repository is returned untouched.
 */
export function initScratchRepo(dir: string): string {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 30_000,
    });
    return dir;
  } catch {
    // Not a repo yet — the ordinary case for a mkdtemp fixture.
  }
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  git(dir, ["config", "user.email", "smoke-test@pi-rukas.invalid"]);
  git(dir, ["config", "user.name", "pi-rukas smoke test"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "fixture baseline"]);
  return dir;
}

/**
 * A git working tree with one empty commit, built from scratch. The fixture
 * every diff-read test starts from: `git diff HEAD` is empty — so the read
 * reports a POSITIVELY proven empty diff — until the test writes a file.
 */
export function initScratchRepoFresh(prefix = "pi-ens-gitfix-"): string {
  return initScratchRepo(scratchDir(prefix));
}

/** Write `content` to `rel` inside `dir`, creating parent directories. */
export function seedFile(dir: string, rel: string, content: string): string {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Stage (but do not commit) `rel`, so the diff read sees a tracked change. */
export function stageFile(dir: string, rel: string): void {
  git(dir, ["add", "--", rel]);
}

/** Commit everything currently in `dir` (the fixture's own identity makes this work). */
export function commitAll(dir: string, message = "fixture commit"): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

/**
 * A directory that holds files but is NOT a git repository — the shape the
 * gate must treat as UNREADABLE rather than empty. `files` are written so the
 * tree is not trivially empty on disk either.
 */
export function scratchDirWithoutGit(
  prefix = "pi-ens-norepo-",
  files: Record<string, string> = {},
): string {
  const dir = scratchDir(prefix);
  for (const [rel, content] of Object.entries(files)) seedFile(dir, rel, content);
  return dir;
}

/**
 * Run `fn` with `git` removed from `PATH`, so every git read a driver path
 * makes fails the way a broken or uninstalled git does. This is the fixture for
 * "git itself failed", as distinct from `scratchDirWithoutGit`'s "there is no
 * repository here": both must be unreadable, and a gate that handles only one
 * of them is a gate that can still be fooled.
 */
export async function withGitBroken<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent-bin-dir-for-smoke-tests";
  try {
    return await fn();
  } finally {
    // An assignment rather than `delete`: biome's noDelete rejects the operator
    // and Node treats an undefined env value as absent, which is the restore we
    // want. A host with no PATH at all is not a case a smoke test runs on, but
    // it costs nothing to answer it correctly.
    process.env.PATH = saved as string;
  }
}
