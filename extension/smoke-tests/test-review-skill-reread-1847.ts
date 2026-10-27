#!/usr/bin/env bun
/**
 * #1847 — the two holes that let a lens child re-read its skill unbounded.
 *
 * (A) NESTED reads. A codemode script inside a lens child opens files through
 * Pi's `ctx.executeTool()`, and Pi reports each as a flat `tool_execution_start`
 * with `parentToolCallId` and NO `message`. The #1827 guard counted only
 * `toolCall` blocks inside an assistant `message_end`, so a lens that opened its
 * `SKILL.md` a hundred times from inside one script registered ZERO reads and
 * was never steered or killed — while codemode is on for every child by default
 * (`PI_ENSEMBLE_CHILD_CODEMODE=0` to disable). These cases drive the nested
 * shape and pin the two rules that keep the count honest: the parent codemode
 * block is never itself a read, and each nested read counts once (no per-parent
 * dedup — a script that loops is exactly what the cap exists to stop).
 *
 * (B) LIVENESS. The guard's kill was suppressed by `promptCompleted`, which the
 * line handler sets on ANY non-retrying `agent_end`. Pi emits one per in-process
 * retry boundary, and a lens whose segment errored with no findings is
 * re-spawned from scratch by `runLensChild` — so "it already reported" described
 * a segment while the live process kept burning reads. Suppression is now
 * liveness: a child that has EXITED is never killed by the cap; a child that is
 * merely past an intermediate `agent_end` still is.
 *
 * Both feed through the SAME single feed the spawn uses (`guard.observe` from
 * the stdout line handler, the decision from `observeReviewBounds`), so the
 * count has one owner here exactly as it does in production.
 */

import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import {
  type ReviewBoundTargets,
  createSkillReadGuard,
  observeReviewBounds,
  reviewSkillReadCap,
} from "../src/review-bounds.ts";
import { isNestedToolStart, nestedEventReadsSkill } from "../src/review-bounds-nested.ts";
import { skillFileCandidates } from "../src/lens-skill-path.ts";
import { SKILL_RESOLVED } from "./lib/lens-skill-proof-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Built from the shared resolved fixture root: the guard compares EXACT whole
// paths through realpath, and a literal /tmp/... spelling would compare equal to
// itself on a host where /tmp is a symlink, making every negative case vacuous.
const SKILL_DIR = SKILL_RESOLVED;
const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;
const OTHER_FILE = `${SKILL_DIR.replace(/code-review-security$/, "code-review-performance")}/SKILL.md`;
/** The candidate lists the guard builds once per spawn, built the same way here
 * so a nested fixture is judged against exactly what production matches. */
const WANTS = skillFileCandidates(SKILL_DIR);
const DIRS = WANTS.length > 0 ? [SKILL_DIR] : [];

let seq = 0;
function tc(name: string, args: unknown): PiContentBlock {
  return { type: "toolCall", id: `c${seq++}`, name, arguments: args };
}
function turn(...blocks: PiContentBlock[]): PiJsonEvent {
  return { type: "message_end", message: { role: "assistant", content: blocks } } as PiJsonEvent;
}
/** A nested call: Pi's flat tool_execution_start, ids shaped `<callerId>/<n>`,
 * no `message` anywhere. Mirrors test-codemode-nested-inflight.ts. */
function nestedStart(toolName: string, args: unknown, parent = "cm1"): PiJsonEvent {
  return {
    type: "tool_execution_start",
    toolCallId: `${parent}/${seq++}`,
    toolName,
    args,
    parentToolCallId: parent,
  } as PiJsonEvent;
}
/** The same event WITHOUT the parent id — a top-level call, which the nested
 * feed must never count (its toolCall block is counted by the message path). */
