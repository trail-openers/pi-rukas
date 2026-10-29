/**
 * lean/specify-reset — the RESET of CAPTURE / RESET / REWRITE, and the
 * verification of the COMMIT that follows it.
 *
 * Both halves exist because the step's claims are git claims, and a git claim
 * nobody checked is a claim. The old shape restored each undeclared path from
 * `HEAD`, which is whatever the child's own `git commit` had made HEAD: a child
 * that committed its test plus a stray source edit turned the revert into a
 * silent no-op that still reported ok, because the stray edit was in the
 * commit the revert restored from. This module does not consult HEAD at all —
 * it names the base sha, discards everything else, and then proves the tree
 * actually got there.
 *
 * `clean -fdx` (not `-fd`) is deliberate: `-x` also removes ignored files, and
 * a child that wrote a `.gitignore` hiding a stray file would otherwise keep
 * that file through the reset, outside what `git status` reports. The
 * provisioned dependency links survive because each one is passed as its own
 * `-e` exemption (see `cleanArgv`), which is what keeps a Node/bun project's
 * runner executable in the tree afterwards.
 *
 * `commitTestFiles` takes the pathspec on the COMMIT as well as the add, and
 * afterwards asserts four things about the result: HEAD moved, HEAD's tree
 * differs from the base by exactly the committed paths, nothing was skipped by
 * a pre-commit hook, and the tree is clean. A mismatch throws rather than
 * handing the rest of the run a commit nobody verified.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { changedPaths } from "./specify-tree.ts";

/** A reset the step cannot confirm. The engine turns this into handed-back 10. */
export class SpecifyResetError extends Error {
  override readonly name = "SpecifyResetError";
}

/** A commit the step cannot verify. Same treatment. */
export class SpecifyCommitError extends Error {
  override readonly name = "SpecifyCommitError";
}

/**
 * `git clean -fdx` with one `-e <p>` per provisioned path.
 *
 * The exemptions go BEFORE the directories so a reader (and a future argv
 * refactor) cannot drop them by accident. `linked` entries are repository-
 * relative (provisioning reports `node_modules` and `extension/node_modules`),
 * and git's exclude-pattern semantics match a pattern without a slash at any
 * depth — so one exemption covers both shapes.
 */
export function cleanArgv(linked: readonly string[]): string[] {
  const argv = ["clean", "-fdx"];
  for (const p of linked) argv.push("-e", p);
  return argv;
}

/**
 * Reset `wt` completely to `baseSha`: child commits, staged changes, untracked
 * files and ignore tricks all go, and the run's branch is pointed at the base.
 *
 * Throws `SpecifyResetError` unless `git rev-parse HEAD` equals `baseSha` and
 * `git status --porcelain` reports nothing. That confirmation is the function:
 * the commands are routine, and the only failure mode that matters is the one
 * where they did not do what they say.
 */
export async function resetWorktreeToBase(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  branch: string,
  linked: readonly string[],
): Promise<void> {
  // `-B` first so the branch — not a detached HEAD — is what `reset --hard`
  // moves: the frozen commit has to land on the run's branch, and a leftover
  // branch from a previous attempt of the same run must move to the base
  // rather than keep its commits.
  const steps: string[][] = [
    ["checkout", "-B", branch, baseSha],
    ["reset", "--hard", baseSha],
    cleanArgv(linked),
  ];
  for (const argv of steps) {
    try {
      await exec("git", { argv, cwd: wt, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      throw new SpecifyResetError(
        `git ${argv.join(" ")} failed in ${wt}: ${(err as Error).message}`,
      );
    }
  }
  const head = await exec("git", {
    argv: ["rev-parse", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha !== baseSha)
    throw new SpecifyResetError(
      `worktree ${wt} is at ${headSha === "" ? "an unreadable commit" : headSha}, not the base ${baseSha}`,
    );
  const dirty = await changedPaths(exec, wt);
  if (dirty.length > 0)
    throw new SpecifyResetError(
      `worktree ${wt} is not clean at the base: ${dirty
        .slice(0, 8)
        .map((e) => `${e.status} ${e.path}`)
        .join(", ")}${dirty.length > 8 ? ` (+${dirty.length - 8} more)` : ""}`,
    );
}

/** Write captured bytes back to their paths, creating parent directories. */
export function writeCaptured(wt: string, captured: Map<string, Buffer>): void {
  for (const [rel, bytes] of captured) {
    const abs = path.join(wt, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    // Plain write of the captured bytes: no link, no rename, nothing that
    // could carry an outside file's identity into the tree.
    writeFileSync(abs, bytes);
  }
}

/**
 * Commit exactly `paths` on top of `baseSha`, and prove the commit is what it
 * claims to be. Throws `SpecifyCommitError` on any mismatch.
 *
 * The pathspec rides on the COMMIT and not only the add: without it the commit
 * takes whatever the index holds, and the index also holds anything a child
 * staged for itself. `git add` is bounded to the kept paths too, so the index
 * cannot be loaded with anything else in the first place.
 */
export async function commitTestFiles(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  paths: string[],
  message: string,
): Promise<void> {
  if (paths.length === 0) throw new SpecifyCommitError("no test files to commit");
  const run = async (argv: string[]): Promise<void> => {
    try {
      await exec("git", { argv, cwd: wt, timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      throw new SpecifyCommitError(
        `git ${argv.join(" ")} failed in ${wt}: ${(err as Error).message}`,
      );
    }
  };
  await run(["add", "--", ...paths]);
  await run(["commit", "-m", message, "--", ...paths]);

  const head = await exec("git", {
    argv: ["rev-parse", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha === "" || headSha === baseSha)
    throw new SpecifyCommitError(
      `HEAD did not move from the base ${baseSha} — the acceptance-test commit was never made`,
    );
  const diff = await exec("git", {
    argv: ["diff", "--name-only", baseSha, headSha],
    cwd: wt,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => undefined);
  if (diff === undefined)
    throw new SpecifyCommitError(`could not read the commit's diff against ${baseSha}`);
  const changed = (diff.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const expected = [...paths].sort();
  if (JSON.stringify(changed.slice().sort()) !== JSON.stringify(expected))
    throw new SpecifyCommitError(
      `the acceptance-test commit contains ${JSON.stringify(changed)}, expected exactly ${JSON.stringify(expected)}`,
    );
  const left = await changedPaths(exec, wt);
  if (left.length > 0)
    throw new SpecifyCommitError(
      `the worktree is not clean after the acceptance-test commit: ${left
        .slice(0, 8)
        .map((e) => `${e.status} ${e.path}`)
        .join(", ")}`,
    );
}

/**
 * `git show HEAD:<path>` — the committed bytes, which are what the freeze
 * hashes. Hashing the blob rather than the file on disk is what makes the
 * recorded hash a fact about the commit rather than a race with whatever the
 * tree looked like a moment earlier.
 */
export async function committedBlob(exec: ExecFn, wt: string, rel: string): Promise<Buffer> {
  const r = await exec("git", {
    argv: ["show", `HEAD:${rel}`],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => undefined);
  if (r === undefined) throw new SpecifyCommitError(`could not read the committed blob ${rel}`);
  return Buffer.from(r.stdout ?? "", "utf8");
}
