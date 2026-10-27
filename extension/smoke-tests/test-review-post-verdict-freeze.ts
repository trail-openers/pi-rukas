#!/usr/bin/env bun
/**
 * #1827 round 3 — the fold freezes the reply at the stop.
 *
 * The adversarial review of PR #1829 found two ways the live stop and the
 * loop's final parse could disagree:
 *
 *   1. the stop accepted a verdict out of the ACCUMULATED tail, so a reviewer
 *      that merely ECHOED the four-line menu its own brief contains — or quoted
 *      one example line inside a code fence — was ended at that turn with a
 *      fabricated verdict and the review was never performed;
 *   2. the fold replaced `result.text` with the accumulation only when the
 *      collapsed reply was empty or a placeholder, so on any other reply
 *      `parseVerdict(result.text)` read the collapse and could report a
 *      different status from the one that ended the child.
 *
 * Both are pinned here against the real objects: the menu is taken out of the
 * built reviewer prompt (so the prompt and this test cannot drift), and the
 * agreement assertion runs the real `applyReviewBounds` and `parseVerdict`.
 *
 * Companion: `test-review-post-verdict-result.ts` (the clean-end/consumer
 * sweep) and `test-review-post-verdict.ts` (the stop's block rules). Split for
 * the 500-line file cap.
 *
 * Offline: pure functions, one fake child handle. Nothing spawns.
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  createVerdictStop,
  observeReviewBounds,
  type ReviewBoundTargets,
} from "../src/review-bounds.ts";
import { applyReviewBounds } from "../src/spawn-review-bounds.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

let seq = 0;
/** A collapsed reply that contradicts the verdict the stop matched — the shape
 *  the freeze exists to override. */
const DISAGREE_HEAD = "Review complete.\n\nVERDICT: APPROVED\n\n(nothing to report)";
function text(t: string): PiContentBlock {
  return { type: "text", text: t };
}
function turn(...blocks: PiContentBlock[]): PiJsonEvent {
  return { type: "message_end", message: { role: "assistant", content: blocks } } as PiJsonEvent;
}
function baseResult(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-developer",
    ok: true,
    text: "VERDICT: APPROVED",
    toolUses: [],
    ms: 1000,
    exitCode: 0,
    ...over,
  } as DispatchResult;
}
function quietTargets(
  calls: string[],
  over: Partial<ReviewBoundTargets> = {},
): ReviewBoundTargets {
  return {
    writeSteer: () => undefined,
    kill: () => calls.push("kill"),
    completePrompt: () => calls.push("completePrompt"),
    armBound: () => calls.push("armBound"),
    setKillCause: (c) => calls.push(`cause:${String(c)}`),
    reported: () => false,
    boundArmed: () => false,
    willRetry: () => false,
    // Alive by default — every case that means otherwise passes `exited` in
    // `over`. The spread is LAST on purpose: an override that landed before a
    // default was silently shadowed by it, which is how a liveness case can
    // read green while judging a live child.
    exited: () => false,
    ...over,
  };
}
/** The four-line verdict menu, lifted out of the prompt the reviewer is actually
 *  sent — retyping it here would let the prompt and this test drift apart. */
function reviewerMenu(): string {
  const prompt = buildAdversarialPrompt({ diff: "+x", context: "c", round: 1, maxRounds: 3 });
  return prompt
    .split("\n")
    .filter((l) => /^\s+VERDICT: [A-Z_]+$/.test(l))
    .join("\n");
}

// ── (1) the CRITICAL: a reply that ECHOES THE BRIEF'S MENU ends nothing. The
// shared reader accepts the menu (its last match is CRITICAL_ISSUES_FOUND), so
// the stop used to fire on it and the review was never performed.
{
  const menu = reviewerMenu();
  assert(menu.split("\n").length === 4, "the reviewer brief carries the four-line menu");
  const calls: string[] = [];
  const stop = createVerdictStop();
  observeReviewBounds(
    { verdictStop: stop, assistantMessageEnd: turn(text(`I must end with one of:\n${menu}`)) },
    quietTargets(calls),
  );
  assert(calls.length === 0, "a menu-echoing message ends nothing and kills nothing");
  assert(stop.status() === undefined, "…and records no verdict");
  // A quoted example inside a fence is the same failure shape.
  const calls2: string[] = [];
  const stop2 = createVerdictStop();
  observeReviewBounds(
    {
      verdictStop: stop2,
      assistantMessageEnd: turn(text("For example:\n\n```text\n  VERDICT: APPROVED\n```")),
    },
    quietTargets(calls2),
  );
  assert(calls2.length === 0, "a fenced example verdict ends nothing");
  assert(stop2.status() === undefined, "…and records no verdict");
  // The child then keeps working, and the real verdict afterwards does stop it.
  const calls3: string[] = [];
  // A FRESH stop, because `stop2` above has already seen the fenced quotation
  // and a stop is sticky once it has decided: reusing it here would have judged
  // the earlier verdict rather than this one.
  const stop3 = createVerdictStop();
  observeReviewBounds(
    { verdictStop: stop3, assistantMessageEnd: turn(text("VERDICT: ISSUES_FOUND")) },
    quietTargets(calls3),
  );
  assert(
    calls3.join(",") === "armBound,completePrompt,kill",
    `the real verdict after the quotation still arms, closes stdin and kills (${calls3.join(",")})`,
  );
}

