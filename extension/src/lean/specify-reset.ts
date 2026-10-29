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
 * that file through the reset, outside what `git status` reports. There is no
 * exemption list: the provisioned dependency links are removed with everything
 * else and `provisionWorktree` builds them again, so the tree after a reset is
 * built by one code path rather than by whatever survived the last one.
 *
 * `commitTestFiles` takes the pathspec on the COMMIT as well as the add, and
 * afterwards asserts four things about the result: HEAD moved, HEAD's tree
 * differs from the base by exactly the committed paths, nothing was skipped by
 * a pre-commit hook, and the tree is clean. A mismatch throws rather than
 * handing the rest of the run a commit nobody verified.
 *
 * `writeCaptured` follows no link either way: every ancestor of a target must
 * be a real directory (never a symlink the child left behind, which would
 * carry a test's bytes outside the worktree), and each file lands through a
 * `wx` temp write plus a rename, so an existing name is never written through.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errorText, gitCatFileSaysAbsent } from "../git-range.ts";
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
 * The git flags every lean step's git calls carry. The hooks a repository has
 * are somebody else's policy, and a repo-supplied fsmonitor is a program git
 * runs on every status: either could write into a commit the step never
 * captured. The only git in this family without it is a read the step does
 * not need to trust.
 */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

/** Counter for temp names, so two files of one capture never share one. */
let writeSeq = 0;

/**
 * Why writing `abs` would follow a link, or undefined when it would not.
 *
 * Every EXISTING ancestor from `wt` down to `abs`'s parent is `lstat`'d: a
 * directory is fine, anything else is refused. A symlinked directory anywhere
 * on that path turns "write the test back into the worktree" into "write it
 * wherever the link points", and the clean-tree assertion afterwards would
 * still pass — the outside file is not in `git status`.
 */
function ancestorProblem(wt: string, abs: string): string | undefined {
  // The chain is the ancestors BELOW `wt`, innermost last: `wt` itself is the
  // boundary the step owns and is not inspected.
  const chain: string[] = [];
  for (let dir = path.dirname(abs); dir !== wt && dir !== path.dirname(dir); ) {
    chain.unshift(dir);
    dir = path.dirname(dir);
  }
  for (const d of chain) {
    if (existsSync(d)) {
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(d);
      } catch (err) {
        return `ancestor ${d} could not be read: ${(err as Error).message}`;
      }
      if (st.isSymbolicLink()) return `ancestor ${d} is a symlink`;
      if (!st.isDirectory()) return `ancestor ${d} is not a directory`;
    }
  }
  return undefined;
}

/**
 * Create the missing ancestors of `abs`, ONE LEVEL AT A TIME, `lstat`ing each
 * new directory to prove it is a directory and not a link.
 *
 * `mkdirSync(recursive: true)` is not used because it creates every component
 * in one call and reports nothing about them: a component that already existed
 * as a symlink would be accepted silently. Stepping down means every name the
 * write depends on is looked at after it exists.
 */
function ensureRealDirs(wt: string, abs: string): void {
  const segments = path.relative(wt, abs).split(path.sep).slice(0, -1);
  let dir = wt;
  for (const seg of segments) {
    dir = path.join(dir, seg);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir);
      } catch (err) {
        throw new SpecifyInfraError(`could not create ${dir}: ${(err as Error).message}`);
      }
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new SpecifyInfraError(`created ancestor ${dir} is a symlink`);
    if (!st.isDirectory())
      throw new SpecifyInfraError(`created ancestor ${dir} is not a directory`);
  }
}

/** A write the step refuses because following it would leave the worktree. */
export class SpecifyInfraError extends Error {
  override readonly name = "SpecifyInfraError";
}

/**
 * Write captured bytes back to their paths, creating parent directories.
 *
 * Three rules, each one against a way the rewrite could land somewhere other
 * than the path it names: no symlinked ancestor (`ancestorProblem` before the
 * write, `ensureRealDirs` after each creation), and a `wx` write to a temp
 * name in the FINAL directory followed by a `renameSync` into place — so a
 * path the child left as a link or a device is never opened for writing, and
 * the bytes appear at their name atomically.
 */
