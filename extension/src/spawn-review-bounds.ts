/**
 * spawn-review-bounds — how the #1827 reviewer bounds land on the result.
 *
 * Two causes, and the place they are applied is load-bearing:
 * `applyChildBound` (spawn-child-bound.ts) rewrites `killCause` whenever it is
 * falsy, `timeout` or `abort`, so a reviewer cause set BEFORE that call is
 * silently relabelled `child-bound` for any child that also outlived its bound.
 * Both causes are therefore applied here, AFTER the attribution passes, and
 * only when no structural cap (loop / token-budget) already named the kill —
 * those are the more specific diagnosis of what actually cost the money.
 *
 * The post-verdict stop is not a kill at all. The reviewer had already written
 * its VERDICT, so the child is ended as DONE: `ok` stays true, the reply is the
 * accumulated assistant text the stop parsed its verdict out of (the SAME
 * string `parseVerdict` reads, which is what keeps the live stop and the loop's
 * final parse from disagreeing), and the stop reason rides on the result so the
 * dispatch report says the harness cut the post-verdict tail.
 */

import type { ChildProcess } from "node:child_process";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  REVIEW_SKILL_REREAD_KILL,
  createReviewBounds,
  observeReviewBounds,
} from "./review-bounds.ts";
import type { SkillReadGuard, VerdictStop } from "./review-bounds.ts";
import { killProcessTree } from "./spawn-kill.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/**
 * The reviewer bounds wired to one child.
 *
 * `observe` is the whole line-hook: call it with whatever the stdout line
 * handler returned. `outcome` is read once, after the attribution passes, and
 * handed to `applyReviewBounds`.
 *
 * The bounds are `undefined` unless the role is a reviewer AND the caller
 * supplied the input that bound needs (a skill path for the re-read cap; the
 * VERDICT protocol, which is the adversarial role itself, for the post-verdict
 * stop) — so a `developer` fix-pass child carries no bound objects at all.
 */
export interface ReviewBoundWiring {
  skillRead?: SkillReadGuard;
  verdictStop?: VerdictStop;
  observe: (assistantMessageEnd: PiJsonEvent | null) => void;
  /** Fold into a result that has been through the attribution passes. */
  apply: (result: DispatchResult, appendStderr: (s: string) => void) => void;
}

/**
 * Build the two reviewer bounds for one child and bind them to its stdin, kill
 * seam and steer seam. Lives here rather than inline in `spawn.ts` so the
 * spawn keeps the process plumbing and this module keeps the bounds; the
 * targets are constructed ONCE because they are the same for every line.
 */
export function wireReviewBounds(deps: {
  /** The child the bounds act through: steers go to its stdin, kills to its
   * process group. Both are wrapped so a child already gone is not an error. */
  child: ChildProcess;
  role: string;
  opts: Pick<SpawnOptions, "reviewSkillPath" | "onSteer">;
  completePrompt: () => void;
  armBound: () => void;
  reported: () => boolean;
}): ReviewBoundWiring {
  const { skillRead, verdictStop } = createReviewBounds(deps.role, deps.opts, deps.reported);
  const observe = (assistantMessageEnd: PiJsonEvent | null): void => {
    observeReviewBounds(
      {
        ...(skillRead ? { skillRead } : {}),
        ...(verdictStop ? { verdictStop } : {}),
        assistantMessageEnd,
      },
      {
        writeSteer: (message) => {
          deps.child.stdin?.write(`${JSON.stringify({ type: "steer", message })}\n`);
        },
        ...(deps.opts.onSteer ? { onSteer: deps.opts.onSteer } : {}),
        kill: () => {
          try {
            killProcessTree(deps.child);
          } catch (err) {
            traceWarn(`reviewer bound killProcessTree failed: ${String(err)}`);
          }
        },
        completePrompt: deps.completePrompt,
        armBound: deps.armBound,
        setKillCause: (cause) => {
          killCause = cause;
        },
      },
    );
  };
  let killCause: DispatchResult["killCause"];
  return {
    ...(skillRead ? { skillRead } : {}),
    ...(verdictStop ? { verdictStop } : {}),
    observe,
    apply: (result, appendStderr) =>
      applyReviewBounds(
        {
          ...(killCause !== undefined ? { killCause } : {}),
          ...(skillRead ? { skillReads: skillRead.count() } : {}),
          // The stop is its own record: once it parsed a verdict, the child was
          // ended as done. `status()` is the flag, so there is no second copy of
          // the state to keep in step with it.
          verdictStopped: verdictStop?.status() !== undefined,
          ...(verdictStop
            ? { verdictText: verdictStop.text(), verdictStatus: verdictStop.status() }
            : {}),
        },
        result,
        appendStderr,
      ),
  };
}

/** What the spawn tells this module about how the child ended. */
export interface ReviewBoundOutcome {
  /** The cause the bounds recorded, or undefined when neither fired. */
  killCause?: DispatchResult["killCause"];
  /** The re-read count at the kill, for the stderr attribution line. */
  skillReads?: number;
  /** The post-verdict end happened (the child is DONE, not killed). */
  verdictStopped: boolean;
  /** The accumulated assistant text the verdict was parsed out of. */
  verdictText?: string;
  /** The parsed verdict, for the stderr line that names what was accepted. */
  verdictStatus?: string;
}

/**
 * Fold the bounds into a result that has already been through
 * `capKillAttribution` and `applyChildBound`. `appendStderr` receives the
 * attribution lines, so the operator sees WHICH bound ended the child rather
 * than a bare cause.
 */
export function applyReviewBounds(
  outcome: ReviewBoundOutcome,
  result: DispatchResult,
  appendStderr: (s: string) => void,
): void {
  if (outcome.killCause && !result.killCause) {
    result.killCause = outcome.killCause;
    if (outcome.killCause === REVIEW_SKILL_REREAD_KILL) {
      appendStderr(
        `\n[pi-rukas] killed: re-read its own skill file ${outcome.skillReads ?? 0} times (override: PI_ENSEMBLE_REVIEW_SKILL_READS / PI_ENSEMBLE_DISPATCH_CAPS)`,
      );
    }
  }
  if (!outcome.verdictStopped) return;
  const accumulated = outcome.verdictText?.trim();
  if (accumulated) result.text = accumulated;
  // A provider error-stop is still the fault it was: ending the child at its
  // verdict does not turn a severed stream into a completed turn.
  result.ok = !result.errorStop;
  result.reviewStopReason = REVIEW_POST_VERDICT_STOP;
  appendStderr(
    `\n[pi-rukas] ended the reviewer at its VERDICT marker (${outcome.verdictStatus ?? "unknown"}) — its post-verdict tool calls were stopped`,
  );
}

/**
 * Whether a kill cause should mark the child as failed. The post-verdict stop
 * is the one cause that must not: the reviewer completed its assignment (it
 * wrote the verdict) and the loop must read a verdict rather than an
 * `incomplete`.
 */
export function failedByKill(result: DispatchResult): boolean {
  return !!result.killCause && result.reviewStopReason !== REVIEW_POST_VERDICT_STOP;
}
