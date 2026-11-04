#!/usr/bin/env bun
/**
 * #1991 — the wiring half: the PM's `maxTurns` / `maxMinutes` actually reach a
 * child, and the child is steered at half and at close-out.
 *
 * The pure logic is pinned by test-budget-progress.ts. This suite pins the
 * places an implementation can pass those unit tests and still never steer a
 * real child:
 *
 *   5. a parameter that is not a whole number in range REFUSES the dispatch on
 *      BOTH tools — a bound the child never got is worse than no bound, because
 *      the PM believes it armed one;
 *   6. a child with no steer seam — a lens / adversarial child, the motivating
 *      overrunners — still receives the progress steer, and the operator's
 *      scrollback line is tagged so it is traceable to this cap.
 *
 * Plus the arm itself: the levers reach `spawnSpecialist` and reach
 * `armChildBounds`, which is the only thing standing between a parameter on
 * a tool schema and a line on a child's screen.
 */

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { registerChildHandle } from "../src/async-jobs-registry.ts";
import { BUDGET_PROGRESS_STEER_SOURCE } from "../src/budget-progress.ts";
import {
  MAX_MINUTES_LIMIT,
  MAX_TURNS_LIMIT,
  parseMaxMinutes,
  parseMaxTurns,
} from "../src/dispatch-budget-params.ts";
import { type LifecycleDetails, formatLine } from "../src/lifecycle-events.ts";
import { type SpawnBudgetOpts, armChildBounds } from "../src/spawn-budget-arms.ts";
import { childBoundGraceMs, childBoundSchedule } from "../src/spawn-child-bound.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) assert(true, msg);
  else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const SRC = join(import.meta.dirname, "..", "src");

/** Collect everything a PassThrough has been written. */
function capture(): { stdin: PassThrough; text: () => string; lines: () => string[] } {
  const stdin = new PassThrough();
  let text = "";
  stdin.on("data", (d) => {
    text += String(d);
  });
  return {
    stdin,
    text: () => text,
    lines: () => text.split("\n").filter(Boolean),
  };
}

/**
 * The arm, called the way `spawnSpecialist` calls it: a spec, a live child, the
 * shared liveness flags, the stdin, and the caller's bound options. A child with
 * no exit state and no flag set is alive, which is the state every steer in
 * this suite is asserted against.
 */
function arm(o: {
  role: string;
  cwd?: string;
  stdin: PassThrough;
  start?: number;
  deckKey?: string;
  boundArmed?: () => boolean;
  exited?: boolean;
  opts: SpawnBudgetOpts;
}) {
  const child = new EventEmitter() as never;
  const opts: SpawnBudgetOpts =
    o.deckKey === undefined
      ? o.opts
      : // The arm reads its registry id out of the caller's options, the same
        // shape `SpawnOptions` declares, because that is where a lens child's
        // deck key lives.
        { ...o.opts, budgetSteerDeckKey: o.deckKey };
  return armChildBounds({
    spec: o.cwd === undefined ? { role: o.role } : { role: o.role, cwd: o.cwd },
    opts,
    child,
    flags: {
      childExited: () => o.exited === true,
      aborted: () => false,
      timedOut: () => false,
      inactivityKilled: () => false,
      toolInactivityKilled: () => false,
    },
    cwd: o.cwd ?? process.cwd(),
    stdin: o.stdin,
    start: o.start ?? 0,
    boundArmed: o.boundArmed ?? (() => false),
    reported: () => false,
  }).budgetProgress;
}