export function writeCaptured(wt: string, captured: Map<string, Buffer>): void {
  for (const [rel, bytes] of captured) {
    const abs = path.join(wt, rel);
    const problem = ancestorProblem(wt, abs);
    if (problem !== undefined) throw new SpecifyInfraError(`could not write ${rel}: ${problem}`);
    ensureRealDirs(wt, abs);
    const dir = path.dirname(abs);
    // `wx` — fail if the name exists. A name that is already there means the
    // tree is not the tree the reset made, and the caller resets again rather
    // than writing through it.
    let tmp = `${dir}/.lean-capture-${process.pid}-${writeSeq++}`;
    for (let n = 0; ; n++) {
      try {
        writeFileSync(tmp, bytes, { flag: "wx" });
        break;
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code !== "EEXIST" || n > 8)
          throw new SpecifyInfraError(`could not write ${rel}: ${(err as Error).message}`);
        tmp = `${dir}/.lean-capture-${process.pid}-${writeSeq}-${n}`;
      }
    }
    try {
      renameSync(tmp, abs);
    } catch (err) {
      try {
        // Never leave the temp file behind for the clean-tree assertion to
        // trip on — and a renamed-aside copy is still residue, so delete it.
        rmSync(tmp, { force: true });
      } catch {
        /* nothing else to do */
      }
      throw new SpecifyInfraError(`could not place ${rel}: ${(err as Error).message}`);
    }
  }
}

/**
 * Reset `wt` completely to `baseSha`: child commits, staged changes, untracked
 * files, ignore tricks AND the provisioned dependency links all go, and the
 * run's branch is pointed at the base.
 *
 * The clean carries no `-e` exemptions. Exempting the links by name meant a
 * leftover tree kept whatever links its first provisioning made, with nothing
 * checking they still pointed anywhere; now the tree is emptied and
 * `ensureSpecifyWorktreeWithProvision` re-provisions it, so a link is always
 * the one provisioning built at this reset. The clean-tree assertion runs
 * BEFORE that re-provisioning, while the tree genuinely holds nothing but the
 * base checkout.
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
): Promise<void> {
  // `-B` first so the branch — not a detached HEAD — is what `reset --hard`
  // moves: the frozen commit has to land on the run's branch, and a leftover
  // branch from a previous attempt of the same run must move to the base
  // rather than keep its commits.
  const steps: string[][] = [
    [...NO_HOOKS, "checkout", "-B", branch, baseSha],
    [...NO_HOOKS, "reset", "--hard", baseSha],
    [...NO_HOOKS, "clean", "-fdx"],
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
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
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

/**
 * Is `rel` a file in the tree of `ref`? Asked of git, not of the working tree.
 *
 * The boundary in `validateSubmitRows` needs this to refuse a submitted test
 * that the run's base ALREADY has — a tracked test the child never wrote is not
 * a new acceptance test, whatever it declares about it — and `git cat-file -e
 * <ref>:<rel>` is the only read that answers it, because a working-tree check
 * cannot tell "the child wrote this" from "it was checked out at me".
 *
 * Two answers, and the difference between them is everything:
 *
 *   - git ran and said the path is not in that commit
 *     (`fatal: path '…' does not exist in '…'`) → **false**: the file is new;
 *   - anything else — the clone is unreadable, the ref did not resolve, the
 *     probe was killed or timed out, its output blew its buffer → **throw**.
 *
 * The throw arm is the one that matters. Reading every failure as "not there"
 * would make a broken repository certify that every submitted test is new, and
 * the newness rule would pass the exact shape it exists to refuse while
 * reporting the loudest possible confidence. It is the same rule every other
 * git read in this module applies: absence is a fact git has to state.
 *
 * `--end-of-options` closes the ref so a path the child spelled cannot be read
 * as a flag, and `--literal-pathspecs` (a top-level option, as `commitTestFiles`
 * passes it) makes `tests/[a]x.test.sh` one file rather than a glob.
 */
