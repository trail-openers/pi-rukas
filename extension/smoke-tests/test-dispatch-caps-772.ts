#!/usr/bin/env bun
/**
 * #772 — the success-keyed counter end-to-end through the CapSession seam.
 *
 * Moved verbatim from test-dispatch-caps.ts (file-size split).
 */

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
    // If the grace window is still open, wait for it to elapse.
    if (!session.loopKilled()) {
      await new Promise((r) => setTimeout(r, 2400));
    }
    assert(session.loopKilled(), "#772: success-keyed kill fires after the grace window");
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
