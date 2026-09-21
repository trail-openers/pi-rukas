/**
 * work-driver-handoff-snapshot — PR5: capture a worktree snapshot at handoff
 * time so the operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal, the GitHub body) can answer WHERE the work is without re-shelling
 * git on every call.
 *
 * Split from work-driver-handoff.ts (AGENTS.md §12 file-size limit) so the
 * handoff step handler stays under the 500-line hard cap as the #775
 * delivery-provenance work grows it. Behaviour-neutral: the function body is
 * unchanged, and the exported name/path stay reachable from
 * work-driver-handoff.ts so no consumer's import path changes.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * PR5 — capture a snapshot of the worktree at handoff time. Lets the
 * operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal renderer, GitHub renderHandoffMarkdown) answer WHERE the
 * work is without re-shelling git on every call.
 *
 * Best-effort: every git invocation is try/catch'd so a missing branch /
 * gh-auth / network issue degrades gracefully — the snapshot's
 * `branchPushed: false` and empty `modifiedFiles` is meaningful by
 * itself; absence of the snapshot field is not.
 *
 * Caps file list at 50 entries to keep state-file readable; the
 * `unstagedCount + stagedCount` totals are always accurate even when
 * the per-file list is truncated.
 */
export async function captureWorktreeSnapshot(
  repoRoot: string,
  branchName: string | undefined,
  worktrees?: Record<string, string>,
): Promise<NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>> {
  const snapshot: NonNullable<WorkState["pipelineState"]["handoffSnapshot"]> = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    headSha: "",
    capturedAt: Date.now(),
  };
  // #287 — the developer's uncommitted work lives in the WORKTREES, not at
  // repoRoot. Snapshotting repoRoot alone would report "0 files modified" on
  // exactly the handoffs where the operator needs to know what survived.
  // Scan every worktree (falling back to repoRoot when none were recorded,
  // i.e. a pre-branch halt), prefixing paths
  // with the workstream id when there is more than one so the file list is
  // unambiguous.
  const scanRoots = Object.entries(worktrees ?? {});
  const targets: Array<{ id: string | undefined; dir: string }> =
    scanRoots.length > 0
      ? scanRoots.map(([id, dir]) => ({ id: scanRoots.length > 1 ? id : undefined, dir }))
      : [{ id: undefined, dir: repoRoot }];
  // git status --porcelain (XY format: column 1 = staged tier, column 2 = unstaged tier).
  for (const { id, dir } of targets) {
    try {
      const { stdout } = await execp("git status --porcelain", {
        cwd: dir,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        if (x !== " " && x !== "?") snapshot.stagedCount += 1;
        if (y !== " ") snapshot.unstagedCount += 1;
        const filePath = line.slice(3);
        if (snapshot.modifiedFiles.length < 50) {
          snapshot.modifiedFiles.push(id ? `${id}: ${filePath}` : filePath);
        }
      }
    } catch (err) {
      trace(
        `work-driver: captureWorktreeSnapshot git status failed for ${dir}: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  // HEAD short SHA.
  try {
    const { stdout } = await execp("git rev-parse --short HEAD", { cwd: repoRoot });
    snapshot.headSha = stdout.trim();
  } catch (err) {
    trace(
      `work-driver: captureWorktreeSnapshot git rev-parse failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  if (branchName) {
    // Local branch existence.
    try {
      await execp(`git rev-parse --verify ${JSON.stringify(branchName)}`, { cwd: repoRoot });
      snapshot.branchExists = true;
    } catch {
      snapshot.branchExists = false;
    }
    // Remote tracking (best-effort; network may be down). 10s timeout
    // because ls-remote can hang on unreachable remotes.
    try {
      const { stdout } = await execp(`git ls-remote --heads origin ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        timeout: 10_000,
      });
      snapshot.branchPushed = stdout.trim().length > 0;
    } catch {
      snapshot.branchPushed = false;
    }
  }
  return snapshot;
}
