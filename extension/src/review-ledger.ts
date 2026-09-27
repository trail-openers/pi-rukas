/**
 * review-ledger — the per-clone record that a branch's changes were reviewed.
 *
 * #912. The incident (sibling project lievo, 2026-09-27): a PM managing work
 * OUTSIDE the /work driver merged two PRs on a developer's self-report plus
 * green CI — skipping adversarial_loop and dispatch_lens_review. Prompt
 * doctrine demanded both; the prompt layer is what failed. This module is the
 * structural floor: a per-clone ledger that the merge guard
 * (merge-guard.ts) reads before any agent-run PR/MR merge.
 *
 * ## What is stored
 *
 * One JSON file under the git COMMON dir (`git rev-parse --git-common-dir`),
 * so every worktree of the clone shares it. Each entry is
 *
 *   { branch, kind: "adversarial" | "lens", patchId, passed, at }
 *
 * The writer stores `passed` — computed by the shared predicates
 * (adversarialPassed / lensPassed, the same functions the driver itself
 * applies to the verdicts — so the writer and the guard compute identical
 * patchIds and identical pass/fail booleans for the same content). The guard
 * trusts the stored boolean; it re-derives nothing.
 *
 * ## Failure isolation
 *
 * A ledger write is a side effect of a review, never a gate on it. Every
 * fault here — no git dir, detached head without a caller-supplied branch,
 * patch-id failure, an unreadable or corrupt file, a rename race — is
 * swallowed and traced. The review's own result must come back
 * byte-identical whether the write ran or threw.
 *
 * ## Concurrency
 *
 * Writes are atomic (temp file in the same directory + rename). Just before
 * the rename the file is re-read and merged: if a concurrent writer added an
 * entry in the meantime, its entry survives under ours.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";

/** The two review kinds the ledger tracks — and what a merge needs of each. */
export type ReviewKind = "adversarial" | "lens";

export interface LedgerEntry {
  /** The branch the review covered. */
  branch: string;
  kind: ReviewKind;
  /** `branchPatchId` of the changes at review time (adversarial entries must
   * MATCH the current patchId; a passing lens entry may carry an earlier one). */
  patchId: string;
  /** Computed by the shared predicates at write time — the guard trusts it. */
  passed: boolean;
  /** Unix ms; the "latest entry per kind" the guard reads is the max `at`. */
  at: number;
  /** One line of what the review concluded, for the operator's audit. */
  detail?: string;
}

interface LedgerFile {
  entries: LedgerEntry[];
}

export type LedgerExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * The patch id of a branch's changes: the diff from `baseRef` to the branch
 * head, fed through `git patch-id --stable`. The writer and the guard both
 * call this, so the same content always yields the same id (and a new commit
 * always changes it).
 *
 * Returns undefined when the diff is empty or patch-id fails — the caller
 * decides the fail-closed meaning.
 */
