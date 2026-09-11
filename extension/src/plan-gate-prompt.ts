/**
 * plan-gate-prompt — the Phase-4 gap-gate reviewer prompts.
 *
 * Two prompts, one per round shape:
 *
 *   - Round 1 (`gapGatePrompt`): the full GAP DETECTION review of the
 *     drafted spec.
 *   - Round 2 (`gapGateVerifyPrompt`): a SCOPED VERIFICATION of the
 *     carried CRITICAL resolutions, not a second full review. The round
 *     fires only when round 1 found CRITICAL gaps (the corrective
 *     re-draft), and the measured evidence says multi-round full
 *     re-review of the same artifact adds noise — single-pass review beat
 *     every multi-turn variant, with multi-turn adding +62% false
 *     positives as reviewers fabricate findings once real errors run out
 *     (arXiv:2603.16244; outputs/spec-driven-plan-driver-gap.md G2). A
 *     verification of specific named resolutions is a DIFFERENT task from
 *     a re-review: smaller read, no fresh-finding churn, and it directly
 *     serves run-to-run consistency. Differentiation between rounds is
 *     prompt-level by design (operator decision 2026-09-09: same model
 *     for all stages by default; a separate endpoint per role remains
 *     available via ensemble-models.json).
 *
 * Split out of plan-driver.ts along the 500-line seam (AGENTS.md §12);
 * plan-driver re-exports gapGatePrompt for its existing consumers.
 *
 * #638 grounding-source third outcome: a claim the reviewer cannot ground in
 * ANY source (the spec text itself, or a world source independent of this
 * repo) is reported with the marker UNGROUNDED: — NOT a gap. The marker
 * vocabulary mirrors /work's intent gate (work-driver-intent.ts SpecEvidence:
 * confirmed | contradicted | unverifiable); ungrounded is this gate's name
 * for the same third state. parseGaps (plan-gaps.ts) parses the lines into
 * GapGateParse.ungrounded and runGapGateLoop exempts an ALL-ungrounded round
 * from the review-unparseable branch — a reviewer that classifies every
 * checkable claim as ungrounded and says READY has reviewed fully, and the
 * zero-CRITICAL file path handles it in one dispatch.
 */
import { DESCRIPTOR_DATA_FRAMING } from "./plan-angles.ts";
import type { AngleFindings } from "./plan-draft.ts";
import { VIPUNE_PRECEDENCE_NOTE, priorContextHasVipune, renderPriorContext } from "./plan-draft.ts";

/**
 * The round-1 gap-gate reviewer prompt. Carries the prior context (capped
 * at the render site via renderPriorContext — #633: the gate child is one
 * reviewer, the filed body carries the full uncapped inventory) and — since
 * the vipune tag (D6) — the explicit precedence note whenever any prior
 * entry is vipune-sourced: a vipune entry is a prior snapshot and may be
 * stale.
 */
