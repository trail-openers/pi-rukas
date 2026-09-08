/**
 * plan-gaps — Phase-4 gap-gate parsing and cap routing for the compiled
 * /plan pipeline.
 *
 * Split out of plan-driver.ts at the same seam as forge-ci.ts / plan-draft.ts
 * (the 500-line hard limit, AGENTS.md §12). Owns:
 *
 *   - `parseGaps`: the reviewer-reply parser (GAP: markers only, verdict
 *     line, and — since this split — a `verdictParsed` flag that keeps an
 *     ABSENT verdict from silently passing as READY when CRITICAL/HIGH gaps
 *     are present (D3)),
 *   - the iteration cap: `evaluateGapGate` decides READY / one corrective
 *     round / cap-hit, and `capRouted` applies the routing policy — at the
 *     cap, zero CRITICAL/HIGH gaps FILE the spec with the residual
 *     MEDIUM/LOW gaps disclosed in a "## Residual gap-gate findings" section
 *     (D2); CRITICAL/HIGH remain → do not file, surface to the operator.
 *     Direct precedent: /work's lens round cap routes to CI instead of
 *     parking when the residuals were posted (AGENTS.md §7 "The round cap
 *     routes, it does not only stop").
 */
import type { PlanGap } from "./plan-types.ts";

/** One verdict the gap gate can yield for a parsed reviewer reply. */
export type GapGateVerdict = "READY" | "NEEDS_ITERATION";

export interface GapGateParse {
  gaps: PlanGap[];
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
  const gapRe = /^\s*GAP:\s*(CRITICAL|HIGH|MEDIUM|LOW)\b[—–-]?\s*(.*)$/i;
  for (const line of lines) {
    const m = line.match(gapRe);
    if (!m) continue;
    const rest = (m[2] ?? "").trim();
    const resMatch = rest.match(/[—–-]?\s*proposed resolution:\s*(.+)$/i);
    const resolution = resMatch?.[1]?.trim() ?? "address during /work plan phase";
    const description = (resMatch ? rest.slice(0, resMatch.index) : rest).trim();
    if (!description) continue;
    gaps.push({
      severity: (m[1] ?? "MEDIUM").toUpperCase() as PlanGap["severity"],
      description: description.slice(0, 300),
      resolution,
    });
  }
  // D3: track whether a verdict line was actually present. The legacy
  // "silence = READY" default survives ONLY for the MEDIUM/LOW-only case;
  // with CRITICAL/HIGH gaps present, an absent verdict routes to
  // NEEDS_ITERATION in `evaluateGapGate` instead of filing a spec its own
  // reviewer rated HIGH-gap (transcripts mtsn8vox / mtsngexs).
  const verdictLine = [...lines].reverse().find((l) => /verdict\s*[:—-]/i.test(l));
  const verdictParsed = typeof verdictLine === "string";
  const verdict: GapGateVerdict =
    verdictParsed && /needs[_ ]iteration/i.test(verdictLine) ? "NEEDS_ITERATION" : "READY";
  if (gaps.length === 0) {
    return {
      gaps: [
        { severity: "MEDIUM", description: "no structured gaps parsed", resolution: "proceed" },
      ],
      verdict,
      verdictParsed,
    };
  }
  return { gaps, verdict, verdictParsed };
}

/** The gaps that block filing: CRITICAL or HIGH severity. */
export function blockingGaps(gaps: PlanGap[]): PlanGap[] {
  return gaps.filter((g) => g.severity === "CRITICAL" || g.severity === "HIGH");
}

/**
 * Decide what to do with one parsed gate round.
 *
 * READY — the reviewer said READY (or stayed silent with no CRITICAL/HIGH
 * gaps) AND nothing CRITICAL/HIGH remains.
 * NEEDS_ITERATION — otherwise; if there are still corrective rounds left,
 * the driver re-drafts with the blocking gaps carried as resolved open
 * questions and re-reviews.
 */
export function evaluateGapGate(parsed: GapGateParse, iterations: number, maxIterations: number) {
  const blocking = blockingGaps(parsed.gaps);
  // D3: an ABSENT verdict with CRITICAL/HIGH gaps present must not pass.
  // The reviewer either stopped mid-reply (mtsn8vox: full review, 4 HIGH
  // gaps, no verdict line) or chose to leave the call open (mtsn8exs — 99 output tokens, stopped mid-reply).
  // Treat the silence as "another round" — the corrective round either
  // gets a real verdict or burns into the cap, which D2 then routes.
  const effectiveVerdict: GapGateVerdict =
    !parsed.verdictParsed && blocking.length > 0 ? "NEEDS_ITERATION" : parsed.verdict;
  const ready = effectiveVerdict === "READY" && blocking.length === 0;
  if (ready) return { ready: true, blocking: [] };
  const corrective = iterations < maxIterations;
  return { ready: false, blocking, corrective, capHit: !corrective };
}

/**
 * D2: the cap ROUTES, it does not only stop (AGENTS.md §7 — /work's lens
 * round cap routes to CI when the residuals were posted; a silent swallow is
 * worse than a park). At the iteration cap:
 *
 *   - zero CRITICAL/HIGH gaps remaining → FILE the spec, disclosing the
 *     residual MEDIUM/LOW gaps in a "## Residual gap-gate findings" section
 *     of the issue body (each with its severity and the reviewer's proposed
 *     resolution). The disclosure is the precondition for filing.
 *   - any CRITICAL or HIGH remaining → do NOT file; surface to the operator.
 */
export function capRouted(blocking: PlanGap[]): "file" | "surface" {
  return blocking.length === 0 ? "file" : "surface";
}

/**
 * The residual-findings disclosure appended to the spec when the cap routes
 * to filing (D2). Naming each gap with its severity + proposed resolution is
 * what makes the disclosure a disclosure — an unposted residual would be the
 * silent swallow the /work doctrine refuses.
 */
export function residualGapsSection(residual: PlanGap[]): string {
  const items = residual
    .map((g) => `- [${g.severity}] ${g.description} → ${g.resolution}`)
    .join("\n");
  return `## Residual gap-gate findings\n\n${items}\n`;
}
