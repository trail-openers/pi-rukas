#!/usr/bin/env bun
/**
 * #772 R3 — (w6) a SUCCESS-keyed kill armed from the toolResult feed must NOT
 * have its grace window re-armed by later message_end traffic.
 *
 * Moved verbatim from test-loop-detector-wire.ts (file-size split, §12): the
 * wire file carries the (n)–(s) fixtures plus the restored provenance
 * comments, which pushed it past the 500-line hard cap.
 */

import { createCapSession } from "../src/spawn-caps.ts";
import { pollUntilKilled } from "./lib/poll-until-killed.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function bash(command: string, id?: string) {
  return { type: "toolCall", id: id ?? "x", name: "bash", arguments: JSON.stringify({ command }) };
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

/* (w6) #772 R3 — a SUCCESS-keyed kill armed from the toolResult feed must
   NOT have its grace window re-armed by later message_end traffic. The
   #753-shape child keeps re-issuing the looping command (each a new
   message_end with a DISTINCT fingerprint because the call args differ
   slightly — e.g. a path that changes). The re-key in loopObserver only
   applies to STREAK-armed kills; a success-armed kill must fire after
   graceMs regardless of the re-issuing traffic. */
async function fixture772w6(): Promise<void> {
  const child = { kill: (_sig: string) => {} } as never;
  let s: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "2000" }, async () => {
    s = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 2000,
      childExited: () => false,
    });
    const green = "All tests passed";
    // Arm a success-keyed kill: 6 identical green results through the
    // toolResult feed (each a distinct call id but identical fingerprint).
    for (let i = 0; i < 6; i++) {
      const callId = `w6-${i}`;
      s.loopObserver?.([bash("bun test", callId)], i * 2);
      s.toolResultObserver?.("bash", callId, green, false);
    }
    assert(s.loopArmedFingerprint() !== undefined, "#772(w6): success kill armed");
    assert(!s.loopKilled(), "#772(w6): kill deferred — grace window open");
    // The #753-shape traffic: the child keeps re-issuing the command, each
    // with a DISTINCT fingerprint (a changing path). Under the old code
    // (re-arm on any distinct message_end) the grace clock would reset
    // indefinitely and the kill would never fire. Under the fix, the
    // success-armed kill is immune to this traffic.
    for (let i = 6; i < 14; i++) {
      s.loopObserver?.([bash(`bun test --filter=case-${i}`, `w6-d${i}`)], i * 2);
    }
    const w6ArmedAt = Date.now();
    const w6Fired = await pollUntilKilled(s);
    assert(w6Fired.ok, "#772(w6): kill fires");
    assert(
      w6Fired.at >= w6ArmedAt + 2000,
      `#772(w6): kill after grace, NOT re-armed (${w6Fired.at - w6ArmedAt}ms >= 2000ms)`,
    );
    assert(s.killCause() === "loop", "#772(w6): killCause loop");
    assert(s.loopEvidence()?.kind === "success", "#772(w6): evidence kind success at kill");
    s?.cleanup();
  });
}
await fixture772w6();

console.log(`\nexit ${exit}`);
process.exit(exit);
