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
export { isFullCommitSha } from "./review-head-sha.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { bumpLensRound } from "./review-ledger-round.ts";
import { trace } from "./trace.ts";
import { type VerifyExecFn, detectMainline } from "./work-driver-git.ts";

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
  /** #973 — lens entries only: the branch-scoped round number this review
   * ran as (the previous latest lens entry's round + 1; a legacy entry
   * without `round` counts as round 1). Stored because the per-(branch, kind)
   * dedupe below keeps only ONE lens row per branch, so the round must live
   * on the entry, not in the file. */
  round?: number;
  /** #973 — lens entries only: whether the reviewed verdict carried a
   * CRITICAL finding. The round-cap merge rule (merge-guard-round-cap.ts)
   * requires `hasCritical === false` on the latest lens entry; a legacy
   * entry without this field cannot satisfy it (conservative refusal). */
  hasCritical?: boolean;
  /** #973 — lens entries only: the commit hash reviewed. Two consumers:
   * the delta-review auto-base (the `since` of a follow-up review defaults
   * to the latest lens entry's `headSha` when it is an ancestor of HEAD) and
   * the disclosure marker's provenance. Always a resolved 40-char SHA when
   * present (#1039); absent when the head could not be resolved; a non-SHA
   * value is malformed and refused by the round-cap path. */
  headSha?: string;
}

interface LedgerFile {
  entries: LedgerEntry[];
}

export type LedgerExecFn = VerifyExecFn;

/**
 * #955 file-size split: `ledgerPathFor` (and its one-time override trace)
 * live in review-ledger-path.ts; the re-export below keeps importers
 * unchanged.
 */
export { ledgerPathFor } from "./review-ledger-path.ts";
export { bumpLensRound } from "./review-ledger-round.ts";

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
    return parsePatchId(stdout, `${baseRef}..${branchRef}`);
  } catch (err) {
    trace(`review-ledger: patch-id failed for ${branchRef}: ${(err as Error).message}`);
    return undefined;
  }
}

/** One `git patch-id` line (`<id> <path>`) → the id, or undefined when empty. */
function parsePatchId(stdout: string, label: string): string | undefined {
  const id = stdout.trim().split(/\s+/)[0]?.trim();
  if (!id) trace(`review-ledger: patch-id was empty for ${label}`);
  return id;
}

/**
 * The remote the forge detection resolves against: `origin` → `upstream` →
 * the first remote in `git remote` order — the same precedence as
 * `detectForge` (forge-detect.ts). The guard and the ledger writers both
 * call this, so a repo whose remote is NOT named `origin` resolves the same
 * ref on both sides of the patchId comparison. Returns undefined when the
 * repo has no remotes — the callers fail closed.
 */
