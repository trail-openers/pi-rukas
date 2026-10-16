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
  /**
   * #1362 — set by `markExemptCandidates` on an untracked entry whose path the
   * project's `.pi/dirty-root-exempt` covers, decided at the pre-reset read
   * while `code` was still `??`. The claim consults it; the stash pathspec
   * ignores it (a cycle-written file must still be stashed). Absent = not
   * exempt, or never marked (every pre-#1362 caller).
   */
  exemptCandidate?: boolean;
}

/** Paths the driver never counts as checkout dirt: its scaffolding and state. */
export function isExcludedStatusPath(p: string): boolean {
  return p.startsWith(".worktrees/") || p.startsWith(".pi/work-state/");
}

/**
 * #1093 — the ONE structured status read at repoRoot. The abort path's
 * changed-path list and every restore post-condition derive from it, so they
 * cannot disagree about what is dirty. `-uall` lists each untracked file (a
 * bare `-u` collapses a directory into one `dir/` entry); `-z` keeps unusual
 * names unquoted. Throws when git cannot be read.
 *
 * The built-in exclusions (`isExcludedStatusPath`) are applied here; the
 * configured `.pi/dirty-root-exempt` list is applied by the CALLER, per
 * consumer — the claim filters, the stash pathspec does not.
 *
 * #1362 — a `??` entry whose path matches the configured list is flagged
 * `exemptCandidate` **without being filtered**. Which consumer honours it is
 * then a per-site decision, and it has to be one, because the two consumers
 * need opposite things from the same read: the claim (read AFTER the mixed
 * reset, when the file is indistinguishable from the operator's own) must not
 * name it, while the stash pathspec (read BEFORE the reset, when git still
 * says `??`) must. Filtering here would have made one of them wrong.
 */
export async function readStatus(execFn: ExecFn, repoRoot: string): Promise<StatusEntry[]> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
    argv: ["status", "--porcelain", "-z", "-uall"],
  });
  return parseStatusRecords(stdout);
}

/**
 * #1362 — the record split of the `-z` read, factored out of `readStatus` so
 * a caller holding the raw stdout (a test asserting the exemption from the
 * reset's own porcelain, for instance) parses it the same way git's bytes
 * deserve. Exported for that reason and no other; production calls `readStatus`.
 */
export function parseStatusRecords(stdout: string): StatusEntry[] {
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

/**
 * #1362 — stamp `exemptCandidate` on the untracked entries the project's list
 * covers. Called by the restore right after `readStatus`, BEFORE the reset, so
 * the decision is made while git still distinguishes an untracked file from a
 * staged-new one (which is what tells the cycle's own work apart from a stray).
 */
export function markExemptCandidates(
  entries: StatusEntry[],
  exempt: readonly string[] | undefined,
): StatusEntry[] {
  for (const e of entries) {
    if (e.code === "??" && isExemptStatusEntry(e, exempt)) e.exemptCandidate = true;
  }
  return entries;
}

/** A tracked entry: anything git knows about, staged, unstaged or unmerged. */
export const isTrackedEntry = (e: StatusEntry): boolean => e.code !== "??";

/**
 * #1362 — is this status entry exempted by the project's configured list?
 *
 * The rule is one line: **`code !== "??"` is not exempt**. Everything the
 * Settlement demands follows from it. A tracked modification, a staged change,
 * a deletion, an unmerged entry — all have a code other than `??` and stay the
 * cycle's business, so the list cannot hide real uncommitted source. A rename
 * or copy is likewise never `??`, which IS the Settlement's "a rename is never
 * exempt": there is no case in which its origPath could rescue it into the
 * exempt set, so there is no origPath clause here.
 *
 * With no list this is always false, so every caller reads exactly what it
 * read before the file existed.
 */
export function isExemptStatusEntry(
  e: StatusEntry,
  exempt: readonly string[] | undefined,
): boolean {
  if (exempt === undefined || exempt.length === 0) return false;
  // The whole rule: only an untracked entry can be exempt (see the doc above).
  if (e.code !== "??") return false;
  return matchesConfiguredExempt(e.path, exempt);
}

/**
 * Does this entry count toward what the restore claims? The built-in
 * exclusions are handled by `readStatus`; this decides the configured part, so
 * an exempt tool-local file is not named by the claim.
 *
 * #1362 — the claim's untracked list is the ONLY consumer, and it reads the
 * `exemptCandidate` stamp rather than re-matching the path: the claim is built
 * AFTER the mixed reset, when a staged-new file the cycle wrote has become
 * `??` and would otherwise match its own exemption and go unmentioned. The
 * stamp was applied at the pre-reset read, where git still said `A`.
 *
 * The abort path's stash pathspec is built by `cycleChangedPaths`, which is
 * deliberately not filtered at all: work the cycle wrote under an exempt prefix
 * is still stashed, because an unstashed path is a path the checkout can lose.
 */
export function isClaimCountedEntry(e: StatusEntry): boolean {
  return e.exemptCandidate !== true;
}
