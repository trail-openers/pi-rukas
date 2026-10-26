/**
 * spawn-review-bounds — how the #1827 reviewer bounds land on the result.
 *
 * One kill cause, and the place it is applied is load-bearing:
 * `applyChildBound` (spawn-child-bound.ts) rewrites `killCause` whenever it is
 * falsy, `timeout` or `abort`, so a reviewer cause set BEFORE that call is
 * silently relabelled `child-bound` for any child that also outlived its bound.
 * It is therefore applied here, AFTER the attribution passes, and only when no
 * structural cap (loop / token-budget) already named the kill — those are the
 * more specific diagnosis of what actually cost the money.
 *
 * The post-verdict stop is not a kill at all, and the round-1 review made what
 * "not a kill" means mechanical: it sets NO `killCause`. A cause is the
 * failure-or-cap vocabulary every consumer keys on — `describeOutcome`, the
 * step router, the cap-kill recorders, the handoff renderers — so a cause that
 * one of them forgot to exempt silently marks a completed review as failed. A
 * clean end therefore lives in its own field, `reviewStopReason`, which no
 * failure path reads. `ok` stays true and the reply is the accumulated
 * assistant text the stop parsed its verdict out of — set as `result.text`
 * whenever the stop fired, which is what makes the stop's status and
 * `parseVerdict(result.text).status` one value rather than two readers that
 * merely share a function.
 */

import type { ChildProcess } from "node:child_process";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  REVIEW_SKILL_REREAD_KILL,
  type ReviewBoundTargets,
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
  /** Fold into a result that has been through the attribution passes. A
   *  re-read kill an earlier cause superseded is traced from here, so it needs
   *  the same warn sink as the fold itself. */
  apply: (
    result: DispatchResult,
    appendStderr: (s: string) => void,
    warn?: (s: string) => void,
  ) => void;
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
  /** #1827 round 2 — the spawn's killing-bound flag, threaded to the re-read
   *  guard so its kill stands down when a caps kill has already armed. */
  boundArmed: () => boolean;
  reported: () => boolean;
  willRetry: () => boolean;
}): ReviewBoundWiring {
  const { skillRead, verdictStop } = createReviewBounds(deps.role, deps.opts, deps.reported, {
    // #1827 round 2 — the re-read kill reads this before ending the child, so
    // a caps kill already in flight is not overwritten.
    boundArmed: deps.boundArmed,
  });
  // Built ONCE per child: the targets close over these, so the path resolution
  // and the stat calls inside the candidate list do not run on every stdout
  // line of a 400-turn child.
  const targets: ReviewBoundTargets = {
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
    // Only ever called by `observeReviewBounds`, on the branch that ends the
    // child; it flips the fold's single gate (see `stoppedByVerdict` below).
    markStopped: () => {
      stoppedByVerdict = true;
    },
    reported: deps.reported,
    willRetry: deps.willRetry,
  };
  const observe = (assistantMessageEnd: PiJsonEvent | null): void => {
    observeReviewBounds(
      {
        ...(skillRead ? { skillRead } : {}),
        ...(verdictStop ? { verdictStop } : {}),
        assistantMessageEnd,
      },
      targets,
    );
  };
  let killCause: DispatchResult["killCause"];
  // The one record the fold reads a clean end from: set by `observeReviewBounds`
  // through `targets.markStopped`, i.e. ONLY on the branch that arms, closes
  // stdin and ends the child. The accumulator runs whatever the caps say, so
  // `verdictStop.status()` on its own is no proof a stop happened — with
  // `PI_ENSEMBLE_DISPATCH_CAPS=0` a verdict is parsed and the child is left
  // alone, and this flag stays false. No second `verdictStopped` boolean: the
  // fold reads THIS one and stamps `reviewStopReason` from it.
  let stoppedByVerdict = false;
  return {
    ...(skillRead ? { skillRead } : {}),
    ...(verdictStop ? { verdictStop } : {}),
    observe,
    apply: (result, appendStderr, warn) =>
      applyReviewBounds(
        {
          ...(killCause !== undefined ? { killCause } : {}),
          ...(skillRead ? { skillReads: skillRead.count() } : {}),
          stoppedByVerdict,
          ...(verdictStop
            ? { verdictText: verdictStop.text(), verdictStatus: verdictStop.status() }
            : {}),
        },
        result,
        appendStderr,
        warn,
      ),
  };
}

