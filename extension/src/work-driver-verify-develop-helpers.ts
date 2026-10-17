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
import type { HangProcess } from "./work-driver-gate-hang.ts";
import {
  captureProcessTree,
  deepestCommands,
  extractRunningTests,
  gateHangClause,
} from "./work-driver-gate-hang.ts";

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
 *
 * #1427 — `hang` is what the gate observed about the run it killed: the test
 * names the runner had flagged, the gate's own process tree, and the tail of
 * its output. It is appended as a clause, so the headline still leads with the
 * bound (the `verify-timeout:<step>` cap router and the handoff explainer key on
 * that text), and the operator sees "hung in test X, N process(es) still
 * alive" where earlier cycles could only say "slow".
 *
 * `where` is a string the CALLER composed, so it is the one place a hang report
 * can be attached without threading a structured argument through every gate
 * seam's call site: each site appends the report to its own `where`.
 */
export function verifyTimeoutFailure(
  cmd: string,
  where: string,
  timeoutMs: number,
  knob = "PI_ENSEMBLE_VERIFY_TIMEOUT_MS",
): string {
  return `${VERIFY_TIMEOUT_LABEL} verify command \`${cmd}\` exceeded its ${boundText(timeoutMs)} timeout ${where} — the run was killed at the bound (${knob}), so it reached no verdict about the code`;
}

/** What a gate seam knows about the run it killed, to build a hang report from. */
export interface KilledGateRun {
  /** The killed run's combined stdout+stderr (the source of the slow-test lines). */
  output: string;
  /** The leader pid the executor killed, when the executor reported one. */
  treePid?: number;
  /** The killed run's own command — the fast tier's when that is what hung. */
  cmd: string;
  cwd: string;
  timeoutMs: number;
  /** Injectable tree walker; production omits it and `ps` is walked. */
  walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string };
  /**
   * A tree the caller already walked at the kill. Preferred over `treePid`:
   * by the time a seam composes its failure string the group may be gone, so
   * the capture has to come from the catch block that saw it alive.
   */
  tree?: { processes: HangProcess[]; treeUnavailable?: string };
}

/**
 * #1427 — the `where` clause of a timeout whose run was observed hanging: the
 * plain `where` plus the hang clause ("hung in test X, N process(es) still
 * alive"). Falls back to the plain `where` when no run was handed in, so a gate
 * that killed a run it could not describe still says exactly what #1324 said.
 *
 * The CLAUSE goes in the failure string, not the full report: a failure survives
 * an 800-char evidence window and the clause is the part that must, while the
 * tree and the output tail are too wide for it and go to the scratch log the
 * handoff points the operator at.
 */
export function timeoutWhere(where: string, run?: KilledGateRun): string {
  if (run === undefined) return where;
  const tree =
    run.tree ??
    (run.treePid === undefined
      ? { processes: [] as HangProcess[] }
      : (run.walk ?? captureProcessTree)(run.treePid));
  const clause = gateHangClause({
    runningTests: extractRunningTests(run.output),
    cmd: run.cmd,
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    processes: tree.processes,
    // The processes deeper in the group are the point of the clause in a
    // failure string: the test name says what hung, the command lines say what
    // was holding on (in the measured case, a `git remote-http` orphaned by the
    // test's own already-killed `git pull`). Bounded: two rows, each already
    // bounded, so the clause still fits the evidence window.
    ...(tree.processes.length > 0 ? { detail: deepestCommands(tree.processes) } : {}),
  });
  return `${where} — ${clause}`;
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
 *   - `verify-env:<step>` also covers #1421's residue decline (`buildResidueOnly`
 *     from the consolidated gate, reported STRUCTURALLY, never matched out of
 *     the failure prose): the gate declined to mutate a root holding untracked,
 *     git-ignored build output (cargo's `target/`, a bundler's `dist/`), so
 *     nothing about the change was judged. An environment refusal, like the
 *     fork failure beside it.
 *
 * One real failure among them is a code failure, so the cap stays verify-failed.
 * The residue branch sits INSIDE the every-no-verdict guard for that reason:
 * a timeout beside a residue decline is still a run that reached no verdict,
 * so it routes `verify-timeout:<step>` — never `verify-failed` (the adversarial
 * round-1 finding: a separate early `every(isBuildResidueFailure)` return made
 * `[timeout] + [residue]` read as a code verdict).
 */
export function verifyCapFor<S extends string>(
  step: S,
  failures: readonly string[],
  baselineRedOnly = false,
  buildResidueOnly = false,
): `verify-failed:${S}` | `verify-timeout:${S}` | `verify-env:${S}` | `verify-baseline-red:${S}` {
  if (failures.length === 0) return `verify-failed:${step}`;
  const noVerdict = (f: string) =>
    isHostExhaustionFailure(f) || isVerifyTimeoutFailure(f) || isBuildResidueFailure(f);
  if (!failures.every(noVerdict))
    return baselineRedOnly ? `verify-baseline-red:${step}` : `verify-failed:${step}`;
  if (failures.some(isHostExhaustionFailure)) return `verify-env:${step}`;
  // #1324 — a run killed at its bound decided this cap BEFORE anything else
  // can: "the bound was too short" is the actionable diagnosis, and it stays
  // actionable whether or not the gate also declined on residue. Checking the
  // residue flag first is what made `[timeout] + [residue]` read as
  // `verify-env` (and, pre-fold, as `verify-failed`) instead of the timeout
  // the operator can actually fix. The check is `some`, not `every`, for the
  // same reason: one kill among no-verdict entries is the thing to report.
  if (failures.some(isVerifyTimeoutFailure)) return `verify-timeout:${step}`;
  // #1421 — nothing was killed and the gate declined to run at all: an
  // environment refusal, not a verdict on the code.
  if (buildResidueOnly) return `verify-env:${step}`;
  return `verify-failed:${step}`;
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
