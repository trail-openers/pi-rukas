/**
 * review-bounds — the two structural bounds the reviewer roles were missing
 * (#1827).
 *
 * Observed on hand-run PR reviews on 2026-10-24/25: lens children re-read
 * their own `SKILL.md` for hundreds of turns — alternating `read`, `cat` and
 * `grep`, so no single fingerprint ever repeats and neither the loop detector
 * (keys on tool+args) nor `ChildProgress` (keys on the command string) sees a
 * repeat — and adversarial reviewers wrote "verification complete, writing the
 * verdict" and then made 200–300 more tool calls (one reached 476 turns and
 * 80M tokens). Prose ("do not re-read it", "stop after the verdict") and PM
 * steers did not stop either shape.
 *
 * Two bounds, both structural, both keyed on what the live stream says:
 *
 *   1. `createSkillReadGuard` — counts the child's reads of ITS OWN skill
 *      file, delegating the "did this call open that file" judgement to the
 *      single predicate `lens-skill-load-proof.ts` already owns (never a
 *      second copy of it). With N = `PI_ENSEMBLE_REVIEW_SKILL_READS` (3):
 *      ≤ N reads do nothing, the (N+1)-th steers once, the (N+2)-th ends the
 *      child with kill cause `review-skill-reread`. Once the child has
 *      reported (its prompt's `agent_end` arrived) the re-read cap has nothing
 *      left to stop, so the kill is suppressed.
 *   2. `createVerdictStop` — on each live assistant `message_end`, runs the
 *      SAME `readEnumMarker(text, "VERDICT", VERDICT_STATUSES)` the consumer
 *      (`parseVerdict`) runs, over the ACCUMULATED assistant text so far. One
 *      source of truth, so the live stop and the final parse cannot disagree:
 *      whatever stopped the child is exactly what `parseVerdict` reads. An
 *      absent or unparseable marker never stops.
 *
 * Scope is reviewer roles only — `code-review-specialist` and
 * `adversarial-developer`. The `developer` role `makeRunPhase` also spawns
 * (the adversarial fix pass) is excluded from every bound here.
 *
 * Both kills are set by the caller AFTER `applyChildBound` has run, so neither
 * is renamed to `child-bound` (that function rewrites only a falsy cause or
 * `timeout`/`abort`). Both are inert under `PI_ENSEMBLE_DISPATCH_CAPS=0` like
 * every other cap.
 */

import { VERDICT_STATUSES } from "./adversarial-verdict.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { isSkillReadWith } from "./lens-skill-load-proof.ts";
import { candidateDirs, resolveSkillDir, skillFileCandidates } from "./lens-skill-path.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/** A child that re-read its skill file past the cap. */
export const REVIEW_SKILL_REREAD_KILL = "review-skill-reread" as const;
/** A reviewer that was ended as done once its verdict appeared. NOT a member
 *  of `DispatchResult.killCause` — it is the value of `reviewStopReason`, the
 *  clean-end vocabulary. See types.ts for why the two are separate. */
export const REVIEW_POST_VERDICT_STOP = "review-post-verdict" as const;

/** The roles the two bounds apply to. The fix-pass `developer` is not one.
 *  Read only through `isReviewerRole` — a second list a caller keeps by hand is
 *  how a role ends up half-bounded. */
const REVIEWER_ROLES: readonly string[] = ["code-review-specialist", "adversarial-developer"];

/** Does this role get the reviewer bounds? */
export function isReviewerRole(role: string): boolean {
  return REVIEWER_ROLES.includes(role);
}

function capsOn(): boolean {
  return process.env.PI_ENSEMBLE_DISPATCH_CAPS !== "0";
}

/** Default allowance, and the ceiling an operator knob cannot raise past. */
const DEFAULT_SKILL_READ_CAP = 3;
const MAX_SKILL_READ_CAP = 50;

