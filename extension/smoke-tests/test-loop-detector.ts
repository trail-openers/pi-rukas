#!/usr/bin/env bun
/**
 * #543 F1 + #772 — loop-detector fixtures.
 *
 * F1 (a)–(h): streak-based identical-tool-call detection (steer@5, kill@10).
 * #772 (i)–(m): success-keyed non-adjacent repetition counter (steer@3, kill@6).
 *
 * The detector is a pure function: fixtures script "message_end" and
 * "toolResult" streams through `createLoopDetector().observe()` and
 * `.observeToolResult()`, asserting threshold crossings.
 *
 * The grace window (g) lives in the caller (spawn-caps.ts, wall-clock);
 * we exercise it through `createCapSession` with a fake child.
 */

import { mock } from "bun:test";

import {
  SUCCESS_KILL_AT,
  SUCCESS_STEER_AT,
  createLoopDetector,
  loopSteerText,
  successSteerText,
} from "../src/loop-detector.ts";
import type { LoopDetectionEvent, LoopDetector } from "../src/loop-detector.ts";
import type { PiContentBlock } from "../src/pi-event-shapes.ts";
import { createCapSession } from "../src/spawn-caps.ts";
import { capKillGraceMs } from "../src/spawn-support.ts";
import { pollUntilKilled } from "./lib/poll-until-killed.ts";

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
  if (a === e) return assert(true, msg);
  console.error(`  expected: ${e}\n  actual:   ${a}`);
  return assert(false, msg);
}

