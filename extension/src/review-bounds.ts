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
 *      child with kill cause `review-skill-reread`. Both a top-level `toolCall`
 *      block and a NESTED codemode `tool_execution_start` are counted (#1847 —
 *      nested reads were the hole, and codemode is on for every child by
 *      default; see `review-bounds-nested.ts`). Both the steer and the kill are
 *      suppressed once the child process has EXITED — nothing left to stop.
 *      An intermediate `agent_end` alone does NOT suppress them (#1847): the
 *      prompt's own end can arrive while the child is still running and still
 *      burning reads.
 *   2. `createVerdictStop` — on each live assistant `message_end`, reads the
 *      verdict with the SAME `readEnumMarker(text, "VERDICT", VERDICT_STATUSES)`
 *      the consumer (`parseVerdict`) runs, but only out of the FINAL text
 *      block of a message that made NO tool calls. Concretely, a stop needs
 *      all four: the message carries no `toolCall` block; the marker comes from
 *      its LAST non-empty text block alone (no cross-message window); that one
 *      block names exactly ONE distinct value of `VERDICT_STATUSES` (the
 *      reviewer prompt's own menu names all four, and the adversarial review
 *      reproduced a child ended on the echoed menu); and the matched line sits
 *      outside any fenced code block. Anything else does not stop. When a stop
 *      does fire, the fold sets the result text to this accumulator (see
 *      `applyReviewBounds`), which is what makes the live status and
 *      `parseVerdict(result.text)` the same value rather than two readers that
 *      merely share a function. An absent or unparseable marker never stops.
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

import type { SteerSource } from "./dispatch-steer.ts";
import { isSkillReadWith } from "./lens-skill-load-proof.ts";
import { candidateDirs, resolveSkillDir, skillFileCandidates } from "./lens-skill-path.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { nestedSkillRead } from "./review-bounds-nested.ts";
import { type VerdictStop, createVerdictStop } from "./review-bounds-verdict-stop.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

// The stop's own module is re-exported here: `review-bounds.ts` is the surface
// every caller of the reviewer bounds already imports (`spawn-review-bounds.ts`,
// the smoke tests), and the stop is one of the two bounds that surface offers.
export { type VerdictStop, createVerdictStop } from "./review-bounds-verdict-stop.ts";

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
const DEFAULT_ADVERSARIAL_BOUND_MS = 30 * 60_000;
/** Four hours: past the 2-h spawn backstop, so a knob cannot ask for a bound
 *  this child could never live long enough to reach. */
const MAX_ADVERSARIAL_BOUND_MS = 4 * 60 * 60_000;

export function adversarialChildBoundMs(): number {
  const raw = process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS;
  // An unset or EMPTY knob is the operator saying "default", not garbage: the
  // same rule `reviewSkillReadCap` applies, so `=""` is never a warning.
  const text = raw?.trim() ?? "";
  if (text === "") return DEFAULT_ADVERSARIAL_BOUND_MS;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    traceWarn(
      `PI_ENSEMBLE_ADVERSARIAL_BOUND_MS="${raw}" is not a positive number — using ${DEFAULT_ADVERSARIAL_BOUND_MS}`,
    );
    return DEFAULT_ADVERSARIAL_BOUND_MS;
  }
  if (n > MAX_ADVERSARIAL_BOUND_MS) {
    traceWarn(
      `PI_ENSEMBLE_ADVERSARIAL_BOUND_MS=${n} exceeds the ${MAX_ADVERSARIAL_BOUND_MS}ms ceiling — using ${MAX_ADVERSARIAL_BOUND_MS}`,
    );
    return MAX_ADVERSARIAL_BOUND_MS;
  }
  return n;
}

export interface SkillReadGuard {
  /** True once a KILLING bound has armed for this child (a caps kill, or
   *  another reviewer bound). The re-read kill then stands down rather than
   *  overwriting the cause that is already on its way. Mirrors the `boundArmed`
   *  seam `armChildBound` already takes. */
  boundArmed(): boolean;
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
  /** True on the (N+2)-th read — the caller ends the child with `review-skill-reread`.
   *  The caller additionally refuses to act on it for a child that has already
   *  exited (#1847), which is a fact about the process and so lives with the
   *  spawn rather than with this counter. */
  shouldKill(): boolean;
  /** Reads counted so far (for the report / tests). */
  count(): number;
}

