/**
 * work-driver-plan-verdicts — the explore-reply verdict parsers.
 *
 * Moved verbatim out of work-driver-plan.ts for the AGENTS.md §12 500-line
 * gate (the same seam `work-driver-plan-parse.ts` and
 * `work-driver-plan-workstreams.ts` already are: "what does this markdown
 * say?" is a different question from "is this plan any good?", and the plan
 * step that owns both had grown past the cap).
 *
 * `work-driver-plan.ts` re-exports all three so the existing importers
 * (test-work-driver-pr6, test-work-driver-pr10-core, test-reply-markers and
 * the explore step) keep their paths unchanged.
 */

/** The explore reply's three-way verdict, plus the per-issue shape. */
export type ExploreVerdict = "NEEDS_WORK" | "ALREADY_COMPLETE" | "NEEDS_CLARIFICATION";

export function parseExploreVerdict(text: string): ExploreVerdict | null {
  const m = text.match(/VERDICT:\s*\**\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\b/i);
  const tok = m?.[1];
  return tok ? (tok.toUpperCase() as ExploreVerdict) : null;
}

/**
 * PR10 — Multi-issue counterpart to parseExploreVerdict.
 *
 * For `/work N M P`, explore returns a per-issue verdict block like:
 *
 *   ## Verdict
 *   - #561: NEEDS_WORK
 *   - #562: ALREADY_COMPLETE — satisfied by PR #534
 *   - #563: NEEDS_WORK
 *
 * Parses one verdict per requested issue number. The `reason` string
 * captures the trailing prose after `—`/`-` (handoff renderers surface
 * it). When explore omitted a per-issue line for an issue, fall back
 * to the overall verdict via parseExploreVerdict; if even that is
 * absent, default to NEEDS_WORK so the driver proceeds rather than
 * silently dropping the issue.
 */
export function parsePerIssueVerdicts(
  text: string,
  issues: number[],
): Array<{
  issue: number;
  verdict: ExploreVerdict;
  reason: string;
  /** Where the verdict came from. `default` means nothing was parsed (#408). */
  verdictSource: "per-issue" | "overall" | "default";
}> {
  const overall = parseExploreVerdict(text);
  return issues.map((n) => {
    const re = new RegExp(
      `#${n}\\s*:\\s*\\**\\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\\b\\**\\s*[—\\-]?\\s*(.*)`,
      "i",
    );
    const m = text.match(re);
    const tok = m?.[1];
    if (tok) {
      const reason = (m?.[2] ?? "").trim();
      return {
        issue: n,
        verdict: tok.toUpperCase() as ExploreVerdict,
        reason,
        verdictSource: "per-issue" as const,
      };
    }
    if (overall) {
      return {
        issue: n,
        verdict: overall as ExploreVerdict,
        reason: "(no per-issue verdict; using overall)",
        verdictSource: "overall" as const,
      };
    }
    // #408 — this used to default to NEEDS_WORK, i.e. BUILD IT. Nothing in
    // the reply said so; the driver invented it. That is the "silence is
    // permission" shape #378 set out to remove, and it survived here on the
    // multi-issue path — which #397 then made the ONLY multi-issue path.
    //
    // A value the driver made up must not drive an irreversible decision
    // (the #404 lesson, one step upstream). NEEDS_CLARIFICATION drops the
    // issue and tells the operator the verdict could not be read, which is
    // recoverable; building something nobody asked for is not.
    return {
      issue: n,
      verdict: "NEEDS_CLARIFICATION" as ExploreVerdict,
      reason:
        "the verdict for this issue could not be read — neither a per-issue marker nor an overall VERDICT was present. Not building on a verdict the driver invented.",
      verdictSource: "default" as const,
    };
  });
}