/* helpers */
function tc(name: string, args: unknown, id?: string): PiContentBlock {
  return { type: "toolCall", id: id ?? "x", name, arguments: args };
}
function bash(command: string, id?: string): PiContentBlock {
  return tc("bash", JSON.stringify({ command }), id);
}
function read(path: string, id?: string): PiContentBlock {
  return tc("read", { path }, id);
}
function edit(path: string, id?: string): PiContentBlock {
  return tc("edit", { path }, id);
}
function feedToolResult(
  det: LoopDetector,
  toolCallId: string,
  toolName: string,
  resultText: string,
  isError: boolean,
): LoopDetectionEvent | null {
  return det.observeToolResult(toolName, toolCallId, resultText, isError);
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
function fakeChild(): {
  killed: Array<"SIGTERM" | "SIGKILL">;
  kill: (s: "SIGTERM" | "SIGKILL") => void;
} {
  const c: { killed: Array<"SIGTERM" | "SIGKILL">; kill?: (s: "SIGTERM" | "SIGKILL") => void } = {
    killed: [],
  };
  c.kill = (sig) => c.killed.push(sig);
  return c;
}
function feedRepeat(det: LoopDetector, blocks: PiContentBlock[], n: number): LoopDetectionEvent[] {
  const evs: LoopDetectionEvent[] = [];
  for (let t = 0; t < n; t++) {
    const ev = det.observe(blocks, t);
    if (ev) evs.push(ev);
  }
  return evs;
}
const first = (evs: LoopDetectionEvent[], kind: "steer" | "kill") =>
  evs.find((e) => e.kind === kind);
const STEER_BASH_5 =
  "you appear to be repeating the same bash call with identical arguments after normalization (5 times); if the result is not changing, change approach or stop, and when you finish write your status (done / remaining / current state) to your final report.";

/* (a) 223-grep shape, pure streak */
{
  const det = createLoopDetector();
  const events = feedRepeat(det, [bash('grep -rn "TODO" src/ | grep -v "test" | head -50')], 20);
  const steer = first(events, "steer");
  const kill = first(events, "kill");
  assert(steer?.count === 5, "F1(a): steer at 5th repeat");
  assert(kill?.count === 10, "F1(a): kill at 10th repeat");
  assert(kill?.tool === "bash", "F1(a): kill names bash");
  assert(
    events.filter((e) => e.kind === "steer").length === 1,
    "F1(a): one steer across 20 repeats",
  );
  assert(det.killTriggered() && det.steerTriggered(), "F1(a): flags sticky");
  assert(det.current()?.count === 20, "F1(a): evidence reaches 20");
}
{
  const det = createLoopDetector();
  const steer = first(feedRepeat(det, [bash("git log --oneline -5")], 5), "steer");
  assert(steer?.text === STEER_BASH_5, "F1(a) text: exact steer text at count=5");
  assert(steer?.text === loopSteerText("bash", 5), "F1(a) text: matches loopSteerText");
}

/* (b) healthy stream: inert */
{
  const det = createLoopDetector();
  const cmds = [
    "bun run build",
    "bunx tsc --noEmit",
    "ls src/",
    "bun test smoke-tests/test-a.ts",
    "git diff --stat",
    "cat src/foo.ts",
    "bun run lint",
    "git status --porcelain",
    "bun test smoke-tests/test-a.ts",
    'rg "normalizeFingerprint" src/',
    "wc -l src/bar.ts",
    "git log --oneline -3",
    "bun test smoke-tests/test-b.ts",
    'grep -n "TODO" src/bar.ts',
    "bun run check",
  ];
  let any = false;
  for (let t = 0; t < cmds.length; t++) {
    // biome-ignore lint/style/noNonNullAssertion: cmds is a fixed literal array; the index is always in range
    any = det.observe([bash(cmds[t]!)], t) !== null || any;
  }
  assert(!any, "F1(b): healthy 15-call stream emits NO events");
  assert(!det.steerTriggered() && !det.killTriggered(), "F1(b): no threshold tripped");
  assert(det.current()?.count === 1, "F1(b): streak evidence holds the last distinct call only");
}

/* (c) 692-shape: path-redaction */
{
  const det = createLoopDetector();
  const events = feedRepeat(det, [bash("sh -n /tmp/x/v1.sh")], 12);
  assert(first(events, "steer")?.count === 5, "F1(c): same path x12 → steer@5");
  assert(first(events, "kill")?.count === 10, "F1(c): same path x12 → kill@10");
  assert(
    det.current()?.fingerprint === 'bash {"command":"sh -n <P1>"}',
    "F1(c): path redacted to <P1>",
  );
  const det2 = createLoopDetector();
  assert(
    det2.observe([bash("sh -n /tmp/x/v1.sh")], 0) === null,
    "F1(c): first distinct path, no event",
  );
  assert(
    det2.observe([bash("sh -n /tmp/x/v2.sh")], 1) === null,
    "F1(c): second distinct path, no event",
  );
  assert(det2.current()?.fingerprint === 'bash {"command":"sh -n <P2>"}', "F1(c): 2nd path → <P2>");
  assert(
    det2.observe([bash("sh -n /tmp/x/v1.sh")], 2) === null,
    "F1(c): return to first path, no event",
  );
  assert(det2.current()?.count === 1, "F1(c): return to <P1> resets streak to 1");
}

/* (d) alternating: no trigger (plus the phase-1 bulk shape the streak
   detector kills before the phase switch) */
{
  const det = createLoopDetector();
  for (let i = 0; i < 10; i++) {
    det.observe([bash("ls /a/b")], i * 2);
    det.observe([bash("ls /c/d")], i * 2 + 1);
  }
  assert(!det.steerTriggered() && !det.killTriggered(), "F1(d): alternating never triggers");
  assert(det.current()?.count === 1, "F1(d): alternating — streak never exceeds 1");
}
{
  // The bulk 10+10 shape: 10 identical calls IS the 223-grep shape — the
  // detector kills on phase 1 alone (the second distinct path never gets to
  // run in the real world, but the phase-2 counter mechanics are asserted).
  const det = createLoopDetector();
  const phase1 = feedRepeat(det, [bash("ls /a/b")], 10);
  assert(first(phase1, "steer")?.count === 5, "F1(d): phase 1 (ls /a/b x10) → steer at 5");
  assert(first(phase1, "kill")?.count === 10, "F1(d): phase 1 (ls /a/b x10) → kill at 10");
  const rest = feedRepeat(det, [bash("ls /c/d")], 10);
  assert(
    first(rest, "steer")?.count === 5 || first(rest, "steer") === undefined,
    "F1(d): phase 2 gets no fresh steer — the dispatch was already flagged in phase 1 (the old file's invariant: steer only from phase 1)",
  );
  assert(
    rest.filter((e) => e.kind === "kill").length === 0,
    "F1(d): phase 2 emits no further kill (the old file's invariant: kill only from phase 1)",
  );
  assert(
    det.current()?.fingerprint === 'bash {"command":"ls <P2>"}' && det.current()?.count === 10,
    "F1(d): phase-2 streak is fresh (new fingerprint, count restarts)",
  );
}

/* (e) two identical blocks in one turn */
{
  const det = createLoopDetector();
  const events = feedRepeat(det, [bash("git show HEAD --stat"), bash("git show HEAD --stat")], 5);
  assert(first(events, "steer")?.count === 5, "F1(e): 2 blocks/turn → steer@5");
  assert(first(events, "kill")?.count === 10, "F1(e): 2 blocks/turn → kill@10");
  assert(det.current()?.count === 10, "F1(e): evidence=10 across 5 turns");
  assert(
    JSON.stringify(det.current()?.turnRange) === JSON.stringify([0, 4]),
    "F1(e): turnRange spans the 5 turns the streak ran in",
  );
}

/* (f) ops role: no observer */
{
  const steers: string[] = [];
  const s = createCapSession({
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
  assert(s.loopObserver === undefined, "F1(f): ops gets NO loop observer");
  for (let t = 0; t < 20; t++) s.loopObserver?.([bash("git log --oneline -5")], t);
  eq(steers, [], "F1(f): 223-grep shape on ops → no steer");
  assert(!s.loopKilled(), "F1(f): ops never loop-killed");
  assert(s.loopEvidence() === undefined, "F1(f): no loop evidence recorded");
  assert(s.killCause() === undefined, "F1(f): killCause stays undefined");
}

/* (g) grace window */
{
  const child = fakeChild();
  const steers: string[] = [];
  let s: ReturnType<typeof createCapSession>;
  const savedGrace = process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
  process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = "1000";
  try {
    assert(capKillGraceMs() === 1000, "F1(g): grace=1000ms read");
    s = createCapSession({
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
    // biome-ignore lint/style/noNonNullAssertion: caps are on by default in this test scope; the observer is defined
    const obs = s.loopObserver!;
    for (let t = 0; t < 10; t++) obs([bash('rg "needle" src/ --line-number')], t);
    eq(steers, [STEER_BASH_5], "F1(g): exact steer text at count 5");
    assert(!s.loopKilled(), "F1(g): kill DEFERRED during grace");
    eq(child.killed, [], "F1(g): no signal before grace");
    const gArmedAt = Date.now();
    const gFired = await pollUntilKilled(s);
    assert(gFired.ok, "F1(g): kill fires (kill did not fire within 10 s of polling)");
    assert(
      gFired.at >= gArmedAt + 1000,
      `F1(g): kill fires after the grace window (kill at ${gFired.at - gArmedAt}ms vs grace 1000ms)`,
    );
    eq(child.killed, ["SIGTERM"], "F1(g): kill fired (grace window elapsed)");
    assert(s.killCause() === "loop", "F1(g): killCause='loop'");
    const ev = s.loopEvidence();
    assert(
      ev?.tool === "bash" && ev?.count >= 10,
      `F1(g): evidence carries tool+count (got ${JSON.stringify(ev)})`,
    );
    s.cleanup();
  } finally {
    if (savedGrace === undefined) delete process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
    else process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = savedGrace;
  }
}
{
  const child = fakeChild();
  const steers: string[] = [];
  let s: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "0" }, () => {
    s = createCapSession({
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
    for (let t = 0; t < 10; t++) s.loopObserver?.([bash('rg "needle" src/ --line-number')], t);
    eq(child.killed, ["SIGTERM"], "F1(g): grace=0 → immediate kill");
    assert(steers.length === 1 && s.killCause() === "loop", "F1(g): steer first, then kill");
  });
  s?.cleanup();
}

/* (h) lens no-retry */
{
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
  eq(spawnCalls.length, 6, "F1(h): 6 lenses, 6 spawns (no retry)");
  assert(
    summary.lenses.every((l) => l.attempts === 1 && l.blocked && l.killCause === "loop"),
    "F1(h): all blocked, no retry",
  );
  assert(
    summary.capKill === "loop" && summary.verdict === "REVIEW_INCOMPLETE",
    "F1(h): REVIEW_INCOMPLETE",
  );
}

/* (i) #772: non-adjacent green re-run — the #753 incident shape */
{
  const det = createLoopDetector();
  const ok = "All 5 tests passed in 1.2s";
  const events: LoopDetectionEvent[] = [];
  // 6 re-runs of the green test, interleaved with distinct reads.
  for (let i = 0; i < 6; i++) {
    det.observe([bash("bun run smoke-tests/test-a.ts", `call-${i * 2 + 1}`)], i * 2);
    const ev = feedToolResult(det, `call-${i * 2 + 1}`, "bash", ok, false);
    if (ev) events.push(ev);
    if (i < 5) det.observe([read(`src/file${i}.ts`, `call-${i * 2 + 2}`)], i * 2 + 1);
  }
  const steer = first(events, "steer");
  const kill = first(events, "kill");
  assert(steer?.count === SUCCESS_STEER_AT, `#772(i): steer at count=${SUCCESS_STEER_AT}`);
  assert(kill?.count === SUCCESS_KILL_AT, `#772(i): kill at count=${SUCCESS_KILL_AT}`);
  assert(steer?.successKeyed === true && kill?.successKeyed === true, "#772(i): both successKeyed");
  assert(kill?.tool === "bash", "#772(i): kill names bash");
  assert(det.current()?.kind === "success", "#772(i): evidence is success-keyed");
  assert(events.filter((e) => e.kind === "steer").length === 1, "#772(i): one steer");
  assert(events.filter((e) => e.kind === "kill").length === 1, "#772(i): one kill");
}

/* (j) #772: state-mutation resets counter */
{
  const det = createLoopDetector();
  const ok = "All 3 tests passed";
  const events: LoopDetectionEvent[] = [];
  det.observe([bash("bun test", "c1")], 0);
  feedToolResult(det, "c1", "bash", ok, false);
  det.observe([bash("bun test", "c2")], 1);
  let ev = feedToolResult(det, "c2", "bash", ok, false);
  if (ev) events.push(ev);
  det.observe([edit("src/foo.ts", "c3")], 2); // state mutation → reset
  det.observe([bash("bun test", "c4")], 3);
  ev = feedToolResult(det, "c4", "bash", ok, false);
  if (ev) events.push(ev);
  det.observe([bash("bun test", "c5")], 4);
  ev = feedToolResult(det, "c5", "bash", ok, false);
  if (ev) events.push(ev);
  det.observe([bash("bun test", "c6")], 5);
  ev = feedToolResult(det, "c6", "bash", ok, false);
  if (ev) events.push(ev);
  const steer = first(events, "steer");
  assert(steer?.count === SUCCESS_STEER_AT, "#772(j): steer@3 (edit reset the counter)");
  assert(first(events, "kill") === undefined, "#772(j): no kill (reset prevented accumulation)");
}

/* (k) #772: output change resets counter (polling CI) */
{
  const det = createLoopDetector();
  const events: LoopDetectionEvent[] = [];
  det.observe([bash("gh pr checks 42", "c1")], 0);
  feedToolResult(det, "c1", "bash", "pending: ci", false);
  det.observe([bash("gh pr checks 42", "c2")], 1);
  let ev = feedToolResult(det, "c2", "bash", "success: ci", false); // different → reset
  if (ev) events.push(ev);
  det.observe([bash("gh pr checks 42", "c3")], 2);
  ev = feedToolResult(det, "c3", "bash", "success: ci", false); // fresh count=1
  if (ev) events.push(ev);
  det.observe([bash("gh pr checks 42", "c4")], 3);
  ev = feedToolResult(det, "c4", "bash", "success: ci", false); // count=2
  if (ev) events.push(ev);
  det.observe([bash("gh pr checks 42", "c5")], 4);
  ev = feedToolResult(det, "c5", "bash", "success: ci", false); // count=3 → STEER
  if (ev) events.push(ev);
  const steer = first(events, "steer");
  assert(steer?.count === SUCCESS_STEER_AT, "#772(k): steer@3 (pending→success reset)");
  assert(first(events, "kill") === undefined, "#772(k): no kill");
}

/* (l) #772: errored result does not count */
{
  const det = createLoopDetector();
  const ok = "All tests passed";
  const events: LoopDetectionEvent[] = [];
  det.observe([bash("bun test", "c1")], 0);
  feedToolResult(det, "c1", "bash", ok, false);
  det.observe([bash("bun test", "c2")], 1);
  let ev = feedToolResult(det, "c2", "bash", "FAIL: test-a", true); // error → reset
  if (ev) events.push(ev);
  det.observe([bash("bun test", "c3")], 2);
  ev = feedToolResult(det, "c3", "bash", ok, false); // fresh count=1
  if (ev) events.push(ev);
  det.observe([bash("bun test", "c4")], 3);
  ev = feedToolResult(det, "c4", "bash", ok, false); // count=2
  if (ev) events.push(ev);
  det.observe([bash("bun test", "c5")], 4);
  ev = feedToolResult(det, "c5", "bash", ok, false); // count=3 → STEER
  if (ev) events.push(ev);
  const steer = first(events, "steer");
  assert(steer?.count === SUCCESS_STEER_AT, "#772(l): steer@3 (error reset the counter)");
  assert(first(events, "kill") === undefined, "#772(l): no kill");
}

/* (m) #772: steer text is distinct */
{
  const text = successSteerText("bash", 3);
  assert(text.includes("re-run the same bash call 3 times"), "#772(m): names tool+count");
  assert(text.includes("each returning the same successful output"), "#772(m): names the RESULT");
  assert(
    text.includes("write your status (done / remaining / current state) to your final report"),
    "#772(m): demands final report",
  );
  assert(text !== loopSteerText("bash", 3), "#772(m): distinct from streak steer");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
