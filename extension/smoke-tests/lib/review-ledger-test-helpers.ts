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
 */

import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Set up a temp repo with a local bare origin + a feature branch. */
export function setupRepo(): { repo: string; origin: string; branch: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
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
  }).trim();
  const abs = path.isAbsolute(common) ? common : path.resolve(repo, common);
  return path.join(abs, "review-ledger.json");
};
