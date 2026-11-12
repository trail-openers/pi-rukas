#!/usr/bin/env bun
/**
 * lean commit — freezing the submitted tests into a commit, and reading a blob back.
 *
 * Split from `specify-reset.ts` for the 500-line gate (AGENTS §12): the reset and its
 * submodule re-initialisation are one concern, the frozen commit is another, and the
 * seam is the commit itself — everything above it discards, everything below records.
 *
 *   (a) `commitTestFiles` refuses an empty path list rather than making an empty
 *       commit, and the commit it does make contains exactly the named paths — the
 *       check the reset's clean-tree proof depends on;
 *   (b) `committedBlob` is the committed bytes and not the file on disk: a working
 *       edit does not change the hash, and an empty blob is refused rather than
 *       hashed, because a hash of nothing would let a zero-byte file pass as a frozen
 *       test.
 *
 * Real temp repo, real git, the real `execp`; nothing stubbed.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { ExecFn } from "../src/worktree.ts";
import { commitTestFiles, committedBlob } from "../src/lean/specify-commit.ts";
import { SpecifyCommitError } from "../src/lean/specify-reset.ts";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const gitEnv = (): Record<string, string> => ({
  ...gitTestEnv(),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});

const exec = ((cmd: string, o?: Record<string, unknown>) =>
  execp(cmd, {
    ...(o ?? {}),
    env: { ...gitEnv(), ...((o?.env as Record<string, string> | undefined) ?? {}) },
  })) as unknown as ExecFn;

const git = (dir: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
};

const put = (dir: string, rel: string, text: string, mode?: number): void => {
  const target = path.join(dir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text, mode === undefined ? undefined : { mode });
};

/**
 * A repo at one base commit with ONE uncommitted test — the state the freeze takes
 * when the child submitted exactly that file. A second untracked file would be the
 * step's own drop failure, which `commitTestFiles` refuses on purpose (case (a2)).
 */
function repoWithTests(): { root: string; base: string } {
  const root = trackedTempDir("commit-tests-");
  git(root, "init", "-q", "-b", "main");
  put(root, "src/retry.ts", "export const retry = () => {};\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  put(root, "tests/AC1-retry.test.sh", "#!/bin/sh\necho AC1\nexit 1\n", 0o755);
  return { root, base };
}

// ── (a) the freeze makes exactly one commit, over exactly the paths it was given
{
  const { root, base } = repoWithTests();
  let emptyThrew: Error | undefined;
  try {
    await commitTestFiles(exec, root, base, [], "test: acceptance tests");
  } catch (err) {
    emptyThrew = err as Error;
  }
  assert(
    emptyThrew instanceof SpecifyCommitError && /no test files/.test(emptyThrew.message),
    `(a) an empty path list is refused rather than committed (${emptyThrew?.message ?? "no throw"})`,
  );
  assert(
    git(root, "rev-parse", "HEAD") === base,
    "(a) and refusing moved no branch at all",
  );

  await commitTestFiles(exec, root, base, ["tests/AC1-retry.test.sh"], "test: acceptance tests");
  const head = git(root, "rev-parse", "HEAD");
  assert(head !== base, "(a) the freeze made its commit on the base");
  assert(
    git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", head) ===
      "tests/AC1-retry.test.sh",
    `(a) and the commit contains exactly the named path (got ${git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", head)})`,
  );
  assert(
    git(root, "rev-list", "--count", `${base}..${head}`) === "1",
    "(a) and it made ONE commit, which is what the step's contract claims",
  );
  assert(
    git(root, "ls-tree", "HEAD", "tests/AC1-retry.test.sh").startsWith("100755"),
    `(a) and the executable bit survived (got ${git(root, "ls-tree", "HEAD", "tests/AC1-retry.test.sh")})`,
  );
}

// ── (a2) a file the step did not name is a failure, not a leftover
{
  // The freeze's own proof of the thing the reset's clean-tree assertion depends on:
  // after it, the tree holds nothing but what the commit recorded. An untracked file
  // left behind would be frozen work that never entered the commit — a test the run
  // believes it has and does not.
  const { root, base } = repoWithTests();
  put(root, "tests/AC2-backoff.test.sh", "#!/bin/sh\necho AC2\nexit 1\n", 0o755);
  let strayThrew: Error | undefined;
  try {
    await commitTestFiles(exec, root, base, ["tests/AC1-retry.test.sh"], "test: acceptance tests");
  } catch (err) {
    strayThrew = err as Error;
  }
  assert(
    strayThrew instanceof SpecifyCommitError && /not clean after the acceptance-test commit/.test(strayThrew.message),
    `(a2) an untracked test the step did not name is refused, not left behind (${strayThrew?.message ?? "no throw"})`,
  );
}

// ── (b) the blob the freeze hashes is the committed one, and an empty one is refused
{
  const { root, base } = repoWithTests();
  await commitTestFiles(exec, root, base, ["tests/AC1-retry.test.sh"], "test: acceptance tests");
  const committed = await committedBlob(exec, root, "tests/AC1-retry.test.sh");
  assert(
    committed.toString("utf8") === "#!/bin/sh\necho AC1\nexit 1\n",
    `(b) the blob read back is what was committed (got ${JSON.stringify(committed.toString("utf8"))})`,
  );
  // The race the hash exists to close: the file on disk changes, the recorded hash
  // must not.
  put(root, "tests/AC1-retry.test.sh", "#!/bin/sh\nexit 0\n");
  const after = await committedBlob(exec, root, "tests/AC1-retry.test.sh");
  assert(
    Buffer.compare(committed, after) === 0,
    "(b) and a working-tree edit after the commit does not move the hash",
  );

  put(root, "tests/empty.test.sh", "");
  git(root, "add", "-A", "tests/empty.test.sh");
  git(root, "commit", "-q", "--amend", "-m", "test: acceptance tests, plus an empty file");
  let blankThrew: Error | undefined;
  try {
    await committedBlob(exec, root, "tests/empty.test.sh");
  } catch (err) {
    blankThrew = err as Error;
  }
  assert(
    blankThrew instanceof SpecifyCommitError && /empty/.test(blankThrew.message),
    `(b) a zero-byte committed file is refused, not hashed (${blankThrew?.message ?? "no throw"})`,
  );

  let missingThrew: Error | undefined;
  try {
    await committedBlob(exec, root, "tests/never-written.test.sh");
  } catch (err) {
    missingThrew = err as Error;
  }
  assert(
    missingThrew instanceof SpecifyCommitError && /could not read/.test(missingThrew.message),
    `(b) and a path not in the commit is named rather than hashed as nothing (${missingThrew?.message ?? "no throw"})`,
  );
}

process.exit(exit);
