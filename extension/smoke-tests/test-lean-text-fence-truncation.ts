#!/usr/bin/env bun
/**
 * lean/text-fence — a clipped fence SAYS it was clipped.
 *
 * `fenceText` is the renderer that keeps newlines, so whoever reads it is reading
 * a document. It used to clip by slicing and appending a single `…`, which for a
 * 20 KB findings block is decoration: it names no bound and states no omission, so
 * "the reviewer had nothing more to say" and "the rest was cut off" render
 * identically. That is the same family of defect as a gate that cannot fail — the
 * one reader who cannot check is the one being told a half-truth. The block this
 * bites hardest is `lensContext`'s carried-findings block, which six lens children
 * are told to weigh as EVIDENCE (see `test-lean-review-lens-fence.ts`).
 *
 * Both directions are asserted, and the negative one is the point. A marker that
 * leaked into every fence — emitted unconditionally, or keyed off a length check
 * off by one — would still pass a suite that only ever looked at a clipped payload
 * and asked for the marker. So every clipped case is paired with a case at the
 * same bound that must NOT carry it, and the marker's own absence is asserted as
 * loudly as its presence.
 *
 * No fixture, no repo, no child: pure functions over strings.
 */

import { fenceText } from "../src/lean/text-fence.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** The bound every case here uses, and the marker it must (or must not) produce. */
const MAX = 50;
const MARKER = `[truncated at ${String(MAX)} characters]`;

/** Lines strictly INSIDE the fence — the region the marker has to live in. */
function fencedBody(rendered: string): string[] {
  const lines = rendered.split("\n");
  assert(
    lines[0] === "```text" && lines[lines.length - 1] === "```",
    `precondition: the payload renders inside one text fence (${JSON.stringify(rendered.slice(0, 60))})`,
  );
  return lines.slice(1, -1);
}

// ── (1) OVER the bound: the marker appears, inside the fence, on its own line.
{
  const payload = "finding line\n".repeat(20); // 240 chars, well past MAX
  const rendered = fenceText(payload, MAX);
  const body = fencedBody(rendered);
  assert(
    body.includes(MARKER),
    `(1) a payload over the bound states the truncation INSIDE the fence, on its own line (${JSON.stringify(body.slice(-3))})`,
  );
  assert(
    rendered.indexOf(MARKER) > payload.slice(0, MAX).indexOf("\n"),
    `(1) and it is a line of the fenced block, not a suffix glued to the last content line (${JSON.stringify(rendered.slice(-Math.max(40, MARKER.length + 8)))})`,
  );
  assert(
    rendered.includes("…"),
    "(1) and the ellipsis that marks the cut in the payload itself is still there — the marker supplements it, it does not replace it",
  );
  // The bound the marker prints is the bound that was APPLIED, not some other
  // number the renderer happens to hold: a marker that lied about its own bound
  // is worse than none, because it reads as a verified fact.
  assert(
    fencedBody(fenceText(payload, 12)).includes("[truncated at 12 characters]"),
    "(1) and the number in the marker is the bound that was applied, not a constant",
  );
}

// ── (2) UNDER the bound: the marker appears NOWHERE. This is the half that makes
// (1) mean anything; a marker emitted unconditionally satisfies (1) forever.
{
  const under = "x".repeat(MAX); // exactly at the bound: not clipped
  const rendered = fenceText(under, MAX);
  assert(
    !rendered.includes("[truncated"),
    `(2) a payload AT the bound is not clipped and carries NO marker — a marker that leaked into every fence would keep this suite's (1) green while telling six lens children their evidence was cut (${JSON.stringify(rendered)})`,
  );
  assert(
    rendered === "```text\n" + under + "\n```",
    `(2) and an unclipped fence is byte-identical to what it was before the marker existed — no stray blank line, no suffix (${JSON.stringify(rendered)})`,
  );
  const empty = fenceText("", MAX);
  assert(
    !empty.includes("[truncated") && empty === "```text\n\n```",
    `(2b) and the empty payload — the shortest thing that can pass through — is likewise untouched (${JSON.stringify(empty)})`,
  );
}

// ── (3) THE MARKER IS RENDERER-STRUCTURE, NOT PAYLOAD TEXT.
{
  // (3a) The marker is renderer-structure: it must never be silently neutralised.
  // A payload of 3+ backticks is rewritten (U+02CB) so it cannot close the fence;
  // the marker is appended AFTER that swap precisely so it is not itself rewritten
  // into something a reader no longer recognises as the disclosure.
  const clipped = fenceText("z".repeat(MAX + 20), MAX);
  assert(
    !clipped.includes("\u02cb".repeat(MARKER.length)),
    `(3a) the marker line is never backtick-neutralised — it is appended after the swap, so the disclosure survives in its readable form (${JSON.stringify(fencedBody(clipped).slice(-2))})`,
  );
  // The renderer's marker is appended after the backtick swap, so a payload full
  // of fence delimiters cannot break the line the marker sits on.
  const hostile = ("```text\n".repeat(20) + "x").repeat(6);
  const clippedHostile = fenceText(hostile, MAX);
  assert(
    fencedBody(clippedHostile).includes(MARKER),
    `(3) and a hostile payload that gets clipped still gets its marker as a clean line — the backtick neutralisation runs before the marker is appended, not after (${JSON.stringify(fencedBody(clippedHostile).slice(-3))})`,
  );
  assert(
    !clippedHostile.includes("```text\ntext") && fencedBody(clippedHostile).filter((l) => l === "```").length === 0,
    "(3) and no payload backtick run closed the fence before the marker line",
  );
}

// ── (4) THE BOUND ITSELF STILL HOLDS. The marker is added AFTER the clip, so it
// must not be paid for out of the payload's allowance — if it were, the visible
// content would shrink by the marker's length and every reader would lose lines.
{
  const payload = "y".repeat(MAX + 500);
  const body = fencedBody(fenceText(payload, MAX));
  const content = body.filter((line) => line !== MARKER).join("");
  assert(
    content === `${"y".repeat(MAX)}…`,
    `(4) the payload keeps exactly \`max\` characters plus the ellipsis, with the marker as a SEPARATE line rather than a tax on the allowance (${String(content.length)} content chars)`,
  );
}

process.exit(failures());
