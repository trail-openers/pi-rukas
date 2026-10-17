/**
 * Shared temp-repo helpers for the review-ledger smoke tests (#912 / #1039).
 *
 * `setupRepo` + `ledgerFile` live in lib/ (not test-review-ledger.ts) so the
 * headSha suite can import them WITHOUT executing the parent file's test
 * body — that import used to run the entire #912 suite and its
 * `process.exit(0)`, which pre-empted the headSha file's final line and made
 * it impossible for the headSha assertions to ever fail the process (#1039).
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as lib/wait-for-ledger.ts, #984).
 *
 * #1069 — `isolateLedger` self-isolates the caller from the REAL per-clone
 * review ledger. Tests that drive the real runLensReview / runAdversarialLoop
 * with process.cwd() (the actual repo, not a temp repo) must call it so the
 * writer's fire-and-forget ledger write lands in a private temp file, not the
 * main clone's .git (a worktree's common dir resolves to the main clone). The
 * ledger tests (test-review-ledger*.ts) do NOT call it — they use temp repos
 * and their writer must write to the temp repo's git dir, which the git-path
 * resolution (no env override) provides. Importing this module does NOT
 * self-isolate (the import-time side effect would break the temp-repo ledger
 * tests by setting the env override).
 *
 * #1449 — the helper no longer LEAKS. It used to honour an already-set value
 * as its own isolation target, which turned every caller into a passthrough:
 * a parent process (or an earlier test file in the same process) that set the
 * override got its value adopted, never replaced, and its own temp dir rmSync'd
 * on this process's exit. The live symptom (issue #1431 / PR #1431, branch
 * recut/issue-1417-merge-guard): a hand-run `dispatch_lens_review` in a Pi
 * process whose environment inherited a leaked override wrote its rows into a
 * /tmp file while `.git/review-ledger.json` sat untouched, and the #912 guard
 * refused the merge for want of a lens entry.
 *
 * The contract now:
 *   - the previous value is SAVED and RESTORED around the helper's own use, so
 *     the importing process's `process.env` after the call is the env it was
 *     before (asserted by test-ledger-isolation.ts);
 *   - a pre-existing value is never adopted as this call's isolation target.
 *     A caller that wants to honour one calls `adoptLedgerOverride()`;
 *     `isolateLedger()` always points at a fresh private temp file;
 *   - the temp dir it created is the only dir it removes on exit, and the
 *     exit handler restores the env before removing anything.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** The env var `ledgerPathFor` reads — owned by the src module, imported so the
 * helper cannot drift from the variable the writer actually honours. */
const LEDGER_ENV = "PI_ENSEMBLE_REVIEW_LEDGER_FILE";

/** What one `isolateLedger()` call owns, so its undo is exact. */
interface Isolation {
  dir: string;
  file: string;
  /** The value the importing process had BEFORE this call — restored verbatim
   * (including "absent"), never reinterpreted. */
  previous: string | undefined;
  /** Restore the env this call changed and remove its temp dir. Idempotent. */
  release: () => void;
}

const active = new Set<Isolation>();

/**
 * Self-isolate from the REAL per-clone review ledger. Sets
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` to a freshly created private temp file so
 * any subsequent `appendLedgerEntry` call in this process writes there, not to
 * the main clone's .git.
 *
 * #1449 — idempotent PER CALLER, and it never adopts an inherited value: each
 * call takes its own target and remembers what it replaced, so a second call
 * (a second file, or a test that re-isolates) cannot inherit the first one's
 * path as if it were the caller's own. The env is restored on process exit
 * before the temp dir is removed, so a suite that outlives the isolation reads
 * the env it started with.
 *
 * Returns the `release` for callers that want to undo the isolation explicitly
 * rather than at process exit (a test file that isolates, runs, and then drives
 * a real-git writer — the temp-repo pattern). Existing callers that ignore the
 * return value are unchanged.
 */
