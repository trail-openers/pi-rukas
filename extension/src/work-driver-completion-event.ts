/**
 * work-driver-completion-event — buildCompletionEvent: the
 * DispatchResult → WorkEvent mapper shared by every single-dispatch
 * step. Split out of work-driver-merged.ts (AGENTS.md §12 file-size
 * limit; the file sat at 531 lines after the #543 F4(j) evidence
 * threading landed).
 *
 * The structured kill-cause (#296; #543 adds loop/token-budget) wins
 * over everything: a child pi-rukas itself killed is OUR failure,
 * never a provider failure. The errorTail names the trigger + the
 * override knob for every cause: wall-clock ms for
 * timeout/inactivity, the streak evidence for loop, the budget + used
 * counts for token-budget.
 */

import path from "node:path";
import { redactClip } from "./decision-log.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { parseAbort } from "./work-driver-diff.ts";
import { FAILURE_REASON_CHARS, clip } from "./work-driver-failure-taxonomy.ts";
import {
  CYCLE_DEADLINE_ENV,
  type FixerBoundSource,
  SPAWN_BACKSTOP_ENV,
  fixerBoundClause,
  fixerBoundEnv,
} from "./work-driver-fixer-bound.ts";
import { withUsage } from "./workflow-state-events-usage.ts";
import { type WorkStep, type appendEvent, writeDispatchArtifact } from "./workflow-state.ts";

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

/** #543 — env knob named in a self-kill's errorTail (loop/token name the cap knobs). */
export function overrideEnvForKillCause(
  killCause: NonNullable<DispatchResult["killCause"]>,
  /**
   * #1798 — which clock armed a FIXER's bound, when the step that armed it
   * recorded one. For `timeout` / `child-bound` it replaces the generic
   * per-role answer: a lens-fix killed at its own 45-minute ceiling must name
   * `PI_ENSEMBLE_LENS_FIX_BOUND_MS`, not the two-hour backstop nobody set.
   * Ignored by every other cause, whose bound is a different mechanism.
   */
  fixerBoundSource?: FixerBoundSource,
): string {
  switch (killCause) {
    case "timeout":
      // #1798 — a fixer's own bound first; the backstop is the fallback for a
      // kill no fix-loop bound claims.
      return fixerBoundSource === undefined
        ? SPAWN_BACKSTOP_ENV
        : fixerBoundSource === "cycle-deadline"
          ? // The deadline branch of the caller is handled by the detail text
            // (`killedAtCycleDeadline`), but a `child-bound` cause that the
            // deadline clamped still needs the knob here rather than the
            // per-role list the fallback below would print.
            CYCLE_DEADLINE_ENV
          : fixerBoundEnv(fixerBoundSource);
    // #754 — the plan step's own bound; its env knob is a DISTINCT name from
    // the global backstop (PI_ENSEMBLE_SPAWN_TIMEOUT_MS stays role-agnostic
    // and step-agnostic — test-spawn-bounds.ts asserts that).
    case "plan-timeout":
      return "PI_ENSEMBLE_PLAN_TIMEOUT_MS";
    case "loop":
      return "PI_ENSEMBLE_DISPATCH_CAPS + PI_ENSEMBLE_CAP_KILL_GRACE_MS";
    // #1642 — nothing arms a token budget by default, so the knob this names
    // is the one the OPERATOR set: the budget that stopped the child, plus
    // the grace window that turned crossing it into the kill.
    case "token-budget":
      return "PI_ENSEMBLE_TOKEN_BUDGET_<ROLE> + PI_ENSEMBLE_CAP_KILL_GRACE_MS";
    case "inactivity":
    case "abort":
      return "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS";
    // #951 — the in-flight-tool silence kill: its bound is a SEPARATE knob
    // (PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS), so the operator is pointed at
    // the value that actually killed the child.
    case "tool-inactivity":
      return "PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS";
    // #1567 — the child-supervision kills are driver caps, so the knob that
    // turns them off is the caps master switch. The piece that emits each
    // cause adds its own bound knob here when it introduces one.
    // #1798 — a fixer's own bound is the one child-bound kill whose knob the
    // driver knows, so it names that knob instead of the three-role list.
    case "child-bound":
      return fixerBoundSource === undefined
        ? "PI_ENSEMBLE_DEVELOP_BOUND_MS / PI_ENSEMBLE_EXPLORE_BOUND_MS / PI_ENSEMBLE_LENS_BOUND_MS"
        : fixerBoundSource === "cycle-deadline"
          ? CYCLE_DEADLINE_ENV
          : fixerBoundEnv(fixerBoundSource);
    case "no-progress":
    case "stuck-tool":
      return "PI_ENSEMBLE_DISPATCH_CAPS";
    // #1827 — the reviewer's skill re-read cap: its own knob plus the caps
    // master switch, so the operator is pointed at the value that stopped the
    // child (not the inactivity knob, which the fallback would imply).
    case "review-skill-reread":
      return "PI_ENSEMBLE_REVIEW_SKILL_READS + PI_ENSEMBLE_DISPATCH_CAPS";
    // #1827 round 1 — no `review-post-verdict` row, and there must never be
    // one: this function reads a `DispatchResult.killCause`, and a clean
    // reviewer stop does not have one. Every member of that union is a failure
    // or a cap; the stop lives in `reviewStopReason`, which no failure path
    // reads. The reviewer's own run bound (`PI_ENSEMBLE_ADVERSARIAL_BOUND_MS`)
    // is named by the `child-bound` row above, which is the cause that stop
    // would have become.
  }
}

