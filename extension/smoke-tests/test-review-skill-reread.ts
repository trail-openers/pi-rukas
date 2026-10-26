#!/usr/bin/env bun
/**
 * #1827 — the reviewer skill re-read cap.
 *
 * The observed shape a lens child falls into: it re-opens its own `SKILL.md`
 * for hundreds of turns, ALTERNATING `read`, `cat` and `grep`. That alternation
 * is why nothing caught it — the loop detector keys on tool+args (a `read` and
 * a `bash` are different tools, so no fingerprint ever repeats) and
 * `ChildProgress` keys on the command string. So this test drives the guard
 * with the alternating shape, not with N copies of one call.
 *
 * The boundary is the acceptance criterion, and it is asymmetric on purpose:
 * with N = PI_ENSEMBLE_REVIEW_SKILL_READS (default 3), a child with N or fewer
 * reads is never steered; the (N+1)-th read steers ONCE; the (N+2)-th kills.
 *
 * Only reads resolving to the DRIVER-supplied skill path's `SKILL.md` count: a
 * read of a DIFFERENT skill file must never advance the counter, or the cap
 * would end a child for reading something the review asked for.
 *
 * Pure function — no child, no timers. The counter delegates the "did this
 * call open that file" judgement to `isSkillFileRead`, so this file also pins
 * that delegation: the grep form is NOT counted (grep names the path without
 * opening it), which is the predicate's own rule, not this cap's.
 */

import type { PiContentBlock, PiJsonEvent } from "../src/pi-event-shapes.ts";
import { createSkillReadGuard, reviewSkillReadCap } from "../src/review-bounds.ts";

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
/** A DIFFERENT skill's file: never counted. */
const OTHER_FILE = "/home/test/.pi/agent/skills/code-review-performance/SKILL.md";

let seq = 0;
function tc(name: string, args: unknown): PiContentBlock {
  return { type: "toolCall", id: `c${seq++}`, name, arguments: args };
}
function turn(...blocks: PiContentBlock[]): PiJsonEvent {
  return { type: "message_end", message: { role: "assistant", content: blocks } } as PiJsonEvent;
}
/**
 * The reader forms the observed loop alternates between. `grep` is the third
 * thing the child actually types, but the shared predicate does not credit it
 * (naming a path is not opening it — see case (3)), so the reload shape the cap
 * must catch is built from the forms that ARE reads: the `read` tool, `cat`,
 * `head`. Alternating tools is still the point — a single repeated fingerprint
 * is what the loop detector already stops.
 */
function readForms(): PiContentBlock[] {
  return [
    tc("read", { path: SKILL_FILE }),
    tc("bash", { command: `cat ${SKILL_FILE}` }),
    tc("bash", { command: `head -100 ${SKILL_FILE}` }),
  ];
}

function guard(reported = () => false) {
  return createSkillReadGuard({ skillPath: SKILL_DIR, reported });
}

// (1) the alternating read/cat/grep reload shape: steer at N+1, kill at N+2.
{
  const g = guard();
  const forms = readForms();
  const cap = reviewSkillReadCap();
  assert(cap === 3, `default allowance is 3 (PI_ENSEMBLE_REVIEW_SKILL_READS=${cap})`);

  // N reads: a healthy reviewer. No steer, no kill, and no steer source at all.
  for (let i = 0; i < cap; i++) g.observe(turn(forms[i % forms.length]));
  assert(g.count() === cap, `the alternating shape counted ${cap} reads`);
  assert(g.steerText() === undefined, "N reads: never steered (the healthy run)");
  assert(!g.shouldKill(), "N reads: never killed");

  // N+1: exactly one steer.
  g.observe(turn(forms[cap % forms.length]));
  const steer = g.steerText();
  assert(typeof steer === "string" && steer.length > 0, "the (N+1)-th read steers once");
  assert(
    steer !== undefined && /skill/i.test(steer),
    "the steer names what it stopped (the skill file), not a generic wrap-up",
  );
  assert(g.steerText() === undefined, "the steer is sent once, not on every later read");

  // N+2: the kill.
  g.observe(turn(forms[(cap + 1) % forms.length]));
  assert(g.shouldKill(), "the (N+2)-th read kills");
  assert(g.count() === cap + 2, `count reached ${cap + 2}`);
}

// (2) a read of a DIFFERENT skill file never counts.
{
  const g = guard();
  for (let i = 0; i < 10; i++) {
    g.observe(turn(tc("read", { path: OTHER_FILE })));
    g.observe(turn(tc("bash", { command: `cat ${OTHER_FILE}` })));
  }
  assert(g.count() === 0, "reads of another skill's SKILL.md are never counted");
  assert(g.steerText() === undefined && !g.shouldKill(), "and so never steer or kill");

  // A read of the skill DIRECTORY is not a read of the file either.
  const dir = guard();
  dir.observe(turn(tc("read", { path: SKILL_DIR })));
  assert(dir.count() === 0, "a read of the skill DIRECTORY does not count as loading it");

  // A nested reference doc inside the same skill directory is not the skill.
  const nested = guard();
  nested.observe(turn(tc("read", { path: `${SKILL_DIR}/references/cheatsheet.md` })));
  assert(nested.count() === 0, "a sibling file inside the skill dir does not count");
}