/**
 * Per-spawn counter of the child's reads of its own skill file.
 *
 * #1847 removed the `reported` parameter this took. It read the spawn's
 * `promptCompleted` flag, which the line handler sets on ANY non-retrying
 * `agent_end` — and Pi emits one per in-process retry boundary — so a lens under
 * a provider timeout (re-spawned from scratch by `runLensChild` whenever its
 * segment had no findings) had the cap switched off while the process that was
 * still burning reads was very much alive. What the suppression must mean is
 * "there is nothing left to stop", and that is the child having EXITED: the gate
 * now lives in `observeReviewBounds` on `targets.exited()`, because liveness is a
 * fact about the process and belongs with the spawn, not with this counter.
 */
export function createSkillReadGuard(o: {
  skillPath: string;
  boundArmed?: () => boolean;
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
      // #1847 — a nested call a tool made (a codemode script's ctx.executeTool)
      // arrives as a flat tool_execution_start with no `message`, which the
      // message-shape branch below cannot see. That was the hole: a lens that
      // re-read its SKILL.md a hundred times from inside one codemode script
      // registered zero reads. Each such read counts once.
      if (nestedSkillRead(event, dirs, wants)) {
        reads += 1;
        return;
      }
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
      // #1847 — liveness is the caller's gate (`targets.exited()`), because only
      // the spawn knows the process; this counter never consulted the spawn's
      // `reported` flag for the kill.
      if (reads < cap + 2) return false;
      killed = true;
      return true;
    },
    count: () => reads,
    boundArmed: () => o.boundArmed?.() === true,
  };
}

/**
 * Which bounds a given spawn gets, decided in ONE place so a role cannot be
 * half-bounded. The re-read cap needs a driver-supplied skill path; the
 * post-verdict stop needs BOTH the adversarial role AND the caller's explicit
 * opt-in (`SpawnOptions.verdictStop`) — `adversarial-developer` is also the plan
 * gap gate's role, and that gate ends on `VERDICT: READY | NEEDS_ITERATION`, a
 * protocol this stop was never written to read. Stopping a lens child (or a gap
 * gate) at a marker from a protocol it was not given cuts a review short.
 */
