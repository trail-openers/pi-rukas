/**
 * work-develop-git — #1016: the git primitives the develop fan-out uses to
 * judge and reset a workstream worktree. Every develop-path git call takes a
 * `GitExec`, whose only implementation (`runGit`) sends an argv array through
 * the argv-honouring executor (`execFn("git", { argv })`). A path, ref,
 * workstream id or commit message is data, never re-parsed by a shell, so a
 * file named `$(touch x)` is a literal name — and no string command can reach
 * these helpers.
 *
 * One owner each for: the 40-hex base predicate (`isValidBaseSha`), the
 * tri-state commits-ahead count (`commitsAheadOfBase`), the status read
 * (`worktreeStatus`, `-z`, rename pairs expanded), the chunked staging
 * (`stagePaths`), the saved-patch path (`retryPatchPath`), and the guarded
 * reset (`resetWorktreeToBase`), which saves partial work to a patch before it
 * discards anything and refuses to touch a worktree outside `.worktrees/`.
 */
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { DriverContext } from "./work-driver-context.ts";

export type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

/** The develop path's git transport: argv only. `args` is the git argv (no `git`). */
export type GitExec = (
  args: string[],
  opts: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string }>;

/** The one adapter from the argv-honouring executor to `GitExec`. */
export const runGit =
  (execFn: ExecFn): GitExec =>
  (args, opts) =>
    execFn("git", { ...opts, argv: args });

const SHA_RE = /^[0-9a-f]{40}$/;

/** The only ref a git command in the develop paths may receive: a full 40-hex SHA. */
export const isValidBaseSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);

/** A workstream id is used as a path component: letters, digits, `.`, `_`, `-` only. */
export const WORKSTREAM_ID_RE = /^[A-Za-z0-9._-]+$/;

export const errText = (err: unknown): string =>
  String((err as Error)?.message ?? err).slice(0, 200);

/** Tri-state commit count: git answered with a count, or the check could not be read. */
export type CommitCheck = { commits: number } | { unreadable: string };

/** `git rev-list --count <base>..HEAD` in `cwd`. Only a strict decimal from
 *  git is a count; an invalid base, a git error or any other output is unreadable. */
export async function commitsAheadOfBase(
  git: GitExec,
  cwd: string,
  base: string | undefined,
): Promise<CommitCheck> {
  if (!isValidBaseSha(base)) return { unreadable: "base is not a 40-hex sha" };
  try {
    const { stdout } = await git(["rev-list", "--count", `${base}..HEAD`], {
      cwd,
      maxBuffer: 64 * 1024,
    });
    const t = stdout.trim();
    return /^\d+$/.test(t)
      ? { commits: Number(t) }
      : { unreadable: `unparseable rev-list output: ${t.slice(0, 80)}` };
  } catch (err) {
    return { unreadable: errText(err) };
  }
}

/** One uncommitted path. `untracked` is true only for a `??` entry: a tracked
 *  edit under `.pi/` is the developer's work, an untracked driver file is not. */
export interface StatusEntry {
  path: string;
  untracked: boolean;
}

/** Every path the worktree has uncommitted, read with `status --porcelain -z`
 *  so git never C-quotes a name (non-ASCII, quotes, control bytes arrive
 *  verbatim). A rename or copy contributes both its new and original path.
 *  Nothing is filtered here: a dropped path is a path the reset would destroy
 *  without saving. Unreadable when git fails. */
export async function worktreeStatus(
  git: GitExec,
  cwd: string,
): Promise<StatusEntry[] | { unreadable: string }> {
  let stdout: string;
  try {
    ({ stdout } = await git(["status", "--porcelain", "-z"], { cwd, maxBuffer: 256 * 1024 }));
  } catch (err) {
    return { unreadable: errText(err) };
  }
  const tokens = stdout.split("\0");
  const out: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.length < 4) continue;
    const code = tok.slice(0, 2);
    out.push({ path: tok.slice(3), untracked: code === "??" });
    // With -z a rename/copy is `XY new\0orig\0`: the origin is its own token.
    if (/[RC]/.test(code)) {
      i++;
      const orig = tokens[i];
      if (orig) out.push({ path: orig, untracked: false });
    }
  }
  return out;
}

/** Driver artefact paths (`.pi/`, `tmp/`). */
export function isDriverArtefact(path: string): boolean {
  return path.startsWith(".pi/") || path.startsWith("tmp/");
}

/** The entries the safety net may commit and the reset must save: everything
 *  except UNTRACKED driver artefacts. A tracked `.pi/` edit is real work and
 *  stays in; an untracked `.pi/` file is a driver file and is left alone (the
 *  reset's `clean -e .pi/ -e tmp/` keeps it). */
export function workEntriesOf(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter((e) => !(e.untracked && isDriverArtefact(e.path)));
}

/** Where the save-then-reset applies: the scratch patch, and the repo whose
 *  `.worktrees/` directory is the only place a reset may run. */
