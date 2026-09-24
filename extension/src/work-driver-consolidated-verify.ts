// #669 — consolidated develop-time verify: all workstreams' commits
// cherry-picked onto the integration branch at repoRoot, then ONE verify
// run against the combined tree. The develop-time twin of the commit-pr
// verify in `integrate()`: same `orchestrateCherryPick` machinery, same
// restore-on-failure contract. Differences: NO push, NO worktree advance
// (#453 invariant — worktrees are only advanced after a successful push,
// which commit-pr owns); `requireAllNonEmpty: false` (a workstream with no
// commit simply contributes nothing); repoRoot is ALWAYS restored
// afterwards (the combined tree is a transient probe; leaving it on a
// scratch ref would break the next integration's dirty-preflight).

import { trace } from "./trace.ts";
import { isDriverManagedDirtLine } from "./work-driver-branch-residue.ts";
import { orchestrateCherryPick } from "./work-driver-cherry-pick.js";
import type { DriverContext } from "./work-driver-context.js";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { restoreClaim, verifiedRestoreRoot } from "./work-driver-restore.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import {
  combinedExecFailureStream,
  rerunConsolidatedVerifyOnce,
  writeConsolidatedVerifyLog,
} from "./work-driver-verify-flake.ts";

/**
 * #826 — the recorded outcome of the flake-retry decision, computed ONCE in
 * `onFirstFailure` (inside `runConsolidatedVerify`) and reported on the
 * result as `retryDecision` so the caller renders its notes from the value
 * instead of a second `sharesAssertion` call:
 *
 * - `"allowed-no-per-worktree-failure"` — the re-run was allowed because
 *   there was no per-worktree failure to compare against (the #782 shape).
 * - `"allowed-shared"` — the per-worktree assertion is KNOWN and shared by
 *   the first consolidated run's RAW failure (one unstable test).
 * - `"allowed-unknown"` — the per-worktree assertion was NOT extractable
 *   (honest absence); the re-run was allowed, preserving pre-#826 behaviour
 *   for that case — absence is not evidence of a mismatch.
 * - `"suppressed-mismatch"` — the per-worktree assertion is KNOWN and the
 *   first consolidated run did NOT share it; the re-run was withheld (a
 *   single per-worktree failure with a different assertion is a genuine
 *   defect the re-run could mask — the #821 shape).
 */
export type ConsolidatedVerifyRetryDecision =
  | "allowed-no-per-worktree-failure"
  | "allowed-shared"
  | "allowed-unknown"
  | "suppressed-mismatch";