export function createReviewBounds(
  role: string,
  opts: Pick<SpawnOptions, "reviewSkillPath" | "verdictStop">,
  /** #1827 round 2 — threaded to the re-read guard so its kill stands down
   *  when a killing bound (the caps) has already armed. Optional: the bounds
   *  are also built directly by tests that have no caps session. */
  bound?: { boundArmed?: () => boolean },
): { skillRead?: SkillReadGuard; verdictStop?: VerdictStop } {
  return {
    ...(opts.reviewSkillPath !== undefined && isReviewerRole(role)
      ? {
          skillRead: createSkillReadGuard({
            skillPath: opts.reviewSkillPath,
            ...(bound?.boundArmed ? { boundArmed: bound.boundArmed } : {}),
          }),
        }
      : {}),
    ...(role === "adversarial-developer" && opts.verdictStop === true
      ? { verdictStop: createVerdictStop() }
      : {}),
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
  /** Whether the post-verdict stop ENDED this child — read by the fold through
   *  `verdictStop.stopped()`, so no separate flag is threaded here (#1827 round 4:
   *  one record of the act, set on the branch in `observeReviewBounds` that arms,
   *  closes stdin and kills). */
  reported: () => boolean;
  /** A KILLING bound has armed for this child (#1827 round 5). The post-verdict
   *  stop stands down when it is true, exactly as the re-read kill does through
   *  `SkillReadGuard.boundArmed()` — whichever bound armed first owns the end. */
  boundArmed: () => boolean;
  /** The CURRENT segment is inside Pi's in-process retry, so ending the child
   *  now discards the replay it is about to resend. Mirrors `willRetryAfter`. */
  willRetry: () => boolean;
  /** #1847 — the child process has EXITED. The re-read cap's kill stands down on
   *  a dead child (there is nothing left to end, and a kill that lands after
   *  the exit races the result the spawn is already assembling). An
   *  intermediate `agent_end` alone is NOT this: see `SkillReadGuard`. */
  exited: () => boolean;
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
    // #1847 — the ADVISORY steer is gated on the child being ALIVE to receive
    // it: `shouldKill()` does not latch when the kill stands down (below), so
    // without this gate every remaining read would write another steer at a
    // stdin that is gone. `reported()` keeps its old meaning here (a child on
    // its way out needs no lecture); it no longer disarms the KILL, which is
    // gated on liveness alone — an intermediate `agent_end` used to switch the
    // cap off in a child that was still burning reads.
    const alive = !targets.exited();
    const steer = !alive || o.skillRead.boundArmed() ? undefined : o.skillRead.steerText();
    //
    // #1827 round 1 — the ADVISORY steer does NOT arm the bound. `armBound`
    // stands down every other supervision seam (slow notice, turn nudge,
    // child-bound wrap-up, the caps steer); arming it on a message whose whole
    // purpose is to get the child to change course would silence the
    // supervision that the steer exists to supplement, and the steer often
    // works — the child carries on and reviews. Only the KILL arms.
    if (steer !== undefined) {
      try {
        if (targets.onSteer) targets.onSteer(steer, SKILL_REREAD_STEER_SOURCE);
        else targets.writeSteer(steer);
      } catch {
        /* child already gone — the kill below still fires */
      }
    }
    // #1827 round 2 — a killing bound that has ALREADY armed owns this child's
    // end: the caps' kill is in flight with its own cause. Ending the child
    // here would overwrite that cause with `review-skill-reread`, the less
    // specific diagnosis of what cost the money (see spawn-review-bounds.ts),
    // so the kill stands down — exactly as `armChildBound`'s wrap-up steer does
    // on the same seam. `shouldKill()` has already latched `killed`, so this
    // branch is reached once and the count stays the operator's evidence.
    if (alive && o.skillRead.shouldKill() && !o.skillRead.boundArmed()) {
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
  // Two gates, copied from the re-read cap and from `willRetryAfter` in
  // spawn-support.ts, for the same reason: while the child has reported, or is
  // mid-retry, its stdout belongs to an answer being delivered or about to be
  // REPLAYED, and a stop that ends the child there loses the very reply the
  // stop is claiming to preserve. `status()` is checked by the caller before
  // `observe`, so an errored/aborted turn — which records no verdict — never
  // reaches here either.
  //
  // #1847 — and the same LIVENESS gate the re-read kill has, placed HERE rather
  // than around `observe` below: `observe` is what accumulates the reply AND
  // latches the sticky "a verdict has been seen" flag, so gating it would (a)
  // drop text out of the result a live child's stop later freezes and (b) let an
  // exited child's message permanently disable the stop. A child whose process
  // has exited has no stdin to close and no process group to signal, and
  // `markEnded()` on that branch would tell the fold to stamp `ok: true` plus a
  // clean `reviewStopReason` onto a result the spawn is already assembling from a
  // stream that ended on its own. One liveness seam (`childHasExited`,
  // spawn-support.ts) decides it for all three supervisors.
  if (
    o.verdictStop &&
    o.assistantMessageEnd &&
    !targets.exited() &&
    !o.verdictStop.status() &&
    // #1827 round 5 — same seam the re-read kill checks: once a KILLING bound
    // has armed, that bound owns how this child ends and its cause is already
    // on its way. Stamping a clean end over it would report a killed review as
    // a completed one.
    !targets.boundArmed() &&
    !targets.reported() &&
    !targets.willRetry()
  ) {
    if (o.verdictStop.observe(o.assistantMessageEnd)) {
      // The fold's single gate: recorded HERE, on the branch that actually ends
      // the child, on the stop object the fold already reads — never from the
      // parse alone, and never through a second flag the wiring keeps.
      o.verdictStop.markEnded();
      targets.armBound();
      // NOT `setKillCause`: a clean end is not a kill cause — see
      // spawn-review-bounds.ts for why the stop rides on `reviewStopReason`
      // instead, where no failure-or-cap consumer can mistake it for one.
      targets.completePrompt();
      targets.kill();
    }
  }
}
