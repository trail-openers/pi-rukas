/**
 * workflow-state-validate — discriminant validation for /work state files.
 *
 * #533 — a reader hitting an unrecognised event kind or step value must
 * REFUSE to reconstruct rather than silently drop. One validator checks
 * every discriminant at read: eventLog[].kind, pipelineState.{currentStep,
 * status, lastCompletedStep}, and every WorkStep-typed event field.
 *
 * **Resume-path-only.** The driver runs the validator on every read;
 * /work-status and the queue do NOT. A TERMINAL state file with an unknown
 * kind must still load (a parked cycle's history has to stay observable).
 */

import { PLAN_VERDICTS } from "./workflow-state-events-caps.ts";
import { isKnownExitOrigin } from "./workflow-state-events-exit-origin.ts";
import { WORK_STEPS, type WorkEvent, type WorkStep } from "./workflow-state-events.ts";
import { prDraftFindings } from "./workflow-state-schema-pr-draft.ts";
import { WORK_STATE_SCHEMA_VERSION } from "./workflow-state-schema.ts";
import {
  CAP_HIT_NEXT_STEPS,
  KNOWN_CAPPED_PARTIAL_ROLES,
  KNOWN_STATUSES,
  isKnownCap,
} from "./workflow-state-validate-caps.ts";
// The consolidation + cap-checkpoint records are validated in their own module
// (#861 seam, AGENTS.md §12 file-size split); predicate + rationale there.
import {
  capEvidenceFindings,
  capedPartialStateFindings,
  consolidationCompletenessFindings,
  consolidationNotesFindings,
  incompleteConsolidationFindings,
} from "./workflow-state-validate-consolidation.ts";
export { KNOWN_STATUSES } from "./workflow-state-validate-caps.ts";
// #1362 — the cycle-start exempt-untracked baseline (#533 rule: type-check the
// untyped cast; predicate + rationale in workflow-state-dirty-root.ts).
import { dirtyRootExemptBaselineFindings } from "./workflow-state-dirty-root.ts";

/**
 * Known event kinds — a literal `as const` tuple (narrower than the
 * pre-#986 `readonly WorkEventKind[]`, which proved each entry was a valid
 * kind but not that the list was complete — the silent-resume-refusal bug
 * this issue fixes). Consumed at runtime by `validateDiscriminants` for
 * `eventLog[].kind` membership. Value-level consumers that need the wider
 * `readonly unknown[]` shape (e.g. for `.includes`) should cast:
 * `(KNOWN_EVENT_KINDS as readonly unknown[])` — the literal tuple type is
 * intentionally not widened here.
 *
 * The compile-time exhaustiveness assertion below (`[MissingEventKinds]
 * extends [never]`) makes tsc fail, naming the missing kind, if any
 * `WorkEvent` union member is added without also being listed here — the
 * src-side half of the guard; the smoke test in
 * smoke-tests/test-work-event-kinds-completeness.ts is the offline runtime
 * half (it is not type-checked by extension/tsconfig.json, so the
 * src-side assertion is the authoritative guard).
 */