// (3) the predicate is delegated, not copied: grep/rg name the path without
// opening it, so they are not reads — the same rule the skill-load proof uses.
{
  const g = guard();
  g.observe(turn(tc("bash", { command: `grep -n x ${SKILL_FILE}` })));
  g.observe(turn(tc("bash", { command: `rg x ${SKILL_FILE}` })));
  g.observe(turn(tc("bash", { command: `ls ${SKILL_FILE}` })));
  g.observe(turn(tc("bash", { command: `echo ${SKILL_FILE}` })));
  assert(g.count() === 0, "grep/rg/ls/echo over the skill file are not counted as reads");
  // …while the reader verbs are, across tools and across one compound command.
  g.observe(turn(tc("bash", { command: `ls -la; cat ${SKILL_FILE}` })));
  assert(g.count() === 1, "a reader verb inside a compound command counts");
  g.observe(turn(tc("head", { command: `head -50 ${SKILL_FILE}` })));
  g.observe(turn(tc("read", { path: SKILL_FILE })));
  assert(g.count() === 2, "cat/head/read all count through the same predicate");
}

// (4) suppressed once the child has reported: a child that sent its agent_end
// is being reported, and killing it then would throw away the answer it gave.
{
  let reported = false;
  const g = guard(() => reported);
  const forms = readForms();
  for (let i = 0; i < reviewSkillReadCap() + 2; i++) g.observe(turn(forms[i % forms.length]));
  reported = true;
  assert(!g.shouldKill(), "the re-read kill is suppressed once the child has reported");
}

// (5) inert under the caps master switch, and with no skill path to count.
{
  const saved = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  const g = guard();
  const forms = readForms();
  for (let i = 0; i < 20; i++) g.observe(turn(forms[i % forms.length]));
  assert(g.count() === 0, "PI_ENSEMBLE_DISPATCH_CAPS=0 makes the re-read cap inert");
  assert(g.steerText() === undefined && !g.shouldKill(), "…no steer, no kill");

  const noPath = createSkillReadGuard({ skillPath: "", reported: () => false });
  for (let i = 0; i < 20; i++) noPath.observe(turn(tc("read", { path: SKILL_FILE })));
  assert(
    noPath.count() === 0 && !noPath.shouldKill(),
    "no driver-supplied skill path = no cap (nothing to count against)",
  );
  if (saved === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  else process.env.PI_ENSEMBLE_DISPATCH_CAPS = saved;
}

// (6) the knob is honoured, and only by a value that means something.
{
  const saved = process.env.PI_ENSEMBLE_REVIEW_SKILL_READS;
  process.env.PI_ENSEMBLE_REVIEW_SKILL_READS = "1";
  const g = guard();
  g.observe(turn(tc("read", { path: SKILL_FILE })));
  assert(g.steerText() === undefined && g.count() === 1, "N=1: one read is allowed");
  g.observe(turn(tc("bash", { command: `cat ${SKILL_FILE}` })));
  assert(typeof g.steerText() === "string", "N=1: the 2nd read steers");
  g.observe(turn(tc("read", { path: SKILL_FILE })));
  assert(g.shouldKill(), "N=1: the 3rd read kills");

  // #1827 round 1 — the junk a knob actually receives. An EMPTY value used to
  // read as `Number("") === 0`, which made every single read a violation: the
  // first read of a review killed the child. An empty or unset knob is the
  // operator asking for the default, never for zero.
  const junk: Array<[string, number]> = [
    ["", 3],
    ["   ", 3],
    ["0", 3],
    ["-2", 3],
    ["2.5", 3],
    ["abc", 3],
    ["NaN", 3],
    ["Infinity", 3],
    ["200", 50],
  ];
  for (const [value, want] of junk) {
    process.env.PI_ENSEMBLE_REVIEW_SKILL_READS = value;
    assert(
      reviewSkillReadCap() === want,
      `PI_ENSEMBLE_REVIEW_SKILL_READS="${value}" resolves to ${want}, never to 0`,
    );
    const j = guard();
    j.observe(turn(tc("read", { path: SKILL_FILE })));
    assert(j.count() === 1 && !j.shouldKill(), `"${value}": a first read is never a violation`);
  }
  process.env.PI_ENSEMBLE_REVIEW_SKILL_READS = "7";
  assert(reviewSkillReadCap() === 7, "a valid integer override is honoured");
  if (saved === undefined) delete process.env.PI_ENSEMBLE_REVIEW_SKILL_READS;
  else process.env.PI_ENSEMBLE_REVIEW_SKILL_READS = saved;
}

// (6b) a tool call whose `name` is not a string is skipped, not thrown on: the
// shape is Pi's and the guard sits on the hot path of a running child.
{
  const g = guard();
  g.observe(turn({ type: "toolCall", id: "weird", name: { o: 1 }, arguments: {} } as never));
  g.observe(turn({ type: "toolCall", id: "noname", arguments: { path: SKILL_FILE } } as never));
  g.observe(turn({ type: "toolCall", id: "noargs", name: "read" } as never));
  assert(g.count() === 0, "a malformed toolCall block counts as nothing and does not throw");
}

// (7) a stdin echo / an errored turn never counts.
{
  const g = guard();
  g.observe({ type: "response" } as PiJsonEvent);
  g.observe({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      content: [tc("read", { path: SKILL_FILE })],
    },
  } as PiJsonEvent);
  assert(g.count() === 0, "a stdin echo and an errored assistant turn are not reads");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