export async function remoteName(execFn: LedgerExecFn, cwd: string): Promise<string | undefined> {
  for (const name of ["origin", "upstream"]) {
    try {
      const { stdout } = await execFn(`git config --get remote.${name}.url`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      if (stdout.trim()) return name;
    } catch {
      /* try the next */
    }
  }
  try {
    const { stdout } = await execFn("git remote", { cwd, maxBuffer: 64 * 1024 });
    return stdout.trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The WORKING-tree patch id against the mainline — the one number the #912
 * writers (adversarial-ledger.ts, lens-ledger.ts) store in the ledger,
 * computed by ONE shared function so both writers agree with each other.
 *
 * The base is `<remote>/<mainline>`, resolved via `detectMainline`
 * (work-driver-git.ts) and `remoteName` — never a hardcoded `origin/main`,
 * never a `HEAD~1` fallback — and the diff runs from the MERGE-BASE of HEAD
 * and that base, over the working tree (uncommitted changes included). Two
 * properties fall out of that:
 *
 *   - the diff covers what the adversarial loop actually saw (its reviewer
 *     reads the working tree, including fixes the fix-developer applied but
 *     has not yet committed),
 *   - when those fixes are later committed UNCHANGED, the id recomputed at
 *     merge time matches the stored one (committing identical content does
 *     not change the content's patch-id).
 *
 * A PR whose base branch is NOT the mainline will not match: the guard
 * computes its patchId against `<remote>/<PR base>` (merge-guard.ts), the
 * patchId differs, and the mismatch fails closed — the operator re-runs the
 * reviews (see docs/troubleshooting.md → "A merge was refused: review ledger").
 *
 * `untracked` names the untracked files the worktree diff could not cover.
 * The entry is still written for the tracked content, but the warning is
 * returned so the caller traces it — the gap is visible to the operator.
 */
export async function workingTreePatchId(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<{ patchId?: string; untracked: string[]; warning?: string }> {
  const mainline = await detectMainline(cwd, execFn);
  if ("branch" in mainline === false) {
    return {
      untracked: [],
      warning: `cannot resolve the mainline branch (${mainline.reason}) — no ledger entry written`,
    };
  }
  const remote = await remoteName(execFn, cwd);
  if (!remote) {
    return {
      untracked: [],
      warning: "no git remote found (origin/upstream/first) — no ledger entry written",
    };
  }
  const baseRef = `${remote}/${mainline.branch}`;
  let mergeBase = "";
  try {
    const { stdout } = await execFn(`git merge-base HEAD ${baseRef}`, {
      cwd,
      maxBuffer: 8 * 1024,
    });
    mergeBase = stdout.trim();
  } catch (err) {
    return {
      untracked: [],
      warning: `merge-base against ${baseRef} failed: ${(err as Error).message?.slice(0, 120)} — no ledger entry written`,
    };
  }
  if (!mergeBase) {
    return {
      untracked: [],
      warning: `no merge-base between HEAD and ${baseRef} — no ledger entry written`,
    };
  }
  let patchId: string | undefined;
  try {
    // The diff runs from the merge-base to the WORKING TREE (a single ref =
    // index + worktree), so uncommitted fixes made by the adversarial loop
    // are covered. `git patch-id --stable` reads the diff from stdin.
    const { stdout } = await execFn(`git diff ${mergeBase} | git patch-id --stable`, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    patchId = parsePatchId(stdout, `working tree vs ${mergeBase.slice(0, 8)}`);
  } catch (err) {
    return {
      untracked: [],
      warning: `working-tree patch-id failed: ${(err as Error).message?.slice(0, 120)} — no ledger entry written`,
    };
  }
  if (!patchId) return { patchId: undefined, untracked: [] };
  // Untracked files are invisible to a worktree diff. The entry is still
  // written for the tracked content, but the gap is surfaced — and anything
  // untracked that later lands in a commit will fail closed at merge time
  // because the committed patchId will no longer match.
  const untracked: string[] = [];
  try {
    const { stdout } = await execFn("git status --porcelain", { cwd, maxBuffer: 256 * 1024 });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("??")) untracked.push(line.slice(3).trim());
    }
  } catch {
    // Untracked enumeration is best-effort; the tracked diff is authoritative.
  }
  if (untracked.length > 0) {
    return {
      patchId,
      untracked,
      warning: `untracked files not covered by the ledger patchId: ${untracked
        .slice(0, 5)
        .join(", ")}${untracked.length > 5 ? ` (+${untracked.length - 5} more)` : ""}`,
    };
  }
  return { patchId, untracked: [] };
}

/**
 * The shared pass predicates the guard's booleans are computed with.
 *
 * `lensPassed` is the ONE predicate both call sites use: the ledger writer
 * (lens-ledger.ts) stores `lensPassed(verdict, threshold)`, and the driver's
 * verdict threshold (lensBlockedByThreshold, below) applies the same
 * comparison — one function, two call sites, no re-implementation that could
 * drift.
 */

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
 * The driver-side twin of `lensPassed`: does this verdict fail AT the given
 * threshold? The ISSUES_FOUND branch of `computeVerdict` (lens-review.ts)
 * applies this exact comparison, and the ledger writer applies `lensPassed`
 * with the SAME resolved threshold — the threshold predicate has one
 * implementation.
 */
export function lensBlockedByThreshold(
  verdict: string,
  threshold: import("./lens-review.ts").Severity,
): boolean {
  return !lensPassed(verdict, threshold);
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
      entries = validEntries(readLedgerFile(file).entries);
    } catch {
      entries = [];
    }
    // Bounded file: keep only the latest entry per (branch, kind) — the
    // guard (latestEntry) reads only the latest anyway, so older entries
    // would be dead weight accumulating one row per review run per clone.
    entries = dedupeLatest(entries);
    // #973 — a lens write advances the branch's round counter in place:
    // the dedupe above keeps the previous latest lens entry, so its round
    // (legacy rows without one count as 1) IS the last recorded round, and
    // the next is a pure function of the file's previous contents. The
    // LATEST lens row per branch is what the guard reads; older rows for
    // the same branch are historical (the guard's latestEntry picks the
    // highest `at` regardless, so a hand-edited or legacy multi-row file
    // still counts the most recent round).
    entries.push(bumpLensRound(entry, entries));
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
        // #973 review — the rename-race fallback applies the SAME invariants
        // as the happy path: dedupe (the merged file may carry stale rows
        // the happy path would have collapsed) and the round bump (the
        // merged content may already hold the previous latest lens entry,
        // whose round the new one must advance — a bare `[...merged, entry]`
        // would record the same round twice or a round the driver never
        // spent, and the guard's `round >= 3` check would fire early or
        // never). A race is rare; it must not quietly write a ledger the
        // happy path would never write.
        const deduped = dedupeLatest(merged);
        deduped.push(bumpLensRound(entry, deduped));
        writeFileSync(tmp, JSON.stringify({ entries: deduped }, null, 2), "utf8");
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
  return { entries: validEntries(parsed.entries) };
}

/**
 * Validate an untrusted row before the ledger trusts it: `branch` must be
 * a non-empty string, `kind` one of the two review kinds, `patchId` a
 * string, `at` a finite number, `passed` a boolean. Anything else is
 * dropped (and traced) — a corrupt row must not satisfy or shadow a
 * genuine one.
 */
export function validEntries(entries: unknown[]): LedgerEntry[] {
  const ok: LedgerEntry[] = [];
  for (const e of entries) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as LedgerEntry).branch === "string" &&
      (e as LedgerEntry).branch.length > 0 &&
      ((e as LedgerEntry).kind === "adversarial" || (e as LedgerEntry).kind === "lens") &&
      typeof (e as LedgerEntry).patchId === "string" &&
      typeof (e as LedgerEntry).at === "number" &&
      Number.isFinite((e as LedgerEntry).at) &&
      typeof (e as LedgerEntry).passed === "boolean"
    ) {
      ok.push(e as LedgerEntry);
    } else {
      trace(`review-ledger: dropped invalid ledger entry: ${safeJson(e)}`);
    }
  }
  return ok;
}

/** One line, for the trace: a never-throwing JSON stringify. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return "<unserialisable>";
  }
}

/**
 * Keep only the latest entry per (branch, kind) — the guard reads only the
 * latest, so older rows are never consulted. Stable on `at` ties (later in
 * file order wins, matching `latestEntry`'s `>=`).
 */
export function dedupeLatest(entries: LedgerEntry[]): LedgerEntry[] {
  const byKey = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const key = `${e.branch}\u0000${e.kind}`;
    const prev = byKey.get(key);
    if (!prev || e.at >= prev.at) byKey.set(key, e);
  }
  return [...byKey.values()];
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

/** Read + validate the ledger from a resolved path; never throws. */
export function readLedgerAt(file: string): LedgerEntry[] {
  try {
    return readLedgerFile(file).entries;
  } catch {
    return [];
  }
}
