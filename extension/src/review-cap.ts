/**
 * Wall-clock cap for /work Step 7 fix loops (#4).
 *
 * Doctrine: a 90-min wall-clock cap on the lens-review → developer fix →
 * adversarial → re-review fix loop. The OLD design asked
 * PM to track 90 minutes itself and halt — trust-the-model. Brittle: PM
 * might miscount, forget, or never call dispatch_status before extending.
 *
 * The cap now lives in extension state. PM starts it with `start_review_cap`
 * and reads it with `check_review_cap` (a per-loop key, typically the issue or
 * PR number) on every relevant decision point; the tool answers
 * deterministically. #1313 — the two are separate tools: a PM that only meant
 * to read the budget called the one tool with no `reset`, started a timer for
 * a key nothing used, and could not tell which budget it had touched. The read
 * never writes.
 *
 * State is per-key — multiple concurrent /work cycles on different issues
 * don't pollute each other's timers. Keys are scoped to this Pi session
 * (module-level Map); restarting Pi resets everything.
 *
 * This timer covers the /work review loop only. `dispatch_lens_review` has its
 * own round budget, enforced mechanically in the tool (lens-round-cap.ts,
 * #1127); the two are independent and neither reads the other.
 * Discipline-by-prompt for this timer, same trust model as dispatch_peek /
 * dispatch_steer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { reviewCapMs } from "./review-budget.ts";

// #1429 — this file used to carry its own `const REVIEW_CAP_MS = 90 * 60 *
// 1000`, a second copy of the driver's ceiling that no knob reached. It is
// gone deliberately: `reviewCapMs()` in work-driver-context.ts is now the only
// place this ceiling is stated, so the tool's answer, the tool description and
// the driver's own budget cannot drift apart again.

// Hard cap on distinct keys. A long PM session that called check_review_cap
// for many issues would otherwise grow the Map unbounded. 100 is well above
// realistic usage (concurrent /work cycles are rare; each adds one key) and
// the audit's bounded-state convention (#171) is to cap state explicitly.
const MAX_CACHED_CAPS = 100;
// Mirror permission-guard.ts's DECISION_KEY_MAX_LENGTH — long keys are almost
// always a misuse (PM passing a payload instead of an identifier).
const MAX_KEY_LENGTH = 250;

const caps = new Map<string, number>();

// Evict the oldest entry (smallest startedAt) once the map exceeds the cap.
// Caller invokes this right after caps.set(); only runs work when the cap is
// breached, so amortised cost is O(1) for typical usage.
function evictOldestCap(): void {
  if (caps.size <= MAX_CACHED_CAPS) return;
  let oldestKey: string | undefined;
  let oldestStartedAt = Number.POSITIVE_INFINITY;
  for (const [k, startedAt] of caps) {
    if (startedAt < oldestStartedAt) {
      oldestKey = k;
      oldestStartedAt = startedAt;
    }
  }
  if (oldestKey !== undefined) caps.delete(oldestKey);
}

/** Test-only — purge state between cases. */
export function reset(): void {
  caps.clear();
}

/** Test-only snapshot of the timer map. */
export function snapshot(): Array<{ key: string; startedAt: number }> {
  return [...caps.entries()].map(([key, startedAt]) => ({ key, startedAt }));
}

interface CheckResult {
  ok: boolean;
  key: string;
  startedAt: number;
  elapsedMs: number;
  capMs: number;
  reset: boolean;
  /** Human-readable reason when ok=false; otherwise the elapsed/remaining summary. */
  message: string;
  /** #1313 — a read-only check found no timer for the key (nothing was started). */
  missing?: true;
}

/**
 * Decide whether the fix loop for `key` is within the cap.
 *
 * On first call (or when `reset: true`): start the timer at `now`, return
 * ok with elapsedMs=0. Note that `reset: true` UNCONDITIONALLY overwrites
 * any existing timer for `key` — if PM sends it mid-loop by mistake the cap
 * is defeated. This is by design (matches dispatch_kill / dispatch_steer's
 * trust-the-prompt model); enforcement is via /work doctrine, not mechanics.
 *
 * Subsequent calls: compare `now - startedAt` against the cap; return
 * ok=false when exceeded.
 *
 * `readOnly` (the `check_review_cap` tool, #1313): never start or reset a
 * timer; an unknown key answers ok with `missing: true`.
 *
 * Exposed for tests; production callers use the registered tools.
 */
