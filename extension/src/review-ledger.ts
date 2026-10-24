/**
 * review-ledger — the per-clone record that a branch's changes were reviewed.
 *
 * #912. The incident (a sibling project, 2026-09-27): a PM managing work
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
 * The whole read → transform → rename window runs under the per-clone
 * review-ledger lock (review-ledger-lock.ts): an O_EXCL lockfile colocated
 * with the ledger file, ≈5 s bounded wait, ≈30 s stale window. Two
 * near-simultaneous writers on one clone (an adversarial_loop finishing while
 * a dispatch_lens_review finishes, or two Pi sessions on the same clone) are
 * serialised, so neither rename drops the other's row.
 *
 * The lock's degraded path (a past-deadline wait or a non-EEXIST open
 * error) traces and returns a no-op release, and the write still runs
 * unlocked: the rename-catch fallback re-reads the file immediately before
 * its rename and merges via mergeAfterRace, so the other writer's row
 * survives even on that path (a ledger miss would fail the merge closed, so
 * the fallback is the safety net and the lock is the fast path).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dedupeLatest } from "./review-ledger-core.ts";
import type { LedgerEntry } from "./review-ledger-entry.ts";
import { acquireLedgerLock, runLedgerCriticalSectionHook } from "./review-ledger-lock.ts";
import { mergeAfterRace } from "./review-ledger-merge.ts";
import {
  cloneLedgerPathFor,
  identityBase,
  ledgerPathFor,
  ledgerWriteLandedAt,
  remoteName,
  sameResolvedPath,
} from "./review-ledger-path.ts";
import { latestEntry, readLedgerFile, validEntries } from "./review-ledger-read.ts";
import { bumpLensRound } from "./review-ledger-round.ts";
import { diffDigestOfRange, patchIdOfRange } from "./review-patch-identity.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

export type LedgerExecFn = VerifyExecFn;

/**
 * #955 file-size split: `ledgerPathFor` (and its one-time override trace)
 * live in review-ledger-path.ts; the re-exports below keep importers
 * unchanged. #1449 adds the override-blind twin and the misdirection
 * predicate/note so every writer reaches them through the same seam it
 * already imports (`review-ledger.ts`) rather than the path module directly.
 */
export {
  cloneLedgerPathFor,
  LEDGER_OVERRIDE_ENV,
  ledgerPathFor,
  MISDIRECTED_LEDGER_NOTE,
  misdirectedLedgerWrite,
} from "./review-ledger-path.ts";
export { bumpLensRound } from "./review-ledger-round.ts";
export { dedupeLatest } from "./review-ledger-core.ts";
// #1557 size split: the row record lives in review-ledger-entry.ts; the
// ledger's public surface stays one module - importers keep their paths.
export type { LedgerEntry, LedgerFile, ReviewKind } from "./review-ledger-entry.ts";
export { mergeAfterRace } from "./review-ledger-merge.ts";
export { remoteName } from "./review-ledger-path.ts";

/**
 * The WORKING-tree patch id against the mainline — the one number the #912
 * writers (adversarial-ledger.ts, lens-ledger.ts) store in the ledger,
 * computed by ONE shared function so both writers agree with each other.
 *
 * The base is `<remote>/<mainline>`, resolved via `identityBase`
 * (review-ledger-path.ts — the guard uses the same) — never a hardcoded `origin/main`,
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
 * The merge guard recomputes the committed form of this identity against the
 * same `<remote>/<mainline>` (`mergeIdentity`, #1305). A PR whose base
 * branch is NOT the mainline is refused there by name (fail closed) — the
 * operator re-runs the reviews or merges by hand (see docs/troubleshooting.md
 * → "A merge was refused: review ledger").
 *
 * `opts.digest` (default false) also computes `diffSha256` — a second
 * `git diff --binary` run. Only the lens writer stores it (the carry needs
 * it); the merge-guard and round-cap paths never read it, so they do not pay
 * for it.
 *
 * `untracked` names the untracked files the worktree diff could not cover.
 * The entry is still written for the tracked content, but the warning is
 * returned so the caller traces it — the gap is visible to the operator.
 */
