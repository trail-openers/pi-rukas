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
import { isBuildResidueFailure } from "./work-driver-dirty-root-classify.ts";
import {
  extractAttributedTail,
  hostExhaustionFailure,
  isHostExhaustionFailure,
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
export function boundText(ms: number): string {
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
 * #1324/#1349 — the cap for a failed verify gate. `verify-failed:<step>`
 * means the gate ran and judged the code; the others reached no verdict:
 *
 *   - `verify-env:<step>` — every failure is the system refusing to start a
 *     process or a run killed at its bound, and at least one is the former;
 *   - `verify-timeout:<step>` — every failure is a run killed at its bound;
 *   - `verify-baseline-red:<step>` — `baselineRedOnly`: the base-commit probe
 *     confirmed the verify command fails without the change, and its failures
 *     are the only ones (the caller decides; see verifyDevelopOutcome);
 *   - `verify-env:<step>` also covers #1421's `[build-residue]`: the gate
 *     declined to mutate a root holding untracked, git-ignored build output
 *     (cargo's `target/`, a bundler's `dist/`), so nothing about the change
 *     was judged. An environment refusal, like the fork failure beside it.
 *
 * One real failure among them is a code failure, so the cap stays verify-failed.
 */
export function verifyCapFor<S extends string>(
  step: S,
  failures: readonly string[],
  baselineRedOnly = false,
): `verify-failed:${S}` | `verify-timeout:${S}` | `verify-env:${S}` | `verify-baseline-red:${S}` {
  if (failures.length === 0) return `verify-failed:${step}`;
  const noVerdict = (f: string) =>
    isHostExhaustionFailure(f) || isVerifyTimeoutFailure(f) || isBuildResidueFailure(f);
  if (failures.every(noVerdict) && failures.some(isHostExhaustionFailure))
    return `verify-env:${step}`;
  // #1421 — build residue alone is an environment refusal, not a verdict.
  if (failures.every(isBuildResidueFailure)) return `verify-env:${step}`;
  if (failures.every(isVerifyTimeoutFailure)) return `verify-timeout:${step}`;
  return baselineRedOnly ? `verify-baseline-red:${step}` : `verify-failed:${step}`;
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
