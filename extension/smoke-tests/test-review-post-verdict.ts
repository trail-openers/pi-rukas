#!/usr/bin/env bun
/**
 * #1827 — the post-verdict stop, and what may (and may not) fire it.
 *
 * The observed shape: an adversarial reviewer writes "verification complete,
 * writing the verdict", emits `VERDICT: APPROVED`, and then makes 200–300 more
 * tool calls (one reached 476 turns and 80M tokens). Prose and PM steers did not
 * stop it.
 *
 * The rule (round 3): the stop reads the FINAL text block of a TOOL-FREE
 * assistant message — not "the accumulated text". Concretely it stops only when
 * the message in hand (a) contains no `toolCall` block, (b) carries the marker
 * in its LAST non-empty text block, (c) names exactly ONE distinct value of
 * `VERDICT_STATUSES` in that block, and (d) matches on a line outside any fenced
 * code block. When it fires, the fold sets the result text to the whole
 * accumulation, so `parseVerdict(result.text).status` equals the stop's status
 * — that equality is asserted here on the real objects rather than tested as two
 * separate properties.
 *
 * Why the rule is narrow and not just "the consumer's reader over a tail": the
 * reviewer's own brief hands the model a verbatim four-line menu of every
 * verdict value, and the shared reader takes the LAST match. A reply that echoes
 * the menu, or quotes one example inside a fence, was ended at that turn with a
 * verdict it never issued and the review was never performed — the CRITICAL the
 * adversarial review reproduced end to end. A verdict at the end of one block
 * with the findings in an earlier block of the SAME message still stops, because
 * only the closing block is judged, not the whole reply.
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import { VERDICT_STATUSES } from "../src/adversarial-verdict.ts";
import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { readEnumMarker } from "../src/reply-markers.ts";
import { createVerdictStop } from "../src/review-bounds.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function text(t: string): PiContentBlock {
  return { type: "text", text: t };
}
function tool(name: string, args: unknown, id: string): PiContentBlock {
  return { type: "toolCall", id, name, arguments: args };
}
function turn(...blocks: PiContentBlock[]): PiJsonEvent {
  return { type: "message_end", message: { role: "assistant", content: blocks } } as PiJsonEvent;
}
/** A message whose LAST text block is `last` — earlier blocks prove the reader
 *  reads the closing block and not the message's whole text. */
function turnEndingWith(first: string, last: string): PiJsonEvent {
  return turn(text(first), text(last));
}

// The four-line menu the reviewer's brief really contains, taken out of the
// built prompt rather than retyped, so the prompt and this test cannot drift.
const MENU = (() => {
  const prompt = buildAdversarialPrompt({
    diff: "+const x = 1;",
    context: "test",
    round: 1,
    maxRounds: 3,
  });
  const lines = prompt
    .split("\n")
    .filter((l) => /^\s+VERDICT: [A-Z_]+$/.test(l))
    .map((l) => l.trim());
  return lines;
})();

// (1) the tail is cut: the verdict stops the child at that message.
{
  const s = createVerdictStop();
  assert(!s.observe(turn(text("Reading the diff now."))), "prose without a verdict does not stop");
  assert(
    !s.observe(
      turn(text("Checking the error handling…"), tool("bash", { command: "bun test" }, "t1")),
    ),
    "a turn with tool calls and no verdict does not stop",
  );
  assert(
    s.observe(turn(text("Verification complete.\n\nVERDICT: APPROVED\n\nAll gates are green."))),
    "a parseable VERDICT stops the child at that message",
  );
  assert(s.status() === "APPROVED", "the parsed verdict is the one the reviewer wrote");
  // Once stopped it stays stopped: the caller ends the child, and any late
  // event must not re-open the decision.
  assert(s.observe(turn(text("more work"))), "the stop is sticky");
  // The text handed to parseVerdict is the accumulated text — so the loop's
  // parse and the live stop cannot report different verdicts.
  assert(
    parseVerdict(s.text()).status === "APPROVED",
    "parseVerdict on the result equals the live parse (one source of truth)",
  );
  assert(
    readEnumMarker(s.text(), "VERDICT", VERDICT_STATUSES) === s.status(),
    "the stop's status IS readEnumMarker over the same string",
  );
}