export function checkReviewCap(
  key: string,
  opts: { reset?: boolean; readOnly?: boolean } = {},
): CheckResult {
  const now = Date.now();
  // Resolved per call, so the operator's PI_ENSEMBLE_REVIEW_CAP_MS applies to
  // a check made mid-cycle rather than being frozen at module load.
  const capMs = reviewCapMs();
  // Validate before any state mutation — invalid keys must not pollute the
  // map. Empty/long keys are almost always a misuse (PM sending a payload
  // instead of an identifier). Return ok=true with a clear diagnostic so
  // the loop continues but the PM sees the warning in the response text.
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return {
      ok: true,
      key,
      startedAt: now,
      elapsedMs: 0,
      capMs,
      reset: false,
      message: `Invalid cap key (${key.length === 0 ? "empty" : `${key.length} chars; max ${MAX_KEY_LENGTH}`}) — pass a short identifier like "issue-42". Timer not started; cap not enforced for this call.`,
    };
  }
  if (opts.readOnly && !caps.has(key)) {
    return {
      ok: true,
      key,
      startedAt: now,
      elapsedMs: 0,
      capMs,
      reset: false,
      missing: true,
      message: `No review timer for "${key}" — nothing was started; start_review_cap starts one. A running /work cycle keeps its own review budget, which this tool does not read: the driver enforces it and parks by itself.`,
    };
  }
  if (!opts.readOnly && (opts.reset || !caps.has(key))) {
    caps.set(key, now);
    evictOldestCap();
    return {
      ok: true,
      key,
      startedAt: now,
      elapsedMs: 0,
      capMs,
      reset: true,
      message: `Started review wall-clock timer for "${key}" — cap is ${capMs / 60_000} minutes.`,
    };
  }
  const startedAt = caps.get(key) ?? now;
  const elapsedMs = now - startedAt;
  const ok = elapsedMs <= capMs;
  return {
    ok,
    key,
    startedAt,
    elapsedMs,
    capMs,
    reset: false,
    message: ok
      ? `Within cap: ${Math.floor(elapsedMs / 60_000)}m elapsed of ${capMs / 60_000}m budget.`
      : `Cap exceeded: ${Math.floor(elapsedMs / 60_000)}m elapsed (cap is ${capMs / 60_000}m). Halt the fix loop and escalate to the user per Step 7 doctrine.`,
  };
}

const KEY_PARAM = Type.String({
  description:
    "Per-loop identifier — typically `issue-<N>` or `pr-<N>`. Different keys = independent timers, so concurrent loops on different issues don't share a cap.",
});

function reply(result: CheckResult) {
  return { content: [{ type: "text" as const, text: result.message }], details: result };
}

export function registerCheckReviewCapTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_review_cap",
    label: "Check Review Wall-Clock Cap",
    description:
      // #1429 — the advertised number follows the configured ceiling, so the
      // tool no longer tells the agent "90 minutes" while enforcing something
      // else. `registerTool` runs once at session start, so this reflects the
      // environment as the operator set it for this session.
      `Read-only: check the ${reviewCapMs() / 60_000}-minute wall-clock cap of a fix loop whose timer start_review_cap started. Never starts or resets a timer. Returns \`{ok: false, ...}\` once the cap has elapsed — halt the loop and escalate; \`{ok: true, missing: true}\` when no timer exists for the key. A running /work cycle's own review budget is the driver's, not this tool's.`,
    parameters: Type.Object({ key: KEY_PARAM }),
    async execute(_id, raw) {
      return reply(checkReviewCap((raw as { key: string }).key, { readOnly: true }));
    },
  });
  pi.registerTool({
    name: "start_review_cap",
    label: "Start Review Wall-Clock Cap",
    description: `Start (or restart) the ${reviewCapMs() / 60_000}-minute wall-clock timer for a fix loop, at the start of the loop. Restarting mid-loop defeats the cap. Read it afterwards with check_review_cap.`,
    parameters: Type.Object({ key: KEY_PARAM }),
    async execute(_id, raw) {
      return reply(checkReviewCap((raw as { key: string }).key, { reset: true }));
    },
  });
}
