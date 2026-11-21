/**
 * lean/verify-roster-base — what the run's BASE commit says about the project's own tests.
 *
 * The roster's other half asks what head ran; this half asks what the base held, and both asks are
 * asked of the COMMIT and never of the disk: a run that adds, deletes or empties files would
 * otherwise choose the tree that judges it. Two questions, one executor shape, and the same
 * fail-closed rule for both — an answer git refused is never read as an answer of "none".
 *
 * The rules these verdicts feed are stated where judged: `verify-roster.ts`.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { isFullCommitSha } from "../commit-sha.ts";
import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { SHAREABLE_DEPS } from "../worktree-dep-contract.ts";
import { globMatches } from "./config-test-location.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import type { VerifyExec } from "./verify-types.ts";

/**
 * The dependencies the base commit tracks that `tree` does NOT have — the ones its suite could not
 * have imported.
 *
 * Asked of the BASE COMMIT rather than of `expectedDepLocations`, and that choice is the whole rule:
 * the provisioner decides what to link by looking at the SOURCE, so if the source has since gone it
 * links nothing, expects nothing, and reports nothing — a base that cannot import a single module is
 * then read as a base whose suite ran and failed on its merits, which is the excuse that turns a
 * head-only regression green. The base commit is the one record of what the project's own tree held
 * that no link can silently empty, so it is what the expectation is taken from. `statSync` follows the
 * symlink provisioning made, so a link whose source has gone is undelivered; any read fault is
 * "undelivered", the fail-closed direction — a tree this cannot look at is not a tree whose suite ran.
 */
export async function undeliveredDeps(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  tree: string,
): Promise<string[]> {
  if (!isFullCommitSha(baseSha)) return [];
  const listed = await trackedPathsAt(exec, repoRoot, baseSha, SHAREABLE_DEPS);
  if (listed === undefined) return [];
  // A directory is expected where the commit tracks a path under one of the shareable names; the
  // recorded path's first segment is the dependency directory itself.
  const expected = new Set<string>();
  for (const rel of listed) {
    const head = rel.split("/")[0] ?? "";
    if ((SHAREABLE_DEPS as readonly string[]).includes(head)) expected.add(head);
  }
  return [...expected].filter((dep) => {
    try {
      return !statSync(path.join(tree, dep)).isDirectory();
    } catch {
      return true;
    }
  });
}

/**
 * The tracked paths one commit holds under `paths`, or `undefined` when git would not answer.
 *
 * Both base reads the roster makes are this one question — which paths does `baseSha` track — asked of
 * the commit and never of the disk, because a run that adds or deletes files would otherwise choose the
 * tree that judges it. A rejection is `undefined`, never an empty list: a directory that does not exist
 * at the base answers exit 0 with nothing, and that IS an empty listing, while a bad sha or a broken
 * object store REJECTS and is not "the base had none".
 */
async function trackedPathsAt(
  exec: VerifyExec,
  repoRoot: string,
  sha: string,
  paths: readonly string[],
): Promise<string[] | undefined> {
  const ran = await exec("git", {
    argv: [
      ...NO_HOOKS,
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "--end-of-options",
      sha,
      "--",
      ...paths,
    ],
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: verifyHostEnv(),
  }).catch(() => undefined);
  if (ran === undefined) return undefined;
  return (ran.stdout ?? "")
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * What {@link listProjectTestFilesAtBase} answers: the listing, or why git would not give it.
 *
 * `files` is never truncated here — the record's cap is `verify-roster.ts`'s to apply, and the
 * caller's edited-file detection must still see a file that would sort past it.
 */
export interface BaseTestListing {
  /** EVERY matching file at ANY depth under `testDir`, repo-relative, in git's tree order. */
  files: string[];
  /** How many matched — `files.length`, carried so a capped record can still state the truth. */
  fileCount: number;
}

/**
 * The project's PRE-EXISTING test files at the run's base commit, at ANY depth under `testDir`.
 *
 * `git ls-tree -r` of `verify.testDir` AT `baseSha`, kept where the BASENAME matches
 * `verify.testGlob`. Listing at the commit rather than the disk is the rule every base read in a run
 * follows: a run that adds or deletes test files would otherwise choose the suite that judges it.
 *
 * The recursion is the fix for a project whose graded tests sit in nested packages
 * (`tests/unit/`, `tests/integration/deep/`): a listing that kept only what sat directly inside
 * `testDir` called such a base EMPTY and handed the run back for having no tests. Matching stays on
 * the basename, so recursion widens which directories are searched and never what counts as a test,
 * and no size of suite is refused — a repo past the record's cap is one this gate CAN judge. It is
 * THIS enumeration's boundary alone: `testLocationProblem`, which judges where the run's SUBMITTED
 * acceptance test may live, stays flat (the project's CI collects the folder's direct entries while its
 * own suite reaches everything under it).
 *
 * A failed listing is NOT "no tests". A directory that does not exist at the base answers exit
 * 0 with empty stdout; a bad sha or a broken object store REJECTS, and a rejection is `none`.
 */
export async function listProjectTestFilesAtBase(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  testDir: string,
  testGlob: string,
): Promise<BaseTestListing | { reason: string }> {
  if (!isFullCommitSha(baseSha))
    return {
      reason: `the roster could not list ${testDir}/: "${baseSha}" is not a full commit sha`,
    };
  const listed = await trackedPathsAt(exec, repoRoot, baseSha, [testDir]);
  if (listed === undefined)
    return {
      reason: `could not list the project's test files at ${baseSha.slice(0, 12)}`,
    };
  // The separator is in the prefix, so a sibling named `tests_backup/` is not read as inside `tests`.
  const prefix = `${testDir}/`;
  const files: string[] = [];
  for (const entry of listed) {
    if (!entry.startsWith(prefix)) continue;
    const base = entry.slice(prefix.length).split("/").pop() ?? "";
    if (!globMatches(testGlob, base)) continue;
    files.push(entry);
  }
  return { files, fileCount: files.length };
}
