/**
 * plan-gap-parse — the gap-gate reply parser for the /plan pipeline (#1132 split).
 *
 * Split out of plan-gaps.ts (500-line hard limit, AGENTS.md §12). Owns the
 * GAP:/UNGROUNDED:/VERDICT: reply grammar and the GAP_RESOLUTION_PLACEHOLDER
 * sentinel; plan-gaps.ts re-exports these names so importers keep one path.
 */
import { type PlanGap, isResolutionType } from "./plan-types.ts";
import { trace } from "./trace.ts";

/** One verdict the gap gate can yield for a parsed reviewer reply. */
export type GapGateVerdict = "READY" | "NEEDS_ITERATION";

/**
 * The resolution text parseGaps assigns when a GAP: line carries no
 * "proposed resolution:" segment. Exported (single source) so the Decision-A
 * writeback (plan-writeback.ts) compares against the EXACT sentinel instead
 * of re-spelling the literal — a parser-side change to the placeholder would
 * otherwise silently flip branch 3 (open, decision owner operator, body
 * unmodified) to a writeback.
 */
export const GAP_RESOLUTION_PLACEHOLDER = "address during /work plan phase";

export interface GapGateParse {
  gaps: PlanGap[];
  /**
   * #638: claims the reviewer classified as ungrounded — no spec-internal
   * contradiction, no live code to check, no verifiable world source.
   * These are NOT gaps: the marker vocabulary mirrors /work's intent gate
   * (work-driver-intent.ts SpecEvidence: confirmed | contradicted |
   * unverifiable — ungrounded is this gate's name for the same third
   * state). They are parsed into their own channel so the review-unparseable
   * branch in runGapGateLoop can distinguish "classified every claim as
   * ungrounded and said READY" (a full review) from "said nothing".
   */
  ungrounded: string[];
  verdict: GapGateVerdict;
  /**
   * D3: true only when a parseable `VERDICT:` line was present in the reply.
   * A reviewer that reviews fully, flags gaps, and simply never writes the
   * verdict line must NOT silently pass as READY — absence is a signal the
   * gate routes on (see `evaluateGapGate`), mirroring the adversarial
   * gate's `verdictParsed` fix (#664).
   */
  verdictParsed: boolean;
}

/**
 * Normalise a declared resolution-type value before the membership check:
 * markdown emphasis and backticks, trailing punctuation, case, and inner
 * spaces (`**Operator decision**.` → `operator-decision`). Anything still not
 * a RESOLUTION_TYPE after this is rejected by isResolutionType (fail closed).
 */
function normaliseResolutionType(raw: string): string {
  return raw
    .replace(/[`*_]/g, "")
    .trim()
    .replace(/[.,;:!?)\]]+$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

/**
 * Parse a gap-gate reply. Only lines starting with the `GAP:` marker create
 * gaps — bare severity words in prose (the reviewer's legend, a clean bill of
 * health, this prompt's own examples) must NOT parse as findings. The
 * marker format is `GAP: <SEVERITY> — <description> — proposed resolution: <r>`
 * (em dash or hyphen separators; the resolution segment is optional, in which
 * case the default placeholder applies).
 *
 * The verdict search is unchanged on purpose (FIELD-CONFIRMED): across 34
 * real gap-gate replies, every verdict line is exactly `VERDICT: READY` or
 * `VERDICT: NEEDS_ITERATION` as the last non-empty line, and zero replies
 * echo the prompt's verdict legend — `reverse().find()` picks the right line
 * in every completed reply.
 */
export function parseGaps(reply: string): GapGateParse {
  const lines = reply.split("\n");
  const gaps: PlanGap[] = [];
  const ungrounded: string[] = [];
  const gapRe = /^\s*GAP:\s*(CRITICAL|HIGH|MEDIUM|LOW)\b[—–-]?\s*(.*)$/i;
  // #638: the third-outcome marker. Anchored on UNGROUNDED: (never a GAP:
  // line, so the two markers are mutually exclusive by construction) and
  // anchored at the line start the same way gapRe is, so bare "ungrounded"
  // words in prose are inert — the same invariant the GAP: marker carries.
  const ungroundedRe = /^\s*UNGROUNDED:\s*(?:—|–|-)?\s*(.+)$/i;
  // #1111: the structured resolution type, a trailing `— resolution-type: <t>`
  // segment. The value is read loosely and normalised (see
  // normaliseResolutionType); absent or outside RESOLUTION_TYPES → undefined,
  // which the writeback treats as not concrete (never spliced).
  const typeRe = /[—–-]\s*resolution-type:\s*(.*)$/i;
  for (const line of lines) {
    const ug = line.match(ungroundedRe);
    if (ug) {
      ungrounded.push((ug[1] ?? "").trim());
      continue;
    }
    const m = line.match(gapRe);
    if (!m) continue;
    let rest = (m[2] ?? "").trim();
    const typeMatch = rest.match(typeRe);
    // The marker is metadata, never resolution text: strip it whenever present,
    // parsed or not.
    if (typeMatch?.index !== undefined) rest = rest.slice(0, typeMatch.index).trim();
    const declared = typeMatch ? normaliseResolutionType(typeMatch[1] ?? "") : undefined;
    const resolutionType = isResolutionType(declared) ? declared : undefined;
    if (!typeMatch)
      trace(`plan-gaps: GAP line has no resolution-type — not spliced (${rest.slice(0, 120)})`);
    else if (resolutionType === undefined)
      trace(`plan-gaps: unrecognised resolution-type "${declared}" — not spliced`);
    const resMatch = rest.match(/[—–-]?\s*proposed resolution:\s*(.+)$/i);
    const resolution = resMatch?.[1]?.trim() ?? GAP_RESOLUTION_PLACEHOLDER;
    const description = (resMatch ? rest.slice(0, resMatch.index) : rest).trim();
    if (!description) continue;
    gaps.push({
      severity: (m[1] ?? "MEDIUM").toUpperCase() as PlanGap["severity"],
      description,
      resolution,
      ...(resolutionType ? { resolutionType } : {}),
    });
  }
  // D3: track whether a verdict line was actually present. The legacy
  // "silence = READY" default survives ONLY for the HIGH/MEDIUM/LOW-only
  // case; with a CRITICAL gap present, an absent verdict routes to
  // NEEDS_ITERATION in `evaluateGapGate` instead of filing a spec its own
  // reviewer rated CRITICAL-gap (transcripts mtsn8vox / mtsngexs).
  // (Pre-#664-transposition the same rule keyed on CRITICAL/HIGH; HIGH no
  // longer blocks — a reviewer silence is no longer worth re-dispatching
  // for a finding the gate may not repeat next round.)
  const verdictLine = [...lines].reverse().find((l) => /verdict\s*[:—-]/i.test(l));
  const verdictParsed = typeof verdictLine === "string";
  const verdict: GapGateVerdict =
    verdictParsed && /needs[_ ]iteration/i.test(verdictLine) ? "NEEDS_ITERATION" : "READY";
  // Zero gaps is returned HONESTLY (operator bug report, 2026-09-09): the
  // old synthetic `[MEDIUM] no structured gaps parsed → proceed` gap
  // collapsed "reviewed, clean" and "review unreadable" onto one severity
  // ladder — and under CRITICAL-only blocking, an unparseable review was
  // structurally guaranteed to pass (it fired twice in six fixture rounds;
  // both escapes filed real contradictions). Severity describes the SPEC;
  // parse success describes the REVIEW — the loop now distinguishes them
  // via `verdictParsed` (see runGapGateLoop's unreviewed branch).
  return { gaps, ungrounded, verdict, verdictParsed };
}