// ── (2) a message that made tool calls never ends the review, even when its
// last text block is a clean verdict.
{
  const calls: string[] = [];
  const stop = createVerdictStop();
  observeReviewBounds(
    {
      verdictStop: stop,
      assistantMessageEnd: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            text("Findings are in.\n\nVERDICT: ISSUES_FOUND"),
            { type: "toolCall", id: `c${seq++}`, name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
    } as unknown as { verdictStop: typeof stop; assistantMessageEnd: PiJsonEvent },
    quietTargets(calls),
  );
  assert(calls.length === 0, "a verdict in a message that also made a tool call ends nothing");
  assert(stop.status() === undefined, "…and records no verdict");
}

// ── (3) the fold freezes the reply: when the stop fired, `result.text` IS the
// frozen accumulation, so parseVerdict(result.text) cannot disagree with it.
{
  const DISAGREES = DISAGREE_HEAD;
  const cases: [string, string][] = [
    ["", "an empty collapse"],
    ["(no output)", "the no-output placeholder"],
    ["(thinking content only - no text output)", "the thinking-only placeholder"],
    // The CRITICAL of this section: a NON-empty collapsed reply whose own last
    // VERDICT line is a different value from the one that ended the child.
    [DISAGREES, "a collapsed reply carrying another verdict"],
  ];
  for (const [collapsed, label] of cases) {
    const fired = createVerdictStop();
    fired.observe(turn(text("Findings: the unbounded scan in observe().")));
    fired.observe(turn(text("VERDICT: ISSUES_FOUND")));
    fired.markEnded();
    const r = baseResult({ text: collapsed });
    applyReviewBounds(
      { stoppedByVerdict: true, verdictText: fired.text(), verdictStatus: fired.status() },
      r,
      () => undefined,
      () => undefined,
    );
    assert(
      r.text === fired.text() && r.reviewStopReason === REVIEW_POST_VERDICT_STOP,
      `a fired stop replaces ${label} with the frozen accumulation`,
    );
    assert(
      parseVerdict(r.text).status === fired.status() && fired.status() === "ISSUES_FOUND",
      `…so parseVerdict(result.text) equals the stop's status (${label})`,
    );
  }

  // An unfired stop (caps off, or a verdict nobody acted on) stamps nothing and
  // leaves the collapsed reply byte-for-byte alone.
  const parsed = createVerdictStop();
  parsed.observe(turn(text("VERDICT: APPROVED")));
  assert(parsed.status() === "APPROVED", "a parsed verdict is available to the fold");
  assert(parsed.stopped() === false, "…but the stop has not fired (nothing was ended)");
  const untouched = baseResult({ text: DISAGREES });
  const lines: string[] = [];
  applyReviewBounds(
    { stoppedByVerdict: false, verdictText: parsed.text(), verdictStatus: parsed.status() },
    untouched,
    (s) => lines.push(s),
    () => undefined,
  );
  assert(untouched.text === DISAGREES, "an unfired stop leaves the collapsed reply alone");
  assert(
    untouched.reviewStopReason === undefined,
    "…and stamps no reviewStopReason, no attribution line",
  );
  assert(lines.length === 0, "…and writes no stderr");

  // An empty accumulation cannot wipe the result — and it cannot record a clean
  // end either (#1827 round 5). A fired stop parses its verdict out of the
  // accumulation, so a status with a blank accumulation is a by-hand outcome:
  // stamping `ok: true` + `reviewStopReason` on it would call a review nobody can
  // show accepted, and would leave `result.text` as the collapse — the exact
  // two-readers-disagree split the freeze above exists to close. So the fold
  // warns once and touches nothing.
  const kept = baseResult({ text: "collapsed reply that already has the verdict" });
  const blankLines: string[] = [];
  const blankWarns: string[] = [];
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: "   ", verdictStatus: "APPROVED" },
    kept,
    (s) => blankLines.push(s),
    (s) => blankWarns.push(s),
  );
  assert(
    kept.text === "collapsed reply that already has the verdict",
    "a fired stop with nothing accumulated keeps the collapsed text",
  );
  assert(
    kept.reviewStopReason === undefined,
    "…but records no clean end (no reviewStopReason) for a blank reply",
  );
  assert(kept.ok === true, "…and leaves the result's own ok untouched");
  assert(blankWarns.length === 1, "…warns exactly once");
  assert(
    /APPROVED/.test(blankWarns[0] ?? "") && /blank reply/.test(blankWarns[0] ?? ""),
    `…and the warning names the accepted status and that the reply was blank (got: ${blankWarns[0]})`,
  );
  assert(blankLines.length === 0, "…and emits no stderr attribution line");
}

