/**
 * work-develop-git — #1016: the git primitives the develop fan-out uses to
 * judge and reset a workstream worktree. Every command runs in argv form
 * (`execFn("git", { argv })`): a path, ref, workstream id or commit message
 * is data, never re-parsed by a shell, so a file named `$(touch x)` is a
 * literal name.
 *
 * One owner each for: the 40-hex base predicate (`isValidBaseSha`), the
 * tri-state commits-ahead count (`commitsAheadOfBase`), the dirty check that
 * ignores driver artefacts (`workPathsOf`), and the guarded reset
 * (`resetWorktreeToBase`), which saves partial work to a patch before it
 * discards anything and refuses to touch a worktree outside `.worktrees/`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { DriverContext } from "./work-driver-context.ts";

export type ExecFn = NonNullable<DriverContext["verifyExecFn"]>;

const SHA_RE = /^[0-9a-f]{40}$/;

/** The only ref a git command in the develop paths may receive: a full 40-hex SHA. */
export const isValidBaseSha = (s: unknown): s is string => typeof s === "string" && SHA_RE.test(s);

export const errText = (err: unknown): string =>
  String((err as Error)?.message ?? err).slice(0, 200);

/** Tri-state commit count: git answered with a count, or the check could not be read. */
export type CommitCheck = { commits: number } | { unreadable: string };

/** `git rev-list --count <base>..HEAD` in `cwd`. Only a strict decimal from
 *  git is a count; an invalid base, a git error or any other output is unreadable. */
export async function commitsAheadOfBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
): Promise<CommitCheck> {
  if (!isValidBaseSha(base)) return { unreadable: "base is not a 40-hex sha" };
  try {
    const { stdout } = await execFn("git", {
      cwd,
      maxBuffer: 64 * 1024,
      argv: ["rev-list", "--count", `${base}..HEAD`],
    });
    const t = stdout.trim();
    return /^\d+$/.test(t)
      ? { commits: Number(t) }
      : { unreadable: `unparseable rev-list output: ${t.slice(0, 80)}` };
  } catch (err) {
    return { unreadable: errText(err) };
  }
}

/** `git status --porcelain` lines (each right-trimmed; leading status
 *  columns are preserved), or unreadable. */
export async function worktreeStatus(
  execFn: ExecFn,
  cwd: string,
): Promise<string[] | { unreadable: string }> {
  try {
    const { stdout } = await execFn("git", {
      cwd,
      maxBuffer: 256 * 1024,
      argv: ["status", "--porcelain"],
    });
    return stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  } catch (err) {
    return { unreadable: errText(err) };
  }
}

/** The work paths in porcelain lines: every path except driver artefacts
 *  under `.pi/` and `tmp/`. A rename contributes both of its sides. */
export function workPathsOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const entry = line.slice(3);
    const arrow = entry.indexOf(" -> ");
    const targets = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry];
    for (const t of targets) {
      const clean = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
      if (clean.startsWith(".pi/") || clean.startsWith("tmp/")) continue;
      out.push(clean);
    }
  }
  return out;
}

/** Where the save-then-reset applies: the scratch patch, and the repo whose
 *  `.worktrees/` directory is the only place a reset may run. */
export interface ResetSave {
  repoRoot: string;
  patchPath: string;
}

/** Throws unless `cwd` resolves strictly inside `<repoRoot>/.worktrees/`. */
export function assertInsideWorktrees(repoRoot: string, cwd: string): void {
  const root = resolve(repoRoot, ".worktrees") + sep;
  if (!resolve(cwd).startsWith(root)) {
    throw new Error(`refusing to reset ${cwd}: not inside ${root}`);
  }
}

/** Reset a workstream worktree to its base, discarding its uncommitted work
 *  ONLY after saving that work. Refuses (throws, touching nothing) unless:
 *  the path is inside `<repoRoot>/.worktrees/`, the base is a 40-hex SHA, the
 *  commit count is readable and zero (a worktree with commits is never reset),
 *  and the status is readable. Uncommitted work (artefacts excluded) is staged,
 *  written as a binary patch against the base to `save.patchPath`, and only
 *  then reset with `git reset --hard` and `git clean -fd -e .pi/ -e tmp/`.
 *  A failed patch write refuses the reset. Returns the patch path, or undefined
 *  when there was no work to save. */
export async function resetWorktreeToBase(
  execFn: ExecFn,
  cwd: string,
  base: string | undefined,
  save: ResetSave,
): Promise<string | undefined> {
  assertInsideWorktrees(save.repoRoot, cwd);
  if (!isValidBaseSha(base)) {
    throw new Error(`refusing to reset ${cwd}: base is not a 40-hex sha`);
  }
  const ahead = await commitsAheadOfBase(execFn, cwd, base);
  if (!("commits" in ahead)) {
    throw new Error(`refusing to reset ${cwd}: commit check unreadable — ${ahead.unreadable}`);
  }
  if (ahead.commits > 0) {
    throw new Error(`refusing to reset ${cwd}: HEAD has ${ahead.commits} commit(s) ahead of base`);
  }
  const status = await worktreeStatus(execFn, cwd);
  if (!Array.isArray(status)) {
    throw new Error(`refusing to reset ${cwd}: status unreadable — ${status.unreadable}`);
  }
  const work = workPathsOf(status);
  let patchPath: string | undefined;
  if (work.length > 0) {
    patchPath = await savePartialWork(execFn, cwd, base, work, save.patchPath);
  }
  await execFn("git", {
    cwd,
    maxBuffer: 64 * 1024,
    argv: ["reset", "--hard", base],
  });
  await execFn("git", {
    cwd,
    maxBuffer: 64 * 1024,
    argv: ["clean", "-fd", "-e", ".pi/", "-e", "tmp/"],
  });
  return patchPath;
}

/** Stage the work paths and write `git diff --binary --cached <base>` to
 *  `patchPath`. Any failure throws, so the caller never resets unsaved work. */
async function savePartialWork(
  execFn: ExecFn,
  cwd: string,
  base: string,
  work: string[],
  patchPath: string,
): Promise<string> {
  let patch: string;
  try {
    await execFn("git", {
      cwd,
      maxBuffer: 256 * 1024,
      argv: ["add", "-A", "--", ...work],
    });
    const { stdout } = await execFn("git", {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      argv: ["diff", "--binary", "--cached", base],
    });
    patch = stdout;
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(patchPath, patch);
  } catch (err) {
    throw new Error(`refusing to reset ${cwd}: could not save partial work — ${errText(err)}`);
  }
  return patchPath;
}