/**
 * The driver dispatch id a result came back with, PROVEN against the transcript
 * rather than trusted. `runSingleDispatch` hands the driver jobId to the child as
 * its `runId`, and `transcriptPathFor` names the transcript
 * `<runId>-<role>[-<seq>][_<tag>].json`; stripping that documented suffix off the
 * basename must yield EXACTLY the claimed id, or the claim is refused and the
 * basename stands. A fake or PM-shaped result therefore keeps reporting the same
 * `jobId` it always reported, and a `dispatchJobId` whose transcript does not
 * encode it never becomes the event identity.
 */
function driverJobIdOf(result: DispatchResult, role: string): string | undefined {
  const claimed = result.dispatchJobId;
  if (!claimed) return undefined;
  // PROVEN, not believed: the child's transcript must carry the claimed id as
  // its run-id component. A fake result that names some other transcript (or no
  // transcript at all) cannot assert an identity the child did not encode, so it
  // keeps reporting the basename it always reported.
  return runIdOfTranscript(result, role) === claimed ? claimed : undefined;
}

/** Exported for the join's own tests: the proven driver id, or undefined when
 *  the transcript does not carry the claim. */
export const driverJobIdOfTranscript = driverJobIdOf;

/** The transcript basename, spawn runId. What every caller saw before the driver
 *  threaded its own id, and still the answer for a PM dispatch. */
function transcriptJobId(result: DispatchResult): string {
  return result.transcriptPath ? path.basename(result.transcriptPath, ".json") : "unknown";
}

/**
 * Recover the run id a transcript was named with.
 *
 * `transcriptPathFor` writes `<runId>-<parts joined by '-'>.json` where the
 * parts are `[role]`, then the batch tag when one was given, then the seq.
 * The run id is therefore the basename minus that documented SUFFIX — stripped
 * with the role the caller already knows, and with the whole `tag[-seq]` tail
 * when the batch tagged its members. Stripping only `-(role|tag)[-seq]` is the
 * bug this states: a tagged member (`dispatch_parallel` passes the PM label or
 * the member index as the tag) left its own tag glued to the recovered id, so
 * the driver's join refused the dispatch it had just run.
 *
 * That matters because the driver now hands the child its jobId as the run id
 * (#1789), and a jobId is `<step>:<label>:<pid>:<ms>` where the label itself
 * contains `-`: `developer:lens-fix-1`. A last-dash rule would eat a digit of
 * the id whenever the role ended up as the tag part.
 *
 * `undefined` when the basename does not end in that suffix at all: the claim
 * is then refused rather than guessed at.
 */
