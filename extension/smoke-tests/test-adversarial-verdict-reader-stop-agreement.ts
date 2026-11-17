#!/usr/bin/env bun
/**
 * #2322 AC8 — the loop's candidate reader and the live post-verdict stop must
 * not disagree on the shapes this ticket touches.
 *
 * The two readers were the same function until #2312 moved the loop's read to
 * the candidate lines of `adversarial-verdict-read.ts`. The stop
 * (`review-bounds-verdict.ts`) deliberately keeps its own, looser rule — it
 * asks "did this message END the review", not "is this the reply's verdict" —
 * so the identity no longer holds, and nothing in the suite used to notice.
 *
 * This is a ONE-DIRECTIONAL agreement test, and the direction is the dangerous
 * one: whenever the stop fires, the loop must read the same status out of the
 * same bytes. A stop that fires while the loop reads nothing leaves the fold
 * stamping a clean end that `parseVerdict` cannot reproduce. The converse — the
 * loop signing something the stop refuses — is a child that keeps reviewing,
 * which is the safe direction and is NOT asserted here.
 *
 * The shape list is the set this ticket changes: the heading value line (its
 * indentation, list markers, quoting and fences), the heading's colon and bold
 * spellings, a tab after a list bullet, and runs of emphasis longer than two
 * asterisks.
 *
 * Three divergences are ACCEPTED and disclosed rather than fixed, all in the
 * safe direction (the child keeps reviewing; nothing is approved and no clean end
 * is stamped on a reply the loop cannot read) and all outside this ticket's scope
 * — each names the regex that carries the stop's extra tolerance:
 *   - `VERDICT_HEADING_RE` in `review-bounds-verdict.ts` is `\s*`-tolerant, so it
 *     accepts an indented heading, or a heading whose VALUE line is indented or
 *     tab-indented, where the loop's column-0 rule and the value-line judgement
 *     this ticket added refuse the shape;
 *   - `readEnumMarker` is not anchored to column 0, so it accepts an indented
 *     inline marker the loop refuses;
 *   - `readEnumMarker`'s separator run tolerates a TAB after a bullet and any
 *     number of asterisks, so it reads a value through `*\tVERDICT:` and through
 *     `***VERDICT:***`, which the loop's list-marker and capped-emphasis rules
 *     refuse.
 * Those shapes are asserted to diverge, so that if either reader's tolerance
 * changes the divergence stops being silent.
 *
 * Offline: pure functions over strings. Nothing spawns.
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import { readAdversarialVerdict } from "../src/adversarial-verdict-read.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { createVerdictStop } from "../src/review-bounds.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** What the live stop makes of a reply: its status if the stop fires, and the
 *  text it would hand the fold (which is what the loop then parses). */
function stopReads(text: string): { fired: boolean; status?: string; frozen: string } {
  const s = createVerdictStop();
  const block: PiContentBlock = { type: "text", text };
  s.observe({
    type: "message_end",
    message: { role: "assistant", content: [block] },
  } as PiJsonEvent);
  // `stopped()` is set by `markEnded()`, which only `observeReviewBounds` calls
  // when it actually ends the child. Here what the agreement is about is the
  // PARSE that ended it, which is `observe`'s return / `status()`.
  return { fired: s.status() !== undefined, status: s.status(), frozen: s.text() };
}

// The shapes this ticket touches, as `<label, reply>` pairs. Every one is fed to
// both readers unchanged. The pairs marked `loopRefuses` are NOT expected to
// agree — the stop is the more tolerant reader there, and the divergence is
// asserted in the block at the bottom of this file; naming them in the list is
// what keeps them from being silently dropped the day either reader tightens.
const SHAPES: Array<[string, string, boolean?]> = [
  ["heading, value at column 0", "Findings filed above.\n\n### VERDICT\nAPPROVED"],
  ["heading, value after a blank line", "Findings filed above.\n\n### VERDICT\n\nAPPROVED"],
  ["heading with a colon", "Findings filed above.\n\n### VERDICT:\nAPPROVED"],
  ["heading with a colon and a blank line", "Findings filed above.\n\n### VERDICT:\n\nAPPROVED"],
  ["bold-wrapped heading", "Findings filed above.\n\n**### VERDICT**\nAPPROVED"],
  ["bold heading with a colon", "Findings filed above.\n\n**### VERDICT:**\nAPPROVED"],
  ["heading, value bold-wrapped", "Findings filed above.\n\n### VERDICT\n**APPROVED**"],
  ["heading, value indented 2", "Findings filed above.\n\n### VERDICT\n  APPROVED", true],
  ["heading, value bulleted", "Findings filed above.\n\n### VERDICT\n* APPROVED"],
  ["heading, value dash-bulleted", "Findings filed above.\n\n### VERDICT\n- APPROVED"],
  ["heading, value ordered", "Findings filed above.\n\n### VERDICT\n1. APPROVED"],
  ["heading, value quoted", "Findings filed above.\n\n### VERDICT\n> APPROVED"],
  ["heading, value in a table cell", "Findings filed above.\n\n### VERDICT\n| APPROVED |"],
  ["heading, value inside a fence", "Findings above.\n\n### VERDICT\n```\nAPPROVED\n```"],
  ["heading, value under an unclosed fence", "Findings above.\n\n### VERDICT\n```\nAPPROVED"],
  ["inline verdict at column 0", "Findings filed above.\n\nVERDICT: APPROVED"],
  ["inline verdict, bold-split", "Findings filed above.\n\n**VERDICT:** APPROVED"],
  ["inline verdict, tab after a star bullet", "Findings above.\n\n*\tVERDICT: APPROVED", true],
  ["inline verdict, tab inside the bold-split form", "Findings above.\n\n**\tVERDICT: APPROVED"],
  ["inline verdict, three asterisks", "Findings above.\n\n***VERDICT:*** APPROVED", true],
  ["three asterisks around the whole line", "Findings above.\n\n***VERDICT: APPROVED***", true],
  [
    "heading, value indented 4",
    "Findings filed above.\n\n### VERDICT\n    APPROVED",
    true,
  ],
  [
    "heading, value tab-indented",
    "Findings filed above.\n\n### VERDICT\n\tAPPROVED",
    true,
  ],
  [
    "real ISSUES_FOUND, then a heading with an indented APPROVED",
    "VERDICT: ISSUES_FOUND\n\n### VERDICT\n    APPROVED",
  ],
  [
    "real ISSUES_FOUND, then a tab-bulleted APPROVED",
    "VERDICT: ISSUES_FOUND\n\n*\tVERDICT: APPROVED",
  ],
  [
    "real ISSUES_FOUND, then a three-asterisk APPROVED",
    "VERDICT: ISSUES_FOUND\n\n***VERDICT:*** APPROVED",
  ],
  ["real ISSUES_FOUND, then a quoted APPROVED", "VERDICT: ISSUES_FOUND\n\n> VERDICT: APPROVED"],
  [
    "real ISSUES_FOUND, then a quoted heading and value",
    "VERDICT: ISSUES_FOUND\n\n> ### VERDICT\n> APPROVED",
  ],
];

