/**
 * work-driver-failure-text — the reason-string pieces of the failure taxonomy: how long an
 * operator-facing reason may be, and how a provider's own text is cut to fit it. Split from
 * `work-driver-failure-taxonomy.ts` (AGENTS.md §12): the classifier decides what happened, this
 * decides how much of it a scrollback line may carry. The budget is ONE number shared by the
 * reason renderers, the completion event and the diff cap, so it lives beside the clip that
 * enforces it rather than being restated at each site.
 */

/**
 * #1243 — the whole reason, not a prefix of it. Every reason site used to
 * `slice(0, 60)` the provider's message and the child's tail, which is why the
 * three measured cycles all read `subagent failed: Adversarial loop infrastructure
 * failure: round 2 review disp` — cut 60 characters into our OWN composite
 * text, so the number that followed was invisible and the one number that WAS
 * visible ("3m54s") read as a constant rather than that attempt's cost.
 *
 * 240 is a compromise: enough of the endpoint's own error to act on, bounded
 * enough that a stack-trailing provider body cannot dominate a scrollback line
 * or a headless `message` field (headless/failure.ts applies its own tighter
 * caps on top of this one).
 */
export const FAILURE_REASON_CHARS = 240;

/** Clip to the reason budget, preserving `undefined` — callers distinguish an
 * absent field from an empty one (`?? "connection lost"` style defaults). */
export function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > FAILURE_REASON_CHARS ? text.slice(0, FAILURE_REASON_CHARS) : text;
}

/** #79 — `×N in a row` when the loop stopped on a repeating provider error. */
export function repeatsNote(tail: { providerRepeats?: number }): string {
  const n = tail.providerRepeats ?? 0;
  return n >= 2 ? ` (×${n} in a row — not re-dispatched)` : "";
}
