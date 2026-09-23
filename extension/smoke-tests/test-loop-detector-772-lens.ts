#!/usr/bin/env bun
/**
 * #772 lens-review — tests (t)-(y): bash-issued mutations, stale evidence,
 * turnRange, single-path registry, bounded memory, callId consumption.
 * Drives the real createLoopDetector (pure detector level).
 */

import { SUCCESS_STEER_AT, createLoopDetector } from "../src/loop-detector.ts";
import type { LoopDetector } from "../src/loop-detector.ts";
import type { PiContentBlock } from "../src/pi-event-shapes.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function tc(name: string, args: unknown, id?: string): PiContentBlock {
  return { type: "toolCall", id: id ?? "x", name, arguments: args };
}
function bash(command: string, id?: string): PiContentBlock {
  return tc("bash", JSON.stringify({ command }), id);
}
function feedToolResult(
  det: LoopDetector,
  toolCallId: string,
  toolName: string,
  resultText: string,
  isError: boolean,
) {
  return det.observeToolResult(toolName, toolCallId, resultText, isError);
}

/* (t) #772 lens-review — bash-issued mutations: a bash toolCall whose command
   matches the conservative mutation pattern clears the success counters the
   same way write/edit does. A `git commit` between identical green re-runs
   means the state HAS changed — a re-run is no longer a pure re-run.
   Conversely, a read-only command between the re-runs does NOT reset. */
{
  const det = createLoopDetector();
  const ok = "All 3 tests passed";
  const events: Array<string> = [];
  // 3 green re-runs of the test (steer at 3), then a `git commit` — the
  // commit resets the counter. After the reset, 2 more re-runs reach
  // count=2 (not 3), so no second steer or kill.
  det.observe([bash("bun test", "t1")], 0);
  let ev = feedToolResult(det, "t1", "bash", ok, false);
  if (ev) events.push(ev.kind);
  det.observe([bash("bun test", "t2")], 1);
  ev = feedToolResult(det, "t2", "bash", ok, false);
  if (ev) events.push(ev.kind);
  det.observe([bash("bun test", "t3")], 2);
  ev = feedToolResult(det, "t3", "bash", ok, false);
  if (ev) events.push(ev.kind); // steer at count=3
  // git commit — bash mutation → successCounters cleared
  det.observe([bash("git commit -m x", "t4")], 3);
  det.observe([bash("bun test", "t5")], 4);
  ev = feedToolResult(det, "t5", "bash", ok, false); // count=1 (fresh)
  if (ev) events.push(ev.kind);
  det.observe([bash("bun test", "t6")], 5);
  ev = feedToolResult(det, "t6", "bash", ok, false); // count=2
  if (ev) events.push(ev.kind);
  // No kill: the counter was reset by the commit; max count after reset is 2.
  assert(events.includes("steer"), "#772(t): steer fired before the commit");
  assert(!events.includes("kill"), "#772(t): git commit between re-runs → no kill (counter reset)");
  assert(det.killTriggered() === false, "#772(t): kill not triggered after commit reset");

  // Contrast: read-only `cat` between re-runs does NOT reset — the counter
  // continues accumulating and the kill fires at 6 identical results.
  const det2 = createLoopDetector();
  const ev2: Array<string> = [];
  // 7 green re-runs, with a `cat` after the 3rd (read-only — no reset).
  for (let i = 1; i <= 7; i++) {
    det2.observe([bash("bun test", `u${i}`)], i - 1);
    let e2 = feedToolResult(det2, `u${i}`, "bash", ok, false);
    if (e2) ev2.push(e2.kind);
    if (i === 3) det2.observe([bash("cat x", "u-cat")], i); // read-only — no reset
  }
  assert(ev2.includes("steer"), "#772(t): steer fired before the cat");
  assert(ev2.includes("kill"), "#772(t): read-only `cat` between re-runs → kill still fires");
  assert(det2.killTriggered(), "#772(t): kill triggered when only read-only calls intervene");
}