export const KNOWN_EVENT_KINDS = [
  "step-started",
  "dispatch-started",
  "dispatch-completed",
  "dispatch-failed-provider",
  "dispatch-failed",
  "adversarial-approved",
  "adversarial-rejected",
  "adversarial-round",
  "adversarial-workstream-outcome",
  "adversarial-skipped-empty-diff",
  // #1114 — the adversarial→develop routing record and the fix pass's applied marker.
  "adversarial-fix-requested",
  "adversarial-fix-applied",
  "lens-approved",
  "lens-issues-found",
  "lens-skipped-empty-diff",
  // #1094 — explore re-dispatched once after a completed reply had no `## Spec`.
  "explore-retried",
  // #654 — the empty-diff re-dispatch marker; no step field (it names the
  // review round + worktree instead), so the validator's step check skips it.
  "lens-fix-empty-resend",
  "cap-hit",
  "plumb-report",
  "step-back-triggered",
  "step-back-completed",
  "handoff-emitted",
  "ci-status",
  "merged",
  "branches-fanned-out",
  "branch-completed",
  "branches-converged",
  "verify-full-status",
  // #782 — the consolidated-verify gate's single-retry recovery marker.
  "verify-flake-recovered",
  // #1240 — the consolidated-verify gate skipped its run because the probe
  // tree is the tree the per-worktree verify already judged. A fast `develop`
  // must be explainable from the state file.
  "consolidated-verify-skipped",
  // #1415 — one EXECUTED run of the driver's verify gate, with its duration
  // and command. Absent from the tuple, a resumed cycle halts on the very
  // event that says what the gate cost (#986's shape). Its `step` is a
  // WorkStep so the validator's step check covers it; `target` is not a
  // discriminant the validator knows, so it carries no unknown-value check.
  // #1404 — the consolidated verify failed and the cycle pushed anyway, because
  // every failing test is red at the cycle's base commit too. The one shape
  // where a red gate does not stop the push, so the state file must carry it.
  "consolidated-verify-pre-existing",
  // #1415 — the develop gate's verify run, bracketed so its time is visible.
  "verify-started",
  "verify-completed",
  // #558 — the branch step's worktree provisioning record (the driver writes
  // it when it symlinks dependencies into a fresh worktree). Absent from the
  // tuple, a cycle that crashed after provisioning refused to resume.
  "worktree-provisioned",
  "widening-scan",
  "memory-write",
  "memory-inject",
  // #741 — the converge gate's one-shot corrective dispatch marker.
  "converge-redispatch",
  // #625 — the develop step's safety-net commit record (the driver writes it
  // when it commits a workstream's in-scope work on a cap/failure exit).
  "safety-net-commit",
  // #1391 — the step-retry clean record (save, keep or refusal of a lost tree).
  "retry-tree-clean",
  // #674 — the handoff consolidation record (the driver writes it when it
  // consolidates parallel workstreams into a single handoff).
  "handoff-consolidated",
  // #735 — the branch step's leftover-worktree handling record (the driver
  // writes it when it adopts or removes a stale .worktrees/ entry).
  "worktree-leftover-handled",
  // #849 — the develop fence recovery marker (discarded SHA + owners).
  "fence-recovery-started",
  // #844 — the branch step's stale-local-branch reset record (old + new tip).
  // Absent from the tuple, EVERY restarted cycle that resets a stale branch
  // halts on its own re-entry (the fix manufactures the corruption it
  // exists to prevent).
  "branch-reset",
  // #799 — the slow-run crossing record (one per threshold crossing of a
  // driver dispatch, written between dispatch-started and
  // dispatch-completed). A state file written by a newer driver must
  // resume on an older one's reader without halting on an unknown kind.
  "dispatch-slow",
  // S4a (#1162) — the interrupt record (SIGTERM / SIGINT via markInterrupted).
  "interrupted",
  // The session-shutdown record. Absent from the tuple, the one cycle this
  // event promises is resumable would refuse to resume.
  "cycle-interrupted",
  // A residual-findings disclosure that did not reach the PR (and whether the
  // issue got it instead).
  "lens-residuals-post-failed",
  // #1398 — a residual-findings disclosure that DID reach the PR, keyed on the
  // reviewed patch: the fact the draft-ready gate holds on.
  "lens-residuals-posted",
  // #1652 — the plan step's refused report_workstream calls.
  "workstream-calls-refused",
] as const;

// #986 — compile-time exhaustiveness. If the `WorkEvent` union gains a kind
// not listed above, `MissingEventKinds` becomes that literal and the
// `[MissingEventKinds] extends [never]` constraint fails with a tsc error
// naming the kind (e.g. `Type '"lens-issues-found"' is not assignable to
// type 'never'`). A plain `extends` would not fire: the conditional is
// evaluated against a naked `never`, and `never extends [never]` is true,
// so wrapping both sides in tuples is what makes an empty missing-set and a
// non-empty one diverge.
type MissingEventKinds = Exclude<WorkEvent["kind"], (typeof KNOWN_EVENT_KINDS)[number]>;
const _eventKindExhaustive: [MissingEventKinds] extends [never] ? true : MissingEventKinds = true;
void _eventKindExhaustive;

