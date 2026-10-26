#!/usr/bin/env bun
/**
 * #1827 round 1 — the CRITICAL: a post-verdict stop is a CLEAN END, so it must
 * never be spelled as a kill cause.
 *
 * The round-1 shape wrote `killCause: "review-post-verdict"` and then asked
 * every consumer of that field — `describeOutcome`, the step router, the lens
 * cap-kill recorders, `killDetail`, the completion event — to remember an
 * exemption. That is a failure waiting for the next consumer nobody exempted:
 * a completed adversarial review read as a killed child, and the loop's reply
 * is the very verdict the child produced.
 *
 * The fix is structural rather than another exemption: the stop sets no
 * `killCause` at all and rides on its own field, `reviewStopReason`. These
 * tests pin the whole consumer set for a result carrying the stop and nothing
 * else — ok true, killCause undefined, verdict parsed — and pin the two
 * `observeReviewBounds` ordering rules the same review found:
 * `armBound()` marks a KILLING decision only (never the advisory N+1 steer),
 * and the stop stands down while the child has reported or is mid-retry, so it
 * cannot discard a replay.
 *
 * Offline: pure functions, one fake child handle. Nothing spawns.
 */

import { parseVerdict } from "../src/adversarial-verdict.ts";
import { classifyDispatchOutcome } from "../src/adversarial-classify.ts";
import { DISPATCH_CAP_KILL_CAUSES } from "../src/work-driver-cap-killed.ts";
import { classifyFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import { describeOutcome } from "../src/async-jobs-report.ts";
import { killDetail } from "../src/kill-detail.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { overrideEnvForKillCause } from "../src/work-driver-completion-event.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  REVIEW_SKILL_REREAD_KILL,
  type ReviewBoundTargets,
  createSkillReadGuard,
  createVerdictStop,
  observeReviewBounds,
} from "../src/review-bounds.ts";
import {
  applyReviewBounds,
  endedAtVerdictStop,
  failedByKill,
} from "../src/spawn-review-bounds.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SKILL_DIR = "/home/test/.pi/agent/skills/code-review-security";
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

