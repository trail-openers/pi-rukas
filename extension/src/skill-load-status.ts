/**
 * skill-load-status — the single reader for the lens child's
 * `Skill Load Status: [SUCCESS|FAILED]` self-report (agents-base/
 * code-review-specialist.md).
 *
 * The shared reader (reply-markers.readEnumMarker) is the primary parse —
 * it tolerates every shape the prompt's accepted template allows (bold,
 * case variants, the heading form) and takes the LAST match, so a musing
 * mid-reply is never the answer. It is deliberately NOT extended for the
 * `=` form (PM decision on the residual gap-gate findings: `=FAILED`
 * appears only in the rule's prose, and extending readMarker for one
 * call site would loosen every other marker).
 *
 * One addition: a LINE-ANCHORED fallback for the `=` form. A reply that
 * quotes the CRITICAL RULE's prose — "If `Skill Load Status=FAILED`,
 * verdict CANNOT be APPROVED" — must NOT read as a real FAILED declaration
 * (that collision is exactly the marker bug this reader exists to
 * prevent). The line anchor `^\s*\**\s*Skill Load Status\**\s*[:=]…`
 * requires the marker to OPEN a line, so the rule's prose (mid-line,
 * `=FAILED` with no space before FAILED) parses as absent, while a
 * compliant declaration (`Skill Load Status=FAILED` at line start)
 * still parses. The shared reader runs first, so any line that the shared
 * reader already accepts wins on the usual last-match-wins basis.
 *
 * The consumer of this token lives in lens-review-child.ts (the `if
 * (status === "FAILED")` block): an explicit FAILED blocks that lens
 * (findings kept, verdict can never be APPROVED); an ABSENT marker is
 * recorded as a trace note (skillLoadNote), never a block.
 */

import { readEnumMarker } from "./reply-markers.ts";

/** The line-anchored `=`-form fallback — see the module doc for why the
 * anchor is load-bearing (it is what keeps a quoted rule from firing). */
const LINE_ANCHORED = /^\s*\**\s*Skill Load Status\**\s*[:=]\s*\**\s*(SUCCESS|FAILED)\b/gim;

/**
 * Read the child's `Skill Load Status` marker. Returns the canonical
 * value, or `undefined` when the marker is genuinely absent (or the child
 * used an unknown value — absence and unknown are both "not a declaration",
 * per the PM decision).
 */
export function skillLoadStatus(text: string): "SUCCESS" | "FAILED" | undefined {
  const inline = readEnumMarker(text, "Skill Load Status", ["SUCCESS", "FAILED"]);
  if (inline) return inline;
  const matches = [...text.matchAll(LINE_ANCHORED)];
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const v = last?.[1];
  return v === "SUCCESS" ? "SUCCESS" : v === "FAILED" ? "FAILED" : undefined;
}
