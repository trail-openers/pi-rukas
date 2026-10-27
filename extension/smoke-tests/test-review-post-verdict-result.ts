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
import { describeOutcome, formatSingleReport } from "../src/async-jobs-report.ts";
import { killDetail } from "../src/kill-detail.ts";
import { NO_TEXT_PLACEHOLDER } from "../src/lens-review-incomplete.ts";
import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { overrideEnvForKillCause } from "../src/work-driver-completion-event.ts";
import {
  REVIEW_POST_VERDICT_STOP,
  REVIEW_SKILL_REREAD_KILL,
  type ReviewBoundTargets,
  createReviewBounds,
  createSkillReadGuard,
  createVerdictStop,
  observeReviewBounds,
} from "../src/review-bounds.ts";
import { applyReviewBounds, endedAtVerdictStop, failedByKill } from "../src/spawn-review-bounds.ts";
import type { VerdictStatus } from "../src/review-bounds-verdict.ts";
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

  // The collapsed reply is the placeholder `collapseEvents` stamps for a child
  // that produced no text — one of the forms the frozen accumulation replaces.
  const result = baseResult({ text: NO_TEXT_PLACEHOLDER });
  applyReviewBounds(
    {
      stoppedByVerdict: true,
      verdictText: stop.text(),
      verdictStatus: stop.status(),
    },
    result,
    () => undefined,
    () => undefined,
  );

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
    "the result text is the accumulated reply, replacing the no-output placeholder",
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
    `describeOutcome reports a clean end, not FAILED (got "${outcome.status}")`,
  );
  assert(!/FAILED/i.test(outcome.status), "…and no FAILED badge anywhere in the headline");
  // #1827 round 2 — the clean end has a reader: the report line NAMES the stop,
  // so an operator can tell a reviewer stopped at its verdict from one that ran
  // its natural tail. Same headline on the batch path (same `describeOutcome`).
  assert(
    outcome.status.includes("stopped after its verdict"),
    `…and the report line names it (got "${outcome.status}")`,
  );
  assert(
    describeOutcome(baseResult()).status === "finished",
    "an ordinary finished child keeps the plain headline",
  );
  const killedThenStopped = baseResult({
    ok: false,
    killCause: "loop",
    reviewStopReason: REVIEW_POST_VERDICT_STOP,
  });
  assert(
    describeOutcome(killedThenStopped).status.includes("loop"),
    "…and a kill cause another pass named still outranks the clean end in the headline",
  );
  assert(
    formatSingleReport("j1", "adversarial-developer", stopped).includes(
      "stopped after its verdict",
    ),
    "the single-dispatch report line carries the stop headline",
  );

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
  assert(stopped.killCause === undefined, "the stop never arrives wearing a killCause");
}

// ── (3) a re-read kill is still a FAILURE, and is still attributed.
{
  const result = baseResult({ ok: false, text: "" });
  const lines: string[] = [];
  applyReviewBounds(
    { killCause: REVIEW_SKILL_REREAD_KILL, skillReads: 5, stoppedByVerdict: false },
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
    { killCause: REVIEW_SKILL_REREAD_KILL, skillReads: 7, stoppedByVerdict: false },
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
    boundArmed: () => false,
    willRetry: () => false,
    exited: () => false,
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
// about to be REPLAYED, so ending the child there discards it. What the stop
// accepts, and what the fold freezes when it fires, is pinned in
// test-review-post-verdict-freeze.ts (the file-size split).
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
      boundArmed: () => false,
      willRetry: () => false,
      exited: () => false,
      ...over,
    };
    const stop = createVerdictStop();
    const ev = turn(text("VERDICT: ISSUES_FOUND"));
    observeReviewBounds({ verdictStop: stop, assistantMessageEnd: ev }, targets);
    return calls;
  };
  const normal = stops({});
  // `markStopped` sits with the kill, not with the parse: it is what the fold
  // reads a clean end from, so it is recorded only on the branch that ends the
  // child (the fold's own gate is pinned in
  // test-review-post-verdict-freeze.ts).
  assert(
    normal.join(",") === "armBound,completePrompt,kill",
    `the stop records the end, then arms, closes stdin and kills (${normal.join(",")})`,
  );
  assert(!normal.some((c) => c.startsWith("cause:")), "…and records no kill cause whatsoever");
  assert(
    stops({ reported: () => true }).length === 0,
    "no stop while the child has reported (its answer is in flight)",
  );
  assert(
    stops({ willRetry: () => true }).length === 0,
    "no stop while the segment will retry (that reply is about to be replayed)",
  );
  // #1827 round 5 — and no stop once a KILLING bound has armed. Same seam the
  // re-read kill checks (section (8)): the bound that armed first owns the
  // child's end, and a clean end stamped over its kill would report a killed
  // review as a completed one. The stop records no verdict either, so the fold
  // cannot stamp anything from a child it never ended.
  const armedCalls = stops({ boundArmed: () => true });
  assert(
    armedCalls.length === 0,
    `no stop while a killing bound is armed (${armedCalls.join(",")})`,
  );
}