export async function runConsolidatedVerify(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  opts: {
    repoRoot: string;
    baseSha: string;
    branchName?: string;
    worktrees: Record<string, string>;
    scratchDir: string;
    verifyCmd: string;
    timeoutMs: number;
    /**
     * #794 — per-workstream effective base map (`workstreamBaseShas`):
     * a stacked workstream's OWN range is measured against its dependency's
     * tip, not the global baseSha — the same map the develop step records
     * when it creates the dependent worktree (work-driver-dep-scheduler.ts).
     * A workstream with no entry falls back to `baseSha` (byte-identical to
     * the pre-#794 range for the N-disjoint case).
     */
    workstreamBaseShas?: Record<string, string>;
    /**
     * #782/#826 — the single bounded flake re-run, two-phase contract:
     * `canRetry` only ADMITS the first run (the length precondition —
     * caller-gated, N>1 at this seam); the FINAL allow/suppress decision is
     * made by `onFirstFailure` when the first run fails. When the re-run is
     * allowed it runs once on the SAME still-checked-out scratch tree
     * (BEFORE `restoreRoot`) and the outcome replaces the single-run
     * verdict: the re-run passes → `status: "passed"` + the `onRecover`
     * callback with the original failing tail (the caller emits
     * `verify-flake-recovered` and proceeds); the re-run fails → the SAME
     * failed shape as a single-run failure, with `retried: true` and
     * `recovered: false` so the caller records `retries: 1, recovered:
     * false` and classifies/parks exactly as today.
     * #826 — `onFirstFailure` fires with the RAW first-run failure text
     * (before `extractAttributedTail` elision) and returns the decision —
     * `{ allowed: boolean, decision: ConsolidatedVerifyRetryDecision }`.
     * `allowed: false` SUPPRESSES the re-run (e.g. a known per-worktree
     * assertion the first run did not share — a likely genuine defect).
     * `allowed: true` runs it. The decision is computed here, ONCE, and
     * reported on the failed/passed result as `retryDecision` so the
     * caller renders its notes from the recorded value instead of a second
     * comparator call. When no first-run failure occurs (or the callback is
     * absent) `retryDecision` is undefined.
     */
    retry?: {
      canRetry: boolean;
      onRecover: (evidenceTail?: string) => void;
      onFirstFailure?: (
        rawFailure: string,
      ) => { allowed: boolean; decision: ConsolidatedVerifyRetryDecision } | undefined;
    };
  },
): Promise<
  | {
      status: "passed";
      applied: string[];
      recovered?: boolean;
      retryDecision?: ConsolidatedVerifyRetryDecision;
      /**
       * #841 — the absolute path of the run1 log (the consolidated first
       * run that failed and was recovered by the flake re-run). Present only
       * on `recovered: true` results; the caller surfaces it in the recovery
       * note. Absent on a passing run that never failed and on a failed
       * result (where `logPath` on the failed shape carries the run that
       * ended the run).
       */
      logPath?: string;
    }
  | {
      status: "failed";
      detail: string;
      retried?: boolean;
      recovered?: boolean;
      retryDecision?: ConsolidatedVerifyRetryDecision;
      /**
       * #841 — the absolute path of the LAST consolidated-verify run's raw
       * log (the run2 log when `retried === true`, the run1 log otherwise).
       * `undefined` when the write failed (unwritable scratch dir, etc.) —
       * the caller then says the log is unavailable in the evidence string.
       * The ticket asks the path to appear in the cap-hit evidence, so it
       * is threaded here rather than regexed out of `detail`.
       */
      logPath?: string;
      /**
       * #841 — the RAW failure stream of the run that ended the run (the
       * run2 raw stream when `retried === true`, the run1 raw stream
       * otherwise), carried structurally so the caller's classifier reads
       * the same shape a single-run failure reads — without parsing the
       * log path / restore claim back out of `detail` prose.
       */
      rawFailure?: string;
    }
  // #725 — the caller distinguishes a genuine cherry-pick / patch-apply
  // conflict from a dirty-repoRoot preflight refusal via `kind`, not by
  // regexing the `detail` prose (a reworded message used to silently
  // re-route the refusal to the conflict cap).
  | { status: "conflict"; detail: string; kind: "conflict" | "dirty-root" }
