/**
 * lean/build-git — the git probes and mutations the build step's normalisation
 * needs, each one answering a question git can answer and no amount of reading
 * the working tree can.
 *
 * `build` holds a worktree a model has just been loose in, and every claim the
 * step makes about that tree is a git claim: does HEAD still descend from the
 * commit I recorded, what changed since then, does this frozen blob still hash
 * to its record, is the tree clean. Each function here is one such claim, and
 * the two failure kinds are kept apart deliberately — a git refusal that MEANS
 * something (exit 1 from `merge-base --is-ancestor` is "no, it does not
 * descend") is a value, while a git that could not run at all is a
 * `BuildInfraError`. Collapsing those two is how a driver builds on a tree it
 * never actually verified.
 */

import { BuildInfraError } from "./build-errors.ts";
import type { BuildExec } from "./build-types.ts";
import { sha256 } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";

/**
 * Run one git argv command with the hook and fsmonitor guard in front of it;
 * `undefined` when git refused rather than crashed. Every git call in this
 * module goes through here or through `headDescendsFrom`, which carries the
 * same guard itself.
 */
async function run(
  exec: BuildExec,
  wt: string,
  argv: string[],
  timeout = 120_000,
): Promise<{ stdout: string } | undefined> {
  return exec("git", {
    argv: [...NO_HOOKS, ...argv],
    cwd: wt,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
    .then((r) => ({ stdout: r.stdout ?? "" }))
    .catch(() => undefined);
}

/** A git command this step must not continue past. */
export async function must(
  exec: BuildExec,
  wt: string,
  argv: string[],
  why: string,
): Promise<string> {
  const r = await run(exec, wt, argv);
  if (r === undefined) throw new BuildInfraError(`git ${argv.join(" ")} failed in ${wt} (${why})`);
  return r.stdout.trim();
}

/** The `-z` fields of a git list output, as repo-relative paths. */
export function fields(out: string): string[] {
  return out
    .split("\0")
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => p !== "");
}

/** `git rev-parse HEAD` in `wt`, or a throw — an unreadable head is infra. */
export async function headSha(exec: BuildExec, wt: string): Promise<string> {
  const r = await run(exec, wt, ["rev-parse", "HEAD"], 30_000);
  const sha = (r?.stdout ?? "").trim();
  if (sha === "") throw new BuildInfraError(`could not read HEAD in ${wt}`);
  return sha;
}

/**
 * `git merge-base --is-ancestor sha HEAD`.
 *
 * git's own "not an ancestor" answer is exit 1 with no output; anything else
 * (a bad object name, no git at all) is a fact the step cannot establish and
 * throws, because "could not tell" must never read as "the child is honest".
 */
export async function headDescendsFrom(exec: BuildExec, wt: string, sha: string): Promise<boolean> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "merge-base", "--is-ancestor", sha, "HEAD"],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => ({ code: (err as { code?: unknown })?.code }));
  if ((r as { code?: unknown }).code === 1) return false;
  if ((r as { code?: unknown }).code !== undefined)
    throw new BuildInfraError(`could not tell whether HEAD descends from ${sha}`);
  return true;
}

/**
 * The committed blob of `rel` at `ref`, byte for byte; `undefined` when git
 * refuses it. `latin1` is read back with `Buffer.from(…, "latin1")`, the one
 * text encoding that keeps every byte: a frozen test holding invalid UTF-8
 * must hash to the record the freeze made, and utf8 would rewrite it.
 */
async function blobAt(
  exec: BuildExec,
  wt: string,
  ref: string,
  rel: string,
): Promise<Buffer | undefined> {
  const r = await exec("git", {
    argv: [...NO_HOOKS, "show", `${ref}:${rel}`],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdoutEncoding: "latin1",
  }).catch(() => undefined);
  if (r === undefined) return undefined;
  return Buffer.from(r.stdout ?? "", "latin1");
}

/**
 * Do `frozen`'s committed blobs at `ref` still hash to their records?
 *
 * A zero-byte blob is never a frozen test, whatever its record says: a record of
 * the empty hash would otherwise vouch for a test that tests nothing.
 */
export async function frozenMatches(
  exec: BuildExec,
  wt: string,
  ref: string,
  frozen: Record<string, string>,
): Promise<string[]> {
  const bad: string[] = [];
  for (const [rel, want] of Object.entries(frozen)) {
    const bytes = await blobAt(exec, wt, ref, rel);
    if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== want) bad.push(rel);
  }
  return bad;
}

/**
 * Every path the child left its mark on: tracked edits and deletions against
 * `headBefore` (which covers the child's own commits) plus untracked files.
 *
 * The two lists are needed together. `diff` alone misses a brand-new file the
 * child never staged; `ls-files --others` alone misses its edits and every
 * deletion it made.
 */
export async function changedSet(
  exec: BuildExec,
  wt: string,
  headBefore: string,
): Promise<string[]> {
  const tracked = await must(
    exec,
    wt,
    ["diff", "--name-only", "-z", headBefore],
    "read the tracked changes against the head",
  );
  const others = await must(
    exec,
    wt,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "list the untracked files",
  );
  return [...new Set([...fields(tracked), ...fields(others)])];
}

/** The paths one commit changes, as repo-relative paths. */
export async function commitDiff(
  exec: BuildExec,
  wt: string,
  base: string,
  head: string,
): Promise<string[]> {
  const r = await run(exec, wt, ["diff", "--name-only", "-z", base, head], 60_000);
  if (r === undefined)
    throw new BuildInfraError(`could not read the commit's diff against ${base}`);
  return fields(r.stdout);
}

/**
 * `git status --porcelain` output; "" when the tree is clean. `--untracked-files=all`
 * lists every file, not each directory: a clean-looking tree with a stray file
 * under an untracked directory is not clean.
 */
export async function porcelain(exec: BuildExec, wt: string): Promise<string> {
  return must(
    exec,
    wt,
    ["status", "--porcelain", "--untracked-files=all"],
    "check the tree is clean",
  );
}
