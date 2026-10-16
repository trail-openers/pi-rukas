/**
 * work-driver-restore-entry — #1362: the entry-level filter the repoRoot
 * restore reads use, split out of work-driver-restore.ts (AGENTS.md §12
 * file-size gate) when adding the configured-exemption check pushed that file
 * past the cap. The behaviour stayed put; only the predicate moved.
 *
 * The one question answered here: does a `git status` entry count toward the
 * restore's claims — the untracked list the claim prints, and the pathspec the
 * abort path stashes?
 *
 * The built-in set (the driver's own scaffolding and its state dir) is applied
 * first and is unchanged by the configuration. The configured list from
 * `.pi/dirty-root-exempt` is layered on top by the caller, which is what keeps
 * the no-config behaviour byte-identical: with no list, only the built-in set
 * ever excludes anything, exactly as before this file existed.
 */
import { matchesConfiguredExempt } from "./work-driver-dirty-root-exempt.ts";

/** One record of the structured `git status` read at repoRoot. */
export interface StatusEntry {
  /** The two-character XY porcelain code (`??` for untracked). */
  code: string;
  path: string;
  /** A rename or copy's original path (the record after the entry). */
  origPath?: string;
}

/** Paths the driver never counts as checkout dirt: its scaffolding and state. */
export function isExcludedStatusPath(p: string): boolean {
  return p.startsWith(".worktrees/") || p.startsWith(".pi/work-state/");
}

/** A tracked entry: anything git knows about, staged, unstaged or unmerged. */
export const isTrackedEntry = (e: StatusEntry): boolean => e.code !== "??";

/**
 * #1362 — is this status entry exempted by the project's configured list?
 *
 * Untracked (`??`) entries only: a tracked modification, a staged change, a
 * deletion or a rename under an exempt prefix is still the cycle's business.
 * A rename would need BOTH its destination and its origPath to match before it
 * counted as exempt — and since a rename's code is never `??`, the untracked
 * test above can never pass for one, which is the Settlement's "a rename is
 * never exempt": it is dirt, and nothing is staged around it.
 *
 * With no list this is always false, so every caller reads exactly what it
 * read before the file existed.
 */
export function isExemptStatusEntry(
  e: StatusEntry,
  exempt: readonly string[] | undefined,
): boolean {
  if (exempt === undefined || exempt.length === 0) return false;
  if (e.code !== "??") return false;
  if (!matchesConfiguredExempt(e.path, exempt)) return false;
  return e.origPath === undefined || matchesConfiguredExempt(e.origPath, exempt);
}

/**
 * Does this entry count toward what the restore claims? The built-in
 * exclusions are handled by `readStatus`; this decides the configured part, so
 * an exempt tool-local file is neither named by the claim nor stashed by the
 * abort path (which builds its pathspec from the same read).
 */
export function isClaimCountedEntry(
  e: StatusEntry,
  exempt: readonly string[] | undefined,
): boolean {
  return !isExemptStatusEntry(e, exempt);
}