/** Reads of its own skill file a reviewer is allowed before the first steer. */
export function reviewSkillReadCap(): number {
  const raw = process.env.PI_ENSEMBLE_REVIEW_SKILL_READS;
  // An unset or EMPTY knob is the operator saying "default", not "0": the old
  // `Number("")` was 0, which silently made every single read a violation.
  const text = raw?.trim() ?? "";
  if (text === "") return DEFAULT_SKILL_READ_CAP;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    traceWarn(
      `PI_ENSEMBLE_REVIEW_SKILL_READS="${raw}" is not a positive integer — using ${DEFAULT_SKILL_READ_CAP}`,
    );
    return DEFAULT_SKILL_READ_CAP;
  }
  if (n > MAX_SKILL_READ_CAP) {
    traceWarn(
      `PI_ENSEMBLE_REVIEW_SKILL_READS=${n} exceeds the ${MAX_SKILL_READ_CAP}-read ceiling — using ${MAX_SKILL_READ_CAP}`,
    );
    return MAX_SKILL_READ_CAP;
  }
  return n;
}

/** The adversarial reviewer's own run bound (a lens child's is 30 min). */
export function adversarialChildBoundMs(): number {
  const n = Number(process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

export interface SkillReadGuard {
  /**
   * Feed one parsed child event. Called from the stdout LINE HANDLER
   * (`spawn-inflight.ts`), which is the only site that sees every parsed event
   * exactly once — `observeReviewBounds` deliberately does NOT call this, so
   * the count has one feed and one owner. Only reads that resolve to the
   * driver-supplied skill path's `SKILL.md` count.
   */
  observe(event: PiJsonEvent): void;
  /** The steer to send, once, on the (N+1)-th read. Undefined when not due. */
  steerText(): string | undefined;
  /** True on the (N+2)-th read — the caller ends the child with `review-skill-reread`. */
  shouldKill(): boolean;
  /** Reads counted so far (for the report / tests). */
  count(): number;
}

/**
 * Per-spawn counter of the child's reads of its own skill file.
 *
 * `reported` is the spawn's `promptCompleted` flag: a child that has sent its
 * `agent_end` is being reported, and killing it then would throw away the
 * answer it already gave.
 */
export function createSkillReadGuard(o: {
  skillPath: string;
  reported: () => boolean;
}): SkillReadGuard {
  const active = capsOn() && !!o.skillPath;
  let reads = 0;
  let steered = false;
  let killed = false;
  // Built ONCE for the guard's lifetime, not per tool call: resolving the
  // skill dir and listing its accepted spellings reaches the filesystem
  // (`realpathSync`), and this guard sits on the per-stdout-line hot path of a
  // child that may run hundreds of turns.
  const dir = active ? resolveSkillDir(o.skillPath) : "";
  const wants = dir ? skillFileCandidates(dir) : [];
  const dirs = wants.length > 0 ? candidateDirs(wants) : [];
  const cap = reviewSkillReadCap();
  return {
    observe: (event) => {
      if (!active || wants.length === 0) return;
      const msg = event.message;
      if (event.type !== "message_end" || msg?.role !== "assistant") return;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
      for (const block of msg.content ?? []) {
        if (block.type !== "toolCall") continue;
        // `name` is Pi's — shape not ours — so a non-string never matches
        // rather than throwing "[object Object]" through the matcher.
        const name = typeof block.name === "string" ? block.name.toLowerCase() : "";
        const args = (block.arguments ?? {}) as Record<string, unknown>;
        if (isSkillReadWith(name, args, dirs, wants)) reads += 1;
      }
    },
    steerText: () => {
      if (!active || steered || killed) return undefined;
      // The steer fires on the read JUST past the allowance, i.e. read N+1.
      if (reads < cap + 1) return undefined;
      steered = true;
      return `Stop re-reading your skill file — it is already in your context and you have opened it ${reads} times. Do not read it again. Do the review and report your findings now.`;
    },
    shouldKill: () => {
      if (!active || killed) return false;
      // Suppressed once the child has reported: nothing left to stop.
      if (o.reported()) return false;
      if (reads < cap + 2) return false;
      killed = true;
      return true;
    },
    count: () => reads,
  };
}

export interface VerdictStop {
  /** Feed one parsed child event. True once a verdict has been seen. */
  observe(event: PiJsonEvent): boolean;
  /** The accumulated assistant text the verdict was parsed from. */
  text(): string;
  /** The parsed verdict, once stopped. */
  status(): string | undefined;
}

/**
 * Assistant text blocks kept verbatim for the marker scan. The stop looks at
 * the NEWEST text plus a small look-back, never at the whole accumulation: a
 * 400-turn reviewer would otherwise re-parse its entire reply on every
 * `message_end`, which is quadratic in a child this bound exists to bound. The
 * look-back covers the one shape a newest-block-only rule misses — the verdict
 * at the end of one block and the findings in the next.
 */
const VERDICT_SCAN_WINDOW = 8;

/**
 * The live post-verdict stop. Accumulates every text block of every assistant
 * `message_end` (that accumulation is the RESULT), and asks the consumer's own
 * reader whether a verdict is in the tail of it.
 *
 * The scan is a window, the stored text is not: `parseVerdict` will later read
 * the whole accumulated reply, so a verdict the window happened to miss is
 * still the verdict the loop reports — it simply costs one extra turn of tail
 * rather than a disagreeing verdict.
 */
export function createVerdictStop(): VerdictStop {
  // The same master switch as the re-read cap: with `PI_ENSEMBLE_DISPATCH_CAPS=0`
  // no bound of ours ends a child, and docs/configuration.md says so. The stop
  // is gated at the decision rather than at the accumulator — the accumulation
  // is the RESULT the spawn reports, so it must keep collecting text whatever
  // the caps say. A disabled stop can never report a status, so the caller's
  // kill branch is unreachable and the reviewer runs its natural tail.
  const active = capsOn();
  const parts: string[] = [];
  let stopped: string | undefined;
  return {
    observe: (event) => {
      const msg = event.message;
      if (event.type !== "message_end" || msg?.role !== "assistant") return stopped !== undefined;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return stopped !== undefined;
      let added = false;
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
          added = true;
        }
      }
      if (stopped) return true;
      if (!active) return false;
      // An event that added no text cannot carry a verdict; re-scanning the
      // unchanged tail of the accumulation for it is the quadratic cost this
      // window exists to remove.
      if (!added) return false;
      const tail = parts.slice(-VERDICT_SCAN_WINDOW).join("\n");
      const hit = readEnumMarker(tail, "VERDICT", VERDICT_STATUSES);
      if (hit) stopped = hit;
      return stopped !== undefined;
    },
    text: () => parts.join("\n"),
    status: () => stopped,
  };
}