export function runIdOfTranscript(result: DispatchResult, role: string): string | undefined {
  if (!result.transcriptPath) return undefined;
  const base = path.basename(result.transcriptPath, ".json");
  const suffix = `-${role}`;
  if (base.endsWith(suffix)) return base.slice(0, -suffix.length) || undefined;
  // A tagged batch member: `<runId>-<role>-<tag>[-<seq>]`. The tag is arbitrary
  // display text, so the only sound rule is "the role starts the tail" — cut at
  // the first `-<role>-` after the run id and require the remainder to be
  // `tag` or `tag-seq` in the shape `transcriptPathFor` writes.
  const tail = new RegExp(`-${role}(-.+)?(-\d+)?$`).exec(base);
  return tail ? base.slice(0, base.length - tail[0].length) || undefined : undefined;
}

/**
 * #1798 round 3 — the provider's own words, scrubbed and bounded the way
 * `providerParkEvidence` bounds its concatenation: same `redactClip` seam
 * (redacts FIRST, then clips, so a cut can never leave a credential fragment)
 * and the same `FAILURE_REASON_CHARS` budget, not a second number.
 *
 * Why it belongs HERE rather than only at render: this text is written into the
 * durable state file by `buildCompletionEvent` and onto `ResultFailure` by
 * `failureOf`, both of which an operator's handoff and a headless `--json` print
 * verbatim. A provider body that quotes a request header, a key in an error
 * page, or a stack trail used to land in both. The renderer-side caps
 * (`headless/failure.ts`) stay — they are the tighter, per-surface numbers —
 * but the STORED value is now the clean one.
 */
function boundedProviderText(text: string): string {
  return redactClip(text, FAILURE_REASON_CHARS);
}

/**
 * Build a dispatch-completed (or dispatch-failed-provider / dispatch-
 * failed) event from a DispatchResult. Handles the claim-check threshold
 * for large summaries.
 */
export async function buildCompletionEvent(
  ctx: CycleContext,
  step: WorkStep,
  role: string,
  label: string,
  result: DispatchResult,
): Promise<
  Extract<
    Parameters<typeof appendEvent>[1],
    {
      kind: "dispatch-completed" | "dispatch-failed-provider" | "dispatch-failed";
    }
  >