// (2) THE MENU: a reply that recites the reviewer brief's four-line menu does
// not stop. This is the reproduced CRITICAL — the shared reader accepts the
// menu (its last match is CRITICAL_ISSUES_FOUND), so a menu-echoing child used
// to be ended at that turn with a verdict it never issued.
{
  assert(MENU.length === 4, `the built prompt carries the four-line menu (${MENU.length})`);
  const s = createVerdictStop();
  assert(
    !s.observe(turn(text(MENU.join("\n")))),
    "the VERBATIM menu from the reviewer brief does not stop",
  );
  assert(s.status() === undefined, "…and records no verdict");
  // Every line of it individually is a valid marker to the shared reader — so
  // (2) is a property of the STOP's rule, not of the reader failing.
  const each = MENU.map((line) => readEnumMarker(line, "VERDICT", VERDICT_STATUSES));
  assert(
    each.every((v, i) => v === VERDICT_STATUSES.find((x) => x === v)),
    `the shared reader accepts each menu line on its own (${each.join(",")})`,
  );
  const s2 = createVerdictStop();
  assert(
    !s2.observe(
      turn(
        text(
          "End your reply with exactly one line, one of:\n" +
            "VERDICT: <APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND|MINOR_OBSERVATIONS>\n" +
            "For example: **VERDICT: APPROVED**",
        ),
      ),
    ),
    "a quoted template plus one example line does not stop",
  );
  // …while the real marker in a LATER message does.
  assert(
    s2.observe(turn(text("VERDICT: ISSUES_FOUND"))),
    "the real marker in a later message stops",
  );
  assert(s2.status() === "ISSUES_FOUND", "…with the value the reviewer actually wrote");
  assert(
    parseVerdict(s2.text()).status === "ISSUES_FOUND",
    "parseVerdict agrees with the live stop on a reply that quoted the menu",
  );
}

// (3) THE FENCE: a verdict inside a fenced code block is an example, not a
// closing verdict — and the turns after it keep running.
{
  const fenced = ["```text", "  VERDICT: APPROVED", "```"].join("\n");
  const s = createVerdictStop();
  assert(!s.observe(turn(text(fenced))), "a verdict inside a fenced block does not stop");
  assert(s.status() === undefined, "…and records no verdict");
  assert(
    !s.observe(turn(text("Continuing with the security lens."))),
    "…and the child keeps reviewing afterwards",
  );
  assert(s.status() === undefined, "no verdict after more prose turns");
  // A fence that CLOSES, followed by the real verdict outside it, does stop:
  // the block is judged as a whole, and this one ends on an unfenced line.
  const s2 = createVerdictStop();
  assert(
    s2.observe(
      turn(text(`The diff adds:\n\n\`\`\`ts\nconst ok = true;\n\`\`\`\n\nVERDICT: APPROVED`)),
    ),
    "a verdict after a CLOSED fence in the same block stops",
  );
  assert(s2.status() === "APPROVED", "…with the value outside the fence");
  // An unbalanced fence (we cannot count it) is not evidence of a verdict.
  const s3 = createVerdictStop();
  assert(
    !s3.observe(turn(text("Reporting the shapes I saw:\n\n```json\nVERDICT: APPROVED"))),
    "a verdict under an unclosed fence does not stop",
  );
}

// (4) A TOOL CALL anywhere in the message means the turn is still at work, even
// when the text does carry a clean verdict.
{
  const s = createVerdictStop();
  assert(
    !s.observe(
      turn(
        text("Findings are in. I will report.\n\nVERDICT: ISSUES_FOUND"),
        tool("bash", { command: "bun run check" }, "t9"),
      ),
    ),
    "a message whose last text block is a verdict but which also contains a toolCall does not stop",
  );
  assert(s.status() === undefined, "…and records no verdict");
  // The tool result comes back, and now the same verdict in a tool-free message
  // is the ending.
  assert(s.observe(turn(text("VERDICT: ISSUES_FOUND"))), "the same verdict tool-free does stop");
  assert(s.status() === "ISSUES_FOUND", "…and records ISSUES_FOUND");
  assert(
    parseVerdict(s.text()).status === "ISSUES_FOUND",
    "parseVerdict on the accumulation matches the stop",
  );
}

// (5) only the LAST non-empty text block is read.
{
  // Verdict in an earlier block of the same message, closing prose after it:
  // the message is still mid-report, so no stop.
  const s = createVerdictStop();
  assert(
    !s.observe(turnEndingWith("VERDICT: APPROVED", "…and that is why the third hunk matters.")),
    "a verdict in an earlier text block does not stop",
  );
  assert(s.status() === undefined, "…and records no verdict");
  // The reverse does stop: findings first, verdict LAST. This is the split shape
  // an earlier-block rule would have to catch by accident.
  const s2 = createVerdictStop();
  assert(
    s2.observe(
      turnEndingWith(
        "Two findings: the unbounded read in observe(), and the missing fence check.",
        "VERDICT: MINOR_OBSERVATIONS",
      ),
    ),
    "a message whose last text block is the verdict stops, with findings above it",
  );
  assert(s2.status() === "MINOR_OBSERVATIONS", "…with the value in the closing block");
  assert(
    s2.text().includes("unbounded read"),
    "the earlier block is still in the reply handed to parseVerdict",
  );
}

// (6) exactly ONE distinct value. Weighing two verdicts is not choosing one.
{
  const s = createVerdictStop();
  assert(
    !s.observe(
      turn(text("This is not an APPROVED — the unbounded loop is real, so ISSUES_FOUND.")),
    ),
    "a closing block that weighs two verdicts does not stop",
  );
  assert(s.status() === undefined, "…and records no verdict");
  const s2 = createVerdictStop();
  assert(s2.observe(turn(text("VERDICT: ISSUES_FOUND"))), "one value does stop");
}

