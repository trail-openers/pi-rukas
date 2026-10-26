#!/usr/bin/env bun
/**
 * #1827 — the post-verdict stop, on one source of truth.
 *
 * The observed shape: an adversarial reviewer writes "verification complete,
 * writing the verdict", emits `VERDICT: APPROVED`, and then makes 200–300 more
 * tool calls (one reached 476 turns and 80M tokens). Prose and PM steers did not
 * stop it.
 *
 * The stop runs the SAME `readEnumMarker(text, "VERDICT", VERDICT_STATUSES)` the
 * consumer `parseVerdict` runs, over the ACCUMULATED assistant text — every text
 * block of every assistant message up to and including the one being examined.
 * That single rule is what keeps the live stop and the loop's final parse from
 * disagreeing, so this test asserts the equality directly rather than testing
 * the two separately.
 *
 * The false-stop risk is the reason the rule is the consumer's rule and not a
 * stricter one: the reviewer prompt hands the model a verbatim menu of the four
 * `VERDICT:` values, so a reply that QUOTES the menu must not end the child, and
 * a reviewer that puts its verdict in one block and its findings in the NEXT
 * must still be stopped (a last-block-only rule would miss it).
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import { VERDICT_STATUSES } from "../src/adversarial-verdict.ts";
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

// (2) a quoted menu line does not stop: `VERDICT: <APPROVED|...>` is not a
// value, and the reviewer prompt hands it that text verbatim.
{
  const s = createVerdictStop();
  assert(
    !s.observe(
      turn(
        "End your reply with exactly one line, one of:\n" +
          "VERDICT: <APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND|MINOR_OBSERVATIONS>\n" +
          "For example: **VERDICT: APPROVED**",
      ),
    ),
    "a quoted menu line (VERDICT: <APPROVED|...>) does not stop",
  );
  assert(s.status() === undefined, "and records no verdict");
  // …while the real marker in the same reply does.
  assert(s.observe(turn(text("VERDICT: ISSUES_FOUND"))), "the real marker in a later block stops");
  assert(
    s.status() === "ISSUES_FOUND",
    "the LAST parseable verdict wins, as parseVerdict reads it",
  );
  assert(
    parseVerdict(s.text()).status === "ISSUES_FOUND",
    "parseVerdict agrees with the live stop on a reply that quoted the menu",
  );
}

// (3) an unparseable marker never stops and never fabricates a verdict.
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
  // Contrast: the same value in the form the reader accepts DOES stop, so (3)
  // is not simply "nothing ever stops".
  assert(s.observe(turn(text("VERDICT: CRITICAL_ISSUES_FOUND"))), "the parseable form does stop");
  assert(s.status() === "CRITICAL_ISSUES_FOUND", "CRITICAL is recognised");
}

// (4) the verdict split across blocks is still caught — the case a
// last-block-only rule silently misses.
{
  const s = createVerdictStop();
  s.observe(turn(text("VERDICT: MINOR_OBSERVATIONS")));
  assert(s.status() === "MINOR_OBSERVATIONS", "the split verdict is read from the accumulation");
  assert(
    s.text().includes("VERDICT: MINOR_OBSERVATIONS"),
    "the block carrying the verdict is in the text handed to parseVerdict",
  );
  assert(
    parseVerdict(s.text()).status === "MINOR_OBSERVATIONS",
    "and parseVerdict reads the same value from it",
  );
}

// (5) an errored / aborted assistant turn never stops the child: it ran none of
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

// (6) the marker scan is a WINDOW, the result text is not.
//
// A 400-turn reviewer must not re-parse its whole reply on every `message_end`
// (quadratic in the exact child this bound exists to bound), so the scan reads
// the newest text plus a small look-back. What must NOT regress is the result:
// the accumulated reply is what `parseVerdict` reads, so a verdict the window
// saw is still the whole reply's verdict.
{
  const s = createVerdictStop();
  // Long prose first, so a scan of the whole accumulation and a scan of the
  // window differ in size — and a marker buried under the window must not be
  // found by the live stop.
  for (let i = 0; i < 40; i++) s.observe(turn(text(`Reviewing file ${i}. Still working.`)));
  assert(s.status() === undefined, "prose alone never stops");
  s.observe(turn(text("VERDICT: APPROVED")));
  assert(s.status() === "APPROVED", "the verdict in the newest block stops the child");
  assert(
    s.text().length > "VERDICT: APPROVED".length &&
      s.text().includes("Reviewing file 0.") &&
      s.text().includes("VERDICT: APPROVED"),
    "the RESULT is the whole accumulated reply, not the scanned window",
  );
  assert(
    parseVerdict(s.text()).status === "APPROVED",
    "parseVerdict over the full accumulation agrees with the windowed live stop",
  );
}

// (7) a tool-call-only turn — no text at all — does not re-scan the unchanged
// tail. This is the quadratic cost the window removes, pinned as behaviour.
{
  const s = createVerdictStop();
  s.observe(turn(text("Reading the diff.")));
  let scans = 0;
  const spy = createVerdictStop();
  for (let i = 0; i < 30; i++) {
    // Each of these adds no text: none of them may find a verdict that was
    // never written, and none of them re-parse what the last text turn left.
    spy.observe(turn(tool("bash", { command: `bun test ${i}` }, `t${i}`)));
    if (spy.status() !== undefined) scans++;
  }
  assert(scans === 0, "30 tool-call-only turns find no verdict and stop nothing");
  assert(s.status() === undefined, "…and a text turn without a marker does not either");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
