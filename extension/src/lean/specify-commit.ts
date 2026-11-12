/**
 * lean/specify-commit — the COMMIT half of specify's freeze, and the blob it hashes.
 *
 * Split from `specify-reset.ts` (AGENTS §12): the reset and its submodule
 * re-initialisation are one concern — discard, then prove the tree got there — and the
 * frozen commit is another: add, commit, and prove the commit is what it claims. The
 * seam is the commit itself, and `changedPaths` is the shared primitive both halves
 * prove against.
 *
 * `commitTestFiles` takes the pathspec on the COMMIT as well as the add, and
 * afterwards asserts four things: HEAD moved, HEAD's tree differs from the base by
 * exactly the committed paths, nothing was skipped by a hook, and the tree is clean.
 * A mismatch throws rather than handing the run a commit nobody verified — which is
 * what makes the reset's clean-tree claim mean anything downstream.
 *
 * `committedBlob` hashes the COMMITTED bytes rather than the file on disk, so the
 * recorded hash is a fact about the commit and not a race with whatever the tree
 * looked like a moment earlier.
 */

import type { ExecFn } from "../worktree.ts";
import {
  SpecifyCommitError as CommitError,
  NO_HOOKS,
  type SpecifyCommitError,
} from "./specify-reset.ts";
import { changedPaths } from "./specify-tree.ts";

/** The wall clock on a short local read (`rev-parse`). */
const QUICK_GIT_MS = 30_000;

/**
 * Commit exactly `paths` on top of `baseSha`, and prove the commit is what it
 * claims to be. Throws `SpecifyCommitError` on any mismatch.
 *
 * The pathspec rides on the COMMIT and not only the add: without it the commit
 * takes whatever the index holds, and the index also holds anything a child
 * staged for itself. `git add` is bounded to the kept paths too, so the index
 * cannot be loaded with anything else in the first place.
 *
 * Both git calls run with `core.hooksPath=/dev/null` and `core.fsmonitor=false`: the
 * hooks a repository carries are somebody else's policy, and a pre-commit hook that
 * rewrites the index would put bytes in the frozen commit the step never captured.
 *
 * `--literal-pathspecs` is a TOP-LEVEL git option and rides on all three calls that
 * name paths, the same way `build-normalise.ts` puts it ahead of the subcommand. It
 * is load-bearing for the diff as much as the writes: a submitted test named
 * `tests/[a]x.test.sh` is one file to this step but a glob to git, and without the
 * flag the add and commit could sweep in a tracked `tests/ax.test.sh` while the
 * un-literal diff still reported the pair as "exactly the paths we meant".
 */
export async function commitTestFiles(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  paths: string[],
  message: string,
): Promise<void> {
  if (paths.length === 0) throw new CommitError("no test files to commit");
  const run = async (argv: string[]): Promise<void> => {
    try {
      await exec("git", { argv, cwd: wt, timeout: 60_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      throw new CommitError(`git ${argv.join(" ")} failed in ${wt}: ${(err as Error).message}`);
    }
  };
  const LITERAL = "--literal-pathspecs";
  await run([LITERAL, ...NO_HOOKS, "add", "--", ...paths]);
  await run([LITERAL, ...NO_HOOKS, "commit", "-m", message, "--", ...paths]);

  const head = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha === "" || headSha === baseSha)
    throw new CommitError(
      `HEAD did not move from the base ${baseSha} — the acceptance-test commit was never made`,
    );
  // `-z` gives the raw paths NUL-separated: without it git C-quotes any name with
  // non-ASCII bytes and a test named `AC1-café` would never equal itself. `core.
  // quotePath=off` is set too, so the quoting rule cannot return if `-z` is dropped.
  const diff = await exec("git", {
    argv: [
      LITERAL,
      ...NO_HOOKS,
      "-c",
      "core.quotePath=off",
      "diff",
      "--name-only",
      "-z",
      baseSha,
      headSha,
    ],
    cwd: wt,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => undefined);
  if (diff === undefined)
    throw new CommitError(`could not read the commit's diff against ${baseSha}`);
  const changed = (diff.stdout ?? "").split("\0").filter((p) => p !== "");
  const expected = [...paths].sort();
  if (JSON.stringify(changed.slice().sort()) !== JSON.stringify(expected))
    throw new CommitError(
      `the acceptance-test commit contains ${JSON.stringify(changed)}, expected exactly ${JSON.stringify(expected)}`,
    );
  const left = await changedPaths(exec, wt);
  if (left.length > 0)
    throw new CommitError(
      `the worktree is not clean after the acceptance-test commit: ${left
        .slice(0, 8)
        .map((e) => `${e.status} ${e.path}`)
        .join(", ")}`,
    );
}

/**
 * `git show HEAD:<path>` — the committed bytes, which are what the freeze hashes.
 * Hashing the blob rather than the file on disk is what makes the recorded hash a
 * fact about the commit rather than a race with whatever the tree looked like a
 * moment earlier.
 */
export async function committedBlob(exec: ExecFn, wt: string, rel: string): Promise<Buffer> {
  // `latin1` keeps every byte (see ExecOpts.stdoutEncoding): the hash is over the
  // committed bytes, and a utf8 round trip would change any invalid sequence.
  const r = await exec("git", {
    argv: ["show", `HEAD:${rel}`],
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdoutEncoding: "latin1",
  }).catch(() => undefined);
  if (r === undefined) throw new CommitError(`could not read the committed blob ${rel}`);
  const bytes = Buffer.from(r.stdout ?? "", "latin1");
  // An empty blob is not a test. `git show` of a path not in the tree fails rather
  // than returning "", so an empty read here means the commit holds an empty file —
  // and a hash of nothing would let a zero-byte file pass as a frozen test.
  if (bytes.length === 0) throw new CommitError(`the committed blob ${rel} is empty — not a test`);
  return bytes;
}