export async function branchPatchId(
  execFn: LedgerExecFn,
  cwd: string,
  branchRef: string,
  baseRef: string,
): Promise<string | undefined> {
  try {
    // `git patch-id --stable` over the diff of the branch's own commits.
    // Piping here is intentional: patch-id reads the diff from stdin.
    const { stdout } = await execFn(`git diff ${baseRef}..${branchRef} | git patch-id --stable`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const id = stdout.trim().split(/\s+/)[0]?.trim();
    if (!id) return undefined;
    return id;
  } catch (err) {
    trace(`review-ledger: patch-id failed for ${branchRef}: ${(err as Error).message}`);
    return undefined;
  }
}

/** The shared pass predicates the guard's booleans are computed with. */

/**
 * Adversarial: a completed review passed when its final verdict is one the
 * doctrine calls non-blocking — the terminal rule of
 * `decideLoopAction`: only `CRITICAL_ISSUES_FOUND` blocks. `INCOMPLETE`
 * (no readable verdict) is NOT a pass; neither is a dispatch that failed or
 * was killed.
 */
export function adversarialPassed(result: {
  ok: boolean;
  loopOutcome?: string;
  errorStop?: unknown;
  killCause?: string;
}): boolean {
  if (result.loopOutcome === "rejected") return false;
  if (result.loopOutcome === "infra-failure") return false;
  if (!result.ok) return false;
  if (result.errorStop || result.killCause) return false;
  return true;
}

/**
 * Lens: the review passed when its verdict is not one the project's
 * threshold blocks. `CRITICAL_ISSUES_FOUND` blocks at every threshold;
 * `REVIEW_INCOMPLETE` means the review did not actually run, so it never
 * passes. `ISSUES_FOUND` passes exactly when the threshold is LOW (nothing
 * at or above LOW that is not already a finding).
 */
export function lensPassed(verdict: string, threshold: string): boolean {
  if (verdict === "APPROVED") return true;
  if (verdict === "REVIEW_INCOMPLETE") return false;
  if (verdict === "CRITICAL_ISSUES_FOUND") return false;
  // ISSUES_FOUND — the project's threshold decides.
  return threshold === "LOW";
}

/**
 * Resolve the ledger file path for a clone.
 *
 * `git rev-parse --git-common-dir` resolves to the MAIN clone's .git for
 * worktrees (worktrees live under .git/worktrees/… and their common dir
 * points back), so every worktree shares one ledger. Absolute-path: a
 * relative answer (a plain clone at cwd) is anchored on `cwd`.
 *
 * Injects the git executor (tests stub it) and the file name (tests point
 * the ledger at a fixture without touching git).
 */
export async function ledgerPathFor(
  execFn: LedgerExecFn,
  cwd: string,
  fileName = "review-ledger.json",
): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git rev-parse --git-common-dir", { cwd, maxBuffer: 8 * 1024 });
    const raw = stdout.trim();
    if (!raw) return undefined;
    const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    // A worktree's common dir is .git/worktrees/<name>; the SHARED storage
    // is the main .git — one ledger per clone, not per worktree.
    const dir =
      raw.startsWith("worktrees/") && !commonDir.endsWith(".git")
        ? path.join(commonDir, "..", "..")
        : commonDir;
    return path.join(dir, fileName);
  } catch (err) {
    trace(`review-ledger: cannot resolve git common dir: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Append an entry to the ledger. Atomic + merge-tolerant (see module docs).
 *
 * Returns a short human-readable reason on every no-op so the caller can
 * trace exactly why no entry was written. Never throws.
 */
export async function appendLedgerEntry(
  entry: LedgerEntry,
  execFn: LedgerExecFn,
  cwd: string,
): Promise<string | undefined> {
  let file: string | undefined;
  try {
    file = await ledgerPathFor(execFn, cwd);
    if (!file) return "no git common dir (not a git worktree)";
    const dir = path.dirname(file);
    if (!existsSync(dir)) {
      // The common dir of a real clone always exists; a missing one means
      // something is off — trace and skip, never create git internals.
      return `ledger dir ${dir} does not exist`;
    }
    // Re-read immediately before writing: a concurrent writer may have
    // appended between our first read and this rename; merging keeps its
    // entry alive.
    let entries: LedgerEntry[] = [];
    try {
      entries = readLedgerFile(file).entries;
    } catch {
      entries = [];
    }
    entries.push(entry);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2), "utf8");
    try {
      renameSync(tmp, file);
    } catch (err2) {
      // A concurrent writer may have created the file first. Re-read, merge,
      // write once more; if even that races the entry is lost — a ledger miss
      // fails the merge closed, which is the safe direction.
      let merged: LedgerEntry[] = [];
      try {
        if (existsSync(file)) {
          merged = JSON.parse(readFileSync(file, "utf8")).entries ?? [];
        }
      } catch {
        merged = [];
      }
      try {
        writeFileSync(tmp, JSON.stringify({ entries: [...merged, entry] }, null, 2), "utf8");
        renameSync(tmp, file);
      } catch (err3) {
        trace(`review-ledger: write failed: ${(err3 as Error).message}`);
        return `ledger write failed: ${(err3 as Error).message}`;
      }
    }
    return undefined;
  } catch (err) {
    trace(`review-ledger: append failed: ${(err as Error).message}`);
    return `ledger append failed: ${(err as Error).message}`;
  }
}

/** Read the raw ledger (no git involved — the path is supplied). */
export function readLedgerFile(file: string): LedgerFile {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown };
  if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
  return { entries: parsed.entries as LedgerEntry[] };
}

/**
 * The LATEST entry per kind for a branch (max `at`), or undefined.
 *
 * Adversarial: the guard requires the latest to be `passed` AND its patchId
 * to equal the current one. Lens: the latest must be `passed` (any patchId
 * — a passing lens entry may predate a later commit; a later FAILING lens
 * run is what the latest-ness protects against).
 */
export function latestEntry(entries: LedgerEntry[], branch: string, kind: ReviewKind) {
  let best: LedgerEntry | undefined;
  for (const e of entries) {
    if (e.branch !== branch || e.kind !== kind) continue;
    if (!best || e.at >= best.at) best = e;
  }
  return best;
}

/** Read + merge the ledger from a resolved path; never throws. */
export function readLedgerAt(file: string): LedgerEntry[] {
  try {
    return readLedgerFile(file).entries;
  } catch {
    return [];
  }
}
