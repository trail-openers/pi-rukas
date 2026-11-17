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
import { readAdversarialVerdict, verdictCandidateLines } from "../src/adversarial-verdict-read.ts";
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

// The fence delimiters built from code points rather than written inline, so no
// escape or formatter can mangle them here.
const FENCE3 = String.fromCharCode(0x60, 0x60, 0x60);
const FENCE4 = FENCE3 + String.fromCharCode(0x60);
// Fence arms whose reply ENDS on a signature the live stop can read. The stop
// ends the child at the LAST marker-shaped line its own fence accounting reaches
// — a second one ABOVE the closing line makes the block unaccountable and the stop
// reads nothing, and an arm that reads nothing short-circuits before its body
// runs, so it asserts nothing. `want` is the value BOTH readers must agree on;
// `inside` is a MARKER-shaped line of the other value parked inside the block, so
// the loop's candidate walk — which is what these arms exist to pin — has a
// forgery to refuse. The signature is the reply's last marker line, which is why
// `inside` sits ABOVE the closer with nothing of that shape below the block —
// except the heading-signature arms, where the stop's heading form is what it
// reaches past the block.
const FENCE_SHAPES: Array<[string, string, string, string?]> = [
  [
    "closing fence above the signature",
    `Findings above.\n\n${FENCE3}\ndiff\n+const x = 1;\n${FENCE3}\n\nVERDICT: APPROVED`,
    "APPROVED",
  ],
  [
    "info-string fence above the signature",
    `Findings above.\n\n${FENCE3}js\nconst a = 1;\n${FENCE3}\n\nVERDICT: APPROVED`,
    "APPROVED",
  ],
  [
    "tilde fence above the signature",
    `Findings above.\n\n~~~js\ncode\n~~~\n\nVERDICT: APPROVED`,
    "APPROVED",
  ],
  [
    "closing fence above a heading signature",
    `Findings above.\n\n${FENCE3}\ndiff\n+const x = 1;\n${FENCE3}\n\n### VERDICT\nAPPROVED`,
    "APPROVED",
  ],
  // The blocks whose info string carries the fence character, and the blocks a
  // reviewer quoted with an indent. Before the fix each of these four opened
  // NOTHING — a tilde run with tildes in its info string was excused, and so was a
  // fence line indented past the three spaces the walk allowed — so a `VERDICT:` line
  // written INSIDE one was treated as a signature of the reply rather than quoted
  // text. The arm is the reply that does exactly that: a forgery inside the block and
  // the honest signature outside it, at a different value, so an arm whose two values
  // agreed could not tell a read signature from a read forgery.
  //
  // The signature is the heading form and it sits ABOVE the block, and the in-block
  // forgery is the reply's only full `VERDICT:` line. Both readers account for fences
  // on their own and both give up on a reply they cannot close, so a shape the stop
  // refuses makes the arm short-circuit on `!stop.fired` and its body is never
  // asserted — the vacuity the firing canary below exists to catch. A second full
  // marker line anywhere, or an inline signature below an indented block, is enough to
  // make the stop read nothing; the heading-above shape is the one both readers reach.
  [
    "a ~~~ opener whose info string carries tildes (`~~~ ~~~`)",
    `Findings above.\n\n### VERDICT\nAPPROVED\n\n~~~ ~~~\nVERDICT: ISSUES_FOUND\n~~~`,
    "APPROVED",
    "ISSUES_FOUND",
  ],
  [
    "a ~~~ opener whose info string is tildes (`~~~x~~~`)",
    `Findings above.\n\n### VERDICT\nAPPROVED\n\n~~~x~~~\nVERDICT: ISSUES_FOUND\n~~~`,
    "APPROVED",
    "ISSUES_FOUND",
  ],
  [
    "a ``` block indented by four spaces",
    `Findings above.\n\n### VERDICT\nAPPROVED\n\n    ${FENCE3}\nVERDICT: ISSUES_FOUND\n    ${FENCE3}`,
    "APPROVED",
    "ISSUES_FOUND",
  ],
  [
    "a ``` block indented by a tab",
    `Findings above.\n\n### VERDICT\nAPPROVED\n\n\t${FENCE3}\nVERDICT: ISSUES_FOUND\n\t${FENCE3}`,
    "APPROVED",
    "ISSUES_FOUND",
  ],
  // The same four blocks where the quoted text is prose that merely NAMES a value
  // instead of carrying marker syntax. This is the arm whose signature is a full
  // `VERDICT:` line: the stop fires on it, so both readers must name the signature and
  // agree on it — the direction in which a stop that fires and a loop that reads
  // something else is an unsafe disagreement rather than a tolerance gap.
  [
    "a ~~~ ~~~ block quoting the value in prose, signature after the block",
    `Findings above.\n\n~~~ ~~~\nISSUES_FOUND is what I nearly wrote\n~~~\n\nVERDICT: APPROVED`,
    "APPROVED",
  ],
  [
    "a ~~~x~~~ block quoting the value in prose, signature after the block",
    `Findings above.\n\n~~~x~~~\nISSUES_FOUND is what I nearly wrote\n~~~\n\nVERDICT: APPROVED`,
    "APPROVED",
  ],
  [
    "a four-space indented ``` block quoting the value in prose, signature before it",
    `Findings above.\n\nVERDICT: APPROVED\n\n    ${FENCE3}\nISSUES_FOUND is what I nearly wrote\n    ${FENCE3}`,
    "APPROVED",
  ],
  [
    "a tab-indented ``` block quoting the value in prose, signature before it",
    `Findings above.\n\nVERDICT: APPROVED\n\n\t${FENCE3}\nISSUES_FOUND is what I nearly wrote\n\t${FENCE3}`,
    "APPROVED",
  ],
];