export async function workingTreePatchId(
  execFn: LedgerExecFn,
  cwd: string,
  opts: { digest?: boolean } = {},
): Promise<{ patchId?: string; untracked: string[]; warning?: string; diffSha256?: string }> {
  const base = await identityBase(execFn, cwd);
  if (!base.ok) return { untracked: [], warning: `${base.reason} — no ledger entry written` };
  const baseRef = `${base.remote}/${base.mainline}`;
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
    patchId = await patchIdOfRange(
      execFn,
      cwd,
      mergeBase,
      `working tree vs ${mergeBase.slice(0, 8)}`,
    );
  } catch (err) {
    return {
      untracked: [],
      warning: `working-tree patch-id failed: ${(err as Error).message?.slice(0, 120)} — no ledger entry written`,
    };
  }
  if (!patchId) return { patchId: undefined, untracked: [] };
  // The digest is best-effort for the WRITER: without it the entry is still
  // recorded, and a later carry falls back to a full review (fail closed).
  let diffSha256: string | undefined;
  if (opts.digest) {
    try {
      diffSha256 = await diffDigestOfRange(execFn, cwd, mergeBase);
    } catch (err) {
      trace(`review-ledger: diff digest unavailable (${(err as Error).message?.slice(0, 120)})`);
    }
  }
  // Untracked files are invisible to a worktree diff. The entry is still
  // written for the tracked content, but the gap is surfaced — and anything
  // untracked that later lands in a commit will fail closed at merge time
  // because the committed patchId will no longer match.
  const untracked: string[] = [];
  try {
    const { stdout } = await execFn("git status --porcelain", {
      cwd,
      maxBuffer: 256 * 1024,
    });
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
      diffSha256,
      warning: `untracked files not covered by the ledger patchId: ${untracked
        .slice(0, 5)
        .join(", ")}${untracked.length > 5 ? ` (+${untracked.length - 5} more)` : ""}`,
    };
  }
  return { patchId, untracked: [], diffSha256 };
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
  if (result.loopOutcome && result.loopOutcome !== "approved") return false;
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
  /** #1449 round 2 — when given, receives the stamped row plus whether it landed
   * outside the clone's own ledger. The stamp is applied HERE, at the one place
   * holding the resolved path, so no writer can forget it; the caller must not
   * read its own `entry` for it. `landedAtPath` is left undefined when the row
   * landed on the clone's ledger, because that field means "somewhere other than
   * where the guard looks" — a value equal to the clone path is not a redirect. */
  stampedOut?: { current: LedgerEntry; landedAtPath?: string },
): Promise<string | undefined> {
  let file: string | undefined;
  try {
    file = await ledgerPathFor(execFn, cwd);
    if (!file) return "no git common dir (not a git worktree)";
    // #1449 — STAMPED HERE, at the one place that knows where the row actually
    // landed, rather than by each writer. Every caller passes an entry whose
    // provenance field is absent (or holds a value from a different context), and
    // this function is the only one holding the resolved path: stamping per-caller
    // meant a new writer could forget, and a forgotten stamp is exactly the state
    // in which a redirected review is indistinguishable from an unreviewed branch.
    // Sanitised on the way in because the value is later printed into a refusal
    // string. An existing stamp is OVERWRITTEN, not honoured: a row carried from
    // another file must report where it landed HERE.
    // The stamp is the RAW resolved path, not the sanitised one: sanitising is a
    // RENDER-time operation (the guard prints the value into a refusal) and
    // `sanitiseLedgerProvenancePath` caps at 240 chars, so a long real path — a
    // deep worktree, a long temp prefix — clamped to a PREFIX of the clone path
    // and `sameResolvedPath` then read an ordinary write as a redirect on every
    // single review. Compare raw, sanitise only where it is rendered.
    const stamped: LedgerEntry = { ...entry, writtenTo: file };
    // #1449 round 2 — `landedAtPath` means "somewhere other than where the guard
    // looks", so it is set only when the resolved path differs from the clone's own
    // ledger (compared RAW and realpath'd where that works — a symlinked or
    // relative override is one file in two spellings). The ROW still carries the
    // full stamp either way: the guard's own comparison needs it.
    //
    // `ledgerWriteLandedAt` owns the short-circuit that keeps the extra
    // `git rev-parse` off the 99% path, and the reasoning for why skipping it is
    // safe (no override ⇒ same resolver, same fileName ⇒ equal by construction;
    // no parent directory ⇒ nothing that can alias). Kept in the path module so
    // the predicate that decides "misdirected" has one definition, next to the
    // resolver whose output it compares.
    if (stampedOut) {
      stampedOut.current = stamped;
      stampedOut.landedAtPath = await ledgerWriteLandedAt(execFn, cwd, file);
    }
    const dir = path.dirname(file);
    if (!existsSync(dir)) {
      // The common dir of a real clone always exists; a missing one means
      // something is off — trace and skip, never create git internals.
      return `ledger dir ${dir} does not exist`;
    }
    // #1071 — the whole read → transform → rename window runs under the
    // ledger lock (review-ledger-lock.ts): two concurrent writers on one
    // clone no longer interleave across the read, because each holds the
    // lock for the duration of its critical section. The lock's degraded
    // path (timeout / non-EEXIST) returns a no-op release, so the code
    // below still runs unlocked and the rename-catch's mergeAfterRace
    // fallback preserves the other writer's row — the lock is the fast
    // path, the fallback is the safety net.
    const release = await acquireLedgerLock(file);
    try {
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
      entries.push(bumpLensRound(stamped, entries));
      // #1071 test-only hook: a two-process race (test-review-ledger-lock.ts)
      // straddles the read/rename gap deterministically by injecting a hook
      // (setLedgerCriticalSectionHookForTests) that awaits here. No-op in
      // production (the hook is undefined); the production write path has no
      // env-var test hook of its own.
      await runLedgerCriticalSectionHook();
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify({ entries }, null, 2), "utf8");
      try {
        renameSync(tmp, file);
      } catch (err2) {
        // A concurrent writer may have created the file first. Re-read, merge,
        // write once more; if even that races the entry is lost — a ledger miss
        // fails the merge closed, which is the safe direction.
        // #1071 — the lock (review-ledger-lock.ts) makes this fallback rare;
        // it remains for the lock's degraded path (a past-deadline wait or a
        // non-EEXIST open error returns a no-op release and the write runs
        // unlocked).
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
          // as the happy path: the round bump (the merged content may already
          // hold the previous latest lens entry, whose round the new one must
          // advance) and the dedupe (the merged file may carry stale rows).
          // The merge step is a pure helper (review-ledger-merge.ts) so the
          // ordering — push the bumped entry FIRST, then dedupe, the #1069
          // fix — is unit-testable without mocking node:fs. A race is rare; it
          // must not quietly write a ledger the happy path would never write.
          const deduped = mergeAfterRace(merged, stamped);
          writeFileSync(tmp, JSON.stringify({ entries: deduped }, null, 2), "utf8");
          renameSync(tmp, file);
        } catch (err3) {
          trace(`review-ledger: write failed: ${(err3 as Error).message}`);
          return `ledger write failed: ${(err3 as Error).message}`;
        }
      }
      return undefined;
    } finally {
      release();
    }
  } catch (err) {
    trace(`review-ledger: append failed: ${(err as Error).message}`);
    return `ledger append failed: ${(err as Error).message}`;
  }
}

// The read side lives in review-ledger-read.ts (file-size limit) and is
// re-exported here so every existing caller keeps importing from this module —
// the ledger's public surface is one module, not a hunt for the right file.
export {
  latestEntry,
  readLedgerAt,
  readLedgerFile,
  readLedgerFileSafe,
  validEntries,
} from "./review-ledger-read.ts";
