/**
 * Wall-clock cap for /work Step 7 fix loops (#4).
 *
 * `pi-prompts/work.md` Step 7 says: 90-min wall-clock cap on the lens-review
 * → developer fix → adversarial → re-review fix loop. The OLD design asked
 * PM to track 90 minutes itself and halt — trust-the-model. Brittle: PM
 * might miscount, forget, or never call dispatch_status before extending.
 *
 * The cap now lives in extension state. PM calls `check_review_cap` with a
 * per-loop key (typically the issue or PR number) on every relevant
 * decision point; the tool answers deterministically.
 *
 * State is per-key — multiple concurrent /work cycles on different issues
 * don't pollute each other's timers. Keys are scoped to this Pi session
 * (module-level Map); restarting Pi resets everything.
 *
 * No mechanical enforcement on `dispatch_lens_review` itself — PM is told
 * (via doctrine) to call the check tool. Discipline-by-prompt, same trust
 * model as dispatch_peek / dispatch_steer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const REVIEW_CAP_MS = 90 * 60 * 1000; // 90 minutes

const caps = new Map<string, number>();

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
}

/**
 * Decide whether the fix loop for `key` is within the cap.
 *
 * On first call (or when `reset: true`): start the timer at `now`, return
 * ok with elapsedMs=0.
 *
 * Subsequent calls: compare `now - startedAt` against the cap; return
 * ok=false when exceeded.
 *
 * Exposed for tests; production callers use the registered tool.
 */
export function checkReviewCap(key: string, opts: { reset?: boolean } = {}): CheckResult {
  const now = Date.now();
  if (opts.reset || !caps.has(key)) {
    caps.set(key, now);
    return {
      ok: true,
      key,
      startedAt: now,
      elapsedMs: 0,
      capMs: REVIEW_CAP_MS,
      reset: true,
      message: `Started review wall-clock timer for "${key}" — cap is ${REVIEW_CAP_MS / 60_000} minutes.`,
    };
  }
  const startedAt = caps.get(key) ?? now;
  const elapsedMs = now - startedAt;
  const ok = elapsedMs <= REVIEW_CAP_MS;
  return {
    ok,
    key,
    startedAt,
    elapsedMs,
    capMs: REVIEW_CAP_MS,
    reset: false,
    message: ok
      ? `Within cap: ${Math.floor(elapsedMs / 60_000)}m elapsed of ${REVIEW_CAP_MS / 60_000}m budget.`
      : `Cap exceeded: ${Math.floor(elapsedMs / 60_000)}m elapsed (cap is ${REVIEW_CAP_MS / 60_000}m). Halt the fix loop and escalate to the user per Step 7 doctrine.`,
  };
}

export function registerCheckReviewCapTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "check_review_cap",
    label: "Check Step 7 Wall-Clock Cap",
    description:
      "Check whether the 90-minute wall-clock cap for a /work Step 7 fix loop has been exceeded. Call with a per-loop key (typically `issue-<N>` or `pr-<N>`) on first entry to Step 7 with `reset: true` to start the timer, then before each new round in 7f WITHOUT `reset` to check elapsed. Returns `{ok: false, ...}` when 90 minutes have elapsed since the timer started — halt the loop and escalate to the user. Returns `{ok: true, ...}` otherwise.",
    parameters: Type.Object({
      key: Type.String({
        description:
          "Per-loop identifier — typically `issue-<N>` or `pr-<N>`. Different keys = independent timers, so concurrent /work cycles on different issues don't share a cap.",
      }),
      reset: Type.Optional(
        Type.Boolean({
          description:
            "Set true to (re)start the timer at the current moment. Use at the start of every Step 7 fix loop. Subsequent calls in the same loop should omit this (or set false) to check against the original start.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { key: string; reset?: boolean };
      const result = checkReviewCap(params.key, { reset: params.reset });
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  });
}
