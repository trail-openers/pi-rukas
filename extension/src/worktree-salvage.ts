/**
 * worktree-salvage — #730 uncommitted-work salvage recipe.
 *
 * Shared by the branch step's residue pass (`worktree-leftover.ts`,
 * `preserveBeforeRemoval`) and the #545 same-issue salvage
 * (`work-driver-branch-salvage.ts`): `git diff HEAD` + the untracked
 * manifest + the untracked file contents into `<scratch>/salvage/<name>/`.
 * One copy of "what must survive a forced worktree removal" so the two
 * sites cannot drift.
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecFn } from "./worktree.ts";

/**
 * Salvage a dirty worktree's uncommitted work into
 * `<scratch>/salvage/<basename>/` (salvage.patch, untracked.txt, files/).
 *
 * Returns the salvage dir, or `undefined` when the tree had no uncommitted
 * work (a clean tree — nothing to salvage here; committed-ahead work is a
 * separate concern, handled by each caller).
 */
export async function salvageUncommittedWork(
  execFn: ExecFn,
  wtPath: string,
  scratch: string,
): Promise<string | undefined> {
  const salvageDir = path.join(scratch, "salvage", path.basename(wtPath));
  const { stdout: diff } = await execFn("git diff HEAD", {
    cwd: wtPath,
    maxBuffer: 1024 * 1024,
  });
  await mkdir(salvageDir, { recursive: true });
  await writeFile(path.join(salvageDir, "salvage.patch"), diff, "utf8");
  const { stdout: untracked } = await execFn("git ls-files --others --exclude-standard", {
    cwd: wtPath,
    maxBuffer: 1024 * 1024,
  });
  await writeFile(path.join(salvageDir, "untracked.txt"), untracked, "utf8");
  for (const rel of untracked
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const src = path.join(wtPath, rel);
    const dest = path.join(salvageDir, "files", rel);
    try {
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true });
    } catch {
      // best-effort per file; the manifest still names it
    }
  }
  return salvageDir;
}
