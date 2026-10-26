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

import path from "node:path";
import { VERDICT_STATUSES } from "./adversarial-verdict.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { isSkillFileRead } from "./lens-skill-load-proof.ts";
import type { PiJsonEvent, SpawnOptions } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import type { DispatchResult } from "./types.ts";

/** A child that re-read its skill file past the cap. */
export const REVIEW_SKILL_REREAD_KILL = "review-skill-reread" as const;
/** A reviewer that was ended as done once its verdict appeared. */
export const REVIEW_POST_VERDICT_STOP = "review-post-verdict" as const;

/** The roles the two bounds apply to. The fix-pass `developer` is not one. */
export const REVIEWER_ROLES: readonly string[] = [
  "code-review-specialist",
  "adversarial-developer",
];

/** Does this role get the reviewer bounds? */
export function isReviewerRole(role: string): boolean {
  return REVIEWER_ROLES.includes(role);
}

function capsOn(): boolean {
  return process.env.PI_ENSEMBLE_DISPATCH_CAPS !== "0";
}

/** Reads of its own skill file a reviewer is allowed before the first steer. */
export function reviewSkillReadCap(): number {
  const n = Number(process.env.PI_ENSEMBLE_REVIEW_SKILL_READS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

/** The adversarial reviewer's own run bound (a lens child's is 30 min). */
export function adversarialChildBoundMs(): number {
  const n = Number(process.env.PI_ENSEMBLE_ADVERSARIAL_BOUND_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60_000;
}

export interface SkillReadGuard {
  /** Feed one parsed child event. Counted reads of the skill file only. */
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
  /** Injectable for tests; the guard is pure otherwise. */
  now?: () => number;
}): SkillReadGuard {
  // No skill path to compare against, or caps off: the guard observes nothing
  // and can neither steer nor kill.
  const active = capsOn() && !!o.skillPath;
  let reads = 0;
  let steered = false;
  let killed = false;
  const cap = reviewSkillReadCap();
  return {
    observe: (event) => {
      if (!active) return;
      const msg = event.message;
      if (event.type !== "message_end" || msg?.role !== "assistant") return;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return;
      for (const block of msg.content ?? []) {
        if (block.type !== "toolCall") continue;
        const name = (block.name ?? "").toLowerCase();
        const args = (block.arguments ?? {}) as Record<string, unknown>;
        if (isSkillFileRead(name, args, o.skillPath)) reads += 1;
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
 * The live post-verdict stop. Accumulates every text block of every assistant
 * `message_end` and asks the consumer's own reader whether a verdict is in it.
 *
 * Accumulated text, not the last block alone: a reviewer that returns its
 * verdict in one block and its findings in the next must not be judged by a
 * different rule than `parseVerdict` will judge the finished reply by.
 */
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

export function createVerdictStop(): VerdictStop {
  const parts: string[] = [];
  let stopped: string | undefined;
  return {
    observe: (event) => {
      const msg = event.message;
      if (event.type !== "message_end" || msg?.role !== "assistant") return stopped !== undefined;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") return stopped !== undefined;
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) parts.push(block.text);
      }
      if (stopped) return true;
      const hit = readEnumMarker(parts.join("\n"), "VERDICT", VERDICT_STATUSES);
      if (hit) stopped = hit;
      return stopped !== undefined;
    },
    text: () => parts.join("\n"),
    status: () => stopped,
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
  /** A killing bound has armed: the advisory steers stand down (#1827 ordering). */
  armBound: () => void;
  /** Record the cause the spawn applies AFTER `applyChildBound`. */
  setKillCause: (cause: DispatchResult["killCause"]) => void;
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
    // One steer on the (N+1)-th read, then the kill on the (N+2)-th. The steer
    // goes through the driver's seam when the caller has one (so the lifecycle
    // record names the source) and to raw stdin otherwise — the same fallback
    // `armChildBound` uses.
    const steer = o.skillRead.steerText();
    if (steer !== undefined) {
      targets.armBound();
      try {
        if (targets.onSteer) targets.onSteer(steer, SKILL_REREAD_STEER_SOURCE);
        else targets.writeSteer(steer);
      } catch {
        /* child already gone — the kill below still fires */
      }
    }
    if (o.skillRead.shouldKill()) {
      targets.setKillCause(REVIEW_SKILL_REREAD_KILL);
      targets.kill();
    }
  }
  // The post-verdict stop ends the child as DONE, not killed: the reviewer's
  // answer is in hand, so the child is ended NOW and none of its later tool
  // calls run. `completePrompt` closes stdin exactly as a normal end would.
  if (o.verdictStop && o.assistantMessageEnd && !o.verdictStop.status()) {
    if (o.verdictStop.observe(o.assistantMessageEnd)) {
      targets.armBound();
      targets.setKillCause(REVIEW_POST_VERDICT_STOP);
      targets.completePrompt();
      targets.kill();
    }
  }
}