// (7) an unparseable marker never stops and never fabricates a verdict.
{
  const s = createVerdictStop();
  assert(
    !s.observe(turn(text("I will output VERDICT: DONE once the gates finish."))),
    "an out-of-enum VERDICT value does not stop",
  );
  assert(
    !s.observe(turn(text("VERDICT pending until I read the tests"))),
    "a bare VERDICT does not stop",
  );
  assert(s.status() === undefined, "no verdict recorded for an unparseable marker");
  assert(
    !s.observe(turn(text("The reviewer may write VERDICT — CRITICAL_ISSUES_FOUND (em-dash form)"))),
    "the em-dash form the tolerant reader does not match does not stop",
  );
  // Contrast: the same value in the form the reader accepts DOES stop, so (7)
  // is not simply "nothing ever stops".
  assert(s.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND"))), "the parseable form does stop");
  assert(s.status() === "CRITICAL_ISSUES_FOUND", "CRITICAL is recognised");
  // Emphasis and the heading form still work — the tolerant reader is still the
  // reader, the narrowing is about WHICH block, not how it is spelled.
  const bold = createVerdictStop();
  assert(bold.observe(turn(text("**VERDICT: APPROVED**"))), "the bold inline form stops");
  const head = createVerdictStop();
  assert(head.observe(turn(text("### VERDICT\n\nAPPROVED"))), "the heading form stops");
}

// (8) an errored / aborted assistant turn never stops the child: it ran none of
// its tool calls, so its text is not an answer.
{
  const s = createVerdictStop();
  assert(
    !s.observe({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        content: [text("VERDICT: APPROVED")],
      },
    } as PiJsonEvent),
    "an errored assistant message never triggers the stop",
  );
  assert(s.status() === undefined, "…and contributes no verdict");
  const a = createVerdictStop();
  assert(
    !a.observe({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [text("VERDICT: APPROVED")],
      },
    } as PiJsonEvent),
    "an aborted assistant message never triggers the stop",
  );
  // A user/toolResult message is not the reviewer's reply either.
  const u = createVerdictStop();
  assert(
    !u.observe({
      type: "message_end",
      message: { role: "user", content: [text("VERDICT: APPROVED")] },
    } as PiJsonEvent),
    "a non-assistant message never triggers the stop",
  );
}

// (9) the result is the WHOLE accumulation, not the block that carried the
// marker — the fold sets `result.text` to it, so the findings reach the loop.
{
  const s = createVerdictStop();
  for (let i = 0; i < 40; i++) s.observe(turn(text(`Reviewing file ${i}. Still working.`)));
  assert(s.status() === undefined, "prose alone never stops");
  s.observe(turn(text("VERDICT: APPROVED")));
  assert(s.status() === "APPROVED", "the verdict in a closing block stops the child");
  assert(
    s.text().includes("Reviewing file 0.") && s.text().includes("VERDICT: APPROVED"),
    "the RESULT is the whole accumulated reply, not the scanned block",
  );
  assert(
    parseVerdict(s.text()).status === "APPROVED",
    "parseVerdict over the full accumulation agrees with the stop",
  );
}

// (10) a tool-call-only turn carries no verdict and changes nothing — and no
// marker from an EARLIER message can be "found" by a later tool-free turn
// (there is no cross-message window any more).
{
  const spy = createVerdictStop();
  for (let i = 0; i < 30; i++)
    spy.observe(turn(tool("bash", { command: `bun test ${i}` }, `t${i}`)));
  assert(spy.status() === undefined, "30 tool-call-only turns find no verdict and stop nothing");
  const s = createVerdictStop();
  // A verdict-looking line in an earlier message that was REFUSED (it named two
  // values) must not resurface as the stop of a later, innocent message.
  s.observe(turn(text("Comparing APPROVED with ISSUES_FOUND here is hard.")));
  s.observe(turn(text("Re-reading the fence logic.")));
  assert(s.status() === undefined, "a refused marker does not stop a later message either");
}

// (11) the master switch: with `PI_ENSEMBLE_DISPATCH_CAPS=0` the stop never
// ends the child — but the accumulated reply is still the result, because the
// accumulator is the report and the cap governs only the KILL.
{
  const saved = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  const s = createVerdictStop();
  assert(
    !s.observe(turn(text("VERDICT: APPROVED"))),
    "PI_ENSEMBLE_DISPATCH_CAPS=0: the verdict does not stop the child",
  );
  assert(s.status() === undefined, "…records no verdict…");
  assert(
    parseVerdict(s.text()).status === "APPROVED",
    "…yet still accumulates the reply the loop will parse",
  );
  if (saved === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  else process.env.PI_ENSEMBLE_DISPATCH_CAPS = saved;
  // …and with the caps back on the same reply DOES stop it, so (11) is not just
  // "nothing ever stops".
  const on = createVerdictStop();
  assert(on.observe(turn(text("VERDICT: APPROVED"))), "with the caps on, it stops again");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
