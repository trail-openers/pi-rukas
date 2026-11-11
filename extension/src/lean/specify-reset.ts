/**
 * lean/specify-reset — the RESET of CAPTURE / RESET / REWRITE, the submodule
 * re-initialisation that reset makes necessary, and the verification of the
 * COMMIT that follows it.
 *
 * Both halves exist because the step's claims are git claims, and a git claim
 * nobody checked is a claim. Restoring each undeclared path from `HEAD` was the
 * defect this closes: a child that committed its test plus a stray source edit
 * turned the revert into a silent no-op, because the stray edit was in the commit
 * the revert restored from. This module does not consult HEAD at all — it names the
 * base sha, discards everything else, and then proves the tree actually got there.
 *
 * `clean -fdx` (not `-fd`) is deliberate: `-x` also removes ignored files, and a
 * child that wrote a `.gitignore` hiding a stray file would otherwise keep that file
 * through the reset, outside what `git status` reports. There is no exemption list:
 * the provisioned dependency links go with everything else and are rebuilt, so the
 * tree after a reset is built by one code path.
 *
 * `commitTestFiles` takes the pathspec on the COMMIT as well as the add, and
 * afterwards asserts four things: HEAD moved, HEAD's tree differs from the base by
 * exactly the committed paths, nothing was skipped by a hook, and the tree is clean.
 * A mismatch throws rather than handing the run a commit nobody verified.
 *
 * `writeCaptured` follows no link either way: every ancestor of a target must be a
 * real directory, and each file lands through a `wx` temp write plus a rename, so an
 * existing name is never written through.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecFn } from "../worktree.ts";
import { trim } from "./specify-proof.ts";
import { changedPaths } from "./specify-tree.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** A reset the step cannot confirm. The engine turns this into handed-back 10. */
export class SpecifyResetError extends Error {
  override readonly name = "SpecifyResetError";
}

/** A commit the step cannot verify. Same treatment. */
export class SpecifyCommitError extends Error {
  override readonly name = "SpecifyCommitError";
}

/**
 * The git flags every lean step's git calls carry. The hooks a repository has are
 * somebody else's policy, and a repo-supplied fsmonitor is a program git runs on
 * every status: either could write into a commit the step never captured.
 */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

/** The wall clock on a local git write (`checkout`, `reset`, `worktree add`). */
const LOCAL_GIT_MS = 120_000;
/** The wall clock on a short local read (`rev-parse`). */
const QUICK_GIT_MS = 30_000;
/** The largest git stdout a step will hold. */
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * One local git call as argv, or `undefined` when git refused rather than said no.
 *
 * The shared shape — the `NO_HOOKS` prefix, the 120s bound, the buffer cap, the
 * swallow-to-`undefined` — that every lean step except `build` wants; `build` keeps
 * its own because it needs a per-call timeout and a different cap.
 *
 * A refusal is `undefined` rather than a throw by design: callers decide what a
 * failed read means, and the review step's reads distinguish "git could not run"
 * from "git found nothing" through the outcome-returning resolver.
 */
export async function gitQuiet(
  exec: ExecFn,
  cwd: string,
  argv: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string } | undefined> {
  try {
    const r = await exec("git", {
      argv: [...NO_HOOKS, ...argv],
      cwd,
      timeout: opts.timeout ?? LOCAL_GIT_MS,
      maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER,
    });
    return { stdout: r.stdout ?? "" };
  } catch {
    return undefined;
  }
}

/** Counter for temp names, so two files of one capture never share one. */
let writeSeq = 0;

/**
 * Why writing `abs` would follow a link, or undefined when it would not.
 *
 * Every EXISTING ancestor from `wt` down to `abs`'s parent is `lstat`'d. A symlinked
 * directory anywhere on that path turns "write the test back into the worktree" into
 * "write it wherever the link points", and the clean-tree assertion afterwards would
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
 * Create the missing ancestors of `abs`, ONE LEVEL AT A TIME, `lstat`ing each new
 * directory to prove it is a directory and not a link.
 *
 * `mkdirSync(recursive: true)` is not used: it creates every component in one call
 * and reports nothing about them, so a component that already existed as a symlink
 * would be accepted silently.
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

/**
 * A write the step refuses because following it would leave the worktree.
 *
 * Also the type the `specify` dispatch throws for a child that died, and it
 * carries that dispatch's cost rows (`BuildInfraError` says why): the child
 * spent tokens before it died and a throw records no outcome.
 */
