/**
 * work-driver-restore-entry — #1362: the entry-level filter the repoRoot
 * restore reads use, split out of work-driver-restore.ts (AGENTS.md §12
 * file-size gate) when adding the configured-exemption check pushed that file
 * past the cap. The behaviour stayed put; only the predicate moved.
 *
 * The one question answered here: does a `git status` entry count toward the
 * untracked list the restore claim prints? (The abort path's stash pathspec is
 * NOT filtered here — see `cycleChangedPaths` in work-driver-restore.ts.)
 *
 * #1362 round 3 — the exemption is decided by **PROVENANCE, not by the status
 * code**. The claim is built after the abort path's mixed reset, and that reset
 * turns the cycle's staged-new files into `??` — indistinguishable from a tool's
 * stray by any means git still offers. So the caller passes the cycle-start
 * baseline (`pipelineState.dirtyRootExemptBaseline`, recorded in the branch step
 * before anything was written) and only a post-reset `??` path that appears in
 * it is exempt. An absent baseline exempts nothing: the fail-closed direction,
 * and the one an old state file gets.
 *
 * The built-in set (the driver's own scaffolding and its state dir) is applied
 * first and is unchanged by the configuration. The configured list from
 * `.pi/dirty-root-exempt` is layered on top by the caller, which is what keeps
 * the no-config behaviour byte-identical: with no list, only the built-in set
 * ever excludes anything, exactly as before this file existed.
 */
import { matchesConfiguredExempt } from "./work-driver-dirty-root-exempt.ts";
import type { ExecFn } from "./worktree.ts";

/** One record of the structured `git status` read at repoRoot. */
export interface StatusEntry {
  /** The two-character XY porcelain code (`??` for untracked). */
  code: string;
  path: string;
  /** A rename or copy's original path (the record after the entry). */
  origPath?: string;
}

/** Paths the driver never counts as checkout dirt: its scaffolding and state. */
function isExcludedStatusPath(p: string): boolean {
  return p.startsWith(".worktrees/") || p.startsWith(".pi/work-state/");
}

/**
 * #1093 — the ONE structured status read at repoRoot. The abort path's
 * changed-path list and every restore post-condition derive from it, so they
 * cannot disagree about what is dirty. `-uall` lists each untracked file (a
 * bare `-u` collapses a directory into one `dir/` entry); `-z` keeps unusual
 * names unquoted. Throws when git cannot be read.
 *
 * The built-in exclusions are applied here; the configured `.pi/dirty-root-exempt`
 * list is applied by the CALLER, per consumer — the claim filters by baseline,
 * the stash pathspec does not filter at all.
 */
export async function readStatus(execFn: ExecFn, repoRoot: string): Promise<StatusEntry[]> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
    argv: ["status", "--porcelain", "-z", "-uall"],
  });
  const records = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const entry: StatusEntry = { code: rec.slice(0, 2), path: rec.slice(3) };
    if (/[RC]/.test(entry.code)) entry.origPath = records[++i] ?? "";
    if (!isExcludedStatusPath(entry.path)) entries.push(entry);
  }
  return entries;
}

/** A tracked entry: anything git knows about, staged, unstaged or unmerged. */
export const isTrackedEntry = (e: StatusEntry): boolean => e.code !== "??";

/**
 * Does this entry count toward what the restore claims? The built-in exclusions
 * are handled by `readStatus`; this decides the configured part, so a tool's own
 * file is not named by the claim — while a file the cycle wrote under the very
 * same prefix is.
 *
 * A TRACKED entry always counts: a modified, staged, deleted or renamed file is
 * the cycle's business no matter where it sits, which is the Settlement's "only
 * untracked entries are exempt" and the reason the list cannot hide real
 * uncommitted source.
 *
 * An UNTRACKED entry counts unless the cycle-start baseline names it. The
 * baseline is the only evidence that distinguishes the two `??` cases after the
 * mixed reset, so `baseline === undefined` (no exemption list, an old state
 * file, or a baseline that could not be taken) exempts nothing.
 *
 * The abort path's stash pathspec is built by `cycleChangedPaths`, deliberately
 * unfiltered: work the cycle wrote under an exempt prefix is still stashed,
 * because an unstashed path is a path the checkout can lose.
 */
export function isClaimCountedEntry(
  e: StatusEntry,
  exempt: readonly string[] | undefined,
  baseline: readonly string[] | undefined,
): boolean {
  if (isTrackedEntry(e)) return true;
  if (exempt === undefined || exempt.length === 0) return true;
  if (baseline === undefined || baseline.length === 0) return true;
  if (!matchesConfiguredExempt(e.path, exempt)) return true;
  return !baseline.includes(e.path);
}
