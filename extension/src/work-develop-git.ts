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
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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

/** The only ref a git command in the develop paths may receive: a full 40-hex SHA.
 *  #679 — the global base is unusable as a fallback (older state files). */
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
  /** For a rename/copy side: the other side's path. Absent otherwise. */
  pairedWith?: string;
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
    // -uall: an untracked directory is listed file by file, so every path is a
    // file that `git diff --cached --name-only` can later confirm as staged.
    ({ stdout } = await git(["status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    return { unreadable: errText(err) };
  }
  const tokens = stdout.split("\0");
  const out: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    // The only empty token is the one after the final NUL; any other is malformed.
    if (tok === "" && i === tokens.length - 1) continue;
    // Porcelain v1 is `XY PATH`: a status line is at least 4 chars with a space at 2.
    if (tok.length < 4 || tok[2] !== " ") {
      return {
        unreadable: `malformed status entry ${JSON.stringify(tok.slice(0, 80))}`,
      };
    }
    const code = tok.slice(0, 2);
    const p = tok.slice(3);
    // With -z a rename/copy is `XY new\0orig\0`: the origin is its own token.
    if (/[RC]/.test(code)) {
      i++;
      const orig = tokens[i];
      if (!orig)
        return {
          unreadable: "rename/copy status entry without its origin path",
        };
      out.push({ path: p, untracked: false, pairedWith: orig });
      out.push({ path: orig, untracked: false, pairedWith: p });
    } else {
      out.push({ path: p, untracked: code === "??" });
    }
  }
  return out;
}

/** Driver artefact paths: anything under `.pi/` or `tmp/`. The first segment is
 *  compared case-insensitively, so `.PI/x` and `TMP/x` (case-insensitive
 *  filesystems) are artefacts too. */
export function isDriverArtefact(path: string): boolean {
  const slash = path.indexOf("/");
  if (slash < 0) return false;
  const first = path.slice(0, slash).toLowerCase();
  return first === ".pi" || first === "tmp";
}

/** Exact-case driver directories: the only paths the reset's `git clean` spares
 *  (RESET_CLEAN_ARGS is case-sensitive). */
export function isExactDriverArtefact(path: string): boolean {
  return path.startsWith(".pi/") || path.startsWith("tmp/");
}

/** The entries the save and the reset act on: everything except UNTRACKED files
 *  under the EXACT-case `.pi/` and `tmp/` — precisely what `git clean -e .pi/
 *  -e tmp/` spares. A tracked `.pi/` edit is real work and stays in; an untracked
 *  `.PI/x` is not spared by clean, so it is saved to the patch before the reset
 *  removes it. (It is still never committed: see commitEntriesOf.) */
export function workEntriesOf(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter((e) => !(e.untracked && isExactDriverArtefact(e.path)));
}

/** The entries the safety net may COMMIT: everything outside the driver
 *  directories in EVERY case spelling (`.pi/`, `.PI/`, `tmp/`, `TMP/`), tracked
 *  or not. `.pi/` defines verification, so a developer's edit there is never
 *  committed by the driver; it goes through the protected-path check (#406).
 *  It is still saved to the retry patch by `workEntriesOf` before any reset. */
export function commitEntriesOf(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter((e) => !isDriverArtefact(e.path));
}

/** The reset's `git clean`. Its exclusions are case-sensitive and must equal the
 *  save rule (workEntriesOf / isExactDriverArtefact): an untracked `.PI/x` is not
 *  spared here, so it has to be in the patch first. */
const RESET_CLEAN_ARGS = ["-fd", "-e", ".pi/", "-e", "tmp/"];

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

/** The next free attempt number for a workstream's retry patch: one past the
 *  highest `retry-<id>-N.patch` already in `scratchAbs` (1 when there is none).
 *  A second re-entry for the same id therefore writes `-2`, never `-1` again. */