/** What the spawn tells this module about how the child ended. */
export interface ReviewBoundOutcome {
  /** The cause the bounds recorded, or undefined when neither fired. */
  killCause?: DispatchResult["killCause"];
  /** Reads counted at the kill, for the stderr attribution line. */
  skillReads?: number;
  /** The post-verdict stop ACTUALLY ended the child — set on the branch in
   *  `observeReviewBounds` that arms, closes stdin and kills, never from the
   *  accumulator. The only condition under which the fold stamps a clean end:
   *  with `PI_ENSEMBLE_DISPATCH_CAPS=0` a verdict is still parsed into the
   *  accumulation and this stays false, so nothing is stamped. */
  stoppedByVerdict: boolean;
  /** The accumulated assistant text the verdict was parsed out of. When the
   *  stop fired this becomes `result.text` outright — the frozen reply. */
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
  warn: (s: string) => void = traceWarn,
): void {
  if (outcome.killCause) {
    if (!result.killCause) {
      result.killCause = outcome.killCause;
      if (outcome.killCause === REVIEW_SKILL_REREAD_KILL) {
        appendStderr(
          `\n[pi-rukas] killed: re-read its own skill file ${outcome.skillReads ?? 0} times (override: PI_ENSEMBLE_REVIEW_SKILL_READS / PI_ENSEMBLE_DISPATCH_CAPS)`,
        );
      }
    } else if (result.killCause !== outcome.killCause) {
      // #1827 round 1 — a kill the review bounds recorded that an EARLIER
      // cause already named is not silently dropped: the two contradict each
      // other and the operator is the only reader who can tell which was the
      // real end of this child. `outcome.killCause` is only ever
      // `review-skill-reread` (the post-verdict stop is not a kill — see the
      // header), so this always means "the re-read cap had decided to end this
      // child and something else did it first". Both causes are named, and no
      // attribution line is claimed for the kill that did not happen.
      warn(
        `reviewer bounds: the re-read cap reached ${outcome.skillReads ?? 0} skill reads but another cause ended the child first (${result.killCause}); the existing cause stands`,
      );
    }
  }
  if (!outcome.stoppedByVerdict) return;
  // #1827 round 3 — when the stop FIRED, the result text IS the frozen
  // accumulation, unconditionally. The round-2 rule replaced the collapsed
  // reply only when it was empty or a placeholder, which left the two readers
  // free to disagree: `collapseEvents` filters model/tool-use noise and can end
  // up dropping or reordering the very line the stop matched, so
  // `parseVerdict(result.text)` could report a different status from the stop
  // that ended the child. The stop's own word is the authoritative end of this
  // review, so its accumulator wins outright. When the stop did NOT fire we
  // return above and the collapsed reply is left alone — the accumulation runs
  // whatever the caps say, and an unfired stop has no authority over the text.
  const accumulated = outcome.verdictText?.trim();
  if (accumulated) result.text = accumulated;
  // A provider error-stop is still the fault it was: ending the child at its
  // verdict does not turn a severed stream into a completed turn.
  result.ok = !result.errorStop;
  // Deliberately NOT a `killCause`: see the module header. Whatever another
  // attribution pass already named on this result stands.
  result.reviewStopReason = REVIEW_POST_VERDICT_STOP;
  appendStderr(
    `\n[pi-rukas] ended the reviewer at its VERDICT marker (${outcome.verdictStatus ?? "unknown"}) — its post-verdict tool calls were stopped`,
  );
}

/**
 * Whether the child ended as a clean reviewer stop rather than as a kill.
 * Keyed on `reviewStopReason` ALONE, deliberately: the stop never writes
 * `killCause`, so a caller that asked "killCause set and not the stop" would
 * return true for a post-verdict child and mark a completed review failed —
 * which is the round-1 CRITICAL this function's shape exists to prevent.
 */
export function endedAtVerdictStop(result: DispatchResult): boolean {
  return result.reviewStopReason === REVIEW_POST_VERDICT_STOP;
}

/**
 * Whether a kill cause should mark the child as failed. A post-verdict child
 * carries no cause at all, so it falls out of this test by construction: the
 * reviewer completed its assignment (it wrote the verdict) and the loop must
 * read a verdict rather than an `incomplete`.
 */
export function failedByKill(result: DispatchResult): boolean {
  return !!result.killCause;
}