/* (u) #772 lens-review — stale evidence: a fingerprint whose entry is
   deleted (output changed / error) and re-seeded at count=1 must not be
   reported as kind:"success" by current(). Only an entry with count >=
   SUCCESS_STEER_AT AND steered/killed qualifies; a count-1 re-seeded entry
   falls through to streak evidence. */
{
  const det = createLoopDetector();
  const ok = "All tests passed";
  // Fire the steer (count reaches 3).
  det.observe([bash("bun test", "v1")], 0);
  let ev = feedToolResult(det, "v1", "bash", ok, false);
  det.observe([bash("bun test", "v2")], 1);
  ev = feedToolResult(det, "v2", "bash", ok, false);
  det.observe([bash("bun test", "v3")], 2);
  ev = feedToolResult(det, "v3", "bash", ok, false); // steer at 3
  assert(ev?.kind === "steer", "#772(u): steer fires at count 3");
  // Now change the output → entry deleted, re-seeded at count=1.
  det.observe([bash("bun test", "v4")], 3);
  feedToolResult(det, "v4", "bash", "DIFFERENT OUTPUT", false); // deleted + re-seeded
  const evidence = det.current();
  // The re-seeded entry has count=1, steered=false, killed=false → does NOT
  // satisfy the (steered||killed) && count >= 3 guard → fall through to
  // streak evidence (or null if no streak).
  if (evidence) {
    assert(
      !(evidence.kind === "success" && evidence.count < SUCCESS_STEER_AT),
      `#772(u): stale success evidence not reported (got kind=${evidence.kind} count=${evidence.count})`,
    );
  }
}

/* (v) #772 lens-review — turnRange: the firstTurn is the turn the
   fingerprint was first recorded, not 0. A green command first seen at
   turn 5 should report turnRange [5, lastTurn], not [0, lastTurn]. */
{
  const det = createLoopDetector();
  const ok = "All tests passed";
  // Fill with distinct calls first (turns 0–4).
  for (let i = 0; i < 5; i++) det.observe([bash(`cmd-${i}`)], i);
  // Green test first seen at turn 5.
  det.observe([bash("bun test", "w5")], 5);
  let ev = feedToolResult(det, "w5", "bash", ok, false);
  det.observe([bash("bun test", "w6")], 6);
  ev = feedToolResult(det, "w6", "bash", ok, false);
  det.observe([bash("bun test", "w7")], 7);
  ev = feedToolResult(det, "w7", "bash", ok, false); // steer at count=3
  const evidence = det.current();
  assert(evidence?.kind === "success", "#772(v): evidence is success-keyed");
  assert(
    evidence?.turnRange[0] === 5,
    `#772(v): turnRange start is firstTurn=5 (got ${evidence?.turnRange[0]})`,
  );
  assert(
    evidence?.turnRange[1] === 7,
    `#772(v): turnRange end is lastTurn=7 (got ${evidence?.turnRange[1]})`,
  );
}

/* (w) #772 lens-review — single-path registry: fingerprintOf uses the
   detector's own path registry, so a path seen by observe() and the same
   path passed to fingerprintOf get the SAME token. */
{
  const det = createLoopDetector();
  // observe sees /a/b first → <P1>
  det.observe([bash("ls /a/b")], 0);
  // fingerprintOf for the same path must also produce <P1> (same registry)
  const fp = det.fingerprintOf("bash", JSON.stringify({ command: "ls /a/b" }));
  assert(fp === 'bash {"command":"ls <P1>"}', `#772(w): fingerprintOf shares the detector's registry (got ${fp})`);
  // A different path gets a different token.
  const fp2 = det.fingerprintOf("bash", JSON.stringify({ command: "ls /c/d" }));
  assert(fp2 === 'bash {"command":"ls <P2>"}', `#772(w): second path → <P2> (got ${fp2})`);
}

/* (x) #772 lens-review — bounded memory: successCounters is capped at 200
   fingerprints. Insert 201 distinct commands (each with unique output),
   verify the re-run of the evicted oldest starts fresh (no event). */
{
  const det = createLoopDetector();
  // Insert 201 distinct commands (each with unique output → unique entry).
  for (let i = 0; i < 201; i++) {
    det.observe([bash(`cmd-${i}`)], i);
    feedToolResult(det, `b-${i}`, "bash", `out-${i}`, false);
  }
  // Re-run cmd-0 (the evicted oldest). Fresh start → count=1, no event.
  det.observe([bash("cmd-0")], 300);
  const e1 = feedToolResult(det, "re-0", "bash", "out-0", false);
  assert(e1 === null, "#772(x): re-run of evicted command starts fresh (no event)");
}

