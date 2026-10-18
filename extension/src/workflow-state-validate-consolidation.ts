/**
 * workflow-state-validate-consolidation — the validators for the five
 * consolidation / cap-checkpoint records `validateDiscriminants` checks on
 * `pipelineState`: `incompleteConsolidation`, `capEvidence`,
 * `consolidationCompleteness`, `consolidationNotes` and `capedPartialState`.
 *
 * Split out of workflow-state-validate.ts for the 500-line gate (AGENTS.md
 * §12), the same seam #861 used for the cap vocabulary
 * (`workflow-state-validate-caps.ts`) and #1362 used for the dirty-root
 * baseline (`workflow-state-dirty-root.ts`). Predicates are verbatim and the
 * validator appends their findings in the original order, so the reported
 * findings are byte-identical.
 *
 * Each function is #533's rule applied to one field: the untyped cast in
 * `readState` is the only runtime gate for the record, so a partial or
 * hand-edited value must be reported rather than reach a handoff renderer as
 * a confident wrong answer. Every one returns `[]` when the field is absent —
 * state files written before the field existed must still resume.
 */

import {
  CAP_EVIDENCE_KINDS,
  KNOWN_CAPPED_PARTIAL_ROLES,
  KNOWN_CAPPED_PARTIAL_TREES,
  KNOWN_CONSOLIDATION_STATUSES,
} from "./workflow-state-validate-caps.ts";

/**
 * `pipelineState.incompleteConsolidation` — the per-workstream consolidation
 * verdicts the commit-pr gate records (#540). Two shapes are legal: the legacy
 * PR14 array of `{ id }` entries, and the object carrying `verdicts[]` (+
 * optional `filesPresent`). Each verdict must name a status the driver can
 * produce and carry the field that status exists to record.
 */
export function incompleteConsolidationFindings(incompleteConsolidation: unknown): string[] {
  const out: string[] = [];
  if (incompleteConsolidation === undefined) return out;
  const ic = incompleteConsolidation;
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
  return out;
}

/**
 * #543 — `pipelineState.capEvidence`, when present, must carry a known
 * `kind` and a numeric `count` (the structured trigger evidence the
 * F1/F6 caps render). The same #533 "type-check the untyped cast" rule
 * that covers `commitPrRoot`: a partial / hand-edited record would
 * otherwise flow to `explainCap` as if every field were present.
 */
export function capEvidenceFindings(capEvidence: unknown): string[] {
  const out: string[] = [];
  if (capEvidence === undefined) return out;
  const ce = capEvidence;
  if (typeof ce !== "object" || ce === null) {
    out.push("pipelineState.capEvidence is not an object");
    return out;
  }
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
  return out;
}

/**
 * #728 — `pipelineState.consolidationCompleteness`, when present, must
 * carry the name-sets (arrays) the handoff renders verbatim: a partial
 * or hand-edited record would otherwise render a confident wrong
 * dropped-path list. `checkError` (the "could not verify" state) is
 * optional and, when present, must be a string.
 */
export function consolidationCompletenessFindings(consolidationCompleteness: unknown): string[] {
  const out: string[] = [];
  if (consolidationCompleteness === undefined) return out;
  const cc = consolidationCompleteness;
  if (typeof cc !== "object" || cc === null) {
    out.push("pipelineState.consolidationCompleteness is not an object");
    return out;
  }
  const cco = cc as Record<string, unknown>;
  for (const field of ["intended", "landed", "droppedPaths"] as const) {
    const arr = cco[field];
    if (!Array.isArray(arr)) {
      out.push(`pipelineState.consolidationCompleteness.${field} is missing or not an array`);
    } else if (arr.some((v) => typeof v !== "string")) {
      out.push(`pipelineState.consolidationCompleteness.${field} contains a non-string entry`);
    }
  }
  if (cco.checkError !== undefined && typeof cco.checkError !== "string") {
    out.push("pipelineState.consolidationCompleteness.checkError is not a string");
  }
  return out;
}

/**
 * #1153 — `pipelineState.consolidationNotes`, when present, must be an
 * array of strings: the handoff renders each entry verbatim into a
 * "checks that did not run" bullet, so a non-string (an object, a number)
 * would render `[object Object]` where the operator expected a reason, and
 * a non-array would crash the renderer.
 */
export function consolidationNotesFindings(consolidationNotes: unknown): string[] {
  const out: string[] = [];
  if (consolidationNotes === undefined) return out;
  const cn = consolidationNotes;
  if (!Array.isArray(cn)) {
    out.push("pipelineState.consolidationNotes is not an array");
  } else if (cn.some((v) => typeof v !== "string")) {
    out.push("pipelineState.consolidationNotes contains a non-string entry");
  }
  return out;
}

/**
 * #543 F5 — `pipelineState.capedPartialState` (the driver-owned
 * checkpoint record) must carry a known role/tree and, when the tree is
 * "committed", the commit it claims: the handoff renders
 * `git -C <worktree> show <sha>` from it, and a partial object would
 * render a confident wrong SHA.
 */
export function capedPartialStateFindings(capedPartialState: unknown): string[] {
  const out: string[] = [];
  if (capedPartialState === undefined) return out;
  const cps = capedPartialState;
  if (typeof cps !== "object" || cps === null) {
    out.push("pipelineState.capedPartialState is not an object");
    return out;
  }
  const cpso = cps as Record<string, unknown>;
  if (typeof cpso.cap !== "string" || cpso.cap.length === 0) {
    out.push("pipelineState.capedPartialState.cap is missing or not a string");
  }
  if (cpso.role !== undefined && !KNOWN_CAPPED_PARTIAL_ROLES.includes(cpso.role)) {
    out.push(`pipelineState.capedPartialState.role has unknown value ${JSON.stringify(cpso.role)}`);
  }
  if (!KNOWN_CAPPED_PARTIAL_TREES.includes(cpso.tree)) {
    out.push(`pipelineState.capedPartialState.tree has unknown value ${JSON.stringify(cpso.tree)}`);
  }
  if (typeof cpso.at !== "number" || !Number.isFinite(cpso.at)) {
    out.push("pipelineState.capedPartialState.at is not a finite number");
  }
  if (cpso.typechecked !== undefined && typeof cpso.typechecked !== "boolean") {
    out.push("pipelineState.capedPartialState.typechecked is not a boolean");
  }
  // #1414 round 2 — the no-verdict reason. Optional, and a string when
  // present: it is rendered into the handoff, so a non-string would
  // reach the operator as "[object Object]".
  if (cpso.typecheckReason !== undefined && typeof cpso.typecheckReason !== "string") {
    out.push("pipelineState.capedPartialState.typecheckReason is not a string");
  }
  if (cpso.tree === "committed" && typeof cpso.commitSha !== "string") {
    out.push(
      "pipelineState.capedPartialState.commitSha is missing or not a string (required when tree is 'committed')",
    );
  }
  return out;
}
