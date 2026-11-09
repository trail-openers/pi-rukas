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
 * Every seam is read per call so one environment decides for every process that
 * loads the hook: the role the harness sets in every child, the caps master
 * switch that makes every other bound inert, and the knob itself. A value that
 * does not parse to a positive finite number means NO bound — never 0, never NaN.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReviewerRole } from "./review-bounds.ts";
import { trace } from "./trace.ts";

/** Ten minutes: above a per-file test run, far below the 60-min tool-inactivity
 *  bound, inside the 30-min lens bound. */
const DEFAULT_REVIEW_BASH_TIMEOUT_MS = 600_000;

/** The bound in the SECONDS Pi's bash schema takes; undefined means no bound. */
export function reviewBashBoundSeconds(): number | undefined {
  const raw = process.env.PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS?.trim() ?? "";
  const n = raw === "" ? DEFAULT_REVIEW_BASH_TIMEOUT_MS : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.ceil(n / 1000);
}

/** Mutate a reviewer's bash call to run within the bound; never block it. */
export function registerReviewBashTimeout(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash" || process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0") return;
    if (!isReviewerRole(process.env.PI_ENSEMBLE_ROLE ?? "")) return;
    const bound = reviewBashBoundSeconds();
    if (bound === undefined) return;
    const input = event.input as { timeout?: number };
    // A smaller timeout the model chose (e.g. `timeout 120`) is kept; a
    // negative or NaN one is not "smaller" and is replaced.
    if (typeof input?.timeout === "number" && input.timeout > 0 && input.timeout <= bound) return;
    input.timeout = bound;
    trace(`review-bash-timeout: bounded a reviewer bash call to ${bound}s`);
  });
}
