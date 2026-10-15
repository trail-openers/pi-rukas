/**
 * work-driver-verify-develop-helpers — exec-error formatting and verify-cmd
 * gate plumbing for the develop-step outcome check.
 *
 * Extracted from work-driver-verify-develop.ts (file-size cap, AGENTS.md §12):
 * the bounded wall-clock timeout, the exec-error formatter with its
 * attribution-aware output tail (#723), the scope-path normaliser, and the
 * skip-ratchet test-delete tolerance. Import chain:
 * work-driver-verify-develop.ts → this file → work-driver-exec-error.ts
 * (acyclic).
 */

import { trace } from "./trace.ts";
import {
  extractAttributedTail,
  hostExhaustionFailure,
  isHostForkExhaustion,
  pidLimitSnapshot,
} from "./work-driver-exec-error.ts";

/** PR17 — bounded wall-clock for the verify command (default 10 min). */
export function verifyTimeoutMs() {
  const env = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return 10 * 60_000;
}

/** Leads a failure string for a verify run killed at its bound (#1324). */
export const VERIFY_TIMEOUT_LABEL = "[verify-timeout]";

/** The bound as a person reads it: whole minutes, else seconds. */
function boundText(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000}-min` : `${Math.round(ms / 1000)}s`;
}

/**
 * #1324 — the failure string for a verify run killed at its bound. A killed
 * run reached no verdict, so the string names the bound and the knob, never
 * an assertion about the code. `where` completes "exceeded its bound <where>".
 */
export function verifyTimeoutFailure(
  cmd: string,
  where: string,
  timeoutMs: number,
  knob = "PI_ENSEMBLE_VERIFY_TIMEOUT_MS",
): string {
  return `${VERIFY_TIMEOUT_LABEL} verify command \`${cmd}\` exceeded its ${boundText(timeoutMs)} timeout ${where} — the run was killed at the bound (${knob}), so it reached no verdict about the code`;
}

export function isVerifyTimeoutFailure(failure: string): boolean {
  return failure.includes(VERIFY_TIMEOUT_LABEL);
}

/**
 * #1324 — the cap for a failed verify gate: `verify-timeout:<step>` when
 * every failure is a run killed at its bound (nothing judged the code), else
 * `verify-failed:<step>`. One real failure among timeouts is a code failure.
 */
export function verifyCapFor<S extends string>(
  step: S,
  failures: readonly string[],
): `verify-failed:${S}` | `verify-timeout:${S}` {
  return failures.length > 0 && failures.every(isVerifyTimeoutFailure)
    ? `verify-timeout:${step}`
    : `verify-failed:${step}`;
}

/**
 * PR338 — format an exec error with a bounded, attribution-aware output
 * tail. #723 — anchors on the last sub-command's `FAILED: <file>` marker
 * (see work-driver-exec-error.ts) so a combined multi-stage verify-cmd run
 * never reports an earlier PASSING sub-command's output as the failure.
 */
export function formatExecError(
  e: Error & { stdout?: string; stderr?: string; killed?: boolean },
  timeoutMsg: string,
  failMsg: string,
) {
  const { tail, attributed } = extractAttributedTail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`, 1500);
  if (!attributed && tail)
    trace("work-driver: exec error tail is unattributed (no FAILED: marker found)");
  const suffix = tail
    ? attributed
      ? tail
      : `${tail} (unattributed — best-effort tail)`
    : undefined;
  if (e.killed) return timeoutMsg;
  const detail = suffix ?? e.message?.slice(0, 300) ?? "";
  // A command the host could not fork never ran: say so, rather than
  // reporting "failed" in the same words a real defect gets. Read from the
  // reported evidence, not the whole stream — a passing stage that merely
  // prints the phrase must not relabel a real failure further down.
  if (isHostForkExhaustion(detail)) {
    return hostExhaustionFailure(
      failMsg.replace(" failed in ", " in "),
      detail,
      pidLimitSnapshot(),
    );
  }
  return `${failMsg}: ${detail}`;
}

/** #285 — normalise a scope path like git would spell it. */
export function normaliseScopePath(raw: string) {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** #307 — maximum number of net-removed test blocks tolerated in a diff. */
export function testDeleteTolerance() {
  const env = Number(process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE);
  if (!Number.isFinite(env) || env < 0) return 0;
  return Math.floor(env);
}
