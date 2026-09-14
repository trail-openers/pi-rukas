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
import { extractAttributedTail } from "./work-driver-exec-error.ts";

/** PR17 — bounded wall-clock for the verify command (default 10 min). */
export function verifyTimeoutMs() {
  const env = Number(process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return 10 * 60_000;
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
  return e.killed ? timeoutMsg : `${failMsg}: ${suffix ?? e.message?.slice(0, 300)}`;
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