export function gapGatePrompt(
  body: string,
  findings: AngleFindings[],
  priorContext: { source: string; fact: string }[],
): string {
  const summary = findings
    .map((x) => {
      const n = x.toolUses.filter((i) => typeof i === "object").length;
      return `- ${x.name}: ${x.ok ? (n > 0 ? `ran (${n} structured item${n === 1 ? "" : "s"})` : "ran (no structured items)") : "skipped/failed"}`;
    })
    .join("\n");
  const head =
    "GAP DETECTION: review this draft spec and find what is missing, under-specified, ambiguous or unverifiable.\n\n";
  // PR #640 SECURITY: descriptor interpolated verbatim; prompt-level mitigation only, not a boundary.
  const spec = `${DESCRIPTOR_DATA_FRAMING}DRAFT SPEC:\n${body}\n\n`;
  const sum = `PHASE 2 FINDINGS SUMMARY:\n${summary}\nAn angle marked skipped/failed means that surface is UNINVESTIGATED — a missing investigation is not evidence of absence; weigh gaps touching that surface accordingly.\n\n`;
  const prior =
    priorContext.length > 0
      ? `PM has already established these decisions and facts (DO NOT re-raise them as gaps; citing them is only valid if you can show the spec contradicts them):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n\n` : ""}`
      : "";
  const tail =
    "Severity is keyed to WHO must decide. For each gap, output ONE line starting with the marker GAP: followed by the severity, an em dash, a short description, then — proposed resolution: with the proposed resolution. The severity scale:\n" +
    "CRITICAL: the spec commits to two things that contradict, or the spec is internally impossible — checkable from the spec text ALONE, no external fact required — building from it produces WRONG behaviour\n" +
    "HIGH: a decision the operator must make because the implementer cannot — a scope boundary, a policy, or a choice between designs with different consequences\n" +
    "MEDIUM: a clarification that changes how the work is organised, not what gets built\n" +
    "LOW: cosmetic\n\n" +
    "GROUNDING-SOURCE CLASSIFICATION (per claim, never per repository). Before you file any gap, classify the CLAIM's grounding source. A claim about THIS project's own code that nothing in the PHASE 2 FINDINGS SUMMARY above can ground — the code does not exist yet — is UNVERIFIED: do NOT file it as a gap at ANY severity. It is not a defect of the spec; it is the absence of a grounding source. A claim about THE WORLD (a published library, a documented external API, an external fact) that you cannot verify against a grounding source independent of this repo: file it as HIGH (NEVER as CRITICAL) with a proposed resolution that names what must be confirmed — it travels in the residual disclosure. A claim the spec text itself contradicts or makes impossible IS a gap (CRITICAL when the contradiction or impossibility is checkable from the spec text alone).\n" +
    "The UNGROUNDED: marker. An ungrounded or unverifiable claim — one with no spec-internal contradiction, no live code to check, and no world source you can verify against — is reported with a line starting with the marker UNGROUNDED: (the claim — why it is ungrounded). UNGROUNDED: lines are NOT gaps — never count them toward a severity, and never invent a severity for an ungrounded claim. The marker is the classification, not a finding.\n\n" +
    "Scope Discipline. Do NOT file a gap, at ANY severity, for:\n" +
    "- a value or constant the implementer will pick (resolved against live code during /work, when the code exists; when nothing exists yet, the spec must commit to creating it — a spec that leaves the type or module to be invented is a gap)\n" +
    "- an exact API or method signature (the implementer reads the current code, when the code exists; when the API is to be created, the spec must name it)\n" +
    "- an error type or error shape (same: the existing types say it, when the types exist; when the error type does not exist yet, the spec must commit to creating it)\n" +
    "- a field list derivable from an existing type (when the type exists; when the type is to be created, the spec must commit to creating it with the named fields)\n" +
    "- a test-harness mechanic (mock flags, grep needles, variable usage)\n" +
    "- exact line numbers anywhere (they rot; name the SYMBOL)\n" +
    "- restating a decision the spec already makes once\n\n" +
    "Example: GAP: CRITICAL — the spec commits to both a retry cap of 3 and an infinite retry on quota errors — proposed resolution: name which wins. Example: UNGROUNDED: whether library BOSL2 exposes a screw() module — no spec-internal contradiction, and no world source you can verify against — reported as ungrounded, NOT as a gap. Never write a severity word on its own line — prose mentioning CRITICAL/HIGH/MEDIUM/LOW does not create a gap unless the line starts with GAP:; the same holds for UNGROUNDED: lines — the marker is what counts, and it counts as an UNVERIFIED classification, not a finding. Each resolution must be ONE of: (a) an additional research dispatch, (b) a sharper acceptance criterion to add, or (c) an Open Question. End your reply with a single line exactly of the form:\nVERDICT: READY  (zero CRITICAL gaps)\nor\nVERDICT: NEEDS_ITERATION";
  return `${head}${spec}${sum}${prior}${tail}`;
}

/** One carried CRITICAL gap + what happened to its resolution. */
export interface CarriedCritical {
  description: string;
  resolution: string;
  writtenBack: boolean;
  heading: string;
}

/**
 * The round-2 SCOPED VERIFICATION prompt (see module header for why round 2
 * is not a second full review). The reviewer sees the re-drafted spec and
 * the exact CRITICAL gaps it flagged, with where each resolution landed,
 * and verifies ONLY those.
 */
export function gapGateVerifyPrompt(body: string, carried: CarriedCritical[]): string {
  const list = carried
    .map(
      (c) =>
        `- ${c.description} → resolution: ${c.resolution} (${c.writtenBack ? `written back to ${c.heading}` : "left as an Open Question, decision owner operator"})`,
    )
    .join("\n");
  return `VERIFICATION ROUND: in the previous review round you flagged the CRITICAL gaps listed below, and the spec has been re-drafted with their resolutions applied. Verify ONLY whether each carried CRITICAL gap is now resolved. Do NOT re-review the whole spec, and do NOT raise new findings unless an applied resolution ITSELF introduces a contradiction. Grounding-source rule (same as round 1): a CRITICAL must be an internal contradiction or internal impossibility checkable from the spec text alone. An ungrounded claim (no spec-internal contradiction, no live code to check, no world source you can verify against) is reported with a line starting with the marker UNGROUNDED: (the claim — why it is ungrounded) — UNGROUNDED: lines are NOT gaps, do NOT count them toward a severity, and do NOT invent a severity for them; a claim about the WORLD you cannot verify is a HIGH at most, never a CRITICAL.\n\nAPPLIED RESOLUTIONS SUPERSEDE OLDER PROSE: a resolution "written back to <section>" appears as the LAST bullet of that section, and where it conflicts with an earlier line in the spec, the appended bullet is the governing text — treat the older line as superseded rather than re-flagging the pair as a contradiction. Only a resolution left as an Open Question resolves nothing.\n\n${DESCRIPTOR_DATA_FRAMING}RE-DRAFTED SPEC:\n${body}\n\nCARRIED CRITICAL GAPS:\n${list}\n\nFor any carried gap that is NOT resolved (or a new contradiction an applied resolution introduces), output ONE line starting with the marker GAP: CRITICAL — a short description — proposed resolution: the proposed resolution. Do not output GAP lines at any other severity in this round. End your reply with a single line exactly of the form:\nVERDICT: READY  (every carried CRITICAL gap is resolved)\nor\nVERDICT: NEEDS_ITERATION`;
}