// ── (8) #1827 round 2 — the re-read kill stands down once a KILLING bound has
// armed: a caps kill is already in flight with its own (more specific) cause,
// and ending the child here would overwrite it. The steer still fires — it is
// advisory and the caps' bound is not a bound that wants silence.
{
  const armed: string[] = [];
  const targets = (): ReviewBoundTargets => ({
    writeSteer: () => armed.push("steer"),
    kill: () => armed.push("kill"),
    completePrompt: () => armed.push("completePrompt"),
    armBound: () => armed.push("armBound"),
    setKillCause: () => undefined,
    reported: () => false,
    boundArmed: () => false,
    willRetry: () => false,
    exited: () => false,
  });
  const guard = createSkillReadGuard({
    skillPath: SKILL_DIR,
    reported: () => false,
    boundArmed: () => true,
  });
  for (let i = 0; i < 6; i++) {
    const ev = turn(tool("read", { path: SKILL_FILE }));
    guard.observe(ev);
    observeReviewBounds({ skillRead: guard, assistantMessageEnd: ev }, targets());
  }
  assert(guard.count() === 6, "the count still counts while a bound is armed");
  // #1847 — the steer is gated on the same seam the kill is, so a guard whose
  // kill stands down never latches `steered` and leaves an unlimited steer
  // stream behind it: with a killing bound already armed, a stdin that is about
  // to be killed is not written to again.
  assert(
    armed.join(",") === "",
    `an armed killing bound means no arm, no kill and no steer (${armed.join(",")})`,
  );
  // And with no bound armed, the same guard still reaches its kill (section (5)
  // pins the sequence; this pins that the new seam did not disable it). Fresh
  // targets, so the assertion below counts THIS guard's calls only.
  const armedFree: string[] = [];
  const freeTargets = (): ReviewBoundTargets => ({
    ...targets(),
    writeSteer: () => armedFree.push("steer"),
    kill: () => armedFree.push("kill"),
    armBound: () => armedFree.push("armBound"),
  });
  const notArmed = createSkillReadGuard({ skillPath: SKILL_DIR, reported: () => false });
  for (let i = 0; i < 6; i++) {
    const ev = turn(tool("read", { path: SKILL_FILE }));
    notArmed.observe(ev);
    observeReviewBounds({ skillRead: notArmed, assistantMessageEnd: ev }, freeTargets());
  }
  assert(
    armedFree.join(",") === "steer,armBound,kill",
    `…and the un-armed guard still arms and kills (${armedFree.join(",")})`,
  );
}

// ── (9) #1827 round 4 — the stop is OPT-IN, and stands down behind a cause
// another pass already named. Both are structural: neither is a prompt that can
// be ignored, and both close a shape the round-3 head shipped with.
{
  const OPT_IN = { verdictStop: true } as const;
  const SKILL = { reviewSkillPath: SKILL_DIR } as const;

  // (a) The adversarial reviewer WITH the flag gets the stop; the same role
  // WITHOUT it gets none. This is the plan gap gate's shape: it spawns
  // `adversarial-developer` with a READY / NEEDS_ITERATION protocol, and a stop
  // keyed on the role alone would have read its `VERDICT:` line with this
  // reviewer's enum and ended a gate round that never agreed to that protocol.
  const opted = createReviewBounds("adversarial-developer", { ...OPT_IN }, () => false);
  assert(opted.verdictStop !== undefined, "adversarial-developer + verdictStop gets the stop");
  const notOpted = createReviewBounds("adversarial-developer", {}, () => false);
  assert(
    notOpted.verdictStop === undefined,
    "adversarial-developer WITHOUT the flag gets no stop (the plan gap gate's shape)",
  );
  // The gate's own reply therefore accumulates and decides nothing, exactly as a
  // non-reviewer child's does: no status, no end, no stamp.
  const gate = createVerdictStop();
  gate.observe(turn(text("GAP lines reviewed.\n\nVERDICT: READY")));
  assert(gate.status() === undefined, "a READY verdict from the gate protocol records no verdict");
  assert(gate.stopped() === false, "…and never reports having ended a child");
  // A lens child never gets the stop whichever way the flag is set, and the
  // re-read cap stays role-keyed (the flag is not its opt-in).
  const lens = createReviewBounds("code-review-specialist", { ...SKILL, ...OPT_IN }, () => false);
  assert(lens.verdictStop === undefined, "a lens child gets no stop even with the flag set");
  assert(lens.skillRead !== undefined, "…and still gets the re-read cap from its skill path");
  const dev = createReviewBounds("developer", { ...SKILL, ...OPT_IN }, () => false);
  assert(dev.skillRead === undefined, "a developer child gets neither bound");
  // The stop's verdict must be a member of the enum, not a bare string: the
  // `VerdictStatus` type is what makes a typo at the fold a compile error.
  const status: VerdictStatus | undefined = createVerdictStop().status();
  assert(status === undefined, "a fresh stop reports no verdict, typed as VerdictStatus");
}

// ── (12) #1827 round 5 — a fired stop whose accumulated reply is BLANK is the
// same by-hand outcome as one with no status at all: the stop parses its verdict
// out of the accumulation, so a status with no text behind it must not record a
// clean end. One gate in the fold covers both arms; the blank arm is pinned here
// (and in test-review-post-verdict-freeze.ts section (3)), the missing-status arm
// in that file.
{
  const result = baseResult({ text: "collapsed reply carrying the verdict" });
  const warned: string[] = [];
  const lines: string[] = [];
  applyReviewBounds(
    { stoppedByVerdict: true, verdictText: "   ", verdictStatus: "APPROVED" },
    result,
    (s) => lines.push(s),
    (s) => warned.push(s),
  );
  assert(result.reviewStopReason === undefined, "a blank frozen reply stamps no reviewStopReason");
  assert(result.text === "collapsed reply carrying the verdict", "…and the collapsed reply");
  assert(result.ok === true, "…and ok are all left as the spawn set them");
  assert(warned.length === 1, "…and warns exactly once");
  assert(
    /APPROVED/.test(warned[0] ?? "") && /blank reply/.test(warned[0] ?? ""),
    `the warning names the accepted status and the blank reply (got: ${warned[0]})`,
  );
  assert(lines.length === 0, "…and emits no \"ended the reviewer at its VERDICT marker\" line");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
