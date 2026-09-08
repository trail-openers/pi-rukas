/**
 * forge-ci-terminal — terminal CI status sets + the per-forge selector.
 *
 * Leaf module of the forge adapter: imported one-way by both `forge.ts`
 * (re-export for callers that reach the pieces from the adapter) and
 * `forge-ci.ts` (the watch loop polls until a terminal status). It creates
 * no edge back — the import-cycle canary (smoke-tests/test-forge-no-cycle.ts)
 * pins that `forge-ci.ts` holds no VALUE import from `forge.ts`.
 */
import type { ForgeType } from "./forge-detect.ts";

/**
 * Terminal statuses for CI-watch, normalized to uppercase.
 *
 * - GitHub Actions run conclusions (uppercase after mapping): SUCCESS,
 *   FAILURE, CANCELED, NEUTRAL, SKIPPED, TIMED_OUT, STOPPED.
 * - GitLab pipeline terminal statuses (per the epic spec): SUCCESS, FAILED,
 *   CANCELED, SKIPPED, MANUAL. (GitLab's `manual` is terminal because the
 *   pipeline is waiting for a human trigger, not a bot.)
 *
 * The watch loop polls until the run/pipeline status lands in this set, or
 * the 30-minute cap fires.
 */
export const GH_TERMINAL_CI: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILURE",
  "CANCELED",
  "CANCELLED",
  "NEUTRAL",
  "SKIPPED",
  "TIMED_OUT",
  "STOPPED",
]);

export const GL_TERMINAL_CI: ReadonlySet<string> = new Set([
  "SUCCESS",
  "FAILED",
  "CANCELED",
  "SKIPPED",
  "MANUAL",
]);

export function terminalCiFor(forge: ForgeType): ReadonlySet<string> {
  return forge === "gitlab" ? GL_TERMINAL_CI : GH_TERMINAL_CI;
}
