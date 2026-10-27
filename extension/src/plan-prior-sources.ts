/**
 * plan-prior-sources — how the /plan pipeline TAGS the prior context it hands
 * its children, and what those children must conclude from the tag.
 *
 * Split out of plan-draft.ts along the AGENTS.md §12 500-line cap. plan-draft.ts
 * re-exports all three for its existing consumers (plan-angles.ts,
 * plan-gate-prompt.ts, plan-prior-context-assembly.ts, research-driver.ts), so
 * the split moved no import site.
 */

/**
 * D6: the source tag for vipune-sourced prior-context entries.
 *
 * A blocked planning session naturally saves its spec to vipune; the next
 * run retrieves that stale copy, and the gap gate can raise a CRITICAL over a
 * "contradiction" between the operator's CURRENT context and their own
 * two-runs-old snapshot (FIELD-CONFIRMED in transcript mtsnbz8b — the same
 * vipune entry "ebfa12c1" quoted its own prior ACs into the next round's
 * gap-gate prompt). The tag makes the entry's provenance visible to the
 * reviewer, and the precedence instruction (VIPUNE_PRECEDENCE_NOTE) tells
 * both the Phase-2 angle children and the gap gate that a vipune entry is a
 * prior snapshot, not live authority.
 */
export const VIPUNE_PRIOR_SOURCE = "vipune (prior snapshot — may be stale)";

/**
 * D6: the explicit precedence instruction rendered into BOTH the angle
 * prompts (plan-angles.ts: buildAnglePrompt) and the gap-gate prompt
 * (plan-driver.ts: gapGatePrompt) whenever prior context contains vipune
 * entries. On conflict between a vipune-sourced entry and a context-param
 * entry or live code, the LIVE context wins: vipune entries are from a
 * previous run and may be stale.
 */
export const VIPUNE_PRECEDENCE_NOTE =
  "PRECEDENCE: entries tagged with a vipune source are snapshots saved during a previous planning run and MAY BE STALE. On conflict between a vipune-sourced entry and a context-param entry or live code, the LIVE context (context param / current code) wins — do not raise a gap for a vipune entry that conflicts with live context, and do not let a stale vipune entry contradict the operator's current instructions.";

/** True when any prior-context entry carries a vipune source tag (D6). */
export function priorContextHasVipune(priorContext: { source: string; fact: string }[]): boolean {
  return priorContext.some((p) => p.source.startsWith("vipune"));
}