export async function nextRetryAttempt(scratchAbs: string, id: string): Promise<number> {
  if (!WORKSTREAM_ID_RE.test(id)) {
    throw new Error(`refusing patch path: workstream id ${JSON.stringify(id)} is not a plain name`);
  }
  let names: string[];
  try {
    names = await readdir(resolve(scratchAbs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw err;
  }
  // Only `.` is special in a workstream id that passed WORKSTREAM_ID_RE.
  const re = new RegExp(`^retry-${id.replace(/\./g, "\\.")}-(\\d+)\\.patch$`);
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Git accepts a long argv, but a fan-out's path list is chunked anyway. */
const STAGE_CHUNK = 500;

/** Stage `paths` with `git --literal-pathspecs add -- <paths>`, one call per
 *  ≤500-path chunk. Literal pathspecs stop git from globbing a name like
 *  `c[1].ts` or `*` into other files. Any failing chunk throws, so the caller
 *  never commits a partial stage. */
export async function stagePaths(git: GitExec, cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    await git(["--literal-pathspecs", "add", "--", ...paths.slice(i, i + STAGE_CHUNK)], {
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
 *  and only then reset with `git reset --hard` and `git clean -fd` that excludes
 *  the exact-case driver directories (see RESET_CLEAN_ARGS).
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
  await git(["clean", ...RESET_CLEAN_ARGS], { cwd, maxBuffer: 64 * 1024 });
  return patchPath;
}

/** Stage the deletion of `paths` that are gone from the working tree. `rm --cached`
 *  with --ignore-unmatch covers both a tracked file deleted on disk and a rename
 *  origin already absent from the index (where `git add` has nothing to match). */
export async function stageDeletions(git: GitExec, cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    await git(
      [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "-q",
        "--ignore-unmatch",
        "--",
        ...paths.slice(i, i + STAGE_CHUNK),
      ],
      {
        cwd,
        maxBuffer: 256 * 1024,
      },
    );
  }
}

/** Unstage `paths` (index only — the working tree is untouched), one
 *  `git --literal-pathspecs reset` per ≤500-path chunk. */
export async function unstagePaths(git: GitExec, cwd: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
    await git(["--literal-pathspecs", "reset", "-q", "--", ...paths.slice(i, i + STAGE_CHUNK)], {
      cwd,
      maxBuffer: 256 * 1024,
    });
  }
}

/** Stage the work paths and write `git diff --binary --cached <base>` to
 *  `patchPath`. The write refuses to overwrite an existing file (`wx`), so a
 *  retry can never clobber an earlier save. Before writing, every work path must
 *  appear in the index (`diff --cached --name-only`) and the patch must be
 *  non-empty; otherwise it throws. Any failure throws, so the caller never
 *  resets unsaved work. */
export async function savePartialWork(
  git: GitExec,
  cwd: string,
  base: string,
  work: string[],
  patchPath: string,
): Promise<string> {
  let patch: string;
  try {
    await stagePaths(
      git,
      cwd,
      work.filter((p) => existsSync(join(cwd, p))),
    );
    await stageDeletions(
      git,
      cwd,
      work.filter((p) => !existsSync(join(cwd, p))),
    );
    const names = await git(["diff", "--cached", "--name-only", "--no-renames", "-z"], {
      cwd,
      maxBuffer: 256 * 1024,
    });
    const staged = new Set(names.stdout.split("\0"));
    const unstaged = work.filter((p) => !staged.has(p));
    if (unstaged.length > 0) {
      throw new Error(
        `${unstaged.length} work path(s) not staged, e.g. ${JSON.stringify(unstaged[0])}`,
      );
    }
    const { stdout } = await git(["diff", "--binary", "--cached", base], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (stdout.trim() === "") throw new Error("empty patch for non-empty work");
    patch = stdout;
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(patchPath, patch, { flag: "wx" });
  } catch (err) {
    // A failed save may already have staged driver-owned paths (.pi/, tmp/):
    // unstage them so the index is left as found. The working tree is untouched.
    // An unstage failure is part of the refusal, never swallowed.
    const unstage = await unstagePaths(git, cwd, work).then(
      () => "",
      (e: unknown) => ` (unstage failed too — ${errText(e)})`,
    );
    throw new Error(
      `refusing to reset ${cwd}: could not save partial work — ${errText(err)}${unstage}`,
    );
  }
  return patchPath;
}
