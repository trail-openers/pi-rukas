#!/usr/bin/env bun
/**
 * #772 — the success-keyed counter end-to-end through the CapSession seam.
 *
 * Moved verbatim from test-dispatch-caps.ts (file-size split).
 */

import { pollUntilKilled } from "./lib/poll-until-killed.ts";
import { createCapSession } from "../src/spawn-caps.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// #772 — the success-keyed counter end-to-end through the CapSession seam:
// a non-adjacent green re-run (the #753 incident shape) must steer once
// (source "driver-success-keyed") and kill with loopEvidence kind: "success"
// after the grace window. Fails without the fix (the seam had no
// toolResultObserver at all — the success counter was unreachable from
// production).
// ---------------------------------------------------------------------------
{
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  const steers: Array<{ msg: string; src: string }> = [];
  process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = "2000";
  let session: ReturnType<typeof createCapSession>;
  try {
    session = createCapSession({
      role: "developer",
      child,
      onSteer: (m, src) => steers.push({ msg: m, src: String(src) }),
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 2000,
      childExited: () => false,
    });
    // Lower bound on the arm time (captured before the arming loop): the
    // 500 ms poll tick is not aligned to arming, so measuring after the arm
    // can overstate it; a lower bound still catches a grace-0 regression.
    const armedAt = Date.now();
    const green = "All tests passed in 0.8s";
    // 7 identical green re-issues (kill at 6), each interleaved with a
    // distinct read (non-adjacent — the streak counter cannot see this shape).
    for (let i = 0; i < 7; i++) {
      const callId = `cap772-${i}`;
      session.loopObserver?.(
        [{ type: "toolCall", id: callId, name: "bash", arguments: '{"command":"bun test"}' }],
        i * 2,
      );
      session.toolResultObserver?.("bash", callId, green, false);
      if (i < 6) {
        session.loopObserver?.(
          [
            {
              type: "toolCall",
              id: `cap772-r${i}`,
              name: "read",
              arguments: '{"path":"src/x.ts"}',
            },
          ],
          i * 2 + 1,
        );
      }
    }
    // Grace window is open (2s) — the kill is deferred while the child has
    // its report window. This is the "chance to REPORT before being killed"
    // the ticket's AC requires. The poll will fire the kill after 2s.
    assert(
      !session.loopKilled() || session.killCause() === "loop",
      "#772: kill either deferred (grace) or fired (race)",
    );
    // Poll until the 500 ms grace poll in spawn-caps.ts fires the kill
    // (the kill lands in [grace, grace + tick]; a fixed sleep raced it on
    // slow runners — #846). The clock check below still proves the kill
    // fired AFTER the grace window, not before.
    const fired = await pollUntilKilled(session, 2000);
    assert(fired.ok, `#772: success-keyed kill fires (kill did not fire within ${2000 + 5000} ms of polling)`);
    assert(
      fired.at >= armedAt + 2000,
      `#772: success-keyed kill fires after the grace window (kill at ${fired.at - armedAt}ms vs grace 2000ms)`,
    );
    assert(
      session.loopEvidence()?.kind === "success",
      "#772: loopEvidence kind:success (typed kill)",
    );
    assert(steers.length === 1, "#772: exactly one steer (the report-demanding one)");
    assert(steers[0]?.src === "driver-success-keyed", "#772: steer source is driver-success-keyed");
    assert(
      steers[0]?.msg.includes("same successful output"),
      `#772: steer text names the identical-output shape (got: ${steers[0]?.msg?.slice(0, 120)})`,
    );
    assert(session.killCause() === "loop", "#772: killCause is loop");
  } finally {
    process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = undefined;
    session?.cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
