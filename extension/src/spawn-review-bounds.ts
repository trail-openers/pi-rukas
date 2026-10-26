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
import type { VerdictStatus } from "./review-bounds-verdict.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  REVIEW_SKILL_REREAD_KILL,
  type ReviewBoundTargets,
  type SkillReadGuard,
  type VerdictStop,
  createReviewBounds,
  observeReviewBounds,
} from "./review-bounds.ts";
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
 * `verdictStop` opt-in PLUS the adversarial role for the post-verdict stop) — so
 * a `developer` fix-pass child and a plan-gap gate carry no bound objects at all.
 */
export interface ReviewBoundWiring {
  skillRead?: SkillReadGuard;
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
  opts: Pick<SpawnOptions, "reviewSkillPath" | "onSteer" | "verdictStop">;
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
    reported: deps.reported,
    // The stop reads this on the same seam the re-read kill does, so whichever
    // killing bound armed first owns the child's end.
    boundArmed: deps.boundArmed,
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
  return {
    ...(skillRead ? { skillRead } : {}),
    observe,
    apply: (result, appendStderr, warn) =>
      applyReviewBounds(
        {
          ...(killCause !== undefined ? { killCause } : {}),
          ...(skillRead ? { skillReads: skillRead.count() } : {}),
          // One source for "the stop ended this child": the stop object itself.
          // There is no second `stoppedByVerdict` boolean for the wiring to keep
          // in step with (#1827 round 4).
          ...(verdictStop
            ? {
                stoppedByVerdict: verdictStop.stopped(),
                verdictText: verdictStop.text(),
                verdictStatus: verdictStop.status(),
              }
            : { stoppedByVerdict: false }),
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
  /** Whether the post-verdict stop ENDED this child — the stop's own record
   *  (`VerdictStop.stopped()`), set on the branch in `observeReviewBounds` that
   *  arms, closes stdin and kills, never from the accumulator. The only condition
   *  under which the fold stamps a clean end: with
   *  `PI_ENSEMBLE_DISPATCH_CAPS=0` a verdict is still parsed into the
   *  accumulation and this stays false, so nothing is stamped. */
  stoppedByVerdict: boolean;
  /** The accumulated assistant text the verdict was parsed out of. When the
   *  stop fired this becomes `result.text` outright — the frozen reply. */
  verdictText?: string;
  /** The parsed verdict, for the stderr line that names what was accepted. When
   *  the stop ended the child it is ALWAYS set (`observeReviewBounds` records the
   *  end on the branch that has it), so its absence with `stoppedByVerdict` true
   *  means a caller built the outcome by hand — the fold refuses to stamp rather
   *  than invent an `ok`. The same holds for `verdictText`: a fired stop parses
   *  its verdict out of the accumulation, so an accumulation that is blank while
   *  a status is set is the same by-hand outcome, judged by the same gate. */
  verdictStatus?: VerdictStatus;
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
  // #1827 round 5 — a clean end is recorded ONLY where a verdict was actually
  // read. `observeReviewBounds` marks the end and records the status together, so
  // this is a by-hand outcome; stamping `ok: true` + `reviewStopReason` without
  // one would call an unreviewed child accepted. Warn and leave the collapsed
  // reply exactly as the spawn built it (warn-not-drop, as everywhere here).
  //
  // One gate covers both ways a fired stop can have nothing behind it: no status
  // at all, and a status with a BLANK accumulation. The stop parses its verdict
  // out of the accumulation, so a status that no text supports is the same
  // by-hand outcome in a different costume — and the old shape recorded a clean
  // end for it while leaving `result.text` as the collapse, which is precisely
  // the two-readers-disagree split the freeze exists to close. `verdictText`
  // undefined counts as blank: it is only ever absent on a by-hand outcome, as
  // the wiring always supplies the stop's own text when it reports an end.
  const accumulated = outcome.verdictText?.trim();
  if (outcome.verdictStatus === undefined || !accumulated) {
    warn(
      `reviewer bounds: the post-verdict stop reported ending a child without a readable verdict (${outcome.verdictStatus ? `accepted "${outcome.verdictStatus}" from a blank reply` : "no recorded verdict status"}) — leaving the collapsed reply and the result's own ok alone`,
    );
    return;
  }
  // #1827 round 4 — the stop stands down behind an armed killing bound, exactly
  // as the re-read kill does (`shouldKill` / `boundArmed` above). If something
  // else already decided how this child ends and named a cause, that cause owns
  // the result: stamping `ok: true`, `reviewStopReason` and the frozen text on
  // top of a kill would report a killed review as a clean one. The stop's own
  // gate cannot see this (the wiring's `armBound` is the same seam both bounds
  // use), so the fold checks it, and says so rather than folding in silence —
  // the same warn-not-drop rule the discarded re-read kill follows.
  if (result.killCause) {
    warn(
      `reviewer bounds: the post-verdict stop had accepted "${outcome.verdictStatus ?? "an unreadable verdict"}" but cause ${result.killCause} ended the child; the existing cause stands`,
    );
    return;
  }
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
  result.text = accumulated;
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
