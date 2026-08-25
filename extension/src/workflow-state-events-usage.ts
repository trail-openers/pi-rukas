/**
 * workflow-state-events-usage — the shared `usage` mapper for the
 * dispatch-outcome WorkEvent members (issue #534).
 *
 * Split out of `workflow-state-events.ts` for module-size hygiene (AGENTS.md
 * §12): the WorkEvent union lives in that file and sits at its line cap, so
 * the small pure mapper + its two types have a home of their own. Both
 * emission sites draw from here — the shared `buildCompletionEvent` mapper
 * in `work-driver-merged.ts` and the lens fan-out in `work-driver-lens.ts` —
 * so "which events can carry usage" is defined exactly once.
 */

import type { DispatchUsage } from "./types.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * The three dispatch-outcome WorkEvent members that carry an optional
 * `usage`. Keyed by `kind` (not `WorkEvent["kind"]`) so a caller can pass a
 * fresh object literal and get each member's exact field types (e.g. `step`
 * as `WorkStep`, not `string`) back out of `withUsage`.
 */
export type UsageEventKind = "dispatch-completed" | "dispatch-failed" | "dispatch-failed-provider";

export type UsageEvent = Extract<WorkEvent, { kind: UsageEventKind }>;

/**
 * Attach a dispatch's usage to one of the usage-carrying events.
 *
 * #534 — the single mapper every driver event emission uses to decide
 * whether to write `usage`. The rule: attach only when a
 * `DispatchResult.usage` object is actually in scope at the emission
 * point. Absent (no child dispatch exists, or the child was killed before
 * flushing any tokens) → the field is omitted, never synthesised as zeros.
 *
 * Omission on failure is load-bearing: a hard-throw path has no
 * `DispatchResult` to draw from, and a killed child's flushed usage (summed
 * by `collapseEvents`) is real spend that counts toward the cycle total.
 *
 * `T extends UsageEvent` (rather than a bare `{ kind: UsageEventKind }`
 * constraint) is what keeps the per-member field types intact: constraining
 * on the bare discriminator widens the object literal's `kind` to
 * `UsageEventKind` and the rest of the member's fields to `string`, which
 * is not assignable back into `appendEvent`.
 */
export function withUsage<T extends UsageEvent>(event: T, usage: DispatchUsage | undefined): T {
  if (!usage) return event;
  return { ...event, usage };
}