export interface ResetSave {
  repoRoot: string;
  patchPath: string;
}

/** Resolve symlinks when the path exists; a path that does not exist keeps its
 *  lexical form (it cannot be a symlink escape). */
const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Throws unless `cwd` resolves (symlinks included) strictly inside
 *  `<repoRoot>/.worktrees/`. */
export function assertInsideWorktrees(repoRoot: string, cwd: string): void {
  const root = realOrSelf(resolve(repoRoot, ".worktrees")) + sep;
  if (!realOrSelf(resolve(cwd)).startsWith(root)) {
    throw new Error(`refusing to reset ${cwd}: not inside ${root}`);
  }
}

/** The saved-patch path for a retry: `<scratchAbs>/retry-<id>-<attempt>.patch`.
 *  Throws on an id that is not a plain path component, or a path that resolves
 *  outside `scratchAbs`. The write refuses to overwrite (see savePartialWork). */
export function retryPatchPath(scratchAbs: string, id: string, attempt: number): string {
  if (!WORKSTREAM_ID_RE.test(id)) {
    throw new Error(`refusing patch path: workstream id ${JSON.stringify(id)} is not a plain name`);
  }
  const scratch = resolve(scratchAbs);
  const p = resolve(join(scratch, `retry-${id}-${attempt}.patch`));
  if (!p.startsWith(scratch + sep)) {
    throw new Error(`refusing patch path ${p}: outside ${scratch}`);
  }
  return p;
}

/** Git accepts a long argv, but a fan-out's path list is chunked anyway. */
const STAGE_CHUNK = 500;

/** Stage `paths` with `git add -- <paths>`, one call per ≤500-path chunk. Any
 *  failing chunk throws, so the caller never commits a partial stage. */
export async function stagePaths(git: GitExec, cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    await git(["add", "--", ...paths.slice(i, i + STAGE_CHUNK)], {
      cwd,
      maxBuffer: 256 * 1024,
    });
  }
}

/** Reset a workstream worktree to its base, discarding its uncommitted work
 *  ONLY after saving that work. Refuses (throws, touching nothing) unless:
 *  the path is inside `<repoRoot>/.worktrees/`, the base is a 40-hex SHA, the
 *  commit count is readable and zero (a worktree with commits is never reset),
 *  and the status is readable. Uncommitted work (untracked artefacts excluded)
 *  is staged, written as a binary patch against the base to `save.patchPath`,
 *  and only then reset with `git reset --hard` and `git clean -fd -e .pi/ -e tmp/`.
 *  A failed patch write refuses the reset. Returns the patch path, or undefined
 *  when there was no work to save. */
export async function resetWorktreeToBase(
  git: GitExec,
  cwd: string,
  base: string | undefined,
  save: ResetSave,
): Promise<string | undefined> {
  assertInsideWorktrees(save.repoRoot, cwd);
  if (!isValidBaseSha(base)) {
    throw new Error(`refusing to reset ${cwd}: base is not a 40-hex sha`);
  }
  const ahead = await commitsAheadOfBase(git, cwd, base);
  if (!("commits" in ahead)) {
    throw new Error(`refusing to reset ${cwd}: commit check unreadable — ${ahead.unreadable}`);
  }
  if (ahead.commits > 0) {
    throw new Error(`refusing to reset ${cwd}: HEAD has ${ahead.commits} commit(s) ahead of base`);
  }
  const status = await worktreeStatus(git, cwd);
  if (!Array.isArray(status)) {
    throw new Error(`refusing to reset ${cwd}: status unreadable — ${status.unreadable}`);
  }
  const work = workEntriesOf(status).map((e) => e.path);
  let patchPath: string | undefined;
  if (work.length > 0) {
    patchPath = await savePartialWork(git, cwd, base, work, save.patchPath);
  }
  await git(["reset", "--hard", base], { cwd, maxBuffer: 64 * 1024 });
  await git(["clean", "-fd", "-e", ".pi/", "-e", "tmp/"], { cwd, maxBuffer: 64 * 1024 });
  return patchPath;
}

/** Stage the work paths and write `git diff --binary --cached <base>` to
 *  `patchPath`. The write refuses to overwrite an existing file (`wx`), so a
 *  retry can never clobber an earlier save. Any failure throws, so the caller
 *  never resets unsaved work. */
async function savePartialWork(
  git: GitExec,
  cwd: string,
  base: string,
  work: string[],
  patchPath: string,
): Promise<string> {
  let patch: string;
  try {
    await stagePaths(git, cwd, work);
    const { stdout } = await git(["diff", "--binary", "--cached", base], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    patch = stdout;
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(patchPath, patch, { flag: "wx" });
  } catch (err) {
    throw new Error(`refusing to reset ${cwd}: could not save partial work — ${errText(err)}`);
  }
  return patchPath;
}
