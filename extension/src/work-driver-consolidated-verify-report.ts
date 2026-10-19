/**
 * #1240 (extraction) — the post-run reporting half of the develop step's
 * consolidated verify: how a `runConsolidatedVerify` outcome becomes
 * `failures[]` entries and operator `notes[]`.
 *
 * This is a pure move of the block that sat inline in
 * `runVerifyCommandGate`, which had grown past the AGENTS.md §12 line cap
 * while carrying three separate concerns (run the per-worktree gate, run the
 * probe, describe what the probe said). No behaviour changed here: the same
 * conditions, the same prose, the same order of pushes. It lives separately
 * because the three-way conflict routing (#725), the flake-retry annotations
 * (#826) and the skip note (#1240) are worth reading without the run-loop
 * around them, and because a description that can be read on its own is a
 * description that can be wrong on its own.
 *
 * The rule this block exists to enforce, stated once: **a note never claims a
 * command ran that did not run.** That is why the #1240 skip has its own
 * branch and its own wording rather than reusing the "consolidated verify
 * passed" note.
 */

import { describeSiblingFenceViolations } from "./work-develop-fence-verdicts.ts";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
  consolidatedRunWhere,
} from "./work-driver-consolidation-classify.ts";
import {
  extractAttributedTail,
  hostExhaustionFailure,
  isHostExhaustionFailure,
} from "./work-driver-exec-error.ts";
import { isHostForkExhaustion, pidLimitSnapshot } from "./work-driver-exec-error.ts";
import { describeObservedConsolidationConflict } from "./work-driver-explain-consolidation.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import { TIER_KNOB } from "./work-driver-verify-budget.ts";
import { verifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import { rawOutputClause } from "./work-driver-verify-flake.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

export interface ConsolidatedVerifyReporting {
  cmd: string;
  failures: string[];
  notes: string[];
  /**
   * #1509 — the bound the consolidated run was given, and the knob that
   * governed it. Both are threaded from the caller rather than re-read: a
   * reporter that called a resolver itself could print a bound other than the
   * one the run was killed at, and could name the wrong knob for a commit-pr
   * run bounded by the integration knob. `timeoutMs` is required for the
   * caller that has a run; a caller with no run behind the failure strings
   * (a decline or conflict path) passes the bound it would have used.
   */
  timeoutMs: number;
  timeoutKnob?: string;
  /** Only `repoRoot` is read. */
  ctx: { repoRoot: string };
  worktrees: Record<string, string>;
  /**
   * #813 — the plan's workstreams, read for their declared `paths` only: the
   * no-fence conflict text says "likely coupled" when the failure names a
   * file a sibling declared. Absent → the neutral observed sentence.
   */
  workstreams?: Record<string, { paths: string[] } | undefined>;
  perWorktreeFailuresByWs: Record<string, string>;
  singlePerWs: string | undefined;
  singlePerAssertion: string | null | undefined;
  /** The develop fence's records — #814 attributes a conflict to a sibling. */
  fenceViolations?: FenceViolationRecord[];
  onConsolidatedLogPath?: (logPath: string) => void;
  /** #1240 — the skip's identity, handed to the caller to record as an event. */
  onConsolidatedVerifySkipped?: (skipped: AlreadyVerifiedTree) => void;
  /**
   * #1421 fix round — the gate declined to consolidate on nothing but build
   * residue. Reported STRUCTURALLY (the result's `buildResidueOnly`), never by
   * matching the label out of the failure prose: a path the operator named
   * `build/[build-residue].log` is text, not a routing key, and a real verify
   * failure beside it must still reach `verify-failed:develop`.
   */
  onBuildResidueOnly?: () => void;
  /**
   * #1427 — called with the path of the persisted gate-hang report, when the
   * consolidated run was killed at its bound and the write succeeded.
   */
  onGateHangLogPath?: (logPath: string) => void;
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
}

/**
 * #813 — the declared paths per workstream, for the coupled-pair clause.
 * An absent plan (no `workstreams` on the state) yields `{}`.
 */
function declaredPathsByWorkstream(
  workstreams: ConsolidatedVerifyReporting["workstreams"],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, ws] of Object.entries(workstreams ?? {})) {
    if (ws && Array.isArray(ws.paths) && ws.paths.length > 0) out[id] = ws.paths;
  }
  return out;
}

