/**
 * worktree-salvage — the salvage recipe for a dirty worktree being removed.
 *
 * Shared by the branch step's residue pass (`worktree-leftover.ts`) and the
 * #545 same-issue salvage (`work-driver-branch-salvage.ts`):
 * `salvageUncommittedWork` (git diff HEAD + the untracked manifest + the
 * untracked file contents into `<scratch>/salvage/<name>/`) and
 * `salvageDirtyWorktree` (that salvage + a durable tag on the worktree's
 * HEAD when it carries commits). One copy of "what must survive a forced
 * worktree removal" so the sites cannot drift.
 */

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { DirtyWorktreeFinding, ExecFn } from "./worktree.ts";

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

export async function salvageDirtyWorktree(
  execFn: ExecFn,
  repoRoot: string,
  wtPath: string,
  fromRef: string,
  scratch: string,
  finding: DirtyWorktreeFinding | undefined,
): Promise<{ refs: string[]; salvageDir?: string }> {
  const refs: string[] = [];
  let salvageDir: string | undefined;
  if (finding && finding.uncommittedFiles.length > 0) {
    try {
      salvageDir = await salvageUncommittedWork(execFn, wtPath, scratch);
    } catch (err) {
      trace(
        `worktree-salvage: salvage of ${wtPath} failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
      );
      salvageDir = "(salvage-failed)";
    }
  }
  if (finding && finding.unpushedCommitCount > 0) {
    try {
      const { stdout } = await execFn("git rev-parse HEAD", { cwd: wtPath, maxBuffer: 64 * 1024 });
      const head = stdout.trim();
      if (head) {
        const tag = `pi-rukas-salvage/${path.basename(wtPath)}-${Date.now()}`;
        await execFn(`git tag ${JSON.stringify(tag)} ${JSON.stringify(head)}`, {
          cwd: repoRoot,
          maxBuffer: 64 * 1024,
        });
        refs.push(`${tag} → ${head}`);
      }
    } catch (err) {
      trace(
        `worktree-salvage: tag for ${wtPath} failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  return { refs, salvageDir };
}
