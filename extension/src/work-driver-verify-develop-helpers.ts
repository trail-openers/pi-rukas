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
import {
  type HangProcess,
  NO_TREE_CAPTURED,
  deepestCommands,
  extractRunningTests,
  gateHangClause,
} from "./work-driver-gate-hang.ts";
import { VERIFY_SUITE_TIMEOUT_ENV, verifyTimeoutMs } from "./work-driver-verify-budget.ts";

/**
 * #1064 — the command the per-worktree leg of the develop gate reported, read
 * back out of the line it produced (`verify command \`<cmd>\` failed in …`).
 *
 * The consolidated line for a single workstream has to name the same command
 * that leg named — both ran the same content with the same gate — and the only
 * record of which tier fell over is that line: the fast tier's identity lives on
 * the thrown error (`failedVerifyCmd`), which the per-worktree seam consumes
 * when it composes the text and does not keep. `fallback` is the configured
 * command, for a line this shape did not produce.
 */
export function ranVerifyCmdOf(perWorktreeFailure: string, fallback: string): string {
  const m = /^verify command `([^`]+)` failed in /.exec(perWorktreeFailure);
  return m?.[1] ?? fallback;
}

/**
 * PR17 — bounded wall-clock for the verify command.
 *
 * #1509 moved the resolution into `work-driver-verify-budget.ts`; this is a
 * plain re-export of that reader, so the 11 call sites that take the
 * develop-tier bound (the skip ratchet's `git diff -U0`, comment retention,
 * the lens / adversarial comment checks, the checkpoint typecheck, and the
 * verify gate's own exec sites) all read the SAME resolver the tier bounds do.
 * A second implementation here is the drift the #1509 spec names as the hazard.
 */
export { verifyTimeoutMs };

/**
 * #1415 — the bound a develop-pass gate verdict is recorded under, read ONCE
 * per pass.
 *
 * The value is part of the reuse key (`work-driver-verify-gate-reuse.ts`), not
 * merely a parameter a run happens to receive: a verdict reached in 9 minutes
 * under a 10-minute bound says nothing about the same tree under a 2-minute
 * bound, so the operator who tightens `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` gets the
 * gate back with no stale record to invalidate. Reading it once per pass —
 * rather than at each of the several `verifyTimeoutMs()` calls a pass makes —
 * is what keeps the record's bound identical to the bound every run in that
 * pass actually got; a re-read between the run and the record could otherwise
 * store a bound no command ever ran under.
 */
export function verifyPassTimeoutMs(): number {
  return verifyTimeoutMs();
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
  // #1509 — the knob defaults to the SUITE tier's, because every existing
  // caller that reaches this function is bounding the full verify command or
  // the consolidated run of it. A fast- or smoke-tier kill names its own knob
  // via the explicit argument; guessing the tier from the command string is
  // the `withFastTier` `cmd !== fullCmd` hazard this avoids.
  knob = VERIFY_SUITE_TIMEOUT_ENV,
): string {
  return `${VERIFY_TIMEOUT_LABEL} verify command \`${cmd}\` exceeded its ${boundText(timeoutMs)} timeout ${where} — the run was killed at the bound (${knob}), so it reached no verdict about the code`;
}

/**
 * #1427 round 3 — a timeout failure string that ALSO says what hung.
 *
 * The clause goes at the END, after the #1324 sentence, and that position is
 * load-bearing rather than stylistic. `boundFailure`
 * (`work-develop-cap-evidence.ts`) bounds each failure to 800 chars by keeping
 * its TAIL (`extractAttributedTail` → `trimmed.slice(-maxLen)` when there is no
 * `FAILED:` marker, and a timeout string has none). A hang clause spliced into
 * the middle of the sentence therefore pushed the `[verify-timeout]` headline
 * past the 800-char cut in exactly the case the clause exists for — a fan-out
 * whose ten long test names make the clause wide — and the capped failure then
 * read as an ordinary verify failure: `verifyCapFor` keys the
 * `verify-timeout:<step>` cap on that marker, so a killed run was routed to
 * `verify-failed:develop` and the handoff told the operator to look at the diff
 * for a run that reached no verdict at all. Appended last, the marker is always
 * inside the kept tail and the names are what gets clipped — which is the
 * correct trade: the cap is what makes the cycle legible, the names are a bonus.
 */
export function verifyHangFailure(
  cmd: string,
  where: string,
  timeoutMs: number,
  run?: KilledGateRun,
  knob = VERIFY_SUITE_TIMEOUT_ENV,
): string {
  const base = verifyTimeoutFailure(cmd, where, timeoutMs, knob);
  if (run === undefined) return base;
  return `${base} — ${hangClauseFor(run)}`;
}