/**
 * Human-readable findings; empty when every discriminant is a known value.
 * Each finding names the field AND the offending value — the driver halts
 * on a non-empty result and the message surfaces verbatim.
 */
export function validateDiscriminants(state: unknown): string[] {
  const out: string[] = [];
  if (typeof state !== "object" || state === null) {
    return ["state file is not an object"];
  }
  const s = state as Record<string, unknown>;

  if (s.schemaVersion !== WORK_STATE_SCHEMA_VERSION) {
    return [`schemaVersion=${String(s.schemaVersion)} (expected ${WORK_STATE_SCHEMA_VERSION})`];
  }

  const ps = s.pipelineState as Record<string, unknown> | null | undefined;
  if (typeof ps !== "object" || ps === null) {
    out.push("pipelineState is missing or not an object");
  } else {
    if (!WORK_STEPS.includes(ps.currentStep as WorkStep)) {
      out.push(`pipelineState.currentStep has unknown value ${JSON.stringify(ps.currentStep)}`);
    }
    if (
      ps.lastCompletedStep !== undefined &&
      !WORK_STEPS.includes(ps.lastCompletedStep as WorkStep)
    ) {
      out.push(
        `pipelineState.lastCompletedStep has unknown value ${JSON.stringify(ps.lastCompletedStep)}`,
      );
    }
    if (!KNOWN_STATUSES.includes(ps.status)) {
      out.push(`pipelineState.status has unknown value ${JSON.stringify(ps.status)}`);
    }
    // #539 review — the untyped cast in `readState` is the only runtime gate
    // for the record, so check it here: `commitPrRoot`, when present, must
    // be a complete `CommitPrRootState`. A partial object (a hand edit or a
    // corrupt write) would otherwise flow to the handoff renderers' arithmetic
    // as if every field were present, and render a confident wrong number.
    if (ps.commitPrRoot !== undefined) {
      const r = ps.commitPrRoot;
      if (typeof r !== "object" || r === null) {
        out.push("pipelineState.commitPrRoot is not an object");
      } else {
        const ro = r as Record<string, unknown>;
        if (typeof ro.branch !== "string" || Array.isArray(ro.branch)) {
          out.push("pipelineState.commitPrRoot.branch is missing or not a string");
        }
        if (!Array.isArray(ro.unmergedPaths)) {
          out.push("pipelineState.commitPrRoot.unmergedPaths is missing or not an array");
        }
        for (const field of ["stagedCount", "totalEntries", "capturedAt"] as const) {
          if (typeof ro[field] !== "number" || !Number.isFinite(ro[field] as number)) {
            out.push(`pipelineState.commitPrRoot.${field} is missing or not a finite number`);
          }
        }
      }
    }
    // #1362 — the cycle-start exempt-untracked baseline: which `??` files under
    // an exempt prefix a restore claim spares. Checked in its own module; the
    // same #533 rule as `commitPrRoot` above (the untyped cast is the gate).
    out.push(...dirtyRootExemptBaselineFindings(ps.dirtyRootExemptBaseline));
    // #1398 — the PR draft record, the same #533 rule as `commitPrRoot` above:
    // `markDraftPrReady` reads `status` to decide whether the PR may merge and
    // `findingsPosted` to decide whether a disclosure licenses that ready, so a
    // partial or hand-edited record is a confident wrong answer about whether a
    // PR is mergeable. Predicate + rationale in workflow-state-schema-pr-draft.ts;
    // absent validates (a cycle that never opened its PR as a draft).
    out.push(...prDraftFindings(ps.prDraft));
    // The five consolidation / cap-checkpoint records below (#540/#543/#728/
    // #778/#875/#1153/#1414) are checked in their own module — the same #533
    // "type-check the untyped cast" rule as `prDraft` and
    // `dirtyRootExemptBaseline` above, and the same #861 seam the cap
    // vocabulary used for the 500-line gate. Findings are appended in the
    // original order, so the reported list is unchanged.
    out.push(...incompleteConsolidationFindings(ps.incompleteConsolidation));
    out.push(...capEvidenceFindings(ps.capEvidence));
    out.push(...consolidationCompletenessFindings(ps.consolidationCompleteness));
    out.push(...consolidationNotesFindings(ps.consolidationNotes));
    out.push(...capedPartialStateFindings(ps.capedPartialState));
  }

  const log = s.eventLog;
  if (!Array.isArray(log)) {
    out.push("eventLog is missing or not an array");
  } else {
    log.forEach((entry, i) => {
      const e = entry as Record<string, unknown> | null | undefined;
      if (typeof e !== "object" || e === null) {
        out.push(`eventLog[${i}] is not an object`);
        return;
      }
      if (!(KNOWN_EVENT_KINDS as readonly unknown[]).includes(e.kind)) {
        out.push(`eventLog[${i}].kind has unknown value ${JSON.stringify(e.kind)}`);
        return; // an unrecognised kind's other fields are not worth parsing
      }
      if ("step" in e && e.step !== undefined && !WORK_STEPS.includes(e.step as WorkStep)) {
        out.push(`eventLog[${i}].step has unknown value ${JSON.stringify(e.step)}`);
      }
      if (e.kind === "cap-hit" && !CAP_HIT_NEXT_STEPS.includes(e.nextStep)) {
        out.push(`eventLog[${i}].nextStep has unknown value ${JSON.stringify(e.nextStep)}`);
      }
      // #543 — the dispatch-cap kill hits (loop-detected / token-budget)
      // carry the killed child's `role`. It stays OPTIONAL on the event
      // (every other cap has no role), but when PRESENT it must name a real
      // role — an unknown string would flow to the checkpoint and the
      // handoff renderers as a confident wrong attribution.
      if (
        e.kind === "cap-hit" &&
        (e.cap === "loop-detected" || e.cap === "token-budget") &&
        e.role !== undefined &&
        !KNOWN_CAPPED_PARTIAL_ROLES.includes(e.role)
      ) {
        out.push(
          `eventLog[${i}].role has unknown value ${JSON.stringify(e.role)} (cap ${String(e.cap)} names a killed child)`,
        );
      }
      // #543/#1338 — a cap-hit's `cap` must be a cap the driver can emit
      // (isKnownCap: the fixed literals, checked against WorkCapLiteral, or
      // a template value). #1263/#753/#973: an unknown cap fails re-entry.
      if (e.kind === "cap-hit" && typeof e.cap === "string" && !isKnownCap(e.cap)) {
        out.push(`eventLog[${i}].cap has unknown value ${JSON.stringify(e.cap)}`);
      }
      // #1652 — the plan verdict routes the explainer and the recovery, so an
      // unknown value would be rendered as a confident wrong cause. Optional.
      if (
        e.kind === "cap-hit" &&
        e.planVerdict !== undefined &&
        // The value is untrusted input here, so compare as a string.
        !(PLAN_VERDICTS as readonly unknown[]).includes(e.planVerdict)
      ) {
        out.push(`eventLog[${i}].planVerdict has unknown value ${JSON.stringify(e.planVerdict)}`);
      }
      // #1247 — a `cycle-interrupted` origin must be one the process tracker
      // can actually write. The field is OPTIONAL (state files pre-#1247 have
      // none), but when PRESENT it names what closed the session, and the
      // handoff and `/work-status` render it to the operator as fact. A string
      // no tracker could produce (`signal:SIGKILL`, a typo, a hand edit) is a
      // confident wrong cause, so it is reported rather than rendered.
      if (
        e.kind === "cycle-interrupted" &&
        e.origin !== undefined &&
        !isKnownExitOrigin(e.origin)
      ) {
        out.push(`eventLog[${i}].origin has unknown value ${JSON.stringify(e.origin)}`);
      }
    });
  }
  return out;
}
