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

import type { WorkStep } from "./workflow-state-events.ts";
import { WORK_STATE_SCHEMA_VERSION, WORK_STEPS } from "./workflow-state-schema.ts";

/**
 * Known event kinds. The union type is the source of the vocabulary; this
 * tuple exists only so the validator can test membership (types are erased
 * at runtime).
 */
export const KNOWN_EVENT_KINDS: readonly unknown[] = [
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
  "lens-approved",
  "lens-issues-found",
  "lens-skipped-empty-diff",
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
  "widening-scan",
  "memory-write",
  "memory-inject",
  // #741 — the converge gate's one-shot corrective dispatch marker.
  "converge-redispatch",
  // #844 — the branch step's stale-local-branch reset record (old + new tip).
  // Absent from the tuple, EVERY restarted cycle that resets a stale branch
  // halts on its own re-entry (the fix manufactures the corruption it
  // exists to prevent).
  "branch-reset",
];

/** `pipelineState.status` vocabulary. */
export const KNOWN_STATUSES: readonly unknown[] = ["running", "merged", "handoff", "aborted"];

/**
 * #540 — `pipelineState.incompleteConsolidation.verdicts[].status`
 * vocabulary. Legacy PR14 entries carry no `status` field at all (they
 * identify themselves by `paths`); the validator tolerates the absent-
 * status + `paths` shape and refuses everything else it does not
 * recognize — the same "extend the union, don't smuggle a field" rule
 * this module applies to event kinds and steps.
 *
 * #778 — `moved` joins the vocabulary: a covered workstream whose declared
 * path was renamed during develop/consolidation, with the move recorded in
 * `movedPaths` (the same "extend the union" move that added `unverifiable`
 * for #540).
 */
export const KNOWN_CONSOLIDATION_STATUSES: readonly unknown[] = [
  "complete",
  "uncovered",
  "moved",
  "unverifiable",
];

/** `cap-hit.nextStep` vocabulary. */
const CAP_HIT_NEXT_STEPS: readonly unknown[] = ["handoff", "step-back", "ci"];

/**
 * #543 — the FIXED-LITERAL caps (F1 loop / F6 token-budget included). A
 * cap-hit's `cap` must be one of these, or a `verify-failed:` / `step-failed:`
 * template value — nothing else. `validateDiscriminants` REJECTS a fabricated
 * `loop-detected:<anything>` / `token-budget:<anything>` suffix (the #533
 * "extend the union, don't smuggle a field" rule applied to cap strings).
 */
const CAP_HIT_FIXED_LITERALS: readonly unknown[] = [
  "adversarial-loop",
  "round-cap",
  "wall-clock",
  "review-incomplete",
  "ci-retry",
  "developer-timeout",
  "explore-already-complete",
  "explore-needs-clarification",
  "explore-bodies-empty",
  "step-back-revise-spec",
  "commit-pr-incomplete-consolidation",
  "lens-fix-not-integrated",
  "integration-verify-failed",
  // #669 — develop-time consolidation hit a file-level conflict (two
  // workstreams edited the same lines). A decomposition error, distinct
  // from the generic verify-failed:develop template.
  "consolidated-verify-conflict",
  // #777 — develop-time consolidated verify failed on a specific assertion
  // that neither workstream tripped alone (per-workstream pass, combined
  // fail). Distinct from the conflict cap and the verify-failed:develop
  // template. The failure message carries the classification + assertion.
  "consolidated-verify-consolidation-created",
  // #728 — consolidation dropped files (strict-subset stage, the #723
  // incident shape): distinct from the conflict cap and the verify-failed:
  // develop template. The dropped paths ride in the event's evidence.
  "consolidation-incomplete",
  // #741 — the converge gate's distinct cap: a plan deliverable is absent
  // from the end-of-develop diff even after the one-shot corrective
  // re-dispatch. Distinct from the verify-failed:develop template (the
  // code builds; the diff is incomplete).
  "develop-incomplete-deliverables",
  // #753 — a DEPENDENT workstream's deferred worktree creation was refused
  // by a dirty same-issue leftover. A deliberate park terminalized as a
  // handoff (not `step-failed:` — that prefix would read as a mid-flight
  // crash), so the validator must know the literal or every re-entry of a
  // live parked cycle would halt on "unrecognised value" and tell the
  // operator to rm the very record this cap exists to create.
  "deferred-creation:develop",
  // #746 task-b — the branch step's early dirty-root block: a stray
  // untracked/modified file at repoRoot (outside the driver-managed
  // exclusion set) present BEFORE any develop dispatch. A deliberate park
  // terminalized as a handoff (not `step-failed:` — that prefix would read
  // as a mid-flight crash); the paths are preserved, never mutated.
  "repo-root-residue",
  "intent-park",
  "awaiting-human-merge",
  "lens-diff-unreadable",
  "existing-pr-detected",
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops created does not sit on the driver-fetched base.
  "ops-merge-base-mismatch",
  "adversarial-infra-failure",
  "loop-detected",
  "token-budget",
];

