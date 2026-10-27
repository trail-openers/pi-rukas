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

import { SKILL_READ_TOOL_NAMES, isSkillReadWith } from "./lens-skill-load-proof.ts";
import { SKILL_FILE_NAME } from "./lens-skill-path.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";

/** The tool names the nested reader will consider (#1847).
 *
 * Derived from the read-tool set the predicate itself owns
 * (`SKILL_READ_TOOL_NAMES`, lens-skill-load-proof.ts), so this gate cannot get
 * ahead of or behind what `isSkillReadWith` accepts — the one drift a hand-
 * copied list manufactures silently.
 *
 * Deliberately a PRE-FILTER, not a second source of truth: the verdict still
 * comes from `isSkillReadWith`, and this list only has to be a sound necessary
 * condition — anything it rejects, the predicate also rejects. It exists because
 * the two real reader shapes are `read` (whose `args` a matcher then compares
 * path-wise) and `bash` (whose `args.command` the predicate TOKENISES: split on
 * separators, strip quotes, test every token against the resolved skill file).
 * Without this gate, a child that spent its run calling `edit`, `write` and
 * `codemode` paid that tokenisation on every nested call of every turn, on the
 * per-stdout-line hot path, for a file those tools cannot open.
 *
 * The VERDICT that admits a `bash` call is narrower than its name: the command
 * must name the skill FILE (`SKILL_FILE_NAME`) somewhere, which is the same
 * sound necessary condition the predicate applies further down. Testing it here
 * is what keeps the parser off the hot path for the thousands of nested `bash`
 * calls of a review that never mention the skill. */
const NESTED_READER_TOOLS = SKILL_READ_TOOL_NAMES;

/** Is this parsed stdout line a tool call a tool itself made? */
function isNestedToolStart(event: PiJsonEvent): boolean {
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
  const name = typeof event.toolName === "string" ? event.toolName.toLowerCase() : "";
  // The hot-path gate, BEFORE any tokenising: a nested `edit`, `write`,
  // `codemode` or `dispatch` call cannot open the skill file, so it returns
  // here and never reaches `isSkillReadWith`'s bash-command parser. A nested
  // event whose `toolName` is not a string lands on the same line — the shape
  // is Pi's and a malformed one must never throw on the hot path.
  if (!NESTED_READER_TOOLS.has(name)) return false;
  const args = event.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  if (name !== "bash") return isSkillReadWith(name, args as Record<string, unknown>, dirs, wants);
  // Cheap gate BEFORE `isSkillReadWith` tokenises: a command that never
  // mentions the skill file name cannot have opened it, and a review's nested
  // `bash` traffic is almost entirely commands that do not. Same condition the
  // predicate tests internally, applied one step earlier so the parser is never
  // reached for those calls.
  const asRecord = args as Record<string, unknown>;
  // `command` is Pi's bash argument key, spelled the same way here as the
  // predicate's own `COMMAND_KEY` below reads it off an open record.
  const command = asRecord.command;
  if (typeof command !== "string" || !command.includes(SKILL_FILE_NAME)) return false;
  return isSkillReadWith(name, asRecord, dirs, wants);
}

/**
 * The one thing the line handler needs to ask: does this line add a skill read
 * to the count? Kept as the single exported predicate so the hot path in
 * `spawn-inflight.ts` holds no policy of its own, and so `isNestedToolStart` /
 * `nestedEventReadsSkill` stay module-private (#1847): the pair is only correct
 * as a conjunction, and exporting the halves let a caller count a top-level
 * start or skip the nesting check.
 */
export function nestedSkillRead(
  event: PiJsonEvent,
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  return isNestedToolStart(event) && nestedEventReadsSkill(event, dirs, wants);
}