> {
  const { repoRoot, baseSha, worktrees, scratchDir, verifyCmd, timeoutMs } = opts;
  // #794 — the pick scope: each workstream's own range is measured against
  // its effective base (the dependency's tip for a stacked workstream), so
  // a dependent's ANCESTOR commits are not re-picked on top of their
  // content. `workstreamBaseShas` entries are resolved per workstream inside
  // `orchestrateCherryPick`; a missing entry falls back to `baseSha`.
  const pickScope = { globalBaseSha: baseSha, workstreamBaseShas: opts.workstreamBaseShas };
  const retry = opts.retry;
  // A scratch branch name no other step of the cycle ever creates. Deleted
  // on the restore path below (a leftover branch costs nothing, but noise
  // is noise; the worktrees are untouched either way).
  const branchName = "pi-rukas-dev-verify";
  let originalRef: string | undefined;
  // #750 — the restore is verified, not assumed: preserves the discarded
  // state, resets, restores the checkout, and reports success only when the
  // porcelain read confirms the root is clean. The caller emits that
  // post-condition — it no longer asserts an unverified "restored".
  const restoreRoot = async (): Promise<VerifiedRestoreResult> => {
    if (!originalRef) return { restored: true };
    const result = await verifiedRestoreRoot(execFn, {
      repoRoot,
      originalRef,
      scratchDir,
      label: "consolidated verify",
    });
    // Delete the scratch branch so it does not accumulate on every develop
    // re-entry. Failure is non-fatal (a leftover branch costs nothing).
    await execFn(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined);
    return result;
  };
  // The verified post-condition for the operator, via the shared claim
  // builder (the not-restored variant carries the preserved-diff location and
  // the still-dirty detail — the loud failure, never a bare "restored").
  const restoreClaimFor = (r: VerifiedRestoreResult) =>
    restoreClaim(r, "the batch was aborted and");
  try {
    // Preflight — same as integrate(): repoRoot must be clean before we
    // touch its checkout, or a dirty root would carry operator residue
    // onto the probe branch. Refuse to consolidate rather than guess.
    // `.worktrees/` and `.pi/` scaffolding are not dirt; untracked `??` IS
    // dirt (see the integrate() preflight comment for the reasoning).
    // #746 AC5 — `-uall`, same as the branch-step early gate's read
    // (readRepoRootDirt): plain --porcelain collapses an untracked
    // directory tree to its top-level entry, so an operator would see a
    // bare `?? extension/` and have to go hunting; -uall names the
    // exact files, which is what the dirty-root message is for.
    const { stdout: rootStatus } = await execFn("git status --porcelain -uall", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const rootDirt = rootStatus.split("\n").filter((l) => l.trim() && !isDriverManagedDirtLine(l));
    if (rootDirt.length > 0) {
      trace("work-driver: consolidated verify — repoRoot dirty, refusing to consolidate");
      return {
        status: "conflict",
        kind: "dirty-root",
        detail: `repoRoot is dirty (${rootDirt
          .slice(0, 5)
          .map((l) => l.slice(3))
          .join(
            ", ",
          )}); consolidated verify skipped — the combination is unverifiable until the root is clean`,
      };
    }

    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );

    await execFn(`git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(baseSha)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });

    const orchResult = await orchestrateCherryPick(execFn, {
      repoRoot,
      branchName,
      worktrees: { ids: Object.keys(worktrees), worktrees, commitShas: {} },
      baseSha,
      scratchDir,
      requireAllNonEmpty: false,
      pickScope,
    });

    if (orchResult._conflict === "conflict") {
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `cherry-pick conflict — two workstreams edited the same lines; ${restoreClaimFor(restore)}`,
      };
    }
    if (orchResult._applyConflict !== undefined) {
      const { id, reason, patchFile } = orchResult._applyConflict;
      const restore = await restoreRoot();
      return {
        status: "conflict",
        kind: "conflict",
        detail: `patch-apply failed for workstream '${id}': ${reason}. Conflict patch preserved at ${patchFile}. ${restoreClaimFor(restore)}`,
      };
    }

    // #841 — ONE ISO timestamp per verify cycle: the run1 and run2 log
    // files share the same prefix (the ticket names them
    // `consolidated-verify-<ISO timestamp>-run<1|2>.log`), so the pair is
    // unambiguous to an operator inspecting scratchDir. The timestamp is
    // captured here, BEFORE the run1 attempt, so both runs of one cycle
    // carry the same value even if the flake retry fires milliseconds later.
    const runTimestamp = new Date().toISOString();
    let run1LogPath: string | undefined;
    // #841 — the run2 log path is NOT precomputed here: it comes from the
    // actual return of the run2 write (inside `rerunConsolidatedVerifyOnce`),
    // so a failed run2 write is reported as "unavailable" rather than
    // naming a file that does not exist on disk.
    let run2LogPath: string | undefined;
    // Run the verify command against the combined tree.
    let verifyFailure: string | undefined;
    try {
      await execFn(verifyCmd, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      verifyFailure = combinedExecFailureStream(e);
      // #841 — persist the RAW run1 stream before the bounded tail is
      // computed: the run1 log is the operator's only record of what the
      // first attempt printed, including the stdout that the pre-#841 `||`
      // shape dropped. The write never fails the step — a write error
      // leaves run1LogPath undefined and the caller's evidence string says
      // the log is unavailable.
      run1LogPath = writeConsolidatedVerifyLog(scratchDir, runTimestamp, 1, verifyFailure);
    }
    // #782/#826 — the single bounded flake re-run. It happens on the SAME
    // still-checked-out scratch tree, BEFORE `restoreRoot` (a re-run after
    // the restore would test the restored mainline, not the combination).
    // The retry decision (allow / suppress) is made ONCE in onFirstFailure
    // against the RAW first-run failure and reported on the result as
    // `retryDecision`; the caller renders its notes from that recorded
    // value, not from a second comparator call.
    let recovered = false;
    let retried = false;
    let retryDecision: ConsolidatedVerifyRetryDecision | undefined;
    // #841 — the raw stream of the run that ended the run, carried
    // structurally on the result (see the `rawFailure` field): run1 unless
    // the re-run below replaces it.
    let rawFailure: string | undefined = verifyFailure;
    if (verifyFailure !== undefined && retry?.canRetry) {
      const verdict = retry.onFirstFailure?.(verifyFailure);
      // One decision, one re-run: no callback (or no result from it) means
      // there was no per-worktree failure to compare against — the re-run
      // is allowed (the #782 shape).
      const { allowed, decision } =
        verdict === undefined
          ? { allowed: true as const, decision: "allowed-no-per-worktree-failure" as const }
          : { allowed: verdict.allowed, decision: verdict.decision };
      retryDecision = decision;
      if (allowed) {
        retried = true;
        // #841 — thread scratchDir + the SAME timestamp into the re-run so
        // the run2 log is written next to run1 with the matching prefix.
        // (The commit-pr twin seam in work-driver-integrate-verify.ts passes
        // neither argument and keeps its pre-#841 behaviour per the ticket's
        // scope.)
        const secondRun = await rerunConsolidatedVerifyOnce(
          execFn,
          verifyCmd,
          repoRoot,
          timeoutMs,
          scratchDir,
          runTimestamp,
        );
        if (secondRun === undefined) {
          recovered = true;
          // #841 — on recovery the run2 re-run passed, so it persisted no
          // log of its own (a pass has no raw stream); run1's log is the
          // only record of the transient failure and is what the caller
          // surfaces in the recovery note.
        } else {
          // #841 — the re-run also failed; `rerunConsolidatedVerifyOnce`
          // returned its RAW stream (not the bounded tail) so the
          // classification below sees the same shape a single-run failure
          // sees, and the run2 log was written inside the helper (same
          // scratchDir + timestamp + run=2). `logPath` is the write's own
          // return — `undefined` when the run2 write failed, which the
          // failure shape below reports as an unavailable log.
          verifyFailure = secondRun.raw;
          rawFailure = secondRun.raw;
          run2LogPath = secondRun.logPath;
        }
      }
    }
    const restore = await restoreRoot();
    const applied =
      orchResult.cherryApplied.length > 0 ? orchResult.cherryApplied : orchResult.patchApplied;
    if (recovered) {
      retry?.onRecover(verifyFailure);
      return {
        status: "passed",
        applied,
        recovered: true,
        retryDecision,
        // #841 — the caller (runVerifyCommandGate) names the run1 log in
        // the recovery note; the run2 re-run passed, so run1 is the
        // interesting record.
        logPath: run1LogPath,
      };
    }
    if (verifyFailure !== undefined) {
      // #723 — same attribution anchor as formatExecError: a bare `.slice(-800)`
      // can splice a passing sub-command's tail onto a later failure.
      const { tail, attributed } = extractAttributedTail(verifyFailure, 800);
      if (!attributed && tail) {
        trace("work-driver: consolidated verify tail is unattributed (no FAILED: marker found)");
      }
      const detail = tail
        ? attributed
          ? tail
          : `${tail} (unattributed — best-effort tail)`
        : "verify command exited non-zero";
      // #841 — the log that matters for THIS failure is run2 when a retry
      // fired (run2 is the run the classifier reads), run1 otherwise.
      // The log path rides on the result so the caller can include it in
      // the failure string (which lands in `verifyEvidence.failures` and
      // renders in the handoff) without regexing `detail`.
      const finalLogPath = retried ? run2LogPath : run1LogPath;
      const logClause = finalLogPath
        ? ` Raw output: ${finalLogPath}.`
        : " Raw output: unavailable.";
      // #750 — the verified post-condition rides with every outcome of the
      // probe run (the root is transient either way; an unverified claim
      // about it is exactly the incident).
      return {
        status: "failed",
        detail: `${detail}${logClause} ${restoreClaimFor(restore)}`,
        retried,
        recovered: false,
        retryDecision,
        logPath: finalLogPath,
        rawFailure,
      };
    }
    if (!restore.restored) {
      trace(
        `work-driver: consolidated verify — root not restored after a passing run: ${restore.detail}`,
      );
    }
    return { status: "passed", applied };
  } catch (err) {
    const restore = await restoreRoot();
    trace(
      `work-driver: consolidated verify — unexpected error: ${(err as Error).message?.slice(0, 200)}`,
    );
    return {
      status: "conflict",
      kind: "conflict",
      detail: `consolidation could not be performed: ${(err as Error).message?.slice(0, 200)}. ${restoreClaimFor(restore)}`,
    };
  }
}
