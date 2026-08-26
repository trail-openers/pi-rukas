#!/usr/bin/env bun
/**
 * #543 F1 — loop-detector fixtures (a)–(h) from the issue spec.
 *
 * The detector (loop-detector.ts) is a pure function: fixtures script
 * "message_end" content-block streams through "createLoopDetector().observe()"
 * and assert when the streak crosses the steer (5) and kill (10) thresholds.
 *
 * The grace window (g's deferral) lives in the CALLER (spawn-caps.ts,
 * wall-clock). We exercise the caller through "createCapSession" with a fake
 * child and a real (short) wall clock: the 500ms poll inside createCapSession
 * is real, and PI_ENSEMBLE_CAP_KILL_GRACE_MS is injected via env (1000ms
 * deferral window; 0 for the immediate-kill variant), keeping the test
 * deterministic without a real spawn.
 *
 * Ops-role exemption (f) is the caller's decision (spawn-caps.ts "capsOn"
 * excludes role === "ops"); we assert it through createCapSession, not the
 * detector (which has no role concept).
 *
 * (h) — no-retry for a loop-killed lens: runLensReview's retry loop breaks
 * on killCause "loop" (lens-review.ts "#543 no-retry-on-cap-kill"); the
 * adversarial-side no-retry is already covered by
 * test-work-driver-cap-kill-no-retry.ts. There was no offline test for the
 * lens side, so this file asserts it here with a mocked spawn.
 */

import { mock } from "bun:test";

import {
  createLoopDetector,
  loopDetectorEnabled,
  loopSteerText,
} from "../src/loop-detector.ts";
import { capKillGraceMs } from "../src/spawn-support.ts";
import type { LoopDetectionEvent, LoopDetector } from "../src/loop-detector.ts";
import type { PiContentBlock } from "../src/pi-event-shapes.ts";
import { createCapSession } from "../src/spawn-caps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    assert(true, msg);
    return true;
  }
  console.error(`  expected: ${e}\n  actual:   ${a}`);
  return assert(false, msg);
}

/* ---------------------------------------------------------------- helpers */

