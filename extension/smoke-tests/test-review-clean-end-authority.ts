#!/usr/bin/env bun
/**
 * #1827 round 5 — who is allowed to record a CLEAN END.
 *
 * Two rules, both structural rather than another exemption:
 *
 *   1. `observeReviewBounds` does not stop a child once a KILLING bound has
 *      armed. The bound that armed first owns the end and already has its cause
 *      on the way; a clean end stamped over that kill reports a killed review as
 *      a completed one. Same seam the re-read kill checks (`SkillReadGuard
 *      .boundArmed()`), so the two bounds cannot both decide how one child ends.
 *   2. `applyReviewBounds` stamps `reviewStopReason` / `ok` / the frozen text
 *      ONLY where the outcome carries a recorded verdict status. The spawn's own
 *      path always has one (`markEnded()` and the status are set on the same
 *      branch), so their absence means an outcome a caller built by hand — and
 *      calling that a clean end would mark an unreviewed child accepted. It warns
 *      and leaves the result alone instead (warn-not-drop, as for a discarded
 *      re-read kill).
 *
 * Companion: `test-review-post-verdict-result.ts` (the consumer sweep, the
 * opt-in rules, the re-read seam). Split for the 500-line file cap (AGENTS.md
 * §12) — the sections were moved, not rewritten.
 *
 * Offline: pure functions. Nothing spawns.
 */

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

// ── (10) #1827 round 4/5 — the stop stands down when a KILLING bound has armed,
// and the fold refuses to stamp a clean end over a cause another pass wrote.
{
  // The fold: a result that already carries a kill cause is left exactly as it
  // is, and the discarded stop is traced (warn-not-drop, as for the re-read kill).
  const fired = createVerdictStop();
  fired.observe(turn(text("Findings, then the line.\n\nVERDICT: ISSUES_FOUND")));
  fired.markEnded();
  assert(fired.stopped() === true, "the stop records that it ended this child");
  const killed = baseResult({ ok: false, text: "collapsed reply", killCause: "child-bound" });
  const lines: string[] = [];
  const warned: string[] = [];
  applyReviewBounds(
    {
      stoppedByVerdict: true,
      verdictText: fired.text(),
      verdictStatus: fired.status(),
    },
    killed,
    (s) => lines.push(s),
    (s) => warned.push(s),
  );
  assert(killed.killCause === "child-bound", "an existing cause keeps the result");
  assert(killed.ok === false, "…and the child stays failed — the stop does not resurrect it");
  assert(
    killed.reviewStopReason === undefined,
    "…and no clean end is stamped on a killed child",
  );
  assert(killed.text === "collapsed reply", "…and the frozen text is not folded in");
  assert(lines.length === 0, "…and no attribution line is claimed for the stop");
  assert(warned.length === 1, "…and exactly one warning is traced");
  assert(
    /ISSUES_FOUND/.test(warned[0] ?? "") && /child-bound/.test(warned[0] ?? ""),
    `the warning names both the accepted verdict and the cause that won (got: ${warned[0]})`,
  );
  // The same fold with NO cause on the result is the clean end, so (10) is not
  // simply "the fold never stamps".
  const clean = baseResult({ text: "collapsed reply" });
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: fired.text(), verdictStatus: fired.status() },
    clean,
    () => undefined,
    () => undefined,
  );
  assert(
    clean.reviewStopReason === REVIEW_POST_VERDICT_STOP && clean.ok === true,
    "with no cause on the result the clean end is still stamped",
  );

  // The observe seam, on the same rule one level earlier: once a killing bound
  // has armed, the stop does not arm, close stdin or kill — and records no
  // verdict, so the fold has nothing to stamp even if it were reached.
  const stops = (over: Partial<ReviewBoundTargets>) => {
    const calls: string[] = [];
    const targets: ReviewBoundTargets = {
      writeSteer: () => undefined,
      kill: () => calls.push("kill"),
      completePrompt: () => calls.push("completePrompt"),
      armBound: () => calls.push("armBound"),
      setKillCause: (c) => calls.push(`cause:${String(c)}`),
      reported: () => false,
      boundArmed: () => false,
      willRetry: () => false,
    exited: () => false,
      ...over,
    };
    const stop = createVerdictStop();
    const ev = turn(text("VERDICT: ISSUES_FOUND"));
    observeReviewBounds({ verdictStop: stop, assistantMessageEnd: ev }, targets);
    return { calls, stop };
  };
  const armed = stops({ boundArmed: () => true });
  assert(
    armed.calls.length === 0,
    `no stop while a killing bound is armed (${armed.calls.join(",")})`,
  );
  assert(armed.stop.status() === undefined, "…and the stop records no verdict for that child");
  assert(armed.stop.stopped() === false, "…and never claims to have ended it");
  // Not-armed is the control: the same seam with nothing armed still ends the
  // child, so (10) is a stand-down rule and not a disabled stop.
  const free = stops({});
  assert(
    free.calls.join(",") === "armBound,completePrompt,kill",
    `with no bound armed the stop still ends the child (${free.calls.join(",")})`,
  );
  assert(free.stop.status() === "ISSUES_FOUND", "…and records the verdict it stopped on");
}

// ── (11) #1827 round 5 — the fold stamps a clean end ONLY where a verdict was
// actually recorded. `observeReviewBounds` sets `markEnded()` and the status on
// the same branch, so `stoppedByVerdict: true` with no status is an outcome a
// caller built by hand — and stamping `ok: true` + `reviewStopReason` there
// would call an unreviewed child accepted. Warn, and leave the collapsed reply
// and the result's own `ok` exactly as the spawn built them.
{
  const before = baseResult({ text: "collapsed reply from collapseEvents", ok: false });
  const lines: string[] = [];
  const warned: string[] = [];
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: "prose with no marker at all" },
    before,
    (s) => lines.push(s),
    (s) => warned.push(s),
  );
  assert(
    before.text === "collapsed reply from collapseEvents",
    "a stopped-by-verdict outcome with no recorded verdict does not replace the text",
  );
  assert(
    before.reviewStopReason === undefined,
    "…stamps no reviewStopReason, records no attribution line",
  );
  assert(before.ok === false, "…and does not resurrect `ok`");
  assert(lines.length === 0, "…and writes no stderr");
  assert(warned.length === 1, "…but traces the mismatch (warn-not-drop)");
  assert(
    /verdict status/.test(warned[0] ?? ""),
    `the warning names what is missing (got: ${warned[0]})`,
  );
  // The real path is unaffected: a stop that ended the child always carries its
  // status, and that is the clean end (pinned above); this pins only that its
  // ABSENCE is not a clean end.
}

console.log(`\nexit ${exit}`);
process.exit(exit);