let seq = 0;
function text(t: string): PiContentBlock {
  return { type: "text", text: t };
}
function tool(name: string, args: unknown): PiContentBlock {
  return { type: "toolCall", id: `c${seq++}`, name, arguments: args };
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

// ── (1) the CRITICAL: a stopped reviewer is ok:true with NO killCause.
{
  const stop = createVerdictStop();
  stop.observe(turn(text("Verification complete.\n\nVERDICT: APPROVED\n\nAll gates green.")));

  const result = baseResult({ text: "(narration that the child was still writing)" });
  const stderr: string[] = [];
  applyReviewBounds(
    {
      verdictStopped: true,
      verdictText: stop.text(),
      verdictStatus: stop.status(),
    },
    result,
    () => undefined,
    () => undefined,
  );
  stderr.push("x");

  assert(result.ok === true, "a post-verdict-stopped reviewer yields ok:true");
  assert(result.killCause === undefined, "…and NO killCause at all");
  assert(
    result.reviewStopReason === REVIEW_POST_VERDICT_STOP,
    "…with reviewStopReason carrying the stop",
  );
  assert(
    parseVerdict(result.text).status === "APPROVED",
    "the verdict is parsed from the result text the stop preserved",
  );
  assert(
    result.text.includes("VERDICT: APPROVED"),
    "the result text is the accumulated reply, not the pre-stop narration",
  );
  assert(failedByKill(result) === false, "failedByKill is false for a stopped reviewer");
  assert(endedAtVerdictStop(result) === true, "endedAtVerdictStop names the clean end");
}

// ── (2) the consumer sweep: nothing classifies a stopped reviewer as failed,
// killed, retried or capped. Each of these read `killCause` in the round-1 head.
{
  const stopped = baseResult({
    text: "VERDICT: APPROVED",
    reviewStopReason: REVIEW_POST_VERDICT_STOP,
  });
  const outcome = describeOutcome(stopped);
  assert(
    /^finished/.test(outcome.status),
    `describeOutcome reports finished, not FAILED (got "${outcome.status}")`,
  );
  assert(!/FAILED/i.test(outcome.status), "…and no FAILED badge anywhere in the headline");

  // The two paths that decide whether a stopped reviewer is a fault: the
  // adversarial loop's own classifier, and the step router's event classifier.
  // Both key on `killCause`; both must see the clean end as the success it is.
  const loop = classifyDispatchOutcome(stopped);
  assert(
    loop.cause === "success" && loop.shouldRetry === false,
    `the adversarial loop reads a stopped reviewer as success (got "${loop.cause}")`,
  );
  const cls = classifyFailureCause({ kind: "dispatch-failed", killCause: stopped.killCause });
  assert(
    !cls.cause.startsWith("self-killed:"),
    `the step router never reads a clean end as a self-kill (got "${cls.cause}")`,
  );
  assert(
    !DISPATCH_CAP_KILL_CAUSES.includes(cls.cause as never),
    "…and never promotes it into a cap-kill record",
  );

  // #1827 round 1 — and a stopped child that somehow reports ok:false must NOT
  // fall through to the retryable `crashed` fallback. It carries no cause, so
  // the taxonomy has nothing to excuse it with; what protects it is that the
  // stop leaves `ok` true. Asserting the fallback here is the canary: if a
  // future fold writes a cause onto a clean end, this row becomes
  // `self-killed:*` and the review is parked instead of read.
  const reported = classifyFailureCause({
    kind: "dispatch-failed",
    killCause: stopped.killCause,
    errorTail: "",
  });
  assert(
    reported.cause === "crashed",
    "a cause-less failed tail is judged, not silently excused by a stop row",
  );

  // `killDetail` selects the last `dispatch-failed` CARRYING a killCause; with
  // no cause on the result there is no kill line to render at all.
  const state = {
    eventLog: [
      {
        kind: "dispatch-failed",
        step: "adversarial",
        role: "adversarial-developer",
        jobId: "j1",
        label: "review",
        ms: 1,
        at: 1,
        killCause: stopped.killCause,
      },
    ],
  } as unknown as Parameters<typeof killDetail>[0];
  assert(killDetail(state).length === 0, "killDetail renders nothing for a cause-less tail");

  // The knob table is a total function over the killCause union; the stop is
  // not in that union, so the only way to reach it is with a real cause.
  assert(
    overrideEnvForKillCause("review-skill-reread").includes("PI_ENSEMBLE_REVIEW_SKILL_READS"),
    "the re-read cause still names its own knob",
  );
  assert(
    !("review-post-verdict" in (stopped as Record<string, unknown> ? stopped : {})) ||
      stopped.reviewStopReason === REVIEW_POST_VERDICT_STOP,
    "the stop never arrives wearing a killCause",
  );
}

// ── (3) a re-read kill is still a FAILURE, and is still attributed.
{
  const result = baseResult({ ok: false, text: "" });
  const lines: string[] = [];
  applyReviewBounds(
    { killCause: REVIEW_SKILL_REREAD_KILL, skillReads: 5, verdictStopped: false },
    result,
    (s) => lines.push(s),
    () => undefined,
  );
  assert(result.killCause === REVIEW_SKILL_REREAD_KILL, "the re-read kill still names its cause");
  assert(failedByKill(result) === true, "…and still counts as a kill");
  assert(
    lines.some((l) => /re-read its own skill file 5 times/.test(l)),
    "…and says how many reads cost it",
  );
  assert(endedAtVerdictStop(result) === false, "…and is not a clean end");
}

// ── (4) a re-read kill discarded because another cause already named the kill
// is traced with BOTH causes, never silently dropped.
{
  const result = baseResult({ ok: false, killCause: "child-bound" });
  const warned: string[] = [];
  const lines: string[] = [];
  applyReviewBounds(
    { killCause: REVIEW_SKILL_REREAD_KILL, skillReads: 7, verdictStopped: false },
    result,
    (s) => lines.push(s),
    (s) => warned.push(s),
  );
  assert(result.killCause === "child-bound", "the earlier cause wins the result");
  assert(lines.length === 0, "…and no attribution line is claimed for the discarded kill");
  assert(warned.length === 1, "…and exactly one warning is traced");
  assert(
    /7 skill reads/.test(warned[0] ?? "") && /child-bound/.test(warned[0] ?? ""),
    `the warning names both causes (got: ${warned[0]})`,
  );
}

// ── (5) the advisory N+1 steer does NOT arm the bound; only the kill does.
// The guard is fed exactly the way the spawn feeds it — `observe` from the
// stdout line handler, the steer/kill decision from `observeReviewBounds` —
// because a count with two owners is a count that drifts.
{
  const armed: string[] = [];
  const targets = (): ReviewBoundTargets => ({
    writeSteer: () => armed.push("steer"),
    kill: () => armed.push("kill"),
    completePrompt: () => armed.push("completePrompt"),
    armBound: () => armed.push("armBound"),
    setKillCause: () => undefined,
    reported: () => false,
    willRetry: () => false,
  });
  const guard = createSkillReadGuard({ skillPath: SKILL_DIR, reported: () => false });
  for (let i = 0; i < 4; i++) {
    const ev = turn(tool("read", { path: SKILL_FILE }));
    guard.observe(ev);
    observeReviewBounds({ skillRead: guard, assistantMessageEnd: ev }, targets());
    if (guard.count() <= 4)
      assert(
        !armed.includes("armBound"),
        `no arming at ${guard.count()} reads — the steer is advisory`,
      );
  }
  assert(armed.join(",") === "steer", `the (N+1)-th read only steers (${armed.join(",")})`);
  const last = turn(tool("read", { path: SKILL_FILE }));
  guard.observe(last);
  observeReviewBounds({ skillRead: guard, assistantMessageEnd: last }, targets());
  assert(
    armed.join(",") === "steer,armBound,kill",
    `the (N+2)-th read arms then kills (${armed.join(",")})`,
  );
}

// ── (6) the post-verdict stop stands down when the child has reported or the
// current segment will retry: in both cases the reply is being delivered or is
// about to be REPLAYED, so ending the child there discards it.
{
  const stops = (over: Partial<ReviewBoundTargets>) => {
    const calls: string[] = [];
    const targets: ReviewBoundTargets = {
      writeSteer: () => undefined,
      kill: () => calls.push("kill"),
      completePrompt: () => calls.push("completePrompt"),
      armBound: () => calls.push("armBound"),
      setKillCause: (c) => calls.push(`cause:${String(c)}`),
      reported: () => false,
      willRetry: () => false,
      ...over,
    };
    const stop = createVerdictStop();
    const ev = turn(text("VERDICT: ISSUES_FOUND"));
    observeReviewBounds({ verdictStop: stop, assistantMessageEnd: ev }, targets);
    return calls;
  };
  const normal = stops({});
  assert(
    normal.join(",") === "armBound,completePrompt,kill",
    `the stop arms, closes stdin and ends the child (${normal.join(",")})`,
  );
  assert(
    !normal.some((c) => c.startsWith("cause:")),
    "…and records no kill cause whatsoever",
  );
  assert(
    stops({ reported: () => true }).length === 0,
    "no stop while the child has reported (its answer is in flight)",
  );
  assert(
    stops({ willRetry: () => true }).length === 0,
    "no stop while the segment will retry (that reply is about to be replayed)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