export function isolateLedger(): () => void {
  const previous = process.env[LEDGER_ENV];
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-iso-"));
  const file = path.join(dir, "review-ledger.json");
  process.env[LEDGER_ENV] = file;
  const iso: Isolation = {
    dir,
    file,
    previous,
    release: () => {
      if (!active.has(iso)) return;
      active.delete(iso);
      // Restore FIRST: an exit handler that removed the dir while the env still
      // named it would leave a window where a late writer targets a deleted
      // directory.
      if (iso.previous === undefined) delete process.env[LEDGER_ENV];
      else process.env[LEDGER_ENV] = iso.previous;
      try {
        rmSync(iso.dir, { recursive: true, force: true });
      } catch {
        // cleanup is best-effort
      }
    },
  };
  active.add(iso);
  return iso.release;
}

/**
 * #1449 — the explicit way to honour an already-set override (an operator's
 * scratch ledger, or a gate that pinned one for the whole suite): returns its
 * path without replacing it, creates nothing, and registers no cleanup — this
 * helper does not own a directory it did not create, so it must never rmSync
 * one. A caller that reaches for `isolateLedger` because its docs once said it
 * "honours an already-set value" reaches for the wrong function now.
 */
export function adoptLedgerOverride(): string | undefined {
  const value = process.env[LEDGER_ENV]?.trim();
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

/**
 * #1449 — every path this module pointed the env at and has NOT restored.
 * Exposed for `test-ledger-isolation.ts`, which asserts the set is empty once
 * a suite's import-time helpers have released their isolations: a leak into the
 * importing (or parent) process is exactly the bug that redirected a real
 * review's write.
 */
export function activeIsolations(): string[] {
  return [...active].map((i) => i.file);
}

// Process-exit cleanup for isolations still held at exit (the common case: a
// test file isolates at the top and never releases). Restores the env in
// reverse order of acquisition so the outermost caller's value wins.
process.on("exit", () => {
  for (const iso of [...active].reverse()) iso.release();
});

/** Set up a temp repo with a local bare origin + a feature branch.
 *
 * #1145 — every `execSync` here carries `env: gitTestEnv()`. These are the
 * synchronous spawn forms, which is exactly the case bun 1.3 does not fix by an
 * ambient `process.env` write, and this repo is what the ledger writers and the
 * merge guard read their identity from: a host `init.defaultBranch` makes the
 * clone's default branch differ, a host `~/.config/git/ignore` makes a file
 * vanish from the fixture's own status. Both decide the verdict, neither is
 * about the code under test. */
export function setupRepo(): { repo: string; origin: string; branch: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin.git");
  const gitEnv = gitTestEnv();
  execSync(`git init -q ${origin}`, { stdio: "ignore", env: gitEnv });
  execSync(`git clone -q ${origin} ${repo}`, { stdio: "ignore", env: gitEnv });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, stdio: "ignore", env: gitEnv });
  git("git config user.email t@t.t");
  git("git config user.name t");
  git("echo base > base.txt");
  git("git add base.txt");
  git('git commit -qm "base"');
  // The clone's default branch is whatever the empty origin has (HEAD →
  // refs/heads/main on modern git); rename to a non-default name so the
  // `git checkout -qb feature/x` + `git push origin feature/x` below works
  // without fighting the origin's checked-out branch.
  git("git branch -M dev");
  git("git push -q origin dev");
  // Set the mainline symbolic ref so detectMainline can resolve it without
  // a network call to gh (the test repo has no GitHub remote).
  git("git remote set-head origin dev");
  git("git checkout -qb feature/x dev");
  git("echo change > change.txt");
  git("git add change.txt");
  git('git commit -qm "change"');
  git("git push -q origin feature/x");
  return { repo, origin, branch: "feature/x" };
}

/** The review-ledger file's path for a repo (its git common dir). */
export const ledgerFile = (repo: string) => {
  const common = execSync("git rev-parse --git-common-dir", {
    cwd: repo,
    encoding: "utf8",
    env: gitTestEnv(),
  }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, "review-ledger.json");
};