// ── (4) end to end: the real observe seam ends the child, the real fold writes
// the result, and the real parser reads the same status back.
{
  const calls: string[] = [];
  const stop = createVerdictStop();
  observeReviewBounds(
    {
      verdictStop: stop,
      assistantMessageEnd: turn(text("Two findings, then the line.\n\nVERDICT: ISSUES_FOUND")),
    },
    quietTargets(calls),
  );
  assert(stop.stopped() === true, "the stop reports itself as ended");
  const r = baseResult({ text: DISAGREE_HEAD });
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: stop.text(), verdictStatus: stop.status() },
    r,
    () => undefined,
    () => undefined,
  );
  assert(
    parseVerdict(r.text).status === stop.status() && stop.status() === "ISSUES_FOUND",
    "the status that ended the child is the status parseVerdict reads back",
  );
  assert(
    parseVerdict(r.text).findings.includes("Two findings"),
    "…and the findings the reviewer wrote reach the loop, not just the token",
  );
}

// ── (5) #1847 — the ONE liveness signal owns the stop too. `exited()` is the
// same seam the caps stack and the child bound read (spawn-support.ts
// `childHasExited`, ORing the kill flags set on `exit`/`close` with the
// handle's own `exitCode`/`signalCode`). A child whose process is gone cannot
// be ended by the stop: `markEnded` records an end that did not happen, the
// fold then stamps `ok: true` and a `reviewStopReason` on a result the spawn
// is already assembling from a dead stream, and `killProcessTree` on a reaped
// pid races whatever the exit path wrote. Silence is the right answer — no
// arm, no stdin close, no kill, and crucially NO `markEnded()`, which is the
// fold's single gate for stamping a clean end.
{
  const calls: string[] = [];
  const stop = createVerdictStop();
  const ev = turn(text("Two findings, then the line.\n\nVERDICT: ISSUES_FOUND"));
  observeReviewBounds(
    { verdictStop: stop, assistantMessageEnd: ev },
    quietTargets(calls, { exited: () => false }),
  );
  assert(
    calls.join(",") === "armBound,completePrompt,kill",
    `(5) control: while the child lives the stop arms, closes stdin and ends it (got ${calls.join(",")})`,
  );
  assert(stop.stopped() === true, "(5) control: and records the end the fold reads");

  const dead: string[] = [];
  const deadStop = createVerdictStop();
  observeReviewBounds(
    { verdictStop: deadStop, assistantMessageEnd: ev },
    quietTargets(dead, { exited: () => true }),
  );
  assert(
    dead.length === 0,
    `(5) an exited child is not completed or killed by the stop (got ${dead.join(",") || "nothing"})`,
  );
  assert(
    deadStop.stopped() === false,
    "(5) …and the fold's single gate stays shut, so no clean end is stamped on a dead child",
  );
  // The canary, run as a DIRECT `observe` on the same event rather than through
  // the gated seam: that proves the fixture is a verdict the stop accepts, so a
  // green pair above is "the liveness gate refused", never "the fixture matched
  // nothing". It cannot be read from `deadStop.status()` — the gate sits before
  // `observe` precisely so an exited child's message cannot latch the stop's
  // sticky flag or cost a live child its accumulation.
  // (With `PI_ENSEMBLE_DISPATCH_CAPS=0` the parse itself stands down — see
  // review-bounds-verdict-stop.ts — and that is a different seam, not this one.)
  const witness = createVerdictStop();
  witness.observe(ev);
  assert(
    witness.status() === "ISSUES_FOUND" && witness.stopped() === false,
    `(5) canary: the same event IS an accepted verdict when nothing gates it (status ${String(witness.status())})`,
  );

  const r = baseResult({ text: DISAGREE_HEAD });
  const warns: string[] = [];
  // The fold is asked with the stop's OWN record, exactly as the wiring hands it
  // (`spawn-review-bounds.ts` reads `verdictStop.stopped()`): the reason this
  // assertion matters is that `status()` is set while `stopped()` is not, so a
  // fold that keyed on the status alone would stamp a clean end here.
  applyReviewBounds(
    { stoppedByVerdict: deadStop.stopped(), verdictText: deadStop.text(), verdictStatus: deadStop.status() },
    r,
    () => undefined,
    (m) => warns.push(m),
  );
  assert(
    r.reviewStopReason === undefined && r.text === DISAGREE_HEAD && warns.length === 0,
    "(5) …so the fold leaves the collapsed reply and the result's own ok alone, untraced",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