function tc(name: string, args: unknown): PiContentBlock {
  return { type: "toolCall", id: "x", name, arguments: args };
}
function bash(command: string): PiContentBlock {
  // Pi's message_end shape carries arguments as a JSON string; the detector
  // redacts absolute paths inside that string.
  return tc("bash", JSON.stringify({ command }));
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface FakeChild {
  killed: Array<"SIGTERM" | "SIGKILL">;
  kill: (sig: "SIGTERM" | "SIGKILL") => void;
}
function fakeChild(): FakeChild {
  const c: FakeChild = { killed: [], kill: (sig) => c.killed.push(sig) };
  return c;
}

/** Feed "n" consecutive assistant turns each carrying the given blocks;
 *  return the emitted events (nulls dropped). */
function feedRepeat(det: LoopDetector, blocks: PiContentBlock[], n: number): LoopDetectionEvent[] {
  const events: LoopDetectionEvent[] = [];
  for (let turn = 0; turn < n; turn++) {
    const ev = det.observe(blocks, turn);
    if (ev) events.push(ev);
  }
  return events;
}
const first = (evs: LoopDetectionEvent[], kind: "steer" | "kill") =>
  evs.find((e) => e.kind === kind);

const STEER_TEXT_BASH_5 =
  "you appear to be repeating the same bash call with identical arguments after normalization (5 times); if the result is not changing, change approach or stop, and when you finish write your status (done / remaining / current state) to your final report.";

/* ----------------------------------------------- (a) 223-grep shape, pure */

{
  const det = createLoopDetector();
  const args = { command: 'grep -rn "TODO" src/ | grep -v "test" | head -50' };
  const events = feedRepeat(det, [bash(args.command)], 20);
  const steer = first(events, "steer");
  const kill = first(events, "kill");
  // The streak counts from the first observation: n1=1 … n4=4 (no event),
  // n5=5 → steer, n10=10 → kill.
  assert(
    steer?.kind === "steer" && steer.count === 5,
    "F1(a): steer fires on the 5th repeat (count=5)",
  );
  assert(
    kill?.kind === "kill" && kill.count === 10,
    "F1(a): kill fires on the 10th repeat (count=10)",
  );
  assert(kill?.tool === "bash", "F1(a): kill names the looping tool (bash)");
  // One steer per dispatch, ever (even with 20 repeats).
  assert(
    events.filter((e) => e.kind === "steer").length === 1,
    "F1(a): exactly one steer across 20 repeats",
  );
  assert(
    det.killTriggered() && det.steerTriggered(),
    "F1(a): killTriggered/steerTriggered are sticky",
  );
  assert(det.current()?.count === 20, "F1(a): current streak evidence reaches 20");
}

// (a) — the EXACT steer text the child receives, verbatim.
{
  const det = createLoopDetector();
  const events = feedRepeat(det, [bash("git log --oneline -5")], 5);
  const steer = first(events, "steer");
  assert(steer?.kind === "steer", "F1(a) text: a steer event fired at count 5");
  assert(
    steer?.text === STEER_TEXT_BASH_5,
    "F1(a) text: steer text is the exact spec sentence with tool=bash, count=5",
  );
  assert(
    steer?.text === loopSteerText("bash", 5),
    "F1(a) text: steer text matches loopSteerText (the source the child receives)",
  );
}

/* ------------------------------------------- (b) healthy stream: inert */

{
  const det = createLoopDetector();
  const healthy = [
    "bun run build",
    "bunx tsc --noEmit",
    "ls src/",
    "bun test smoke-tests/test-a.ts", // a test that just passed
    "git diff --stat",
    "cat src/foo.ts",
    "bun run lint",
    "git status --porcelain",
    "bun test smoke-tests/test-a.ts", // re-running the passing test — same args,
    // NOT the same fingerprint right before: the streak is a SINCE-LAST-DISTINCT
    // counter, so a non-adjacent repeat does not accumulate (the 223-grep
    // cluster had ~286 turns between repeats; a sliding window would miss it).
    'rg "normalizeFingerprint" src/',
    "wc -l src/bar.ts",
    "git log --oneline -3",
    "bun test smoke-tests/test-b.ts",
    'grep -n "TODO" src/bar.ts',
    "bun run check",
  ];
  let anyEvent = false;
  for (let turn = 0; turn < healthy.length; turn++) {
    anyEvent = det.observe([bash(healthy[turn])], turn) !== null || anyEvent;
  }
  assert(!anyEvent, "F1(b): healthy 15-call stream emits NO steer/kill events");
  assert(!det.steerTriggered() && !det.killTriggered(), "F1(b): no threshold ever tripped");
  assert(det.current()?.count === 1, "F1(b): streak evidence holds the last distinct call only");
}

/* ------------------------------- (c) 692-shape: path-redaction collapses */

{
  // Note on spec wording: the first-seen registry (loop-detector.ts) assigns
  // each distinct absolute path its OWN placeholder token in first-seen
  // order, so "sh -n /tmp/x/v1.sh" and "sh -n /tmp/x/v2.sh" are DISTINCT
  // fingerprints and do NOT accumulate (the issue's deferred follow-up).
  // The 692-shape assertion that holds: v1.sh itself repeated 12x — the same
  // path redacted to the same placeholder — IS the 223-grep shape and kills.
  const det = createLoopDetector();
  const cmd = (p: string) => `sh -n ${p}`;
  const events = feedRepeat(det, [bash(cmd("/tmp/x/v1.sh"))], 12);
  assert(first(events, "steer")?.count === 5, "F1(c): sh -n <same path> x12 → steer at 5");
  assert(first(events, "kill")?.count === 10, "F1(c): sh -n <same path> x12 → kill at 10");
  assert(
    det.current()?.fingerprint === 'bash {"command":"sh -n <P1>"}',
    "F1(c): fingerprint shows the absolute path redacted to a placeholder",
  );

  // Distinct paths → distinct tokens → different fingerprints.
  const det2 = createLoopDetector();
  assert(
    det2.observe([bash(cmd("/tmp/x/v1.sh"))], 0) === null,
    "F1(c): first distinct path, no event",
  );
  assert(
    det2.observe([bash(cmd("/tmp/x/v2.sh"))], 1) === null,
    "F1(c): second distinct path, no event",
  );
  assert(
    det2.current()?.fingerprint === 'bash {"command":"sh -n <P2>"}',
    "F1(c): the second path got its OWN token (<P2>), not the first path's",
  );
  // Same path again → same token → same fingerprint. Actual behavior:
  // because the intervening /tmp/x/v2.sh was a DIFFERENT fingerprint, the
  // streak RESETS — the token registry keeps fingerprints stable across
  // calls, but streaks only count CONSECUTIVE identical calls.
  assert(
    det2.observe([bash(cmd("/tmp/x/v1.sh"))], 2) === null,
    "F1(c): return to first path, no event",
  );
  assert(
    det2.current()?.fingerprint === 'bash {"command":"sh -n <P1>"}' && det2.current()?.count === 1,
    "F1(c): same path → same token (<P1>), but the intervening distinct call reset the streak to 1",
  );
}

/* -------------------------------------------- (d) second distinct path */

{
  const det = createLoopDetector();
  const a = feedRepeat(det, [bash("ls /a/b")], 10);
  // 10 identical calls IS the 223-grep shape → steer 5, kill 10 — the
  // detector does not know the path will change at turn 11.
  assert(first(a, "steer")?.count === 5, "F1(d): phase 1 (ls /a/b x10) → steer at 5");
  assert(first(a, "kill")?.count === 10, "F1(d): phase 1 (ls /a/b x10) → kill at 10");

  // The bulk 10+10 shape: the second distinct path breaks the streak — no
  // FURTHER events fire beyond phase 1's single steer+kill.
  const det2 = createLoopDetector();
  const b = [
    ...feedRepeat(det2, [bash("ls /a/b")], 10),
    ...feedRepeat(det2, [bash("ls /c/d")], 10),
  ];
  assert(
    b.filter((e) => e.kind === "steer").length === 1,
    "F1(d): bulk 10+10 → steer only from phase 1",
  );
  assert(
    b.filter((e) => e.kind === "kill").length === 1,
    "F1(d): bulk 10+10 → kill only from phase 1",
  );
  assert(
    det2.current()?.fingerprint === 'bash {"command":"ls <P2>"}' && det2.current()?.count === 10,
    "F1(d): phase-2 streak is fresh (new fingerprint, count restarts)",
  );

  // The reset mechanic's actual guarantee: an ALTERNATING stream — where the
  // streak is broken before it can ever reach 10 — never triggers.
  const det3 = createLoopDetector();
  const interleaved: LoopDetectionEvent[] = [];
  for (let i = 0; i < 10; i++) {
    const e1 = det3.observe([bash("ls /a/b")], i * 2);
    const e2 = det3.observe([bash("ls /c/d")], i * 2 + 1);
    if (e1) interleaved.push(e1);
    if (e2) interleaved.push(e2);
  }
  assert(interleaved.length === 0, "F1(d): alternating /a/b and /c/d never triggers");
  assert(
    !det3.steerTriggered() && !det3.killTriggered(),
    "F1(d): alternating stream — no threshold tripped",
  );
  assert(det3.current()?.count === 1, "F1(d): alternating stream — streak never exceeds 1");
}

/* ------------------------------ (e) two identical blocks in one turn */

{
  const det = createLoopDetector();
  const blocks = [bash("git show HEAD --stat"), bash("git show HEAD --stat")];
  const events = feedRepeat(det, blocks, 5); // 10 calls in 5 turns
  assert(
    first(events, "steer")?.count === 5,
    "F1(e): two identical blocks per turn — steer at 5th call",
  );
  assert(
    first(events, "kill")?.count === 10,
    "F1(e): two identical blocks per turn — kill at 10th call",
  );
  assert(det.current()?.count === 10, "F1(e): evidence count reached 10 across 5 turns");
  assert(
    JSON.stringify(det.current()?.turnRange) === JSON.stringify([0, 4]),
    "F1(e): turnRange spans the 5 turns the streak ran in",
  );
}

/* ---------------------------------------------------------- (f) ops role */

{
  const steers: string[] = [];
  const session = createCapSession({
    role: "ops",
    child: fakeChild() as never,
    onSteer: (m) => steers.push(m),
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 0,
    childExited: () => false,
  });
  assert(session.loopObserver === undefined, "F1(f): ops-role child gets NO loop observer at all");
  // The loop as it would arrive: identical bash args across 20 turns.
  const blocks: PiContentBlock[] = [bash("git log --oneline -5")];
  for (let turn = 0; turn < 20; turn++) session.loopObserver?.(blocks, turn);
  eq(steers, [], "F1(f): the 223-grep shape on an ops child → no steer");
  assert(!session.loopKilled(), "F1(f): ops child is never loop-killed");
  assert(session.loopEvidence() === undefined, "F1(f): no loop evidence recorded");
  assert(session.killCause() === undefined, "F1(f): ops child's killCause stays undefined");
}

/* ------------------------------------------------------------- (g) grace */

{
  const child = fakeChild();
  const steers: string[] = [];
  let session: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "1000" }, async () => {
    // Grace reader sanity: the injected env is what the session gets.
    assert(
      capKillGraceMs() === 1000,
      "F1(g): PI_ENSEMBLE_CAP_KILL_GRACE_MS=1000 is read (time-injection seam)",
    );
    session = createCapSession({
      role: "developer",
      child: child as never,
      onSteer: (m) => steers.push(m),
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 1000,
      childExited: () => false,
    });
    assert(session.loopObserver !== undefined, "F1(g): developer child gets a loop observer");
    // biome-ignore lint/style/noNonNullAssertion: assert()-guarded above; the observer is defined when caps are on
    const observe = session.loopObserver!;
    // 10 identical calls; the 10th tool execution is still running
    // (no further message_end) when the kill arms.
    for (let turn = 0; turn < 10; turn++) {
      observe([bash('rg "needle" src/ --line-number')], turn);
    }
    // The 5th repeat steered with the exact spec text.
    eq(steers, [STEER_TEXT_BASH_5], "F1(g): the child received the exact steer text at count 5");
    // Armed, not killed: the grace window is open (real wall clock — no
    // message_end has arrived since trigger, so the 1000ms window can't have
    // elapsed within this instant).
    assert(!session.loopKilled(), "F1(g): kill is DEFERRED while the grace window is open");
    eq(child.killed, [], "F1(g): no signal sent before grace elapses");
    // Let the 500ms poll inside createCapSession fire once the window
    // (1000ms, injected) has elapsed.
    await new Promise((r) => setTimeout(r, 1400));
    eq(child.killed, ["SIGTERM"], "F1(g): kill fires AFTER the grace window elapses");
    assert(session.loopKilled(), "F1(g): loopKilled is true post-grace");
    assert(session.killCause() === "loop", "F1(g): killCause is 'loop'");
    eq(
      session.loopEvidence(),
      { tool: "bash", count: 10 },
      "F1(g): attribution evidence carries the looping tool and count",
    );
  });
  assert(session !== undefined, "F1(g): session built before cleanup");
  session?.cleanup();
  // The 5s SIGKILL escalation timer is unref'd in spawn-caps, so it can't
  // keep the process alive.
}

