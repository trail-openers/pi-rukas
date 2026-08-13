/**
 * work-driver-stage — deciding what in a worktree is the developer's work.
 *
 * Split from work-driver-integrate.ts (AGENTS.md §12) once it grew a second
 * responsibility: not merely enumerating what changed, but distinguishing the
 * developer's output from the harness's own scaffolding. Those are different
 * questions, and the second is where a live incident came from.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Stage every path `git status --porcelain -z` lists, explicitly.
 *
 * Never `git add -A`: a misbehaving agent's root-level scratch (the #553
 * pollution pattern) must not ride along.
 *
 * `-z` is load-bearing twice over, and both were measured on real fixtures:
 *
 *   - **It never quotes.** The default format C-quotes any path with
 *     non-ASCII or control characters (`"h\303\244yh\303\244.txt"`). The old
 *     parser stripped the surrounding quotes and then re-quoted the still-
 *     escaped string, so the shell saw literal backslashes and `git add`
 *     exited 128 — killing the whole integration over one filename.
 *   - **It reverses the rename field order.** A staged rename is emitted as
 *     `R  <new>\0<old>\0`, new path first, with no ` -> ` arrow. We stage the
 *     NEW path only: the old path exists neither on disk nor in the index, so
 *     staging it is exactly what git rejects. The previous comment here
 *     claimed both sides were staged, which is what made `git mv` in a
 *     worktree abort the run.
 */
export async function stagePorcelainPaths(execFn: ExecFn, cwd: string): Promise<number> {
  const { stdout } = await execFn("git status --porcelain -z", { cwd, maxBuffer: 1024 * 1024 });
  // Trailing NUL leaves an empty final field; short fields cannot hold
  // "XY " plus a path and are not entries.
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    // Rename and copy entries carry the source path in the FOLLOWING field.
    // Skip it — see the docstring. Only the index column ever reports R/C:
    // an unstaged rename surfaces as `D old` + `?? new`, two ordinary
    // entries, which need no special handling.
    if (field[0] === "R" || field[0] === "C") i += 1;
    paths.push(field.slice(3));
  }
  const staged: string[] = [];
  for (const p of paths) {
    if (await escapesWorktree(cwd, p)) {
      // Provisioning scaffolding, not the developer's work. `node_modules/`
      // in a .gitignore matches a DIRECTORY, so the symlink `provisionWorktree`
      // creates escapes the pattern and porcelain reports `?? node_modules`.
      // Staging it captured an absolute-path `mode 120000` entry into the
      // patch, and applying that at repoRoot failed `Directory not empty` —
      // aborting mechanized integration on every Node or Python project.
      trace(`work-driver: integrate — refusing to stage '${p}', a symlink outside the worktree`);
      continue;
    }
    await execFn(`git add -- ${JSON.stringify(p)}`, { cwd, maxBuffer: 256 * 1024 });
    staged.push(p);
  }
  return staged.length;
}

/**
 * Is this a symlink pointing outside the worktree?
 *
 * Only such links are refused. A symlink *within* the tree is ordinary source
 * that a developer may legitimately add, and a machine-specific absolute path
 * is meaningless in a commit besides.
 */
async function escapesWorktree(cwd: string, rel: string): Promise<boolean> {
  try {
    const abs = path.resolve(cwd, rel);
    if (!(await fs.lstat(abs)).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(abs), await fs.readlink(abs));
    const root = path.resolve(cwd);
    return target !== root && !target.startsWith(`${root}${path.sep}`);
  } catch {
    // Unreadable — let git decide rather than silently dropping a real path.
    return false;
  }
}