/**
 * Which bounds a given spawn gets, decided in ONE place so a role cannot be
 * half-bounded. The re-read cap needs a driver-supplied skill path; the
 * post-verdict stop is the adversarial reviewer's alone — it is the only role
 * whose reply ends on a VERDICT marker, and stopping a lens child at a marker
 * that never appears would cut reviews short.
 */
export function createReviewBounds(
  role: string,
  opts: Pick<SpawnOptions, "reviewSkillPath">,
  reported: () => boolean,
): { skillRead?: SkillReadGuard; verdictStop?: VerdictStop } {
  return {
    ...(opts.reviewSkillPath !== undefined && isReviewerRole(role)
      ? { skillRead: createSkillReadGuard({ skillPath: opts.reviewSkillPath, reported }) }
      : {}),
    ...(role === "adversarial-developer" ? { verdictStop: createVerdictStop() } : {}),
  };
}

/** The steer source naming the re-read cap (distinct from every other bound's). */
export const SKILL_REREAD_STEER_SOURCE: SteerSource = "driver-review-skill-reread";

/**
 * What the two reviewer bounds need from the spawn, and nothing more. The
 * spawn keeps the kill and the reporting; this seam exists so the decision
 * logic sits with the counters it acts on rather than inflating `spawn.ts`
 * past its size cap.
 */