function topLevelStart(toolName: string, args: unknown): PiJsonEvent {
  const e = nestedStart(toolName, args);
  delete e.parentToolCallId;
  return e;
}
function guard(reported = () => false) {
  return createSkillReadGuard({ skillPath: SKILL_DIR, reported });
}
function targets(calls: string[], over: Partial<ReviewBoundTargets> = {}): ReviewBoundTargets {
  return {
    writeSteer: () => calls.push("steer"),
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
}

/* ── (A1) a nested codemode read of the skill counts, and reaches its kill. */
{
  const g = guard();
  const cap = reviewSkillReadCap();
  const g2 = guard();
  // `steerText()` latches after its first non-undefined answer, so reachability
  // is pinned on a guard that has not been asked yet.
  for (let i = 0; i < cap + 1; i++) g2.observe(nestedStart("read", { path: SKILL_FILE }));
  assert(
    g2.count() === cap + 1,
    `(A1) nested reads counted at all (${g2.count()} — was 0 before #1847)`,
  );
  assert(g2.steerText() !== undefined, "(A1) the (N+1)-th nested read is reachable: steer due");
  for (let i = 0; i < cap + 2; i++) g.observe(nestedStart("read", { path: SKILL_FILE }));
  assert(g.count() === cap + 2, "(A1) every nested read advanced the same counter");
  assert(g.shouldKill(), "(A1) the (N+2)-th nested read kills — the cap now sees codemode");
  assert(!guard().shouldKill(), "(A1) canary: a guard that saw no read at all does not kill");
}

/* ── (A2) BOTH shapes the predicate knows are reachable on the nested form:
 * `read` with args.path AND `bash` with args.command. A guard that read only
 * `args.path` would pass (A1) and fail here, which is why the spec demands a
 * test for each. */
{
  const g = guard();
  for (let i = 0; i < reviewSkillReadCap() + 2; i++) {
    g.observe(
      i % 2 === 0
        ? nestedStart("read", { path: SKILL_FILE })
        : nestedStart("bash", { command: `cat ${SKILL_FILE}` }),
    );
  }
  assert(g.count() === reviewSkillReadCap() + 2, "(A2) nested read and nested bash both count");
  assert(g.shouldKill(), "(A2) …and together they reach the kill");
}

/* ── (A3) what must NOT count. A nested read of another skill's file; a nested
 * non-reader (grep names a path without opening it); and a TOP-LEVEL
 * tool_execution_start, which the message path already owns. Each would
 * silently inflate the cap and end a healthy review early. */
{
  const g = guard();
  for (let i = 0; i < 8; i++) {
    g.observe(nestedStart("read", { path: OTHER_FILE }));
    g.observe(nestedStart("grep", { pattern: "x", path: SKILL_FILE }));
    g.observe(topLevelStart("read", { path: SKILL_FILE }));
    g.observe(nestedStart("read", null));
    g.observe(nestedStart("read", "not-an-object"));
    g.observe({ type: "tool_execution_start", toolCallId: "x1", toolName: "read" } as PiJsonEvent);
  }
  assert(g.count() === 0, "(A3) none of the near-miss nested shapes advance the counter");
  assert(!g.shouldKill(), "(A3) …and none of them kill");
  // Canary that the fixture is not simply broken: the same guard DOES count the
  // real nested read.
  g.observe(nestedStart("read", { path: SKILL_FILE }));
  assert(g.count() === 1, "(A3) canary: the real nested read still counts in this guard");
}

/* ── (A4) the predicate's own guards, called directly so a mutation in the
 * nested leaf is visible even where the guard's candidate lists would mask it. */
{
  assert(
    nestedEventReadsSkill(nestedStart("read", { path: SKILL_FILE }), DIRS, WANTS),
    "(A4) the nested predicate credits a read of the skill",
  );
  assert(
    !nestedEventReadsSkill(nestedStart("write", { path: SKILL_FILE, content: "x" }), DIRS, WANTS),
    "(A4) …and refuses a write to it (a mutation trap for a matcher that only looked at path)",
  );
  assert(
    !isNestedToolStart(topLevelStart("read", { path: SKILL_FILE })),
    "(A4) a top-level tool_execution_start is not a nested start, so the feed never double-counts it",
  );
  assert(
    isNestedToolStart(nestedStart("read", { path: SKILL_FILE })),
    "(A4) …and a call carrying parentToolCallId is (the gate is real, not always-false)",
  );
  assert(
    !nestedEventReadsSkill(nestedStart("read", { path: SKILL_FILE }), DIRS, []),
    "(A4) no candidate list, no count (the guard's inactive shape)",
  );
}

/* ── (A5) ONE feed, one count. `observeReviewBounds` consumes only the assistant
 * message_end, so a line that carries both a nested start and a message must
 * not double-count the same read. This is the double-feed the spec names. */
{
  const calls: string[] = [];
  const g = guard();
  const ev = turn(tc("codemode", { code: "tools.read({path: SKILL.md})" }));
  // The parent codemode block itself is never a read…
  g.observe(ev);
  observeReviewBounds({ skillRead: g, assistantMessageEnd: ev }, targets(calls));
  assert(g.count() === 0, "(A5) the parent codemode toolCall block is not itself a read");
  // …while its five nested reads are five reads, counted by the handler feed only.
  for (let i = 0; i < 5; i++) {
    const n = nestedStart("read", { path: SKILL_FILE });
    g.observe(n);
    observeReviewBounds({ skillRead: g, assistantMessageEnd: null }, targets(calls));
  }
  assert(g.count() === 5, "(A5) each nested read counts once — no per-parent dedup, no double feed");
}

/* ── (B1) an intermediate agent_end (reported() true) with the child ALIVE still
 * kills. This is the case the old `reported()` suppression made unreachable. */
{
  const calls: string[] = [];
  const cap = reviewSkillReadCap();
  let reported = false;
  const g = guard(() => reported);
  let reads = 0;
  // The steer is asked and latched BEFORE the provider answers, which is the
  // ordering the real loop has: the steer text is consumed on the read that
  // earns it (read N+1), and only then does that segment's `agent_end` flip
  // `promptCompleted`. So the steer is legitimately present — what #1847
  // changes is that the kill does NOT stand down when it does.
  for (let i = 0; i < cap + 1; i++) {
    const ev = turn(tc("read", { path: SKILL_FILE }));
    g.observe(ev);
    observeReviewBounds({ skillRead: g, assistantMessageEnd: ev }, targets(calls));
    reads += 1;
    if (reads === cap + 1) reported = true;
  }
  assert(calls.includes("steer"), "(B1) the (N+1)-th read steered before the segment ended");
  for (let i = 0; i < 3; i++) {
    const ev = turn(tc("read", { path: SKILL_FILE }));
    g.observe(ev);
    observeReviewBounds({ skillRead: g, assistantMessageEnd: ev }, targets(calls));
  }
  assert(
    calls.includes("cause:review-skill-reread"),
    "(B1) …with its own cause, not a generic one",
  );
  assert(
    calls.includes("kill"),
    "(B1) the kill still lands after the segment's agent_end (the old suppression is gone)",
  );
  assert(
    calls.filter((c) => c === "kill").length === 1,
    `(B1) …exactly once, however many reads follow (${calls.filter((c) => c === "kill").length})`,
  );
}

/* ── (B2) a child that has EXITED is never killed by the cap, and never steered
 * again. The second half is what the un-latched `steered` flag would otherwise
 * allow: with the kill standing down, every later read would write another line
 * at a stdin that is gone. */
{
  const calls: string[] = [];
  const g = guard(() => false);
  for (let i = 0; i < reviewSkillReadCap() + 1; i++) {
    const ev = turn(tc("read", { path: SKILL_FILE }));
    g.observe(ev);
    observeReviewBounds({ skillRead: g, assistantMessageEnd: ev }, targets(calls));
  }
  assert(calls.join(",") === "steer", "(B2) the (N+1)-th read steers while the child lives");
  const before = calls.length;
  for (let i = 0; i < 8; i++) {
    const ev = turn(tc("read", { path: SKILL_FILE }));
    g.observe(ev);
    observeReviewBounds(
      { skillRead: g, assistantMessageEnd: ev },
      targets(calls, { exited: () => true }),
    );
  }
  assert(
    !calls.slice(before).includes("kill"),
    "(B2) an exited child is never killed by the re-read cap",
  );
  assert(
    !calls.slice(before).includes("armBound"),
    "(B2) …and no bound arms for a child that already ended",
  );
  assert(
    !calls.slice(before).includes("steer"),
    "(B2) …and no further steer is written to a stdin that is gone (#1847)",
  );
}

/* ── (B3) the healthy run stays healthy: a child that stops at the allowance is
 * steered once and never killed, on both feeds (top-level and nested mixed). */
{
  const calls: string[] = [];
  const g = guard();
  const cap = reviewSkillReadCap();
  // Exactly N reads total, split across the two feeds: at N nothing is due, so
  // a healthy reviewer is neither steered nor killed however it reached its
  // reads. (N+1 is (A1)'s steer case and (B1)/(B2)'s kill cases.)
  for (let i = 0; i < cap; i++) {
    if (i % 2 === 0) {
      const ev = turn(tc("read", { path: SKILL_FILE }));
      g.observe(ev);
      observeReviewBounds({ skillRead: g, assistantMessageEnd: ev }, targets(calls));
    } else {
      g.observe(nestedStart("bash", { command: `head -50 ${SKILL_FILE}` }));
      observeReviewBounds({ skillRead: g, assistantMessageEnd: null }, targets(calls));
    }
  }
  assert(g.count() === cap, `(B3) mixed stream counted ${g.count()} reads on both feeds`);
  assert(
    calls.length === 0,
    `(B3) a child that stays at the allowance is never steered or killed (${calls.join(",")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
