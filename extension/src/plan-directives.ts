/**
 * plan-directives — the operator's TRUSTED typed channel into a /plan spec.
 *
 * The `context` param is the one input the driver treats as authority (D7):
 * typed blocks parsed here take precedence over specialist output for their
 * fields. This is the deliberate counterpart to DESCRIPTOR_DATA_FRAMING —
 * children are told quoted text is never instructions, so instructions must
 * arrive through this structural channel instead.
 *
 * Split out of plan-draft.ts along the 500-line seam (AGENTS.md §12);
 * plan-draft re-exports for existing consumers.
 */

export interface OperatorDirectives {
  acceptanceCriteria: string[];
  pitfalls: string[];
  outOfScope: string[];
}

/**
 * Parse operator-supplied typed fields out of the `context` param (D7).
 * Headings: ACCEPTANCE CRITERIA, PITFALLS (or EDGE CASES), OUT OF SCOPE.
 *
 * D4: accept `#`, `=`, `*`, and backtick wrappers on both sides of the
 * heading keyword, plus an optional trailing parenthetical (operators write
 * "=== ACCEPTANCE CRITERIA ===", "**ACCEPTANCE CRITERIA**",
 * "\"\"\"ACCEPTANCE CRITERIA\"\"\"", or "=== ACCEPTANCE CRITERIA (use verbatim) ==="
 * — the old regex silently dropped every one of these and the bullets under
 * them never reached the typed field). The keyword itself is unchanged.
 */
export function parseOperatorDirectives(context: string | undefined): OperatorDirectives {
  const out: OperatorDirectives = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  if (!context || !context.trim()) return out;
  let target: keyof OperatorDirectives | null = null;
  for (const raw of context.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // D4 heading regex: optional left wrapper (`#`, `=`, `*`, backtick —
    // any of them, repeated), the keyword, an optional colon (for the
    // plain "ACCEPTANCE CRITERIA:" form), an optional trailing
    // parenthetical like `(use verbatim)`, an optional right wrapper, and
    // any residual text (which, when non-empty, becomes the first item —
    // e.g. a one-line heading+item like "PITFALLS: the retry path").
    // The right wrapper is a SEPARATE token so `=== X ===` is consumed
    // (== 2) before any residual text is captured.
    const m = line.match(
      /^(?:[#=*`]+\s*)?(ACCEPTANCE[\s-]*CRITERIA|PITFALLS|EDGE[\s-]*CASES|OUT[\s-]*OF[\s-]*SCOPE)\s*[:：]?\s*(?:\([^)]*\))?\s*(?:[#=*`]+\s*)?(.*)$/i,
    );
    if (m) {
      const name = (m[1] ?? "").toUpperCase();
      target = name.startsWith("ACCEPTANCE")
        ? "acceptanceCriteria"
        : name.startsWith("OUT")
          ? "outOfScope"
          : "pitfalls";
      const rest = (m[2] ?? "").trim();
      if (rest) out[target].push(rest);
      continue;
    }
    if (!target) continue;
    const bullet = line.replace(/^[-*\d.)\s]+/, "").trim();
    if (bullet) out[target].push(bullet);
  }
  return out;
}