export function reportConsolidatedVerifyOutcome(
  cons: ConsolidatedVerifyResult,
  {
    cmd,
    failures,
    notes,
    timeoutMs,
    timeoutKnob,
    ctx,
    worktrees,
    workstreams,
    perWorktreeFailuresByWs,
    singlePerWs,
    singlePerAssertion,
    fenceViolations,
    onConsolidatedLogPath,
    onVerifyFlakeRecovered,
    onConsolidatedVerifySkipped,
    onBuildResidueOnly,
    onGateHangLogPath,
  }: ConsolidatedVerifyReporting,
): void {
  // The decision is recorded ONCE by the consolidated run (the caller's
  // `onFirstFailure`) and reported on the failed/passed result as
  // `retryDecision` — every note here renders from that value, never a second
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
        `consolidated verify was refused — repoRoot is dirty (${cons.detail}). NOT a workstream conflict or a verify failure: the named paths are tracked or unignored content the probe's checkout would carry onto the scratch branch (yours, or a previous cycle's — the gate cannot tell and preserves both). Run \`git status\` at the repo root, decide what each one is (commit, move, or gitignore it), and re-run the cycle. A cycle that left the root like this on purpose says so in its own handoff and names the tree it saved`,
      );
    } else if (cons.kind === "build-residue") {
      // #1421 — the gate DECLINED to refuse: every path was untracked and
      // git-ignored, i.e. build output. Nothing was judged, so the failure
      // string carries the `[build-residue]` label the cap router reads
      // (`verify-env:develop`, not `verify-failed:develop`) rather than the
      // conflict wording the router matches on for a decomposition error.
      //
      // #1421 fix round — the label in this string is for the OPERATOR; the
      // cap router reads the structured flag below. Emitting it and nothing
      // else is what made a prose substring the routing key, so an unrelated
      // failure whose text happened to contain the tag decided the cap.
      failures.push(cons.detail);
      if (cons.buildResidueOnly === true) onBuildResidueOnly?.();
    } else if (cons.kind === "host") {
      // The host could not fork, so nothing was combined: neither a conflict
      // nor a verify failure. The message deliberately avoids the conflict
      // wording the cap router matches on.
      failures.push(hostExhaustionFailure("consolidated verify", cons.detail, pidLimitSnapshot()));
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
        // #813 — no fence record: report what was OBSERVED (which patch
        // failed, what applied cleanly before it) instead of asserting "two
        // workstreams edited the same lines; the decomposition is
        // incoherent". #1005 merges coupled workstreams at plan time, so the
        // pair that still collides is usually coupled through types with
        // disjoint declared paths — where re-splitting is not the fix. One
        // renderer's sentence, shared with the cap explanation via
        // describeObservedConsolidationConflict. `cons.detail` is deliberately
        // NOT passed as `evidence`: this renderer already embeds it in the
        // lead, and only the structured pick fields are trustworthy enough to
        // license the "likely coupled" wording — a `detail` string is an
        // ungoverned message that could manufacture that diagnosis.
        failures.push(
          describeObservedConsolidationConflict({
            lead: `consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (${cons.detail})`,
            conflictedWorkstream: cons.conflictedWorkstream,
            appliedBeforeConflict: cons.appliedBeforeConflict,
            conflictedFile: cons.conflictedFile,
            declaredPathsByWorkstream: declaredPathsByWorkstream(workstreams),
          }),
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
    // #1064 — with ONE workstream the consolidated probe is not a combination:
    // it cherry-picks that workstream's own commits onto its own base, so the
    // tree it verified IS that workstream's worktree, and "the CONSOLIDATED
    // tree" describes a combination that never happened. The tree is then named
    // exactly the way the per-worktree run names a tree (`… failed in <cwd>`).
    //
    // Only the genuinely unresolvable shapes keep the CONSOLIDATED wording: N>1
    // (a real combination) and a map with no worktree for the one workstream —
    // where there is no path to name and a workstream ID would be a lie (`failed
    // in default` is not a location). The probe runs under `repoRoot` in both,
    // so the N>1 clause keeps naming it, as before.
    //
    // The decision is made ONCE here and read by the three sites below (this
    // message, the timeout clause, the host-exhaustion clause), so the
    // `failures[]` entry and the handoff that renders it cannot name different
    // trees for one failure.
    const ownTree = wsIds.length === 1 ? worktrees[wsIds[0] ?? ""] : undefined;
    const treeClause = consolidatedRunWhere(wsIds.length, ownTree, ctx.repoRoot).phrase;
    // A run KILLED at the bound never reached a verdict: its stream stops
    // wherever the kill landed, and classifying that reported a timeout as
    // "specific assertion: (no specific assertion could be extracted)" — a
    // claim about the code. Report the bound instead, as the per-worktree
    // run above already does.
    // A verify command the host could not fork never ran, so the classifier's
    // verdict ("[needs-human-decision] … no specific assertion could be
    // extracted") would be a judgement about code nobody executed. Read from
    // the same bounded evidence the classifier saw, not the whole stream — a
    // passing stage that merely prints the phrase must not relabel a real
    // failure further down.
    failures.push(
      (cons.timedOut === true
        ? // #1427 — the hang report carries the test names, the process tree and
          // the output tail, so the headline stays the plain timeout sentence and
          // the report is pointed at structurally (`hangLogPath` below, thence to
          // the cap event and the handoff).
          `${verifyTimeoutFailure(
            cmd,
            // #1064 — same clause; at N=1 the repoRoot suffix is dropped because
            // the probe's scratch checkout is not the workstream's tree.
            ownTree === undefined ? `on the CONSOLIDATED tree at ${ctx.repoRoot}` : treeClause,
            timeoutMs,
            timeoutKnob ?? TIER_KNOB.suite,
          )}.`
        : isHostForkExhaustion(classifierInput)
          ? // #1064 — the same clause, so the three sites cannot name different
            // trees for one failure.
            hostExhaustionFailure(
              `verify command \`${cmd}\` ${treeClause}`,
              classifierInput,
              pidLimitSnapshot(),
            )
          : consolidatedFailureMessage(verdict, cmd, ownTree, ctx.repoRoot)) + logClause,
    );
    // #841 — thread the ACTUAL written log path back (the write's own
    // return — undefined when the write failed, in which case there is
    // nothing to record structurally).
    if (cons.logPath !== undefined) onConsolidatedLogPath?.(cons.logPath);
    // #1427 — the hang report's path, on the same structural channel #841 uses
    // for the raw logs, so the cap event carries it and no renderer greps prose.
    if (cons.hangLogPath !== undefined) onGateHangLogPath?.(cons.hangLogPath);
  } else {
    // #1240 — the probe was skipped because its tree is the tree that just
    // passed the per-worktree run. Recorded as an explicit note rather than
    // silence: "consolidated verify passed" would claim a command ran that
    // never ran, and the operator reading a 20-minute gap that is no longer
    // there needs to know why.
    if (cons.skipped !== undefined) {
      // The event (appended by the caller, where the event log is) is the
      // durable record; the note is the same fact in the gate's own voice.
      onConsolidatedVerifySkipped?.(cons.skipped);
      notes.push(
        `consolidated verify skipped: tree ${cons.skipped.treeHash} already passed in ${cons.skipped.worktree} — the single workstream's own commits are the whole combination, so the consolidated tree is byte-identical to the tree the per-worktree verify just judged (Set PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP=0 to run it anyway)`,
      );
    } else {
      // #1005 — per-worktree failures still BLOCK (the aggregation below keeps
      // them as failures); this note records the PASSING combined run as
      // evidence only — it shows the combination is not the cause, but a
      // workstream that fails in its OWN tree is not excused.
      notes.push(
        `consolidated verify passed — workstreams ${cons.applied.join(", ")} combined in one tree passed \`${cmd}\`; the passing combined run is recorded as evidence only — per-worktree verify failures STILL BLOCK (a workstream that fails in its own tree must block, #1005)`,
      );
    }
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
}
