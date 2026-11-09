/**
 * review-bash-timeout — the in-child `tool_call` hook that bounds a REVIEWER's
 * bash call (#2140).
 *
 * A reviewer that never returns from one bash call never returns from its turn
 * either: no steer can land and the whole-child bound ends the review with no
 * verdict. This hook does not kill anything — it lowers `event.input.timeout`
 * to the bound and Pi's own bash tool enforces it, answering the child with the
 * usual "Command timed out after N seconds" error result. The child keeps its
 * turn, the steer arrives, the review still reaches a verdict. Because that
 * error text is the operator's evidence the bound fired, there is no killCause,
 * no parent timer and no process kill.
 *
 * Nested calls — a `bash` a codemode script made, carrying `parentToolCallId` —
 * reach these same handlers, so they are bounded too; the codemode call itself
 * is not a bash call and is left alone.
 *
 * Every seam is read per call, so one environment decides for every process:
 * the harness-set role, the caps master switch that makes every other bound
 * inert, and the knob itself — a plain decimal ms value (`Number()` alone took
 * `1e308`, hex and a digit separator). An invalid non-empty value means NO bound
 * and warns, like the sibling review knobs; empty or unset means the default.
 * The hook never throws: it registers through `failClosedPi`, whose wrapper
 * turns a thrown handler into a `{ block: true }` refusal, so an operator knob
 * cannot refuse a reviewer's bash call — a write that fails warns, as written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReviewerRole } from "./review-bounds.ts";
import { trace, traceWarn } from "./trace.ts";

/** Ten minutes: above a per-file test run, far below the 60-min tool-inactivity
 *  bound, inside the 30-min lens bound. */
const DEFAULT_REVIEW_BASH_TIMEOUT_MS = 600_000;

/** Pi's bash ceiling for `timeout` (its MAX_TIMEOUT_MS / 1000): past it the tool
 *  rejects the value, so a knob asking for it gets no bound. A plain decimal ms
 *  value is required because `Number()` also takes a sign, exponent, hex and
 *  digit separators, none of which an operator types for a bound. The return is
 *  in the SECONDS Pi's bash schema takes; undefined means no bound. */
const MAX_BASH_TIMEOUT_SECONDS = 2_147_483;
const PLAIN_MILLISECONDS = /^\d+(\.\d+)?$/;

export function reviewBashBoundSeconds(): number | undefined {
  const text = process.env.PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS?.trim() ?? "";
  if (text === "") return Math.ceil(DEFAULT_REVIEW_BASH_TIMEOUT_MS / 1000);
  const seconds = PLAIN_MILLISECONDS.test(text) ? Math.ceil(Number(text) / 1000) : Number.NaN;
  // One range test, not two: a non-plain value is NaN and NaN fails this.
  if (!(seconds >= 1 && seconds <= MAX_BASH_TIMEOUT_SECONDS)) {
    traceWarn(
      `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS=${text.slice(0, 40)} is not a bash-range second count`,
    );
    return undefined;
  }
  return seconds;
}

/** Mutate a reviewer's bash call to run within the bound; never block it. */
export function registerReviewBashTimeout(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash" || process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0") return;
    if (!isReviewerRole(process.env.PI_ENSEMBLE_ROLE ?? "")) return;
    const bound = reviewBashBoundSeconds();
    if (bound === undefined) return;
    const input = event.input as { timeout?: unknown } | undefined | null;
    if (typeof input !== "object" || input === null) return;
    // Only a finite positive timeout the model chose for itself survives (a
    // `timeout 120` it wrote); absent, 0, negative, NaN, a string or over the
    // ceiling is replaced, so an oversized one is clamped too.
    const chosen = input.timeout;
    if (typeof chosen !== "number" || !Number.isFinite(chosen) || !(chosen > 0) || chosen > bound) {
      try {
        input.timeout = bound;
      } catch (err) {
        // A frozen input must not throw: into the wrapper above that is a refusal.
        traceWarn(`review-bash-timeout: could not set the bound: ${String(err)}`);
        return;
      }
      trace(`review-bash-timeout: bounded a reviewer bash call to ${bound}s`);
    }
  });
}
