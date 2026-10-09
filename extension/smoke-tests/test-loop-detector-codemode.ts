#!/usr/bin/env bun
/**
 * #1032 — loop-detector codemode fixtures.
 *
 * (n): identical codemode script re-issued N times trips the existing
 * streak counter at the same threshold as any repeated call — no
 * special-casing, no different threshold.
 */

import { createLoopDetector } from "../src/loop-detector.ts";
import type { LoopDetectionEvent, LoopDetector } from "../src/loop-detector.ts";
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
/** #1032 — codemode toolCall: fingerprinted by its script text (arguments). */
function codemode(code: string, id?: string): PiContentBlock {
  return tc("codemode", { code }, id);
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

/* (n) #1032: identical codemode script re-issued N times — no special-casing.
   A codemode toolCall is fingerprinted by its script text (its arguments) just
   like any other tool call: the same script re-issued trips the existing
   streak counter at the SAME thresholds (steer@5, kill@10) as an identical
   bash call re-issued the same number of times. */
{
  const det = createLoopDetector();
  const events = feedRepeat(
    det,
    [codemode("const r = await tools.bash('bun run build'); return r;", "code-1")],
    20,
  );
  const steer = first(events, "steer");
  const kill = first(events, "kill");
  assert(steer?.count === 5, "(n) codemode: steer at 5th repeat (same as bash)");
  assert(kill?.count === 10, "(n) codemode: kill at 10th repeat (same as bash)");
  assert(kill?.tool === "codemode", "(n) codemode: kill names codemode");
  assert(kill?.successKeyed === false, "(n) codemode: streak (not success-keyed) trigger");
  assert(
    events.filter((e) => e.kind === "steer").length === 1,
    "(n) codemode: one steer across 20 repeats",
  );
  assert(
    det.current()?.fingerprint ===
      'codemode {"code":"const r = await tools.bash(\'bun run build\'); return r;"}',
    "(n) codemode: fingerprint is the tool + redacted script text",
  );
  const bashDet = createLoopDetector();
  const bashEvents = feedRepeat(bashDet, [bash("bun run build", "bash-1")], 20);
  assert(
    first(bashEvents, "steer")?.count === steer?.count &&
      first(bashEvents, "kill")?.count === kill?.count,
    "(n) codemode: identical-script threshold matches identical-bash threshold",
  );
  assert(
    bashDet.current()?.count === det.current()?.count,
    "(n) codemode: final streak count matches bash baseline",
  );
  // Drifting paths get different redaction tokens and reset the streak (same as
  // bash) — the same-threshold guarantee applies to byte-identical scripts.
  const driftDet = createLoopDetector();
  let driftAny = false;
  for (let i = 0; i < 10; i++) {
    const script =
      i % 2 === 0
        ? "return await tools.read('/tmp/x/a.ts');"
        : "return await tools.read('/tmp/x/b.ts');";
    driftAny = driftDet.observe([codemode(script, `drift-${i}`)], i) !== null || driftAny;
  }
  assert(!driftAny, "(n) codemode: drifting paths (different <Pn>) never trip the streak");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
