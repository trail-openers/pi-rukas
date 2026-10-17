/**
 * work-driver-handoff-verify-tail — #1392 D5: the bounded RAW verify output
 * tail in BOTH handoff surfaces.
 *
 * Cycles 54 and 60 both parked on a consolidated-verify failure that named no
 * assertion, and neither handoff said what the gate printed. Both surfaces
 * carried only the #841 clause — `Raw output: <path>` — a scratch-dir file
 * that is not on the issue, is not durable, and cannot be read by anyone
 * looking at the comment. The operator was handed a verdict on the change with
 * no content, twice.
 *
 * This module is the single renderer for the tail, so the GitHub body and the
 * in-chat message print the same lines from the same record (the "agree by
 * copy" drift class this project keeps paying for). Pure function, no I/O:
 * the caller has already persisted the raw log; this only renders what the
 * state file carries.
 *
 * The tail is UNTRUSTED — it is whatever the project's verify command printed,
 * on its way to a forge comment. It is emitted inside a code fence computed
 * from its own longest backtick run (the same discipline as `renderNoteBullet`
 * in work-driver-handoff-markdown.ts), so output containing ```` ``` ````
 * cannot break out of the block and be interpreted as markdown by
 * `gh pr comment`.
 *
 * There is deliberately NO cap-keyed presence rule here, unlike the
 * cap-gated commit-pr sections. The tail is not a guess about the park — it is
 * the output of the command the driver actually ran, so printing it for any
 * cap whose state file carries one is informative, and an enumeration of caps
 * would always lag (the #398 failure class). The record is only ever written
 * by a consolidated-verify failure, so the two surfaces cannot disagree about
 * whether it exists.
 */

import { redactSecrets } from "./secret-patterns.ts";
import type { VerifyOutputTail } from "./workflow-state-schema-verify.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * How many code points of raw output the handoff prints.
 *
 * Sized against the surfaces, not against the log: the develop seam already
 * puts an 800-char attributed tail in the cap's prose, and the comment already
 * carries findings, dispatch rows and recovery commands. 1600 covers a smoke
 * loop's `FAILED:` marker plus the verbose re-run beneath it — which is the
 * content the operator actually needs and the one thing the sentinel sentence
 * could not give them — while keeping the block small enough to read in the
 * chat surface. The full, unbounded stream stays on disk in the scratch log;
 * this is the bounded excerpt, not a replacement for the log.
 */
export const HANDOFF_TAIL_MAX_CHARS = 1600;

/** Longest run of consecutive backticks in `s` (0 when it has none). */
function longestBacktickRun(s: string): number {
  let longest = 0;
  const runs = s.match(/`+/g);
  if (runs) {
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return longest;
}

/**
 * The tail, clipped by CODE POINT (so a surrogate pair is never split in
 * half), with a marker that says the excerpt is an excerpt.
 *
 * Redaction runs BEFORE the clip, never after: clipping first can cut a token
 * into a fragment no pattern recognises, and the fragment then survives into a
 * public comment (the ordering rule `redactThenBound` in text-flatten.ts
 * exists for). A verify command echoes the command line it ran, so a
 * credential-carrying env or URL in gate output is a realistic path here, not
 * a hypothetical.
 */
function boundTail(raw: string): { text: string; clipped: boolean } {
  const chars = Array.from(redactSecrets(raw).text);
  if (chars.length <= HANDOFF_TAIL_MAX_CHARS) return { text: chars.join(""), clipped: false };
  // Keep the marker inside the bound: the printed length never exceeds the cap.
  return { text: `${chars.slice(0, HANDOFF_TAIL_MAX_CHARS - 1).join("")}…`, clipped: true };
}

/**
 * A fenced code block that cannot be escaped by its own content.
 *
 * The fence is one backtick longer than the longest run inside, and a line of
 * output that begins with an equal-or-longer run would close it early — so
 * such a line is prefixed with a single space, which is inert inside a fenced
 * block and keeps the run from being line-initial.
 *
 * `indent` is applied UNIFORMLY to every line, including blank ones. That
 * matters: CommonMark strips the block's *minimum* indent from all lines, so
 * a blank line left un-indented would set that minimum to 0 and cancel the
 * indentation the caller asked for — and it would also stop being the blank
 * line that separates the fence from the paragraph above it. Because the
 * removal is uniform, output that carries its own leading whitespace (an
 * indented assertion diff, a stack-trace continuation) keeps its layout, which
 * a naive per-line prefix would have doubled on some lines and lost on others.
 */
function fencedBlock(text: string, indent: string): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  const safe = text
    .split("\n")
    .map((l) => `${indent}${/^`{3,}/.test(l) ? ` ${l}` : l}`)
    .join("\n");
  return [`${indent}${fence}`, safe, `${indent}${fence}`];
}

/** The tail record this state carries, when it carries one. */
export function verifyOutputTail(state: WorkState): VerifyOutputTail | undefined {
  return state.pipelineState.verifyEvidence?.outputTail;
}

/**
 * The rendered block, or `[]` when no tail was captured.
 *
 * `indent` is prepended verbatim to every line — the markdown surface passes
 * `""` (a fenced block at column 0), the in-chat surface passes FOUR spaces.
 * Four is not a style choice: a markdown fence nested inside a list item has
 * to be indented at least as far as that item's content, and the chat
 * renderer's sections are `"  text"` lines whose content column is 2 — two
 * spaces of fence would be read as the continuation of the line above and
 * printed raw. Four spaces is a valid indent for BOTH and still visually
 * belongs to its neighbours.
 *
 * Absence renders as nothing here rather than as a sentence: a state file
 * from before this field, or a gate that captured no stream, is not a finding,
 * and the surfaces already say "Raw output: unavailable" where the path was
 * unknown.
 */
export function verifyTailSection(
  state: WorkState,
  indent = "",
  label = "Verify output (bounded excerpt)",
): string[] {
  const rec = verifyOutputTail(state);
  if (!rec) return [];
  const { text, clipped } = boundTail(rec.tail);
  if (!text.trim()) return [];
  const fence = rec.command ? `${label} — ${rec.command}` : label;
  const attribution =
    rec.attributed === false
      ? // The tail came from the fixed-size fallback window, so a passing
        // sub-command's output could sit at its head. Say so rather than let
        // the excerpt read as anchored evidence.
        `${indent}(unanchored — no FAILED: marker in the run's output)`
      : undefined;
  return [
    `${indent}**${fence}**`,
    "",
    ...fencedBlock(text, indent),
    ...(clipped
      ? [`${indent}(excerpt — output truncated at ${HANDOFF_TAIL_MAX_CHARS} chars)`]
      : []),
    ...(attribution ? [attribution] : []),
    "",
  ];
}