> {
  const at = Date.now();
  // #1789 — a DRIVER dispatch's jobId is its own identity, and with `runId`
  // threaded through `runSingleDispatch` the transcript's basename now ENCODES
  // it (`<jobId>-<role>.json`), so the two agree. A bare `${jobId}-` prefix
  // match is therefore the join; anything else (a PM job, a test result that
  // hands in its own transcript path, a legacy path) falls back to the basename
  // exactly as before. Preferring the driver's id is what lets a step prove a
  // tail event is its own dispatch — `clearDispatch` clears the id
  // `beginDispatch` wrote, and a completion whose `jobId` came from an
  // unrelated transcript basename could never match it.
  const jobId = driverJobIdOf(result, role) ?? transcriptJobId(result);

  if (result.killCause) {
    let detail: string;
    if (result.killCause === "abort") {
      detail = "[pi-rukas] cancelled (abort signal)";
    } else if (result.killCause === "loop") {
      const ev = result.loopEvidence;
      // #772 — a success-keyed kill names its specific shape: an already-green
      // command re-issued with identical output, not the generic streak.
      const what =
        ev?.kind === "success"
          ? `an already-successful ${ev.tool} call (${ev.count} times, identical output each time)`
          : ev
            ? `${ev.tool} × ${ev.count} (normalised args)`
            : "the same tool call after normalisation";
      detail =
        `[pi-rukas] killed on loop — it kept re-issuing ${what}` +
        ` (override: ${overrideEnvForKillCause(result.killCause)})`;
    } else if (result.killCause === "token-budget") {
      const tb = result.tokenBudget;
      const spend = tb
        ? ` (${Math.round(tb.used).toLocaleString()} of ${Math.round(tb.budget).toLocaleString()} tokens)`
        : "";
      detail = `[pi-rukas] killed on token-budget — a token budget you set stopped this child${spend}; unset it or raise it (override: ${overrideEnvForKillCause(result.killCause)})`;
    } else if (result.killCause === "plan-timeout") {
      // #754 — the plan step's own 30-minute bound expired (not the 2 h
      // global backstop). The operator-facing text names the bound so the
      // kill is not misread as a developer-scale wall-clock timeout.
      detail =
        `[pi-rukas] killed after ${result.killBudgetMs}ms — the plan step's own wall-clock bound expired` +
        ` (override: ${overrideEnvForKillCause(result.killCause)})`;
    } else if (result.killedAtCycleDeadline) {
      // #1593 — the caller's deadline, not the backstop, set this bound.
      // #1798 — the fixer's bound source says the same thing from the other
      // side; the deadline form wins because it also carries the ms.
      detail = `[pi-rukas] killed after ${result.killBudgetMs}ms at the caller's cycle deadline (${CYCLE_DEADLINE_ENV})`;
    } else if (
      result.fixerBoundSource !== undefined &&
      (result.killCause === "timeout" || result.killCause === "child-bound") &&
      result.killBudgetMs !== undefined
    ) {
      // #1798 — the kill pi-rukas's OWN clock produced, named as such: which
      // source, how many minutes, and the one knob that moves it. The generic
      // form below would print the per-role backstop this child never ran
      // under, which is what sent operators to a provider that was fine.
      detail =
        `[pi-rukas] killed after ${result.killBudgetMs}ms at ${fixerBoundClause(result.fixerBoundSource, result.killBudgetMs)}` +
        ` (override: ${overrideEnvForKillCause(result.killCause, result.fixerBoundSource)})`;
    } else if (result.killBudgetMs === undefined) {
      // #1798 round 1 — no budget to report means no "undefinedms": a kill with
      // no `killBudgetMs` (a role backstop that recorded no bound, a synthetic
      // result) states the cause and the knob alone.
      detail =
        `[pi-rukas] killed ${result.killCause}` +
        ` (override: ${overrideEnvForKillCause(result.killCause, result.fixerBoundSource)})`;
    } else {
      detail =
        `[pi-rukas] killed after ${result.killBudgetMs}ms ${result.killCause}` +
        ` (override: ${overrideEnvForKillCause(result.killCause, result.fixerBoundSource)})`;
    }
    // Attribute the silence, not just the budget. `linesSeen: 0` means the
    // child never spoke — a provider stall or auth failure, not a hang.
    const la = result.lastActivity;
    const attribution = la
      ? ` · last output: ${la.kind} ${Math.round(la.agoMs / 1000)}s before the kill, after ${la.linesSeen} line(s)`
      : "";
    // #1798 round 1 — a kill that is ALSO a provider error-stop. The kill
    // branch owns the event, so the `dispatch-failed-provider` branch below is
    // never reached and the provider fact used to be discarded with it — which
    // let a severed stream get the "raise the bound" advice. The kill still
    // wins the KIND of the event (a self-kill is never reported as a provider
    // failure, see `DispatchResult.killCause`), but it no longer erases the
    // fact, and the classifier abstains on it.
    // #1798 round 3 — the provider's own words, scrubbed and bounded BEFORE
    // they are written anywhere: both the clause appended to `errorTail` and
    // the field stored on the event come from this one reading, so a provider
    // body cannot land unredacted in the durable state file (see
    // `boundedProviderText`). `providerParkEvidence` gets the same treatment for
    // its concatenation; this is the same seam and the same budget.
    const providerAtKill = result.errorStop !== undefined;
    const providerText = providerAtKill
      ? boundedProviderText(
          result.errorStop?.message ?? result.errorStop?.reason ?? "provider error-stop",
        )
      : "";
    // #1798 round 4 — the KILL clause comes FIRST, then the provider note. The
    // order is the bound: `errorTail` is capped to the reason budget at this
    // write site, and a reader that lost the tail would lose the provider's
    // words, while a reader that lost the FRONT would lose "which bound killed
    // this child and what knob moves it" — the one sentence the whole #1798
    // handoff exists to deliver. So the clause is composed before the note and
    // the composite is clipped from the FRONT, which keeps the clause whole and
    // lets the provider note lose its own tail (its full text still rides on
    // `providerMessage`, redacted and bounded by the same seam). Without the
    // cap, a max-length kill clause plus a 240-char provider note wrote a
    // `errorTail` over the reason budget into the durable state file.
    const killClause = `${detail}${attribution}`;
    const providerNote = providerAtKill ? ` · provider error-stop: ${providerText}` : "";
    const errorTail = clip(`${killClause}${providerNote}`) ?? "";
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail,
        killCause: result.killCause,
        // #1798 round 1 — the provider's own words, on the field every provider
        // read already consults (`failureOf` copies `providerMessage` for a
        // `dispatch-failed` too, which makes the classifier's provider guard
        // reachable), while the kill keeps the event's KIND and its text.
        ...(providerAtKill ? { providerMessage: providerText } : {}),
        // #543 — carry the structured trigger evidence on the event so the
        // step router can persist it on `pipelineState.capEvidence` when it
        // emits the cap-hit. Absent for the four non-cap causes (timeout /
        // inactivity / abort / the no-cause fallback).
        ...(result.killCause === "loop" && result.loopEvidence
          ? { loopEvidence: result.loopEvidence }
          : {}),
        ...(result.killCause === "token-budget" && result.tokenBudget
          ? { tokenBudget: result.tokenBudget }
          : {}),
        // #1593/#1789 — the caller's deadline, not the fixer's bound. Carried on
        // the event so the lens-fix partial-fix conversion can refuse it (a cycle
        // that is out of time parks) without reaching back into the child.
        ...(result.killedAtCycleDeadline === true ? { killedAtCycleDeadline: true } : {}),
        // #1798 — which clock armed the bound, persisted so a resumed cycle
        // classifies its own kill identically to a live one.
        ...(result.fixerBoundSource === undefined || result.killCause === undefined
          ? {}
          : { fixerBoundSource: result.fixerBoundSource }),
      },
      result.usage,
    );
  }
  if (result.errorStop) {
    return withUsage(
      {
        kind: "dispatch-failed-provider",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        // #1798 round 4 — the same seam as the kill branch above. Before this
        // the provider-kind write stored `result.errorStop.message` RAW and
        // unbounded: the provider's own body (which can quote a request header
        // or a key from an error page) landed in the durable state file
        // unredacted, and a long body made the resume validator reject the
        // whole state file as "unrecognised value".
        providerMessage: boundedProviderText(result.errorStop.message ?? "provider error-stop"),
        ...(result.providerRepeats ? { providerRepeats: result.providerRepeats } : {}),
        transcriptPath: result.transcriptPath,
      },
      result.usage,
    );
  }
  if (!result.ok) {
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail: result.text?.slice(-200),
      },
      result.usage,
    );
  }

  // ABORT detection (PR2): the subagent's PROCESS exited 0 but it
  // refused the requested action (dirty worktree, --ff-only refusal, etc).
  // Without this check, branch step's "**ABORT: Working tree is not
  // clean**" on issue #553 was recorded as success and the driver
  // continued develop on main with 41 untracked files. Treat the abort
  // as dispatch-failed so the driver's existing fail-path halts cleanly.
  const abortLine = parseAbort(result.text);
  if (abortLine) {
    return withUsage(
      {
        kind: "dispatch-failed",
        step,
        role,
        jobId,
        label,
        ms: result.ms,
        at,
        exitCode: result.exitCode ?? null,
        errorTail: abortLine.slice(0, 500),
      },
      result.usage,
    );
  }

  // Successful completion. Spill large text bodies to a claim-check
  // artifact under .pi/work-state/<issue>/<jobId>.txt so the state file
  // stays small.
  const text = result.text ?? "";
  let summary: string | undefined;
  let artifactPath: string | undefined;
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_THRESHOLD_BYTES) {
    try {
      artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, jobId, text);
    } catch (err) {
      trace(
        `work-driver: artifact write failed for ${jobId}: ${(err as Error).message?.slice(0, 120)}`,
      );
    }
  } else {
    summary = text;
  }
  return withUsage(
    {
      kind: "dispatch-completed",
      step,
      role,
      jobId,
      label,
      ok: true,
      ms: result.ms,
      at,
      transcriptPath: result.transcriptPath,
      summary,
      artifactPath,
    },
    result.usage,
  );
}