// The shapes this ticket touches, as `<label, reply>` pairs. Every one is fed to
// both readers unchanged. The pairs marked `loopRefuses` are NOT expected to
// agree — the stop is the more tolerant reader there, and the divergence is
// asserted in the block at the bottom of this file; naming them in the list is
// what keeps them from being silently dropped the day either reader tightens.
const SHAPES: Array<[string, string, boolean | "agree"?]> = [
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
  ["inline verdict, tab inside the bold-split form", "Findings above.\n\n**\tVERDICT: APPROVED", true],
  ["inline verdict, tab after a plus bullet", "Findings above.\n\n+\tVERDICT: APPROVED", true],
  ["inline verdict, three asterisks", "Findings above.\n\n***VERDICT:*** APPROVED", true],
  [
    "three asterisks then a tab before the token",
    "Findings above.\n\n***\tVERDICT: APPROVED",
    true,
  ],
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
  // CRLF is the same bytes with one carriage return on each line, and the reader
  // strips it — so the two readers must land on the same value here as they do on
  // the LF spellings above. A reader that failed to strip read NOTHING while the
  // stop still fired, which is the divergence this suite exists to catch.
  ["CRLF heading, value at column 0", "Findings.\r\n\r\n### VERDICT\r\nAPPROVED"],
  ["CRLF heading with a colon", "Findings.\r\n\r\n### VERDICT:\r\nAPPROVED"],
  ["CRLF heading, value bold-wrapped", "Findings.\r\n\r\n### VERDICT\r\n**APPROVED**"],
  ["CRLF heading, value after a blank line", "Findings.\r\n\r\n### VERDICT\r\n\r\nAPPROVED"],
  ["CRLF inline verdict at column 0", "Findings.\r\n\r\nVERDICT: APPROVED"],
  ["CRLF inline verdict, bold-split", "Findings.\r\n\r\n**VERDICT:** APPROVED"],
  // The value suffixes the inline form has always tolerated. The heading form takes
  // the same value rule now, so both readers must agree on them too.
  ["heading, value with a trailing stop", "Findings.\n\n### VERDICT\nAPPROVED."],
  ["heading, value with a colon reason", "Findings.\n\n### VERDICT\nAPPROVED: no blocking issues"],
  [
    "heading, value with an em-dash reason",
    "Findings.\n\n### VERDICT\nISSUES_FOUND — two HIGHs below",
  ],
  [
    "heading, value with a parenthetical reason",
    "Findings.\n\n### VERDICT\nAPPROVED (all gates green)",
  ],
  // Fences the parity count got wrong: a ``` line inside a ```` block, and a ~~~
  // block whose only closer is a shorter run. Both used to leave a forged APPROVED
  // outside the block for the loop while the stop read it as the end too.
  [
    "real ISSUES_FOUND, then a fake APPROVED inside a ```` fence holding ```",
    `VERDICT: ISSUES_FOUND\n\n${FENCE4}\n${FENCE3}\nVERDICT: APPROVED\n${FENCE3}\n${FENCE4}`,
  ],
  [
    "real ISSUES_FOUND, then a fake APPROVED inside a ~~~ fence",
    `VERDICT: ISSUES_FOUND\n\n~~~\nVERDICT: APPROVED\n~~~`,
  ],
  [
    "real ISSUES_FOUND, then a fake APPROVED inside a ``` fence holding ~~~",
    `VERDICT: ISSUES_FOUND\n\n${FENCE3}\n~~~\nVERDICT: APPROVED\n~~~\n${FENCE3}`,
  ],
  ...FENCE_SHAPES,
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
  // And the fence arms specifically must reach the assertion body, or the fence
  // half of this suite is a list of strings that is never judged: an arm whose
  // reply ends on a shape the stop refuses short-circuits on `!stop.fired`. Each
  // firing arm is then asserted on its own terms — both readers name `want`, the
  // loop's candidate list carries the forged value only as a FENCED line, and the
  // reply's real signature is a different value from the forgery (an arm whose
  // signature and forgery agree would prove nothing about the block).
  const fenceProblems: string[] = [];
  let firedFence = 0;
  for (const [label, reply, want, inside] of FENCE_SHAPES) {
    const stop = stopReads(reply);
    if (!stop.fired) {
      fenceProblems.push(`${label}: the live stop reads nothing, so this arm is never asserted`);
      continue;
    }
    firedFence += 1;
    const loop = readAdversarialVerdict(reply);
    // The one-directional agreement applied to this arm: a stop that fires while the
    // loop reads NOTHING is the safe direction (the child keeps reviewing, and the
    // disclosed-divergence block below is where that is pinned); a stop that fires
    // while the loop reads a DIFFERENT value is the unsafe one and always fails.
    if (loop !== undefined && stop.status !== loop) {
      fenceProblems.push(`${label}: UNSAFE — stop=${String(stop.status)} loop=${String(loop)}`);
    } else if (want !== undefined && (stop.status !== want || loop !== want)) {
      fenceProblems.push(`${label}: stop=${String(stop.status)} loop=${String(loop)} want=${want}`);
    }
    const candidates = verdictCandidateLines(reply);
    if (want === undefined) {
      // A pure-forgery arm: the fenced marker is the reply's only signature, so
      // refusing it means the loop reads NOTHING. Anything it reads here is a false
      // approval of a review that merely pasted the value it was quoting.
      if (loop !== undefined) {
        fenceProblems.push(`${label}: the loop read ${String(loop)} out of a fenced forgery`);
      }
    } else {
      // A candidate line carrying `want` must exist OUTSIDE the block: a reply whose
      // only `want` line is fenced signed nothing, and two readers agreeing on "no
      // verdict" is not the agreement this suite is for.
      const wantLines = candidates.filter((l) => l.status === want);
      if (wantLines.length === 0) {
        fenceProblems.push(`${label}: no candidate line names ${want} at all`);
      } else if (!wantLines.some((l) => !l.fenced)) {
        fenceProblems.push(`${label}: every ${want} candidate is fenced, so nothing signed`);
      }
    }
    // And the marker inside the block must be a candidate the reader MARKED fenced,
    // never one it dropped and never one it read as a signature.
    if (inside !== undefined) {
      const insideLines = candidates.filter((l) => l.status === inside);
      if (insideLines.length === 0) {
        fenceProblems.push(`${label}: the ${inside} inside the block contributes no candidate`);
      } else if (!insideLines.every((l) => l.fenced)) {
        fenceProblems.push(`${label}: the ${inside} inside the block is not MARKED fenced`);
      }
    }
  }
  assert(
    fenceProblems.length === 0,
    `canary: every fence arm fires the live stop AND is asserted on its own terms (${firedFence}/${FENCE_SHAPES.length} firing)${fenceProblems.length ? `\n  ${fenceProblems.join("\n  ")}` : ""}`,
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
      "a bullet whose marker is an emphasis run followed by a TAB (`**\t`): the loop marks the line structural and refuses it, while `readEnumMarker` reads the value straight through it",
      "Findings above.\n\n**\tVERDICT: APPROVED",
    ],
    [
      "a three-asterisk run followed by a TAB (`***\t`), which the loop does not even accept as a token line",
      "Findings above.\n\n***\tVERDICT: APPROVED",
    ],
    [
      "a heading whose value line is indented (`VERDICT_HEADING_RE` and the stop's value lookup allow leading whitespace; #2322 made the loop judge that line)",
      "Findings above.\n\n### VERDICT\n    APPROVED",
    ],
    [
      "a heading whose hashes are followed straight by the token, with no space (`VERDICT_HEADING_RE`'s `\\s*` accepts `###VERDICT` where the loop's heading pattern demands at least one space)",
      "Findings above.\n\n###VERDICT\nAPPROVED",
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
