/**
 * plan-validate — deterministic validation of the drafted spec body, run
 * AFTER draftSpec and BEFORE the gap gate.
 *
 * The research base (outputs/spec-driven-plan-driver-gap.md, G4) notes the
 * pipeline's only deterministic checks were parser-level: a draft whose
 * load-bearing sections all fell back to placeholder strings could reach
 * the LLM gap gate (paying a reviewer dispatch to notice junk) or — for
 * the types the gate does not cover — the forge. These checks are free,
 * mechanical, and identical on every run.
 *
 * Deliberately NARROW (the all-angles-failed guard already catches total
 * junk; this catches the partial case where SOME angle produced items but
 * the load-bearing section still fell back):
 *
 *   - bug/feature: the Acceptance criteria section must not be the
 *     fallback placeholder — an issue with zero real ACs is not
 *     /work-consumable (work-driver-plan-helpers.ts counts AC lines).
 *   - epic (below the sub-issue depth limit): the Sub-issues section must
 *     contain an actual decomposition, and a sane number of entries.
 *   - chore/spike: no additional check. A spike has one angle, so a spike
 *     with no deliverable items is already the all-angles-failed halt; a
 *     chore's smallest-viable-change shape does not require structured ACs.
 *
 * Type/content plausibility ("is this feature really an epic?") is NOT
 * checked here — that is a judgment call, and deterministic heuristics for
 * it would trade false halts for nothing the gap gate does not already
 * cover.
 *
 * The fallback strings are declared HERE and imported by plan-draft.ts's
 * draftSpec — single source, so a reworded placeholder cannot silently
 * stop matching the validator.
 */
import { EPIC_SUB_ISSUE_DEPTH_LIMIT, type PlanType } from "./plan-types.ts";

/** The Acceptance-criteria fallback draftSpec renders when no AC exists. */
export const AC_FALLBACK =
  "derive the testable outcomes from the investigation findings before /work";

/** The Sub-issues fallback draftSpec renders when no decomposition exists. */
export const SUB_ISSUES_FALLBACK = "(decomposition not available)";

/**
 * Sanity ceiling for an epic's sub-issue count — SECTION_MAX_ITEMS-sized;
 * a decomposition past it is a runaway angle, not a plan.
 */
export const EPIC_SUB_ISSUE_MAX = 20;

export interface DraftValidation {
  ok: boolean;
  problems: string[];
}

/** Extract one `## <heading>` section's content (up to the next `## `). */
function sliceSection(body: string, heading: string): string | undefined {
  const re = new RegExp(`^## ${heading}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m");
  const m = body.match(re);
  return m?.[1];
}

export function validateDraft(type: PlanType, body: string, depth: number): DraftValidation {
  const problems: string[] = [];
  if (type === "bug" || type === "feature") {
    const ac = sliceSection(body, "Acceptance criteria");
    if (!ac || ac.includes(AC_FALLBACK)) {
      problems.push(
        "the Acceptance criteria section is the fallback placeholder — no angle or operator directive produced a testable outcome, so the issue would not be /work-consumable",
      );
    }
  }
  if (type === "epic" && depth < EPIC_SUB_ISSUE_DEPTH_LIMIT) {
    const sub = sliceSection(body, "Sub-issues");
    if (!sub || sub.includes(SUB_ISSUES_FALLBACK)) {
      problems.push(
        "the epic has no sub-issue decomposition — the decomposition-surface angle produced no sub-issue items",
      );
    } else {
      const n = (sub.match(/^- /gm) ?? []).length;
      if (n > EPIC_SUB_ISSUE_MAX) {
        problems.push(
          `the epic decomposed into ${n} sub-issues (ceiling ${EPIC_SUB_ISSUE_MAX}) — a decomposition this wide is a runaway angle, not a plan; split the epic descriptor instead`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