{
  const child = fakeChild();
  const steers: string[] = [];
  let session: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "0" }, () => {
    assert(capKillGraceMs() === 0, "F1(g): PI_ENSEMBLE_CAP_KILL_GRACE_MS=0 disables the deferral");
    session = createCapSession({
      role: "developer",
      child: child as never,
      onSteer: (m) => steers.push(m),
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 0,
      childExited: () => false,
    });
    for (let turn = 0; turn < 10; turn++) {
      session.loopObserver?.([bash('rg "needle" src/ --line-number')], turn);
    }
    // No grace: the kill fires the moment the 10th observation lands.
    eq(child.killed, ["SIGTERM"], "F1(g): grace=0 → kill is immediate at trigger");
    assert(steers.length === 1, "F1(g): grace=0 → the one steer still fires first");
    assert(session.killCause() === "loop", "F1(g): grace=0 → killCause 'loop'");
  });
  assert(session !== undefined, "F1(g): session built before cleanup (grace=0)");
  session?.cleanup();
}

/* ------------------------------------------------------ (h) lens no-retry */

{
  // spawnSpecialist is module-bound; mock the module before lens-review.ts
  // is first imported, so the retry loop calls the fake. MAX_LENS_ATTEMPTS
  // is 4: a retried lens would spawn 4x, six lenses = 24 spawns.
  const spawnCalls: Array<{ prompt: string }> = [];
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-f1h",
    spawnSpecialist: async (spec: { prompt: string }) => {
      spawnCalls.push({ prompt: spec.prompt });
      return {
        role: "code-review-specialist",
        ok: false,
        text: "",
        toolUses: [],
        ms: 10,
        exitCode: 143,
        transcriptPath: "/tmp/f1h.json",
        killCause: "loop",
      };
    },
  }));
  const { runLensReview } = await import("../src/lens-review.ts");
  const summary = await runLensReview({ diff: "diff --git a/a b/a" } as never);
  eq(
    spawnCalls.length,
    6,
    "F1(h): each loop-killed lens was spawned exactly ONCE (6 lenses, 6 spawns)",
  );
  assert(
    summary.lenses.every((l) => l.attempts === 1),
    "F1(h): every lens reports attempts=1 — the retry loop broke on the cap kill",
  );
  assert(
    summary.lenses.every((l) => l.blocked),
    "F1(h): every lens is recorded as blocked",
  );
  assert(
    summary.lenses.every((l) => l.killCause === "loop"),
    "F1(h): every lens carries killCause 'loop'",
  );
  assert(
    summary.capKill === "loop",
    "F1(h): the summary carries capKill 'loop' for the driver's cap-hit",
  );
  assert(
    summary.verdict === "REVIEW_INCOMPLETE",
    "F1(h): a loop-killed lens → REVIEW_INCOMPLETE, not a silent 5-of-6",
  );
}

/* ------------------------------------------------- env / master switches */

assert(
  withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () => loopDetectorEnabled()) === false,
  "master switch: PI_ENSEMBLE_DISPATCH_CAPS=0 disables the loop detector",
);
assert(
  withEnv({ PI_ENSEMBLE_LOOP_DETECTOR: "0" }, () => loopDetectorEnabled()) === false,
  "F1-only switch: PI_ENSEMBLE_LOOP_DETECTOR=0 disables the loop detector",
);
assert(
  withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: undefined, PI_ENSEMBLE_LOOP_DETECTOR: undefined }, () =>
    loopDetectorEnabled(),
  ) === true,
  "default: the loop detector is ON",
);
assert(
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: undefined }, () => capKillGraceMs()) === 5 * 60_000,
  "capKillGraceMs: default 5 minutes (the ship value)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
