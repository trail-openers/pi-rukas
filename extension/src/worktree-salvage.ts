/**
 * worktree-salvage — the salvage recipe for a dirty worktree being removed.
 *
 * Shared by the branch step's residue pass (`worktree-leftover.ts`) and the
 * #545 same-issue salvage (`work-driver-branch-salvage.ts`):
 * `salvageUncommittedWork` (git diff HEAD + the untracked manifest + the
 * untracked file contents into `<scratch>/salvage/<name>/`) and
 * `salvageDirtyWorktree` (that salvage + a stop-salvage ref on the
 * worktree's HEAD when it carries commits). One copy of "what must survive a
 * forced worktree removal" so the sites cannot drift. The ref lives under
 * `refs/pi-rukas/` so the merged cycle's ref prune reaches it.
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
  issue: number,
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
    // No catch: a tree whose commits could not be kept is not removed.
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: wtPath, maxBuffer: 64 * 1024 });
    const head = stdout.trim();
    const ref = await writeStopSalvageRef(execFn, repoRoot, issue, path.basename(wtPath), head);
    refs.push(`${ref} → ${head}`);
  }
  return { refs, salvageDir };
}

/**
 * Keep `sha` on the ref a removed tree's otherwise unreachable work lives on.
 * The SHA is part of the name, so a later stop of a same-named tree adds a ref
 * and never moves one. Exit 0 of `update-ref` is the evidence; anything else throws.
 */
export async function writeStopSalvageRef(
  execFn: ExecFn,
  repoRoot: string,
  issue: number,
  treeName: string,
  sha: string,
): Promise<string> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`not a commit SHA: ${JSON.stringify(sha.slice(0, 64))}`);
  }
  const ref = `refs/pi-rukas/stop-salvage/issue-${issue}/${treeName}/${sha}`;
  await execFn("git", { cwd: repoRoot, maxBuffer: 64 * 1024, argv: ["update-ref", ref, sha] });
  return ref;
}
