/**
 * review-bounds-nested — the nested-call half of the #1827 skill re-read cap
 * (#1847).
 *
 * A codemode script running inside a reviewer child reads files through Pi's
 * `ctx.executeTool()`, and Pi reports each of those calls as a flat
 * `tool_execution_start` event carrying its own `toolCallId` (`<callerId>/<n>`)
 * and a `parentToolCallId` pointing at the codemode call that made it. Those
 * events have no `message`, which is precisely why the cap missed them: the
 * guard counted only `toolCall` blocks inside an assistant `message_end`, so a
 * lens that re-read its `SKILL.md` a hundred times from inside one codemode
 * script registered ZERO reads and was never bounded. Nested reads are the
 * default for a lens child, not an opt-in — codemode is on for every child
 * unless `PI_ENSEMBLE_CHILD_CODEMODE=0`.
 *
 * One rule per event, and the two rules that keep the count honest:
 *
 *   - Only a NESTED call counts (`parentToolCallId` present). The parent
 *     codemode call's own `toolCall` block is not a read and is never counted;
 *     when that block is a `read` the parent already credited it through the
 *     `message_end` path.
 *   - Each nested read event counts once — a script that opens the skill file
 *     five times is five reads, matching what five assistant-turn reads would
 *     cost. There is deliberately no per-parent dedup: the unbounded reload is
 *     exactly the shape one script loops through.
 *
 * The judgement stays in `isSkillReadWith` (lens-skill-load-proof.ts) — the
 * same predicate the assistant-turn path and the #1530 proof use, so the two
 * feeds cannot disagree about what a skill read is. Both shapes the predicate
 * knows are reachable on the nested form and both count: `read` with `args.path`
 * and `bash` with `args.command`.
 *
 * This counting lives in `createStdoutLineHandler`'s feed only
 * (`spawn-inflight.ts`) — `observeReviewBounds` keeps consuming just the
 * assistant `message_end`, so one nested event is never counted twice.
 */

import { isSkillReadWith } from "./lens-skill-load-proof.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";

/** Is this parsed stdout line a tool call a tool itself made? */
export function isNestedToolStart(event: PiJsonEvent): boolean {
  return (
    event.type === "tool_execution_start" &&
    typeof event.parentToolCallId === "string" &&
    event.parentToolCallId !== ""
  );
}

/**
 * Does this nested call read one of the accepted skill-file spellings?
 *
 * `dirs` / `wants` are the guard's precomputed candidate lists (built once per
 * spawn — resolution reaches the filesystem, and this runs on the per-line hot
 * path of a child that may run hundreds of turns). A nested event whose
 * `toolName` is not a string, or whose `args` are not an object, is not a read:
 * the shape is Pi's and a malformed one must never throw on the hot path.
 */
export function nestedEventReadsSkill(
  event: PiJsonEvent,
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  if (wants.length === 0) return false;
  const name = typeof event.toolName === "string" ? event.toolName : "";
  if (name === "") return false;
  const args = event.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  return isSkillReadWith(name, args as Record<string, unknown>, dirs, wants);
}

/**
 * The one thing the line handler needs to ask: does this line add a skill read
 * to the count? Kept as a single predicate so the hot path in
 * `spawn-inflight.ts` holds no policy of its own.
 */
export function nestedSkillRead(
  event: PiJsonEvent,
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  return isNestedToolStart(event) && nestedEventReadsSkill(event, dirs, wants);
}