/* (y) #772 lens-review — callIdToFp is consumed: a toolCallId that was
   already processed cannot be re-used to feed a second result. */
{
  const det = createLoopDetector();
  det.observe([bash("bun test", "z1")], 0);
  const e1 = feedToolResult(det, "z1", "bash", "green", false); // consumes z1
  assert(e1 === null, "#772(y): first result consumes the callId");
  // Re-feed the same toolCallId → should return null (no fp found)
  const e2 = feedToolResult(det, "z1", "bash", "green", false);
  assert(e2 === null, "#772(y): second result for same callId returns null (consumed)");
}

/* (z) #772 — BASH_MUTATION_RE redirection branch: detect output redirection
   to a file anywhere in the command, but NOT fd duplication (2>&1) and
   NOT /dev/null targets. */
{
  // (z1) echo x > out.txt → mutation (resets success counters)
  {
    const det = createLoopDetector();
    const ok = "All tests passed";
    det.observe([bash("bun test", "z1a")], 0);
    let ev = feedToolResult(det, "z1a", "bash", ok, false);
    det.observe([bash("bun test", "z1b")], 1);
    ev = feedToolResult(det, "z1b", "bash", ok, false);
    det.observe([bash("bun test", "z1c")], 2);
    ev = feedToolResult(det, "z1c", "bash", ok, false); // steer at count=3
    assert(ev?.kind === "steer", "#772(z1): steer fires before the redirect");
    // echo x > out.txt — bash mutation → successCounters cleared
    det.observe([bash("echo x > out.txt", "z1d")], 3);
    det.observe([bash("bun test", "z1e")], 4);
    ev = feedToolResult(det, "z1e", "bash", ok, false); // count=1 (fresh)
    if (ev) assert(ev.kind === "steer", "#772(z1): fresh start after redirect reset (unexpected steer)".replace(" (unexpected steer)", ""));
    assert(ev === null, "#772(z1): no event after redirect reset (count=1)");
  }

  // (z2) cmd 2>&1 → NOT a mutation (fd duplication, not a file write)
  {
    const det = createLoopDetector();
    const ok = "All tests passed";
    det.observe([bash("bun test", "z2a")], 0);
    let ev = feedToolResult(det, "z2a", "bash", ok, false);
    det.observe([bash("bun test", "z2b")], 1);
    ev = feedToolResult(det, "z2b", "bash", ok, false);
    det.observe([bash("bun test", "z2c")], 2);
    ev = feedToolResult(det, "z2c", "bash", ok, false); // steer at count=3
    // cmd 2>&1 — NOT a mutation (fd duplication) → no reset
    det.observe([bash("cmd 2>&1", "z2d")], 3);
    det.observe([bash("bun test", "z2e")], 4);
    ev = feedToolResult(det, "z2e", "bash", ok, false); // count=4
    det.observe([bash("bun test", "z2f")], 5);
    ev = feedToolResult(det, "z2f", "bash", ok, false); // count=5
    det.observe([bash("bun test", "z2g")], 6);
    ev = feedToolResult(det, "z2g", "bash", ok, false); // count=6 → kill
    assert(ev?.kind === "kill", "#772(z2): 2>&1 does NOT reset — kill still fires at count 6");
  }

  // (z3) cmd > /dev/null → NOT a mutation (/dev/null target)
  {
    const det = createLoopDetector();
    const ok = "All tests passed";
    det.observe([bash("bun test", "z3a")], 0);
    let ev = feedToolResult(det, "z3a", "bash", ok, false);
    det.observe([bash("bun test", "z3b")], 1);
    ev = feedToolResult(det, "z3b", "bash", ok, false);
    det.observe([bash("bun test", "z3c")], 2);
    ev = feedToolResult(det, "z3c", "bash", ok, false); // steer at count=3
    // cmd > /dev/null — NOT a mutation (/dev/null target) → no reset
    det.observe([bash("cmd > /dev/null", "z3d")], 3);
    det.observe([bash("bun test", "z3e")], 4);
    ev = feedToolResult(det, "z3e", "bash", ok, false); // count=4
    det.observe([bash("bun test", "z3f")], 5);
    ev = feedToolResult(det, "z3f", "bash", ok, false); // count=5
    det.observe([bash("bun test", "z3g")], 6);
    ev = feedToolResult(det, "z3g", "bash", ok, false); // count=6 → kill
    assert(ev?.kind === "kill", "#772(z3): > /dev/null does NOT reset — kill still fires at count 6");
  }

  // (z4) ~500-char command containing `->` and `=>` is NOT treated as a
  // mutation (the reduced redirection branch must not false-positive on
  // arrow-like sequences); the counter still accumulates across it and the
  // kill fires. Also asserts the check runs fast (no exponential backtracking).
  {
    const det = createLoopDetector();
    const ok = "All tests passed";
    // Build a ~500-char command full of `->` / `=>` (no real `>` redirect).
    const filler = ("echo a->b => c; ").repeat(25); // ~500 chars
    const long = filler.slice(0, 500);
    det.observe([bash("bun test", "z4a")], 0);
    let ev = feedToolResult(det, "z4a", "bash", ok, false);
    det.observe([bash("bun test", "z4b")], 1);
    ev = feedToolResult(det, "z4b", "bash", ok, false);
    det.observe([bash("bun test", "z4c")], 2);
    ev = feedToolResult(det, "z4c", "bash", ok, false); // steer at count=3
    assert(ev?.kind === "steer", "#772(z4): steer fires before the long command");
    const t0 = Date.now();
    det.observe([bash(long, "z4d")], 3); // the ~500-char non-mutation
    assert(Date.now() - t0 < 500, "#772(z4): 500-char command mutation check runs fast");
    det.observe([bash("bun test", "z4e")], 4);
    ev = feedToolResult(det, "z4e", "bash", ok, false); // count=4 (no reset)
    det.observe([bash("bun test", "z4f")], 5);
    ev = feedToolResult(det, "z4f", "bash", ok, false); // count=5
    det.observe([bash("bun test", "z4g")], 6);
    ev = feedToolResult(det, "z4g", "bash", ok, false); // count=6 → kill
    assert(ev?.kind === "kill", "#772(z4): -> / => in a long command is NOT a mutation — kill still fires");
  }

  // (z5) object args: bashMutation reads args.command DIRECTLY (no
  // stringify/regex round-trip). A command with embedded quotes and a real
  // redirect is detected as a mutation; the same command as a JSON object
  // works identically to a raw string.
  {
    const det = createLoopDetector();
    const ok = "All tests passed";
    det.observe([bash("bun test", "z5a")], 0);
    feedToolResult(det, "z5a", "bash", ok, false);
    det.observe([bash("bun test", "z5b")], 1);
    feedToolResult(det, "z5b", "bash", ok, false);
    det.observe([bash("bun test", "z5c")], 2);
    feedToolResult(det, "z5c", "bash", ok, false); // count=3 (steer)
    // Object args {command: "..."} with a real redirect → mutation → reset.
    const objArgs = { command: 'echo "x" > out.txt && git add . && git commit -m "w"' };
    det.observe([tc("bash", objArgs, "z5d")], 3);
    det.observe([bash("bun test", "z5e")], 4);
    const ev = feedToolResult(det, "z5e", "bash", ok, false); // count=1 (reset)
    assert(ev === null, "#772(z5): object-args mutation (direct .command read) resets the counter");
  }
}

