/**
 * plan-gap-resolution — how a gap-gate resolution may be written into a spec
 * body (#1111), and how a CRITICAL that quotes such a write is re-routed.
 *
 * Split out of plan-gaps.ts (500-line hard limit, AGENTS.md §12). Imports
 * nothing but the PlanGap type, so plan-gaps and plan-writeback can both depend
 * on it without a cycle.
 */
import type { PlanGap } from "./plan-types.ts";

/**
 * Prefix on every spliced writeback bullet: a gate resolution rendered into a
 * section must be attributable to the gate, never mistakable for an
 * investigator-derived item (vipune round 9). Lives here so the
 * re-route rule below (and plan-writeback.ts) share one spelling.
 */
export const GATE_RESOLUTION_MARKER = "(gate resolution) ";

/**
 * The leading resolution-type label the gate prompt used to ask for
 * ("(a) additional research", "(b) a sharper acceptance criterion", "(c) an
 * Open Question"). It is gate meta-language, never a spec statement.
 */
const RESOLUTION_LABEL_RE = /^\s*\((?:a|b|c)\)\s*/i;

/**
 * The concrete statement a resolution contributes to a spec body: the
 * resolution with its leading (a)/(b)/(c) label removed (#1111).
 */
export function spliceStatement(resolution: string): string {
  return resolution.replace(RESOLUTION_LABEL_RE, "").trim();
}

/**
 * #1111: a CRITICAL whose text quotes a gate-spliced bullet is a finding about
 * the gate's OWN output, not about the spec the author wrote. It is re-routed
 * to the residual disclosure instead of blocking filing.
 */
export function quotesGateBullet(g: PlanGap): boolean {
  const marker = GATE_RESOLUTION_MARKER.trim();
  return g.description.includes(marker) || g.resolution.includes(marker);
}

/**
 * Partition one round's gaps: CRITICAL gaps that quote a gate-spliced bullet
 * are moved out (`rerouted`, to be disclosed at the originating gap's
 * severity — the carried CRITICAL they quote — and never counted toward
 * capRouted); everything else is `kept` for the normal blocking rule.
 */
export function rerouteGateQuotes(
  gaps: PlanGap[],
  carried: PlanGap[],
): { kept: PlanGap[]; rerouted: PlanGap[] } {
  const kept: PlanGap[] = [];
  const rerouted: PlanGap[] = [];
  // Only a CONCRETE carried gap was ever spliced, so only it can be the origin
  // of a gate-spliced bullet. A quote with no matching origin is not ours.
  const spliced = carried.filter((c) => c.resolutionType === "concrete");
  for (const g of gaps) {
    if (g.severity !== "CRITICAL" || !quotesGateBullet(g)) {
      kept.push(g);
      continue;
    }
    const origin = spliced.find((c) => {
      const statement = spliceStatement(c.resolution);
      return (
        statement !== "" && (g.description.includes(statement) || g.resolution.includes(statement))
      );
    });
    if (!origin) {
      kept.push(g);
      continue;
    }
    rerouted.push({ ...g, severity: origin.severity });
  }
  return { kept, rerouted };
}
