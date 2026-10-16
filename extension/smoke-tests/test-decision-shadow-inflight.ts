#!/usr/bin/env bun
/**
 * The shadow call's in-flight slot never leaks (#1393).
 *
 * `shadowDecide` takes a slot from a counter capped at 16 and releases it in a
 * `finally`. Before the fix the increment happened BEFORE the promise chain was
 * built, so a throw while building it — a `setImmediate` whose implementation
 * throws, a throwing clock — left the slot held forever. 16 such calls disable
 * every shadow seam for the life of the process, leaving nothing but dropped-call
 * warnings, and no test had ever read the counter, so the leak was invisible by
 * construction. Split out from test-decision-shadow-seams.ts to keep both files
 * under the 500-line cap.
 *
 *   - the counter is observable, saturates at the cap, and returns to 0;
 *   - a call whose backend never settles still releases on the seam's own bound;
 *   - 20 calls whose scheduler throws leave the counter at 0, not 20;
 *   - after the leak scenario clears, a further call still fires.
 */

import {
  __acquireSlotForTests,
  __inFlightForTests,
  __resetShadowForTests,
  shadowDecide,
} from "../src/decision-shadow.ts";
import { makeAssert, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

const req = { question: "q", state: {}, rule: "unknown" };

{
  const root = tmpDir("shadow-leak");
  const where = { repoRoot: root, issues: [22] };

  // 1. Observability and saturation. The counter is driven through the seam's
  //    own increment/release pair, because `shadowDecide` runs its guards first
  //    and releases before any backend runs — a test cannot make it nonzero by
  //    handing `shadowDecide` a slow state, which is the mistake this hook
  //    exists to prevent.
  const holders: (() => void)[] = [];
  for (let i = 0; i < 4; i++) holders.push(__acquireSlotForTests());
  assert(
    __inFlightForTests() === 4,
    `the counter is observable: ${__inFlightForTests()} call(s) in flight, expected 4`,
  );
  // Saturation is what the leak would cause permanently: at the cap, further
  // calls are dropped as "already in flight" rather than queued behind a slow model.
  const capHolders = Array.from({ length: 12 }, () => __acquireSlotForTests());
  assert(__inFlightForTests() === 16, "the counter reaches the 16-call cap");
  for (const release of [...holders, ...capHolders]) release();
  assert(
    __inFlightForTests() === 0,
    "every acquired slot is released, so the counter returns to 0",
  );

  // 2. A chain whose backend never settles must still release its slot: the
  //    seam's own bound ends it, not the caller.
  process.env.PI_ENSEMBLE_DECISION_TIMEOUT_MS_FAILURE_CAUSE = "60";
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    pending.push(
      shadowDecide(
        "failure-cause",
        { question: "q", state: { kind: "dispatch-failed", lastOutput: "x" }, rule: "unknown" },
        where,
      ),
    );
  }
  await Promise.all(pending);
  assert(
    __inFlightForTests() === 0,
    "inFlight returns to 0 once the chains are done, with nothing ever settling",
  );
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_TIMEOUT_MS_FAILURE_CAUSE");

  // 3. The leak itself: with the slot taken and `setImmediate` throwing on the
  //    way in, the pre-#1393 shape incremented and never decremented.
  const realSetImmediate = globalThis.setImmediate;
  try {
    __resetShadowForTests({ inFlight: true });
    globalThis.setImmediate = (() => {
      throw new Error("scheduler exploded");
    }) as never;
    for (let i = 0; i < 20; i++) {
      const out = await shadowDecide("failure-cause", req, where);
      assert(out === undefined, `a throwing scheduler yields undefined, call ${i}`);
    }
    assert(
      __inFlightForTests() === 0,
      "20 calls whose setImmediate threw leave inFlight at 0, not 20 (the leak #1393 closes)",
    );
  } finally {
    globalThis.setImmediate = realSetImmediate;
    __resetShadowForTests({ inFlight: true });
  }

  // 4. After the leak scenario clears, a fresh call fires rather than being
  //    dropped as "already in flight".
  const after = await shadowDecide("failure-cause", req, where);
  assert(
    !!after?.abstained,
    "a further call after the leak still fires (answered from the rule, no session attached)",
  );
}

process.exit(state.exit);