export interface ReviewBoundTargets {
  /** The child's stdin, for the steer when the caller supplied no steer seam. */
  writeSteer: (message: string) => void;
  /** The driver's steer seam, when the caller has one (lifecycle-tagged). */
  onSteer?: (message: string, source: SteerSource) => void;
  /** End the child. The caller's own kill path (guarded, traced). */
  kill: () => void;
  /** The prompt's `agent_end` arrived — the post-verdict end also closes stdin. */
  completePrompt: () => void;
  /** A KILLING bound has armed: the advisory steers stand down (#1827 ordering).
   *  Set only where a bound actually ends the child — never on an advisory steer. */
  armBound: () => void;
  /** Record the cause the spawn applies AFTER `applyChildBound`. */
  setKillCause: (cause: DispatchResult["killCause"]) => void;
  /** The child has sent its `agent_end` — nothing left to stop. */
  reported: () => boolean;
  /** The CURRENT segment is inside Pi's in-process retry, so ending the child
   *  now discards the replay it is about to resend. Mirrors `willRetryAfter`. */
  willRetry: () => boolean;
}

/**
 * The one call the spawn makes per stdout line for a reviewer child: it lets
 * each bound decide, and reports what it decided through `targets`.
 *
 * Runs AFTER the line handler has fed every other observer, so stopping a
 * child never depends on this hook being first. Both bounds are inert when
 * their guard is absent (a non-reviewer role, or no driver-supplied skill
 * path), which is the shape every developer / ops child takes.
 */
export function observeReviewBounds(
  o: {
    skillRead?: SkillReadGuard;
    verdictStop?: VerdictStop;
    /** The assistant `message_end` this line carried, or null. */
    assistantMessageEnd: PiJsonEvent | null;
  },
  targets: ReviewBoundTargets,
): void {
  if (o.skillRead) {
    // One steer on the (N+1)-th read, then the kill on the (N+2)-th — both
    // driven from the count the LINE HANDLER fed, never from an event consumed
    // twice. The steer goes through the driver's seam when the caller has one
    // (so the lifecycle record names the source) and to raw stdin otherwise —
    // the same fallback `armChildBound` uses.
    //
    // #1827 round 1 — the ADVISORY steer does NOT arm the bound. `armBound`
    // stands down every other supervision seam (slow notice, turn nudge,
    // child-bound wrap-up, the caps steer); arming it on a message whose whole
    // purpose is to get the child to change course would silence the
    // supervision that the steer exists to supplement, and the steer often
    // works — the child carries on and reviews. Only the KILL arms.
    const steer = o.skillRead.steerText();
    if (steer !== undefined) {
      try {
        if (targets.onSteer) targets.onSteer(steer, SKILL_REREAD_STEER_SOURCE);
        else targets.writeSteer(steer);
      } catch {
        /* child already gone — the kill below still fires */
      }
    }
    if (o.skillRead.shouldKill()) {
      targets.armBound();
      targets.setKillCause(REVIEW_SKILL_REREAD_KILL);
      targets.kill();
    }
  }
  // The post-verdict stop ends the child as DONE, not killed: the reviewer's
  // answer is in hand, so the child is ended NOW and none of its later tool
  // calls run. `completePrompt` closes stdin exactly as a normal end would —
  // and it is what keeps the accumulated reply as the result rather than a
  // replay (spawn.ts only opens the stdin gate on a non-retrying `agent_end`).
  //
  // Two gates, both copied from the re-read cap and from `willRetryAfter` in
  // spawn-support.ts, for the same reason: while the child has reported, or is
  // mid-retry, its stdout belongs to an answer being delivered or about to be
  // REPLAYED, and a stop that ends the child there loses the very reply the
  // stop is claiming to preserve. `status()` is checked by the caller before
  // `observe`, so an errored/aborted turn — which records no verdict — never
  // reaches here either.
  if (
    o.verdictStop &&
    o.assistantMessageEnd &&
    !o.verdictStop.status() &&
    !targets.reported() &&
    !targets.willRetry()
  ) {
    if (o.verdictStop.observe(o.assistantMessageEnd)) {
      targets.armBound();
      // NOT `setKillCause`: a clean end is not a kill cause — see
      // spawn-review-bounds.ts for why the stop rides on `reviewStopReason`
      // instead, where no failure-or-cap consumer can mistake it for one.
      targets.completePrompt();
      targets.kill();
    }
  }
}