// ── 5. parameter validation refuses at the tool boundary ────────────────
{
  eq(parseMaxTurns(undefined), undefined, "maxTurns absent → no bound, exactly as before #1991");
  eq(parseMaxMinutes(undefined), undefined, "maxMinutes absent → no bound, exactly as before");
  eq(parseMaxTurns(40), 40, "maxTurns 40 passes through unchanged");
  eq(parseMaxMinutes(60), 3_600_000, "maxMinutes 60 becomes 60 minutes of ms (childBoundMs)");
  eq(parseMaxTurns(1), 1, "the floor of the range is accepted");
  eq(parseMaxTurns(MAX_TURNS_LIMIT), MAX_TURNS_LIMIT, "the ceiling of the range is accepted");
  eq(
    parseMaxMinutes(MAX_MINUTES_LIMIT),
    MAX_MINUTES_LIMIT * 60_000,
    "the minute ceiling is accepted (it sits under the 2-h spawn backstop)",
  );

  const refused: Array<[string, unknown, (v: unknown) => unknown]> = [
    ["maxTurns", 1.5, parseMaxTurns],
    ["maxTurns", "20", parseMaxTurns],
    ["maxTurns", 0, parseMaxTurns],
    ["maxTurns", -3, parseMaxTurns],
    ["maxTurns", MAX_TURNS_LIMIT + 1, parseMaxTurns],
    ["maxTurns", Number.NaN, parseMaxTurns],
    ["maxTurns", Number.POSITIVE_INFINITY, parseMaxTurns],
    ["maxTurns", null, parseMaxTurns],
    ["maxTurns", true, parseMaxTurns],
    ["maxTurns", {}, parseMaxTurns],
    ["maxMinutes", 1.5, parseMaxMinutes],
    ["maxMinutes", "20", parseMaxMinutes],
    ["maxMinutes", 0, parseMaxMinutes],
    ["maxMinutes", MAX_MINUTES_LIMIT + 1, parseMaxMinutes],
    ["maxMinutes", [], parseMaxMinutes],
    ["maxMinutes", Number.NEGATIVE_INFINITY, parseMaxMinutes],
  ];
  for (const [name, value, fn] of refused) {
    let threw = false;
    let message = "";
    try {
      fn(value);
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    assert(
      threw && message.startsWith(name) && message.includes("between 1 and"),
      `${name} ${JSON.stringify(value)} refused, with the range in the message`,
    );
  }
}

// Both tools must state the same rule, parse every spec of a parallel batch
// rather than only the first, and hand the parsed values (never the raw ones)
// to the spawn — a bound that survived validation but was dropped on the way is
// the failure this whole guard exists for.
{
  const dispatch = readFileSync(join(SRC, "dispatch.ts"), "utf8");
  const armSites = dispatch.split("budgetArms(").length - 1;
  assert(
    armSites >= 3,
    `both tools validate every spec before anything spawns (${String(armSites)} budgetArms sites: the shared parser plus one per tool)`,
  );
  assert(
    (dispatch.match(/maxTurns: Type\.Optional\(Type\.Integer\(/g) ?? []).length >= 2 &&
      (dispatch.match(/maxMinutes: Type\.Optional\(Type\.Integer\(/g) ?? []).length >= 2,
    "both levers are on the parameter schemas of both tools",
  );
  assert(
    /\{ budgetTurns: turns \}/.test(dispatch) && /\{ childBoundMs: boundMs \}/.test(dispatch),
    "the PARSED values are what reach the spawn (childBoundMs ends a child, budgetTurns is the denominator)",
  );
  assert(
    /MAX_TURNS_DESCRIPTION/.test(dispatch) && /MAX_MINUTES_DESCRIPTION/.test(dispatch),
    "both schemas carry the range and the consequence, so the model reads the fix",
  );
  const budgetArms = dispatch.slice(dispatch.indexOf("function budgetArms"));
  assert(
    /if \(turns === undefined && boundMs === undefined\) return \{\}/.test(budgetArms),
    "no bound at all arms nothing — a plain dispatch is unchanged by this feature",
  );
}

// ── the arm: the levers reach the spawn and build a real steer ──────────
{
  const spawn = readFileSync(join(SRC, "spawn.ts"), "utf8");
  assert(
    /armChildBounds\(\{/.test(spawn),
    "spawn.ts arms the child's bounds (without this call the feature is dead code)",
  );
  assert(
    /budgetProgress\.onAssistantTurn\(runningState\.turns/.test(
      readFileSync(join(SRC, "spawn-inflight.ts"), "utf8"),
    ),
    "the steer is driven on the per-assistant-turn seam, beside the turn nudge",
  );
  assert(
    /budgetProgressActive: \(\) => budgetProgress\.armed\(\)/.test(spawn),
    "the spawn tells the cap session when a bound is armed, so the #546 nudge stands down",
  );
  const caps = readFileSync(join(SRC, "spawn-caps.ts"), "utf8");
  assert(
    /if \(opts\.budgetProgressActive\?\.\(\)\) return;/.test(caps),
    "the stand-down lives inside the nudge itself, not at the call site",
  );
  const armSource = readFileSync(join(SRC, "spawn-budget-arms.ts"), "utf8");
  assert(
    /childBoundMs/.test(armSource) && /budgetTurns/.test(armSource),
    "the arm reads BOTH levers — either one alone arms the steer",
  );
  assert(
    /childHasExited\(o\.flags, o\.child\)/.test(armSource),
    "the arm asks the project's one liveness question, the way every other supervisor of this child does",
  );
  assert(
    /childBoundSchedule\(\s*boundMs \?\? 0,\s*childBoundGraceMs\(\),\s*o\.start,?\s*\)/.test(
      armSource,
    ),
    "the minutes lever is built from the run bound's OWN schedule, anchored to the spawn's start",
  );
}

// ── 6. a child with NO steer seam still receives both steers ────────────
//
// The lens / adversarial path passes no onSteer, so delivery falls through to
// the stdin envelope. That is the whole of AC6 and nothing else exercises it:
// every other steer test supplies a seam.
{
  const out = capture();
  const progress = arm({
    role: "code-review-specialist",
    stdin: out.stdin,
    start: 0,
    opts: { budgetTurns: 4 },
  });
  eq(progress.armed(), true, "a turns lever alone arms the progress steer");
  // The seam the pump drives: runningState.turns, one call per assistant turn.
  for (let t = 1; t <= 4; t++) progress.onAssistantTurn(t, 0);
  eq(out.lines().length, 2, "AC6: a no-seam child receives exactly two steers on stdin");
  const first = JSON.parse(out.lines()[0] ?? "{}");
  eq(first.type, "steer", "the stdin line is an RPC steer envelope (the only stdin form Pi reads)");
  assert(
    first.message === "Budget: turn 2 of 4.",
    `the 50% line states the child's position (${first.message})`,
  );
  const second = JSON.parse(out.lines()[1] ?? "{}");
  assert(
    second.message === "Budget: turn 4 of 4. Report your findings now, then end your turn.",
    `a reviewer at 80% is told to report, never to commit (${second.message})`,
  );
  progress.stop();
}

// The close-out instruction follows what the child can actually do: the arm
// decides from (role, cwd), the same rule `armChildBound`'s `commits` encodes.
{
  const dev = capture();
  const committing = arm({
    role: "developer",
    cwd: "/work/issue-1",
    stdin: dev.stdin,
    start: 0,
    opts: { budgetTurns: 10 },
  });
  for (let t = 1; t <= 10; t++) committing.onAssistantTurn(t, 0);
  eq(dev.lines().length, 2, "a developer receives exactly two steers too");
  assert(
    /Commit your work now/.test(JSON.parse(dev.lines()[1] ?? "{}").message ?? ""),
    "the 80% line for a developer with a tree of its own says commit",
  );
  committing.stop();

  const lone = capture();
  const noCwd = arm({
    role: "developer",
    stdin: lone.stdin,
    start: 0,
    opts: { budgetTurns: 10 },
  });
  for (let t = 1; t <= 10; t++) noCwd.onAssistantTurn(t, 0);
  assert(
    !/Commit/.test(lone.text()),
    "a developer with no cwd of its own is told to report — there is no tree to commit into",
  );
  assert(
    /Report your findings now/.test(JSON.parse(lone.lines()[1] ?? "{}").message ?? ""),
    "and it is told so in the same words a reviewer hears (the rule is (role, cwd), not role)",
  );
  noCwd.stop();
}

// ── no levers → inert arm, and the nudge is NOT stood down ──────────────
{
  const out = capture();
  const inert = arm({ role: "explore", stdin: out.stdin, start: 0, opts: {} });
  eq(inert.armed(), false, "AC2: no bound armed → the steer reports itself unarmed");
  for (let t = 1; t <= 500; t++) inert.onAssistantTurn(t, 0);
  eq(out.text(), "", "AC2: and emits nothing, ever (500 turns)");
  inert.stop();

  // The distinction the AC insists on: "no bound" and "bound not yet crossed"
  // must not read the same, because the #546 nudge stands down on one and not
  // the other.
  const early = arm({ role: "explore", stdin: out.stdin, start: 0, opts: { budgetTurns: 100 } });
  early.onAssistantTurn(3, 0);
  eq(early.armed(), true, "a bound that is not yet crossed still counts as armed");
  eq(out.lines().length, 0, "and still says nothing before its first threshold");
  early.stop();
}

// ── the deck-key path (a lens child steered through the registry) ───────
{
  const out = capture();
  const key = "budget-progress-wiring-lens";
  // A lens child registers its handle under its deck key (#799); the steer
  // resolves that id, so the tagged lifecycle line and the stdin envelope both
  // arrive through the one path the operator's `dispatch_steer` uses.
  registerChildHandle(key, out.stdin, "lens/simplicity", "code-review-specialist");
  const progress = arm({
    role: "code-review-specialist",
    stdin: out.stdin,
    start: 0,
    deckKey: key,
    opts: { budgetTurns: 2 },
  });
  progress.onAssistantTurn(1, 0);
  progress.onAssistantTurn(2, 0);
  eq(
    out.lines().length,
    2,
    "AC6: a deck-registered child receives both steers through the registry",
  );
  eq(
    out.lines().map((l) => JSON.parse(l).type),
    ["steer", "steer"],
    "each registry steer is one RPC envelope on the child's stdin",
  );
  eq(
    BUDGET_PROGRESS_STEER_SOURCE,
    "driver-budget-progress",
    "the source the registry path tags with is the literal the operator reads",
  );
  const line = formatLine({
    kind: "steered",
    jobId: key,
    label: "lens/simplicity",
    role: "code-review-specialist",
    steerMessage: "Budget: turn 2 of 2. Report your findings now, then end your turn.",
    steerSource: BUDGET_PROGRESS_STEER_SOURCE,
  } satisfies LifecycleDetails);
  assert(
    line.includes("[driver-budget-progress]"),
    `the scrollback line names this cap as the nudger (${line})`,
  );
  progress.stop();

  // A deck key nobody registered — the shape a lens child has once its round
  // ended. `steerChild` answers "no-such-job" and the caller's stdin is the
  // same dead pipe, so nothing is written behind the registry's back.
  const orphan = capture();
  const orphanProgress = arm({
    role: "code-review-specialist",
    stdin: orphan.stdin,
    start: 0,
    deckKey: "budget-progress-wiring-orphan",
    opts: { budgetTurns: 2 },
  });
  let threw = false;
  try {
    orphanProgress.onAssistantTurn(1, 0);
    orphanProgress.onAssistantTurn(2, 0);
  } catch {
    threw = true;
  }
  assert(!threw, "an unregistered deck key never throws onto the child's hot path");
  eq(orphan.text(), "", "an unregistered deck key is not written to twice on a closed pipe");
  orphanProgress.stop();
}

// ── the stand-down reaches the arm through the spawn's flag ─────────────
{
  const out = capture();
  let armed = false;
  const progress = arm({
    role: "developer",
    cwd: "/w",
    stdin: out.stdin,
    start: 0,
    boundArmed: () => armed,
    opts: { budgetTurns: 4 },
  });
  armed = true;
  for (let t = 1; t <= 4; t++) progress.onAssistantTurn(t, 0);
  eq(out.text(), "", "a child another bound is already ending gets no progress steer");
  progress.stop();
}

// ── the minutes lever arms without any turns lever ──────────────────────
{
  const out = capture();
  // A synthetic epoch, so the deadline clamp inside the bound's schedule (which
  // is relative to the instant it is asked) cannot shorten the bound out from
  // under the assertions below.
  const start = 1_000_000;
  const BOUND_MS = 600_000;
  const progress = arm({
    role: "explore",
    stdin: out.stdin,
    start,
    opts: { childBoundMs: BOUND_MS },
  });
  eq(progress.armed(), true, "AC4: maxMinutes alone arms the steer, whatever the role");
  // The denominator is the run bound's FULL schedule — bound plus the wrap-up
  // grace — because that is the child's whole life, and it is the same schedule
  // `armChildBound` arms its timers from. Read back off the schedule rather than
  // written as a literal, so this test cannot drift from the bound's arithmetic.
  // Asked at the spawn's own instant, exactly as the arm asks it: the deadline
  // clamp inside the schedule is relative to `now`, so asking it later measures
  // the child against a bound it never had.
  const total = (childBoundSchedule(BOUND_MS, childBoundGraceMs(), 0).killAtMs ?? 0) - 0;
  assert(
    total > BOUND_MS,
    `the child is paced against bound + grace (${String(total / 60_000)} min, not the bare ${String(BOUND_MS / 60_000)})`,
  );
  // Half, on a minute boundary: the display floors, so an unaligned instant
  // would print 9 and make a correct renderer look off by one.
  const halfAt = start + Math.floor(total / 2 / 60_000) * 60_000;
  progress.onAssistantTurn(1, halfAt);
  eq(out.lines().length, 1, "the minutes lever fires at half");
  const half = JSON.parse(out.lines()[0] ?? "{}");
  // Half the bound means half the time left, to the minute the display floors
  // to — an assertion on the wording alone would pass on a renderer that always
  // printed the total, which is the bug worth catching here.
  const halfMatch = /about (\d+) min left of (\d+)\./.exec(half.message ?? "");
  eq(
    halfMatch?.[1],
    String(Math.floor((total - (halfAt - start)) / 60_000)),
    `at half the bound the child is told it has half left (${half.message})`,
  );
  eq(
    halfMatch?.[2],
    String(Math.floor(total / 60_000)),
    `the total it names is the whole bound it was given (${half.message})`,
  );
  assert(
    (half.message ?? "").startsWith("Budget: turn 1, about "),
    `the line opens with the child's position and carries the minutes clause (${half.message})`,
  );
  assert(
    !/turn 1 of/.test(half.message ?? ""),
    "a turns-less child is never shown a turns figure it has no limit for",
  );
  progress.onAssistantTurn(2, start + total * 0.9);
  eq(out.lines().length, 2, "and again at close-out");
  assert(
    /Report your findings now/.test(JSON.parse(out.lines()[1] ?? "{}").message ?? ""),
    "the close-out instructs a non-committing child on the minutes lever too",
  );
  progress.onAssistantTurn(3, start + total * 1.5); // past the bound
  eq(out.lines().length, 2, "never a third steer, even past the bound");
  progress.stop();
}

// ── an exited child is never written to ─────────────────────────────────
{
  const out = capture();
  const progress = arm({
    role: "developer",
    cwd: "/w",
    stdin: out.stdin,
    start: 0,
    exited: true,
    opts: { budgetTurns: 2 },
  });
  progress.onAssistantTurn(1, 0);
  progress.onAssistantTurn(2, 0);
  eq(out.text(), "", "advice is never written to a child whose exit the supervisors observed");
  progress.stop();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