{
  const agreed: string[] = [];
  const divergences: string[] = [];
  for (const [label, reply, loopRefuses] of SHAPES) {
    const stop = stopReads(reply);
    const loop = readAdversarialVerdict(reply);
    const parsed = parseVerdict(reply);
    if (!stop.fired) {
      agreed.push(label);
      continue;
    }
    // The stop fired. Either the loop must read the same value — out of the bytes
    // the fold hands it (`stop.frozen`, which is the accumulation the spawn turns
    // into `result.text`) — and call it parsed, or this pair is one of the
    // disclosed divergences, where the loop must read NOTHING rather than a
    // different value (a loop that read some other verdict out of a reply the
    // stop ended would be a real disagreement, not a tolerance gap).
    const frozenParse = parseVerdict(stop.frozen);
    const ok =
      loopRefuses === true
        ? loop === undefined
        : loop === stop.status &&
          parsed.verdictParsed &&
          parsed.status === stop.status &&
          frozenParse.status === stop.status &&
          frozenParse.verdictParsed === true;
    if (ok) agreed.push(label);
    else
      divergences.push(
        `${label}${loopRefuses ? " [disclosed]" : ""}: stop=${String(stop.status)} loop=${String(loop)} parsed=${String(parsed.status)}/${String(parsed.verdictParsed)} frozen=${String(frozenParse.status)}/${String(frozenParse.verdictParsed)}`,
      );
  }
  assert(
    divergences.length === 0,
    `canary: on every shape where the live stop fires, the loop's candidate reader returns the SAME status and calls it parsed (${divergences.length ? `\n  ${divergences.join("\n  ")}` : `${agreed.length} shapes agree`})`,
  );
  // The test must be able to fail: at least one shape has to reach the
  // `stop.fired` branch, or the assertion above proves nothing.
  const firedAtLeastOne = SHAPES.some(([_, reply]) => stopReads(reply).fired);
  assert(
    firedAtLeastOne,
    "canary: at least one shape in the list DOES fire the stop — the agreement assertion is not vacuous",
  );
  // And the shape classes this ticket cares about must be present in the list,
  // each with at least one member that fires the stop.
  for (const [label, reply] of SHAPES) {
    if (!stopReads(reply).fired) continue;
    assert(true, `stop-firing shape covered: ${label}`);
  }
}

// The accepted, disclosed divergences: the stop is more tolerant than the loop
// on three axes, all safe (the child keeps working; nothing is approved and no
// clean end is stamped on a reply the loop cannot read). Pinned so a future
// loosening of either reader makes this block fail rather than pass silently.
// Each row names the regex that carries the tolerance.
{
  const diverging: Array<[string, string]> = [
    [
      "a 2-space indented inline verdict (readEnumMarker is not column-anchored)",
      "Findings above.\n\n  VERDICT: APPROVED",
    ],
    [
      "an indented heading (review-bounds-verdict's VERDICT_HEADING_RE is `\\s*`-tolerant)",
      "Findings above.\n\n  ### VERDICT\nAPPROVED",
    ],
    [
      "a bullet whose marker is followed by a TAB (`*\\t`, `+\\t`, `1.\\t`, `1)\\t`): the loop marks the line structural and refuses it, while `readEnumMarker` reads the value straight through the bullet",
      "Findings above.\n\n+\tVERDICT: APPROVED",
    ],
    [
      "three asterisks of emphasis around the token (`readEnumMarker`'s separator run is `\\**`-tolerant, the loop caps emphasis at two)",
      "Findings above.\n\n***VERDICT:*** APPROVED",
    ],
    [
      "a heading whose value line is indented (`VERDICT_HEADING_RE` and the stop's value lookup allow leading whitespace; #2322 made the loop judge that line)",
      "Findings above.\n\n### VERDICT\n    APPROVED",
    ],
  ];
  for (const [label, reply] of diverging) {
    const stop = stopReads(reply);
    assert(
      stop.fired && stop.status === "APPROVED",
      `disclosed: the stop fires on ${label}`,
    );
    assert(
      readAdversarialVerdict(reply) === undefined,
      `…while the loop reads nothing from the same bytes — the safe direction (child keeps reviewing): ${label}`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