/* (aa) #772 — firedEvidence returns the MOST SEVERE fired entry
   deterministically: a killed entry wins over a steered one, and among
   kills the highest count wins. The test uses TWO fingerprints where the
   LATER one is killed — the earlier steered entry must not mask it. */
{
  const det = createLoopDetector();
  const ok = "All tests passed";
  // Fingerprint A (bash "cmd-A"): reach steer (count=3) but not kill.
  for (let i = 0; i < 3; i++) {
    det.observe([bash("cmd-A", `aa-a${i}`)], i);
    feedToolResult(det, `aa-a${i}`, "bash", ok, false);
  }
  // Fingerprint B (bash "cmd-B"): the LATER fingerprint — drive it to KILL
  // (count=6).
  let ev: unknown = null;
  for (let i = 0; i < 6; i++) {
    det.observe([bash("cmd-B", `aa-b${i}`)], 3 + i);
    const e = feedToolResult(det, `aa-b${i}`, "bash", ok, false);
    if (e) ev = e;
  }
  assert(ev !== null && (ev as { kind: string }).kind === "kill", "#772(aa): later fingerprint reaches kill");
  const evidence = det.current();
  assert(evidence?.kind === "success", "#772(aa): evidence is success-keyed");
  assert(evidence?.count === 6, `#772(aa): killed entry (count 6) wins over steered (count 3) — got ${evidence?.count}`);
  assert(
    evidence?.fingerprint?.includes("cmd-B"),
    `#772(aa): evidence is the KILLED fingerprint (got ${evidence?.fingerprint})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