/** The clause half of {@link verifyHangFailure}, composed in one place so the
 *  failure string and the written report cannot describe the kill differently.
 *
 *  #1427 round 4 — this function NEVER walks. The caller captures the tree once,
 *  in the window between the executor's kill and its settle, and hands it in; a
 *  run with no captured tree says so (`no tree was captured`) rather than
 *  forking `ps` on a group that the kill has usually already reaped. A live walk
 *  here was a second snapshot of a dead group — different from the one the
 *  written report describes — paid for on the failure path of a cycle that has
 *  already run out of time. */
function hangClauseFor(run: KilledGateRun): string {
  const processes = run.tree?.processes ?? [];
  // #1427 round 4 — with no rows there is nothing to count, and the clause's
  // second half carries the reason instead: a walk that collected nothing
  // reports why it collected nothing, and a caller that captured nothing at all
  // says `no tree was captured`. Rendering `N process(es) still alive` over an
  // empty snapshot would claim a live count of zero — the exact false positive
  // this clause is not allowed to make.
  const treeUnavailable =
    run.tree === undefined
      ? NO_TREE_CAPTURED
      : (run.tree.treeUnavailable ?? "the walk collected no process rows");
  return gateHangClause({
    runningTests: extractRunningTests(run.output),
    cmd: run.cmd,
    cwd: run.cwd,
    timeoutMs: run.timeoutMs,
    processes,
    // The processes deeper in the group are the point of the clause in a
    // failure string: the test name says what hung, the command lines say what
    // was holding on (in the measured case, a `git remote-http` orphaned by the
    // test's own already-killed `git pull`). Bounded: two rows, each already
    // bounded, and the name list itself is bounded by `gateHangClause`, so the
    // clause cannot outgrow the window that has to carry the headline.
    ...(processes.length > 0 ? { detail: deepestCommands(processes) } : {}),
    ...(processes.length === 0 ? { treeUnavailable } : {}),
  });
}

/**
 * #1427 — the single hang-report gate for every gate seam: a run gets a report
 * ONLY when the wall clock killed it. `killed` alone is not enough — a run that
 * overflowed `maxBuffer` is killed too, and reporting one as a hang tells the
 * operator the gate stalled when it actually printed too much.
 *
 * `timedOutKill` is the field `execTree` stamps; a test fake or a rethrown
 * fast-tier error that predates it is accepted on the documented shape
 * (`killed` with no `overflow`), which is what those fakes have always carried.
 */
export function isTimedOutKill(e: {
  killed?: boolean;
  timedOutKill?: boolean;
  overflow?: string;
}): boolean {
  if (e.overflow !== undefined) return false;
  if (e.timedOutKill !== undefined) return e.timedOutKill === true;
  return e.killed === true;
}

/**
 * What a gate seam knows about the run it killed, to build a hang report from.
 *
 * #1427 round 4 — `treePid` and `walk` are GONE from this shape. A caller either
 * hands in the tree it captured in its own `catch`, or hands in nothing and the
 * clause says no tree was captured. There is deliberately no way to ask this
 * module to walk: the seam that killed the run is the only place with a chance of
 * seeing the group alive, and a second walk from here is a second, later, worse
 * snapshot of the same kill.
 */
export interface KilledGateRun {
  /** The killed run's combined stdout+stderr (the source of the slow-test lines). */
  output: string;
  /** The killed run's own command — the fast tier's when that is what hung. */
  cmd: string;
  cwd: string;
  timeoutMs: number;
  /**
   * The tree the caller walked at the kill — the ONLY source of process rows for
   * a clause. Absent = the clause reports that nothing was captured.
   */
  tree?: { processes: HangProcess[]; treeUnavailable?: string };
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

/** PR338 — validate a git SHA before shell interpolation. A type guard, so a
 *  caller that has checked one does not re-cast it to satisfy the diff reader. */
const VALID_SHA_RE = /^[0-9a-f]{40}$/;
export function isValidSha(s: string | undefined): s is string {
  return typeof s === "string" && VALID_SHA_RE.test(s);
}

/** #307 — maximum number of net-removed test blocks tolerated in a diff. */
export function testDeleteTolerance() {
  const env = Number(process.env.PI_ENSEMBLE_TEST_DELETE_TOLERANCE);
  if (!Number.isFinite(env) || env < 0) return 0;
  return Math.floor(env);
}
