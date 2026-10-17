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
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * Self-isolate from the REAL per-clone review ledger (idempotent). Sets
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` to a private temp file so any subsequent
 * `appendLedgerEntry` call in this process writes there, not to the main
 * clone's .git. The temp dir is removed on process exit (best-effort).
 * Honours an already-set value (e.g. the operator's or a prior call).
 */
export function isolateLedger(): void {
  if (process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE === undefined) {
    const isoDir = mkdtempSync(path.join(os.tmpdir(), "ledger-iso-"));
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(isoDir, "review-ledger.json");
    process.on("exit", () => {
      try {
        rmSync(isoDir, { recursive: true, force: true });
      } catch {
        // cleanup is best-effort
      }
    });
  }
}

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
