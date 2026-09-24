/**
 * work-driver-verify-verify-cmd — the verify-command gate of the develop
 * verify (per-worktree run + consolidated run + classification), extracted
 * from work-driver-verify-develop.ts by #794 (500-line gate).
 *
 * #669/#750/#782 semantics live here unchanged: the per-worktree failures
 * are the verdict when the consolidated run cannot run (no valid baseSha or
 * nothing to combine); otherwise the CONSOLIDATED tree is the verdict and
 * per-worktree failures downgrade to notes on a consolidated pass. #782's
 * single bounded flake re-run is caller-gated (every per-worktree verify
 * passed + a genuine N>1 consolidation) and happens inside
 * runConsolidatedVerify. #794 threads `workstreamBaseShas` into the
 * consolidated run so a stacked workstream's OWN range is picked against
 * its dependency's tip (no ancestor replay — the #775 shape).
 */
import path from "node:path";
import { describeSiblingFenceViolations } from "./work-develop-fence-verdicts.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import {
  NO_SPECIFIC_ASSERTION,
  buildPerWorktreeFailuresByWs,
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
  extractSpecificAssertion,
  sharesAssertion,
} from "./work-driver-consolidation-classify.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { provisionDepsHint } from "./work-driver-deps-hint.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import { formatExecError, verifyTimeoutMs } from "./work-driver-verify-develop-helpers.ts";
import { rawOutputClause } from "./work-driver-verify-flake.ts";
import type { WorkState } from "./workflow-state.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/**
 * #826 — the three-state per-worktree assertion for the flake-retry gate.
 * The RAW extracted assertion (a specific `✗`/error line found in the
 * failure text) or `null` when nothing assertion-shaped could be extracted
 * (honest absence, the NO_SPECIFIC_ASSERTION sentinel is NOT a known
 * assertion). Known-and-mismatching suppresses the re-run (the #821 defect);
 * unknown ALLOWS it (the pre-#826 behaviour for that case): absence on the
 * per-worktree side is not evidence the consolidated failure is an
 * independent defect.
 */
function gatePerAssertion(failureText: string | undefined): string | null {
  if (failureText === undefined) return null;
  const extracted = extractSpecificAssertion(failureText);
  return extracted === NO_SPECIFIC_ASSERTION ? null : extracted;
}

// #794 — the per-worktree + consolidated verify gate of the develop step
// (moved from work-driver-verify-develop.ts to keep that file under the
// 500-line gate; behaviour is a pure move, no logic change).
export async function runVerifyCommandGate(opts: {
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  cmd: string;
  ctx: DriverContext;
  state: WorkState;
  worktrees: Record<string, string>;
  baseSha: string | undefined;
  changedWorktrees: string[];
  workstreamBaseShas: Record<string, string> | undefined;
  failures: string[];
  notes: string[];
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
  /**
   * #841 — out-parameter for the consolidated run's persisted raw-output log
   * path (called with the log the gate actually wrote — `logPath` is
   * undefined when the write failed, so the caller never records a path
   * that does not exist on disk).
   */
  onConsolidatedLogPath?: (logPath: string) => void;
  /**
   * #814 — structured fence violations recorded by the scope gate earlier
   * in this same develop verify (the gate runs BEFORE the consolidated
   * verify, so the records already exist when the conflict branch fires).
   * When a sibling-declared violation exists, the conflict is the fence
   * materialising at consolidation, not an incoherent decomposition — the
   * failure string attributes it accordingly (workstream, file, declaring
   * sibling) and the "incoherent" claim is not asserted.
   */
  fenceViolations?: FenceViolationRecord[];
}): Promise<void> {
  const {
    execFn,
    cmd,
    ctx,
    state,
    worktrees,
    baseSha,
    changedWorktrees,
    workstreamBaseShas,
    failures,
    notes,
    onVerifyFlakeRecovered,
    fenceViolations,
    onConsolidatedLogPath,
  } = opts;
  const VALID_SHA_RE = /^[0-9a-f]{40}$/;
  const isValidSha = (s: string | undefined) => typeof s === "string" && VALID_SHA_RE.test(s);
  const perWorktreeVerifyFailures: string[] = [];
  for (const cwd of changedWorktrees) {
    try {
      await execFn(cmd, { cwd, timeout: verifyTimeoutMs(), maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
      // A verify command that fails for want of `node_modules` reports the
      // same shape as one that fails on a real defect; development happens
      // in a fresh worktree, so this is the likelier of the two when it
      // matches — say so rather than implying the diff is at fault. The
      // consolidated run below decides whether this is a genuine per-
      // worktree defect (kept as a failure) or a cross-worktree artifact
      // (downgraded to evidence).
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      const depsHint = looksLikeMissingDeps(output) ? provisionDepsHint(state, cwd) : "";
      perWorktreeVerifyFailures.push(
        formatExecError(
          e,
          `verify command \`${cmd}\` exceeded its ${Math.round(verifyTimeoutMs() / 60000)}-min timeout in ${cwd}`,
          `verify command \`${cmd}\` failed in ${cwd}${depsHint}`,
        ),
      );
    }
  }
  // #750 — the develop gate reads the CONSOLIDATED tree, not the isolated
  // worktrees: a per-worktree verify cannot see a file a sibling's commit
  // supplies (or deletes), and the #750 regression proves the combined
  // state is the only state worth testing. The combined tree is built from
  // every worktree that has commits ahead of baseSha, so the gate runs
  // when any committed worktree is non-trivial to consolidate — i.e. any
  // worktree with committed work exists and the root itself is not the
  // only worktree (N=1 with the root as the worktree is the combined tree).
  const consolidationNeeded = changedWorktrees.length > 0;
  // #750 — the consolidated run (which owns the dirty-root refusal at its
  // preflight) must run whenever there is ANY committed worktree: the
  // refusal fires even for the N=1 case where the only worktree is the
  // root itself, because operator residue on the root must not be swept
  // into the PR just because the combined tree is trivially the root.
  if (!consolidationNeeded || !isValidSha(baseSha)) {
    // No consolidation possible: the per-worktree results are the verdict.
    // The only reachable skip is "changed work exists but no valid baseSha"
    // (without it the combined tree cannot be built); with no changed
    // worktrees there is nothing to combine, so no note is recorded.
    failures.push(...perWorktreeVerifyFailures);
    if (consolidationNeeded && !isValidSha(baseSha)) {
      notes.push(
        "consolidated verify skipped — no valid baseSha to build the combined tree against, so the per-worktree evidence is the verdict",
      );
    }
    return;
  }
  const scratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  // #807 — the retry gate and the Case-2 root-cause match below must read
  // the SAME per-worktree failure map: if the retry fires on one view of
  // the failures and the classifier later compares a different, filtered
  // view, a "shared assertion" decision can diverge between the gate and
  // the verdict (the #798 class of marker-vs-marker mismatch). Both now
  // read `perWorktreeFailuresByWs`.
  const perWorktreeFailuresByWs = buildPerWorktreeFailuresByWs(
    worktrees,
    changedWorktrees,
    perWorktreeVerifyFailures,
  );
  // #782/#807/#826 — the consolidated-verify flake retry, two-phase gate:
  // (1) a length-only precondition admits the FIRST consolidated run — it
  // fires when this is a genuine consolidation (N>1) AND the per-worktree
  // failures are at most one (zero = the #782 shape; one = a possible
  // flake, the #798 shape where a timing-flaky test failed in a worktree
  // AND on the combined tree — one unstable test, not two independent
  // defects). The consolidated assertion is not known before the run, so
  // nothing more can be checked up front.
  // (2) the RE-RUN is decided by onFirstFailure against the RAW first-run
  // failure (deliberately raw: the elided detail can drop the ✗ line —
  // see #827 — while the classifier compares the elided detail): a KNOWN
  // per-worktree assertion that the first run does NOT share is suppressed
  // (a single per-worktree failure with a different assertion is a genuine
  // defect — the re-run would burn a full verify run and could mask it,
  // the #821 defect); a SHARED assertion or an UNKNOWN (unextractable) one
  // ALLOWS the re-run (pre-#826 behaviour for the unknown case). The
  // decision is computed ONCE in onFirstFailure and reported on the result
  // as `retryDecision` — the post-run notes are rendered from it, not from
  // a second comparator call.
  const singlePerWorktreeFailure = perWorktreeVerifyFailures.length === 1;
  const flakeRetryPrecondition =
    (!singlePerWorktreeFailure || Object.keys(perWorktreeFailuresByWs).length === 1) &&
    Object.keys(worktrees).length > 1;
  // The #807 invariant: the per-worktree assertion is extracted BEFORE the
  // consolidated run so the post-run note reads the same value the
  // classifier will compare. `null` = honest absence (nothing extractable),
  // which the gate treats as unknown, not as a mismatch.
  const singlePerWs = singlePerWorktreeFailure
    ? Object.keys(perWorktreeFailuresByWs)[0]
    : undefined;
  const singlePerAssertion: string | null | undefined =
    singlePerWs !== undefined ? gatePerAssertion(perWorktreeFailuresByWs[singlePerWs]) : undefined;
  const cons = await runConsolidatedVerify(execFn, {
    repoRoot: ctx.repoRoot,
    baseSha: baseSha as string,
    worktrees: state.pipelineState.worktrees ?? {},
    // #794 — own-range selection: a stacked workstream's range is
    // measured against its dependency's tip, so its ancestor commits are
    // not re-picked on top of their content (the #775 replay).
    workstreamBaseShas,
    scratchDir,
    verifyCmd: cmd,
    timeoutMs: verifyTimeoutMs(),
    retry: {
      canRetry: flakeRetryPrecondition,
      onFirstFailure: (raw) => {
        if (singlePerAssertion === undefined) {
          return { allowed: true, decision: "allowed-no-per-worktree-failure" };
        }
        if (singlePerAssertion === null) {
          return { allowed: true, decision: "allowed-unknown" };
        }
        return sharesAssertion(raw, singlePerAssertion)
          ? { allowed: true, decision: "allowed-shared" }
          : { allowed: false, decision: "suppressed-mismatch" };
      },
      onRecover: (evidenceTail) => {
        // #841 — onRecover fires BEFORE the run result is available, so the
        // log path is not in scope here. The post-run pass below (the
        // `cons.recovered === true` branch) surfaces the run1 log path in
        // its own note, which is the one the operator actually reads when
        // the gate proceeds after recovery.
        notes.push(
          `consolidated verify RECOVERED after one bounded re-run (transient flake) — first-run failure preserved${evidenceTail ? `: ${evidenceTail}` : ""}`,
        );
        // The decision note rides on the recorded `retryDecision` AFTER the
        // consolidated run (below), where the same value also drives the
        // failed-path notes — one read, no closure cell.
        onVerifyFlakeRecovered?.(evidenceTail);
      },
    },
  });
  // The decision is recorded ONCE by the consolidated run (see onFirstFailure
  // above) and reported on the failed/passed result as `retryDecision` —
  // every post-run note below renders from this value, never a second
  // comparator call. A conflict outcome (refusal or cherry-pick failure)
  // never records one.
  const consRetryDecision =
    cons.status === "failed" || cons.status === "passed" ? cons.retryDecision : undefined;
  if (cons.status === "conflict") {
    // #725 — "conflict" has TWO causes: a genuine cherry-pick / patch-apply
    // conflict (a decomposition error) and the repoRoot-dirty preflight
    // refusal (operator residue — #668/#714). Routed on the structured
    // `kind`, not the detail prose; a dirty root is cleared with git status.
    if (cons.kind === "dirty-root") {
      failures.push(
        `consolidated verify was refused — repoRoot is dirty (${cons.detail}). Leftover residue from an earlier cycle, NOT a workstream conflict or verify failure: run \`git status\` at the repo root, clear the residue, and re-run the cycle`,
      );
    } else {
      // #814 — the "incoherent decomposition" claim is asserted ONLY when
      // the driver has NO recorded fence evidence. When a sibling-declared
      // fence violation exists (the #792/#794 shape: declared paths were
      // DISJOINT — a developer wrote outside its scope, and the conflict is
      // that violation materialising at consolidation), the conflict is the
      // FENCE's consequence, and re-splitting the plan fixes nothing: name
      // the violating workstream, the file, and the declaring sibling
      // instead of re-diagnosing a plan that was never wrong.
      // #814 — the sibling-declared attribution sentence is the shared
      // describeSiblingFenceViolations (one home for the wording; the
      // explainConsolidation fence branch renders the same sentence).
      const named = describeSiblingFenceViolations(fenceViolations ?? []);
      if (named !== undefined) {
        failures.push(
          `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail}). The develop scope fence recorded a sibling-declared violation BEFORE this conflict: ${named}. The declared paths are disjoint — the decomposition is fine; the fence was violated and the conflict is its consequence at consolidation. Re-splitting the plan will NOT fix this; restore the fence boundary (the touching workstream's commit must not include that file) and re-run`,
        );
      } else {
        failures.push(
          `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail}). Two workstreams edited the same lines; the decomposition is incoherent, which is distinct from a verify failure`,
        );
      }
    }
  } else if (cons.status === "failed") {
    // #777/#807 — classify the consolidated-tree failure (see the
    // classifier module docstring for the three-way distinction). #782 —
    // when the flake re-run happened (and also failed), the detail is the
    // second run's tail; a test that fails twice is not a flake, so the
    // cycle parks as today.
    const wsIds = Object.keys(worktrees);
    // #807/#826 — post-run annotation, rendered from the decision computed
    // ONCE in onFirstFailure (no second comparator call; the mismatch
    // branch is unreachable here because suppression withheld the re-run
    // before this point).
    if (cons.retried === true && singlePerWs !== undefined) {
      if (consRetryDecision === "allowed-shared" && singlePerAssertion !== null) {
        notes.push(
          `flake retry fired despite a per-worktree failure — workstream '${singlePerWs}' and the consolidated tree failed on the SAME assertion (${singlePerAssertion}), which is one unstable test failing twice, not two independent defects`,
        );
      } else if (consRetryDecision === "allowed-unknown") {
        notes.push(
          `flake retry fired despite a per-worktree failure — workstream '${singlePerWs}' failed but no assertion could be extracted from its failure, so the re-run was allowed (pre-#826 behaviour for the unknown case) and also failed`,
        );
      }
    }
    if (
      consRetryDecision === "suppressed-mismatch" &&
      singlePerWs !== undefined &&
      singlePerAssertion !== null
    ) {
      // #826 — suppression is observable: name the per-worktree assertion
      // and state that the re-run was WITHHELD (bounded evidence only —
      // the raw failure text is never embedded in a note).
      const boundedPer = perWorktreeFailuresByWs[singlePerWs]
        ? extractAttributedTail(perWorktreeFailuresByWs[singlePerWs] ?? "", 800).tail
        : "";
      notes.push(
        `flake re-run WITHHELD — workstream '${singlePerWs}' failed with assertion (${singlePerAssertion}) while the consolidated first run failed on a different assertion, so a single re-run was suppressed as likely masking a genuine defect${boundedPer ? ` — per-worktree evidence: ${boundedPer}` : ""}`,
      );
    }
    // #841 — the classifier reads the bounded tail of the RAW verify
    // failure, NOT `cons.detail` (which now carries the log path + restore
    // claim). The raw stream is carried structurally on the result
    // (`rawFailure`) instead of being regexed out of the detail prose —
    // the log path on the result is likewise spliced in without parsing.
    const rawFailure = cons.rawFailure ?? "";
    const { tail } = extractAttributedTail(rawFailure, 800);
    const classifierInput =
      tail.length > 0
        ? tail
        : rawFailure.length > 0
          ? rawFailure
          : "verify command exited non-zero";
    const verdict = classifyConsolidatedVerifyFailure(
      wsIds.length,
      wsIds,
      classifierInput,
      perWorktreeFailuresByWs,
    );
    // #841 — the log path must land in `failures[]` (which the gate pushes
    // into `verifyEvidence.failures` and the handoff renders) — not only in
    // `cons.detail` (which the classifier reads but does not surface in the
    // final message). The path is on the result, so we splice it into the
    // failure string here: the evidence must name the path so an operator
    // with "(no specific assertion could be extracted)" can open the file
    // and see the raw stream.
    // #841 — the shared rawOutputClause helper (single home for the
    // sentence so both verify seams render identically).
    const logClause = rawOutputClause(cons.logPath);
    failures.push(consolidatedFailureMessage(verdict, cmd) + logClause);
    // #841 — thread the ACTUAL written log path back (the write's own
    // return — undefined when the write failed, in which case there is
    // nothing to record structurally).
    if (cons.logPath !== undefined) onConsolidatedLogPath?.(cons.logPath);
  } else {
    notes.push(
      `consolidated verify passed — workstreams ${cons.applied.join(", ")} combined in one tree passed \`${cmd}\`; per-worktree verify failures are recorded as evidence, not failures, because the combined tree is the verdict for cross-worktree artifacts`,
    );
    // #841 — on a RECOVERED pass (run1 failed, run2 passed), the run1 log
    // is the only record of the transient failure and the operator needs
    // to know where it is. The log path is on the result, so the note
    // reads it here rather than threading it through the onRecover callback
    // (whose signature is `(evidenceTail?: string) => void` and predates
    // #841).
    if (cons.recovered === true && cons.logPath) {
      notes.push(`recovered run — raw first-run output preserved at ${cons.logPath}`);
    }
    // #826 — recovery is as observable as failure: when the re-run recovered
    // a first-run failure that shares a KNOWN per-worktree assertion (or is
    // attributed to a transient flake, the `allowed-unknown` case), record
    // the per-worktree failure evidence here — BOUNDED to the extracted
    // assertion plus an attributed 800-char tail, never the raw failure
    // text. Rendered from `cons.retryDecision` (the value the seam recorded
    // once); `allowed-no-per-worktree-failure` has no per-worktree failure
    // to evidence and is left to the RECOVERED note emitted in onRecover.
    if (
      cons.recovered === true &&
      singlePerWs !== undefined &&
      (consRetryDecision === "allowed-shared" || consRetryDecision === "allowed-unknown")
    ) {
      const boundedPer = perWorktreeFailuresByWs[singlePerWs]
        ? extractAttributedTail(perWorktreeFailuresByWs[singlePerWs], 800).tail || "(no tail)"
        : "(no tail)";
      if (consRetryDecision === "allowed-shared" && singlePerAssertion !== null) {
        notes.push(
          `recovered with a per-worktree failure present — workstream '${singlePerWs}' failed on the SAME assertion (${singlePerAssertion}) as the consolidated first run — one unstable test, not two independent defects — per-worktree evidence: ${boundedPer}`,
        );
      } else {
        // `allowed-unknown`: the per-worktree assertion was not
        // extractable, so the recovery is attributed to a transient
        // flake and the per-worktree failure stands as evidence.
        notes.push(
          `recovered with a per-worktree failure present — workstream '${singlePerWs}' failed (assertion not extractable from the per-worktree failure; recovery attributed to a transient flake) — per-worktree failure stands as evidence: ${boundedPer}`,
        );
      }
    }
  }
  // Aggregation: a consolidated PASS downgrades per-worktree failures
  // to evidence; a consolidated FAILURE keeps them as failures.
  if (cons.status === "passed") {
    for (const f of perWorktreeVerifyFailures) notes.push(`per-worktree verify (evidence) — ${f}`);
  } else {
    failures.push(...perWorktreeVerifyFailures);
  }
}

// `verifyCmdFor` re-exported so the caller keeps its pre-#794 import
// surface (it already imports the symbol from work-driver-verify-cmd.ts;
// this re-export is a no-op safety net, kept for import-graph symmetry).
export { verifyCmdFor };