export async function existsInCommit(
  exec: ExecFn,
  cwd: string,
  ref: string,
  rel: string,
): Promise<boolean> {
  try {
    await exec("git", {
      argv: [
        ...NO_HOOKS,
        "--literal-pathspecs",
        "cat-file",
        "-e",
        "--end-of-options",
        `${ref}:${rel}`,
      ],
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (err) {
    if (gitCatFileSaysAbsent(err)) return false;
    if (existsInCommitProblem(err) === undefined) return false;
    throw new SpecifyResetError(
      `could not read the base commit ${ref} to check whether ${rel} is new: ${existsInCommitProblem(err)}`,
    );
  }
}

/**
 * The one wording `gitCatFileSaysAbsent` does not cover, and must not.
 *
 * `git cat-file -e <base>:<rel>` for a file that sits in the WORKING TREE but
 * not in `<base>` answers `fatal: path '…' exists on disk, but not in '<base>'`
 * — and that wording carries no "does not exist", so the shared tree-probe rule
 * reads it as a store fault. For the other caller of that rule (`lens-evidence.ts`,
 * which asks whether a branch HOLDS a prose file) a fault is the safe answer:
 * an ungrounded claim is merely unhelpful. Here a fault is the UNSAFE one: an
 * unclassified failure would throw on the one shape the rule exists to catch —
 * the child wrote the file into its own tree, which is exactly what a file that
 * "exists on disk, but not in the base" IS.
 *
 * So this wording is recognised HERE, at the caller that can say what it means,
 * and deliberately not pushed into the shared rule, where it would widen
 * `lens-evidence`'s absence set for a reason that has nothing to do with it.
 */
function pathExistsOnDiskOnly(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown } | null;
  if (e?.code !== 1 && e?.code !== 128) return false;
  return typeof e.stderr === "string" && /exists on disk, but not in/i.test(e.stderr);
}

/** The cause to report, or undefined when git answered the question either way. */
function existsInCommitProblem(err: unknown): string | undefined {
  if (pathExistsOnDiskOnly(err)) return undefined;
  if (gitCatFileSaysAbsent(err)) return undefined;
  return errorText(err);
}

/**
 * Commit exactly `paths` on top of `baseSha`, and prove the commit is what it
 * claims to be. Throws `SpecifyCommitError` on any mismatch.
 *
 * The pathspec rides on the COMMIT and not only the add: without it the commit
 * takes whatever the index holds, and the index also holds anything a child
 * staged for itself. `git add` is bounded to the kept paths too, so the index
 * cannot be loaded with anything else in the first place.
 *
 * Both git calls run with `core.hooksPath=/dev/null` and `core.fsmonitor=false`:
 * the hooks a repository carries are somebody else's policy, and a pre-commit
 * hook that rewrites the index would put bytes in the frozen commit the step
 * never captured. With hooks off, the commit holds exactly what was added.
 *
 * `--literal-pathspecs` is a TOP-LEVEL git option and rides on all three calls
 * that name paths — the add, the commit and the verification diff — the same
 * way `build-normalise.ts` puts it ahead of the subcommand. It is load-bearing
 * for the diff as much as the writes: a submitted test named `tests/[a]x.test.sh`
 * is one file to this step, but a glob to git, and without the flag the add and
 * the commit could sweep in a tracked `tests/ax.test.sh` while the un-literal
 * diff still reported the pair as "exactly the paths we meant".
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
  const LITERAL = "--literal-pathspecs";
  await run([LITERAL, ...NO_HOOKS, "add", "--", ...paths]);
  await run([LITERAL, ...NO_HOOKS, "commit", "-m", message, "--", ...paths]);

  const head = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha === "" || headSha === baseSha)
    throw new SpecifyCommitError(
      `HEAD did not move from the base ${baseSha} — the acceptance-test commit was never made`,
    );
  // `-z` gives the raw paths NUL-separated: without it git C-quotes any name
  // with non-ASCII bytes, and a test named `AC1-café` would never equal itself.
  // `core.quotePath=off` is set too, so the quoting rule cannot return if `-z`
  // is ever dropped from this call.
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
    throw new SpecifyCommitError(`could not read the commit's diff against ${baseSha}`);
  const changed = (diff.stdout ?? "").split("\0").filter((p) => p !== "");
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
  // `latin1` keeps every byte (see ExecOpts.stdoutEncoding): the hash is over the
  // committed bytes, and a utf8 round trip would change any invalid sequence.
  const r = await exec("git", {
    argv: ["show", `HEAD:${rel}`],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdoutEncoding: "latin1",
  }).catch(() => undefined);
  if (r === undefined) throw new SpecifyCommitError(`could not read the committed blob ${rel}`);
  const bytes = Buffer.from(r.stdout ?? "", "latin1");
  // An empty blob is not a test. `git show` of a path that is not in the tree
  // fails rather than returning "", so an empty read here means the commit
  // holds an empty file — and a hash of nothing would let a zero-byte file
  // pass as a frozen test for the rest of the run.
  if (bytes.length === 0)
    throw new SpecifyCommitError(`the committed blob ${rel} is empty — not a test`);
  return bytes;
}