export class SpecifyInfraError extends Error {
  override readonly name = "SpecifyInfraError";

  /** The cost rows this failure already observed, when it knows them. */
  readonly dispatches?: DispatchUsageRow[];

  constructor(message: string, dispatches?: DispatchUsageRow[]) {
    super(message);
    if (dispatches !== undefined) this.dispatches = dispatches;
  }
}

/**
 * Write captured bytes back to their paths, creating parent directories.
 *
 * Three rules, each against a way the rewrite could land somewhere other than the
 * path it names: no symlinked ancestor (`ancestorProblem` before the write,
 * `ensureRealDirs` after each creation), and a `wx` write to a temp name in the FINAL
 * directory followed by `renameSync` into place — so a path the child left as a link
 * or a device is never opened for writing, and the bytes appear atomically.
 */
export function writeCaptured(wt: string, captured: Map<string, Buffer>): void {
  for (const [rel, bytes] of captured) {
    const abs = path.join(wt, rel);
    const problem = ancestorProblem(wt, abs);
    if (problem !== undefined) throw new SpecifyInfraError(`could not write ${rel}: ${problem}`);
    ensureRealDirs(wt, abs);
    const dir = path.dirname(abs);
    // `wx` — fail if the name exists. A name already there means the tree is not the
    // tree the reset made, and the caller resets again rather than writing through it.
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
        // Never leave the temp file behind for the clean-tree assertion to trip on.
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
 * files, ignore tricks AND the provisioned dependency links all go, and the run's
 * branch is pointed at the base. A caller whose tree owns no branch passes `""` for
 * `branch` and is checked out detached, since git refuses to `-B` a name onto a tree
 * whose branch somebody else holds.
 *
 * Both checkout forms carry `-f`. Without it git refuses to move a tree whose
 * tracked files are dirty — "Your local changes ... would be overwritten by
 * checkout", exit 1 — which is exactly what a build child leaves behind when it
 * committed a file and then kept editing it, so a routine budget stop would hand
 * the run back as a reset failure. Nothing here is worth protecting: the bytes a
 * caller keeps were read into memory before this ran, and the `reset --hard` and
 * `clean -fdx` below discard everything the forced checkout walked past anyway.
 *
 * The clean carries no `-e` exemptions. Exempting the links by name meant a leftover
 * tree kept whatever links its first provisioning made, with nothing checking they
 * still pointed anywhere; now the tree is emptied and re-provisioned, so a link is
 * always the one built at this reset. The clean-tree assertion runs AFTER the
 * submodule re-initialisation rather than before it, because the tree the reset
 * actually produces — the one every caller hands its child — is the populated one:
 * proof and product then describe the same bytes.
 *
 * `git clean -fdx` de-populates every submodule the base carries, and a test that
 * imports from one then fails before collection — so a runner that cannot collect is
 * blamed on the adversary. `initSubmodules` runs inside this function rather than in
 * one caller after it, because every reset has to restore them and the resets are
 * made in four places.
 *
 * Throws `SpecifyResetError` unless `rev-parse HEAD` equals `baseSha` and
 * `status --porcelain` reports nothing — that confirmation is the function: the
 * commands are routine, and the only failure that matters is the one where they did
 * not do what they say.
 */
export async function resetWorktreeToBase(
  exec: ExecFn,
  wt: string,
  baseSha: string,
  branch: string,
  /**
   * Called with the tree the clean left — a submodule the base carries present as a
   * gitlink, nothing fetched — before this function asks git to populate it. Product
   * code never supplies it; it is how a smoke test sabotages a submodule between the
   * clean and the command that has to recover it, which is the only way to watch git
   * fail that command rather than assert what it would have done.
   */
  beforeSubmoduleInit?: (wt: string) => void | Promise<void>,
): Promise<void> {
  // `-B` first so the branch — not a detached HEAD — is what `reset --hard` moves:
  // the frozen commit has to land on the run's branch, and a leftover branch from a
  // previous attempt must move to the base rather than keep its commits.
  const steps: string[][] = [
    branch === ""
      ? [...NO_HOOKS, "checkout", "-f", "--detach", baseSha]
      : [...NO_HOOKS, "checkout", "-f", "-B", branch, baseSha],
    [...NO_HOOKS, "reset", "--hard", baseSha],
    [...NO_HOOKS, "clean", "-fdx"],
  ];
  for (const argv of steps) {
    try {
      await exec("git", { argv, cwd: wt, timeout: LOCAL_GIT_MS, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      throw new SpecifyResetError(
        `git ${argv.join(" ")} failed in ${wt}: ${(err as Error).message}`,
      );
    }
  }
  await initSubmodules(exec, wt, beforeSubmoduleInit);
  const head = await exec("git", {
    argv: [...NO_HOOKS, "rev-parse", "HEAD"],
    cwd: wt,
    timeout: QUICK_GIT_MS,
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
 * Populate the worktree's submodules, when its commit has any.
 *
 * The question "does this base have submodules" is answered by the working tree and
 * by git rather than by a heuristic. `.gitmodules` absent means there are none, and
 * that is the normal case — it costs one `existsSync` and no spawn, so a
 * submodule-free repository pays nothing for this step. A tracked `.gitmodules` is
 * then asked what it lists: `git config --file .gitmodules --get-regexp path` exits
 * 1 on a file that lists nothing and non-zero-but-1 on a file it could not read, so
 * "could not tell" refuses the run instead of skipping the initialisation it was
 * asked for.
 *
 * `git submodule update --init --recursive` is bounded, because it may reach the
 * network — and a clone with no network, or a submodule whose remote is gone, is the
 * same infrastructure handback as a runner that cannot collect: nothing downstream
 * can judge the work without those files.
 */
async function initSubmodules(
  exec: ExecFn,
  wt: string,
  /** Passed through from {@link resetWorktreeToBase}; product code never supplies it. */
  beforeInit?: (wt: string) => void | Promise<void>,
): Promise<void> {
  if (!existsSync(path.join(wt, ".gitmodules"))) return;
  await beforeInit?.(wt);
  const listed = await exec("git", {
    argv: submoduleArgv("config", "--file", ".gitmodules", "--get-regexp", "path"),
    cwd: wt,
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (listed as { __err?: unknown })?.__err;
  if (err !== undefined) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && code <= 1) return;
    throw new SpecifyInfraError(
      `could not tell whether ${wt} has submodules: git config --file .gitmodules --get-regexp path exited ${String(code)}`,
    );
  }
  const ran = await exec("git", {
    argv: submoduleArgv("submodule", "update", "--init", "--recursive"),
    cwd: wt,
    timeout: SUBMODULE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).catch((err: unknown) => ({ __err: err }) as never);
  const failed = (ran as { __err?: unknown })?.__err;
  if (failed === undefined) return;
  const e = failed as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const out = [e.stdout, e.stderr, e.message]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  throw new SpecifyInfraError(
    `the worktree's submodules could not be initialised in ${wt}: git submodule update --init --recursive — ${trim(out)}`,
  );
}

/**
 * The submodule calls' own `-c` flags, added to {@link NO_HOOKS} at the call.
 *
 * There are none, and that is the point: the step asks git to populate submodules
 * with git's OWN transport policy. `protocol.file.allow` is `user` by default — the
 * CVE fix that made git refuse the `file` transport for submodules — and widening it
 * here would let a `file`-protocol URL in the base's `.gitmodules`, at any depth of
 * `--recursive`, clone an arbitrary repository that already exists on this host into
 * the worktree the run then tests and commits. A tracked `.gitmodules` is reviewed as
 * code, but a submodule's own `.gitmodules` is content of ANOTHER repository, fetched
 * from wherever the first one points — so "the URL is tracked content" does not hold
 * past the first level. A base whose submodule genuinely lives on a local path is
 * served by the operator's own `protocol.allow`/`protocol.file.allow` configuration,
 * which git reads as usual: the step adds no licence of its own. Hooks stay refused,
 * whatever the repository carries.
 */
function submoduleArgv(...argv: string[]): string[] {
  return [...NO_HOOKS, ...argv];
}

/** The wall clock on `git submodule update --init --recursive`, which may reach the network. */
const SUBMODULE_TIMEOUT_MS = 5 * 60_000;

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
    timeout: QUICK_GIT_MS,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
  const headSha = (head?.stdout ?? "").trim();
  if (headSha === "" || headSha === baseSha)
    throw new SpecifyCommitError(
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
  if (r === undefined) throw new SpecifyCommitError(`could not read the committed blob ${rel}`);
  const bytes = Buffer.from(r.stdout ?? "", "latin1");
  // An empty blob is not a test. `git show` of a path not in the tree fails rather
  // than returning "", so an empty read here means the commit holds an empty file —
  // and a hash of nothing would let a zero-byte file pass as a frozen test.
  if (bytes.length === 0)
    throw new SpecifyCommitError(`the committed blob ${rel} is empty — not a test`);
  return bytes;
}