/** `pipelineState.capEvidence.kind` vocabulary (#543). */
const CAP_EVIDENCE_KINDS: readonly unknown[] = ["loop", "token-budget"];

/** #543 F5 — `pipelineState.capedPartialState.tree` vocabulary. */
const KNOWN_CAPPED_PARTIAL_TREES: readonly unknown[] = ["committed", "dirty-uncommitted", "clean"];

/** #543 F5 — `pipelineState.capedPartialState.role` vocabulary. The
 * dispatch-cap kill is attributed to a role the driver can name, so a
 * fabricated `cap-hit.role` is rejected with the same rule. */
const KNOWN_CAPPED_PARTIAL_ROLES: readonly unknown[] = [
  "project-manager",
  "developer",
  "ops",
  "explore",
  "adversarial-developer",
  "code-review-specialist",
];

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
    if (ps.incompleteConsolidation !== undefined) {
      const ic = ps.incompleteConsolidation;
      if (Array.isArray(ic)) {
        ic.forEach((e, i) => {
          const v = e as Record<string, unknown> | null;
          if (typeof v !== "object" || v === null) {
            out.push(`pipelineState.incompleteConsolidation[${i}] is not an object`);
          } else if (typeof v.id !== "string") {
            out.push(`pipelineState.incompleteConsolidation[${i}].id is missing or not a string`);
          }
        });
      } else if (typeof ic !== "object" || ic === null) {
        out.push("pipelineState.incompleteConsolidation is not an object or array");
      } else {
        const ico = ic as Record<string, unknown>;
        const verdicts = ico.verdicts;
        if (verdicts === undefined) {
          out.push("pipelineState.incompleteConsolidation has no verdicts field");
        } else if (!Array.isArray(verdicts)) {
          out.push("pipelineState.incompleteConsolidation.verdicts is not an array");
        } else {
          verdicts.forEach((v, i) => {
            const e = v as Record<string, unknown> | null;
            if (typeof e !== "object" || e === null) {
              out.push(`pipelineState.incompleteConsolidation.verdicts[${i}] is not an object`);
              return;
            }
            if (e.status === undefined) {
              if (!Array.isArray(e.paths)) {
                out.push(
                  `pipelineState.incompleteConsolidation.verdicts[${i}] has neither status nor paths`,
                );
              }
              return;
            }
            if (!KNOWN_CONSOLIDATION_STATUSES.includes(e.status)) {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].status has unknown value ${JSON.stringify(e.status)}`,
              );
              return;
            }
            if (e.status === "uncovered" && !Array.isArray(e.uncoveredPaths)) {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].uncoveredPaths is missing or not an array (required when status is 'uncovered')`,
              );
            }
            // #875 — the per-workstream dirty flag (computed once at gate
            // time from the worktree porcelain). OPTIONAL: pre-#875 state
            // files lack it entirely and must keep validating; when
            // present it must be a boolean (renderers read it verbatim,
            // so a non-boolean would be a confident-wrong claim).
            if (e.status === "uncovered" && e.dirty !== undefined && typeof e.dirty !== "boolean") {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].dirty is not a boolean (must be a boolean when present)`,
              );
            }
            if (e.status === "unverifiable" && typeof e.reason !== "string") {
              out.push(
                `pipelineState.incompleteConsolidation.verdicts[${i}].reason is missing or not a string (required when status is 'unverifiable')`,
              );
            }
            // #778 — a `moved` verdict must carry the move records: the
            // whole point of the status is that the state file names both
            // sides of the rename, so a partial record would be a confident
            // wrong handoff input.
            if (e.status === "moved") {
              const mp = e.movedPaths;
              if (!Array.isArray(mp)) {
                out.push(
                  `pipelineState.incompleteConsolidation.verdicts[${i}].movedPaths is missing or not an array (required when status is 'moved')`,
                );
              } else if (
                mp.some(
                  (m) =>
                    typeof m !== "object" ||
                    m === null ||
                    typeof (m as Record<string, unknown>).from !== "string" ||
                    typeof (m as Record<string, unknown>).to !== "string",
                )
              ) {
                out.push(
                  `pipelineState.incompleteConsolidation.verdicts[${i}].movedPaths contains an entry without string from/to`,
                );
              }
            }
          });
          if (ico.filesPresent !== undefined && !Array.isArray(ico.filesPresent)) {
            out.push("pipelineState.incompleteConsolidation.filesPresent is not an array");
          }
        }
      }
    }
    // #543 — `pipelineState.capEvidence`, when present, must carry a known
    // `kind` and a numeric `count` (the structured trigger evidence the
    // F1/F6 caps render). The same #533 "type-check the untyped cast" rule
    // that covers `commitPrRoot`: a partial / hand-edited record would
    // otherwise flow to `explainCap` as if every field were present.
    if (ps.capEvidence !== undefined) {
      const ce = ps.capEvidence;
      if (typeof ce !== "object" || ce === null) {
        out.push("pipelineState.capEvidence is not an object");
      } else {
        const ceo = ce as Record<string, unknown>;
        if (!CAP_EVIDENCE_KINDS.includes(ceo.kind)) {
          out.push(`pipelineState.capEvidence.kind has unknown value ${JSON.stringify(ceo.kind)}`);
        }
        // (H3) — the repeat count is the trigger evidence for the LOOP kind
        // only: the token-budget evidence's story is the budget arithmetic
        // (budgetTokens / usedTokens), and a count there would be fiction.
        if (ceo.kind === "loop") {
          if (typeof ceo.count !== "number" || !Number.isFinite(ceo.count)) {
            out.push(
              "pipelineState.capEvidence.count is missing or not a finite number (required for kind 'loop')",
            );
          }
        }
        if (ceo.turnRange !== undefined && !Array.isArray(ceo.turnRange)) {
          out.push("pipelineState.capEvidence.turnRange is not an array");
        }
        // (H3) — the budget arithmetic is REQUIRED for the token-budget kind
        // (that IS the evidence); for any other kind it is only checked when
        // present, so a loop record carrying a stray budgetTokens is not
        // rejected.
        if (ceo.kind === "token-budget") {
          for (const field of ["budgetTokens", "usedTokens"] as const) {
            if (typeof ceo[field] !== "number" || !Number.isFinite(ceo[field] as number)) {
              out.push(
                `pipelineState.capEvidence.${field} is missing or not a finite number (required for kind 'token-budget')`,
              );
            }
          }
        } else {
          for (const field of ["budgetTokens", "usedTokens"] as const) {
            if (
              ceo[field] !== undefined &&
              (typeof ceo[field] !== "number" || !Number.isFinite(ceo[field] as number))
            ) {
              out.push(`pipelineState.capEvidence.${field} is not a finite number`);
            }
          }
        }
      }
    }
    // #728 — `pipelineState.consolidationCompleteness`, when present, must
    // carry the name-sets (arrays) the handoff renders verbatim: a partial
    // or hand-edited record would otherwise render a confident wrong
    // dropped-path list. `checkError` (the "could not verify" state) is
    // optional and, when present, must be a string.
    if (ps.consolidationCompleteness !== undefined) {
      const cc = ps.consolidationCompleteness;
      if (typeof cc !== "object" || cc === null) {
        out.push("pipelineState.consolidationCompleteness is not an object");
      } else {
        const cco = cc as Record<string, unknown>;
        for (const field of ["intended", "landed", "droppedPaths"] as const) {
          const arr = cco[field];
          if (!Array.isArray(arr)) {
            out.push(`pipelineState.consolidationCompleteness.${field} is missing or not an array`);
          } else if (arr.some((v) => typeof v !== "string")) {
            out.push(
              `pipelineState.consolidationCompleteness.${field} contains a non-string entry`,
            );
          }
        }
        if (cco.checkError !== undefined && typeof cco.checkError !== "string") {
          out.push("pipelineState.consolidationCompleteness.checkError is not a string");
        }
      }
    }
    // #543 F5 — `pipelineState.capedPartialState` (the driver-owned
    // checkpoint record) must carry a known role/tree and, when the tree is
    // "committed", the commit it claims: the handoff renders
    // `git -C <worktree> show <sha>` from it, and a partial object would
    // render a confident wrong SHA.
    if (ps.capedPartialState !== undefined) {
      const cps = ps.capedPartialState;
      if (typeof cps !== "object" || cps === null) {
        out.push("pipelineState.capedPartialState is not an object");
      } else {
        const cpso = cps as Record<string, unknown>;
        if (typeof cpso.cap !== "string" || cpso.cap.length === 0) {
          out.push("pipelineState.capedPartialState.cap is missing or not a string");
        }
        if (cpso.role !== undefined && !KNOWN_CAPPED_PARTIAL_ROLES.includes(cpso.role)) {
          out.push(
            `pipelineState.capedPartialState.role has unknown value ${JSON.stringify(cpso.role)}`,
          );
        }
        if (!KNOWN_CAPPED_PARTIAL_TREES.includes(cpso.tree)) {
          out.push(
            `pipelineState.capedPartialState.tree has unknown value ${JSON.stringify(cpso.tree)}`,
          );
        }
        if (typeof cpso.at !== "number" || !Number.isFinite(cpso.at)) {
          out.push("pipelineState.capedPartialState.at is not a finite number");
        }
        if (cpso.typechecked !== undefined && typeof cpso.typechecked !== "boolean") {
          out.push("pipelineState.capedPartialState.typechecked is not a boolean");
        }
        if (cpso.tree === "committed" && typeof cpso.commitSha !== "string") {
          out.push(
            "pipelineState.capedPartialState.commitSha is missing or not a string (required when tree is 'committed')",
          );
        }
      }
    }
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
      if (!KNOWN_EVENT_KINDS.includes(e.kind)) {
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
      // #543 — a cap-hit's `cap` must be a known fixed literal, a
      // `verify-failed:` / `step-failed:` template value, or nothing else. A
      // fabricated `loop-detected:<anything>` / `token-budget:<anything>`
      // suffix is REJECTED: those caps are fixed literals, and a suffix would
      // smuggle a role the canary does not know (the role travels in the
      // separate `role` field instead).
      if (e.kind === "cap-hit" && typeof e.cap === "string") {
        const cap = e.cap as string;
        // #844 — `branch-ahead:` is a TEMPLATE (the ahead count rides in the
        // suffix), like `verify-failed:` / `step-failed:`; the other two #844
        // caps are fixed literals in CAP_HIT_FIXED_LITERALS.
        const isTemplate =
          cap.startsWith("verify-failed:") ||
          cap.startsWith("step-failed:") ||
          cap.startsWith("branch-ahead:");
        if (!CAP_HIT_FIXED_LITERALS.includes(cap) && !isTemplate) {
          out.push(`eventLog[${i}].cap has unknown value ${JSON.stringify(cap)}`);
        }
      }
    });
  }
  return out;
}
