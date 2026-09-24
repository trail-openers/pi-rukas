/**
 * work-driver-git-exclude — `.git/info/exclude` bookkeeping.
 *
 * Extracted verbatim from work-driver-branch-mechanized.ts (500-line gate).
 * Owns the serialised read-modify-write that keeps driver-managed paths
 * (`.worktrees/`, `tmp/`) out of the project's `git status` without touching
 * committed shape.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Keep `.worktrees/` out of the repo's own `git status`.
 *
 * Written to `.git/info/exclude` (per-clone) rather than `.gitignore`
 * (committed) so the driver never alters the project's tracked shape — the
 * same convention AGENTS.md §7 already mandates for `tmp/`.
 *
 * Not cosmetic: without it, the very worktrees this step creates read as
 * untracked residue at repoRoot, and `integrate()`'s dirty-root preflight
 * refuses to run — every cycle, forever. Caught by the real-git test, missed
 * by the mocked one, which is the whole argument for having both.
 */
export async function ensureWorktreesExcluded(_execFn: ExecFn, repoRoot: string): Promise<void> {
  await ensureGitExclude(repoRoot, [".worktrees/"]);
}

/**
 * Add lines to `.git/info/exclude` as ONE atomic read-modify-write.
 *
 * Two callers append to this file — this one and `setupWorkspaceTmp` (for
 * `tmp/`) — and both previously did a non-atomic read-then-write. Interleaved,
 * the `writeFile` overwrite clobbers whatever the other just appended. Losing
 * the `.worktrees/` line is not cosmetic: every worktree file then shows in
 * repoRoot's `git status --porcelain`, and while `integrate()`'s preflight
 * filters it defensively, nothing else does.
 *
 * tmp-file + rename, the same shape `writeState` uses, so a concurrent reader
 * never observes a half-written file.
 *
 * `.git/info/exclude` rather than `.gitignore`: per-clone, so the driver never
 * alters the project's tracked shape — the convention AGENTS.md §7 already
 * mandates for `tmp/`.
 */
let excludeChain: Promise<unknown> = Promise.resolve();

export function ensureGitExclude(repoRoot: string, lines: string[]): Promise<void> {
  // Serialised, not merely atomic. tmp-file + rename makes each WRITE atomic,
  // but two callers that read the same original and each write their own
  // version still lose one update — which is precisely the bug: whichever
  // wrote second silently dropped the other's line. The chain makes the whole
  // read-modify-write the unit.
  const run = excludeChain.then(
    () => ensureGitExcludeInner(repoRoot, lines),
    () => ensureGitExcludeInner(repoRoot, lines),
  );
  excludeChain = run.catch(() => undefined);
  return run;
}

async function ensureGitExcludeInner(repoRoot: string, lines: string[]): Promise<void> {
  const excludePath = path.join(repoRoot, ".git", "info", "exclude");
  try {
    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    const missing = lines.filter(
      (l) => !new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(existing),
    );
    if (missing.length === 0) return;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const body = `${existing}${sep}# pi-rukas /work driver\n${missing.join("\n")}\n`;
    const tmp = `${excludePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, excludePath);
  } catch (err) {
    // Best-effort: integrate()'s preflight filters `.worktrees/` defensively.
    trace(
      `work-driver: could not update .git/info/exclude: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
}
