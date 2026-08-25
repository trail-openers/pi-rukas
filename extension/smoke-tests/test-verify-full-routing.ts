#!/usr/bin/env bun
/**
 * A failing full verification must not reach `merged`.
 *
 * `runCi` runs a second, stricter verification before it watches CI —
 * `.pi/verify-cmd-full`, which in this repo runs `tsc --noEmit`, `bun run check`
 * and the vipune fixture suites with `PI_ENSEMBLE_VIPUNE_REQUIRED=1`, i.e.
 * strictly more than CI does. On failure (`work-driver-stepback-ci.ts:202-229`)
 * it appends `verify-full-status: failure`, bumps `ciRetryCount`, and returns —
 * emitting **no** `ci-status` and no cap-hit until the retry cap is blown.
 *
 * `nextStep` had no branch for `verify-full-status`, so the tail fell through to
 * the linear table, where `ci: "merged"`. The step's own comment says "the
 * ci-retry cap will fire on the next iteration"; there is no next iteration,
 * because the cycle has already left `ci`.
 *
 * Measured before the fix:
 *
 *     tail=verify-full-status:failure  ->  merged
 *     tail=ci-status:failure           ->  develop
 *
 * `verifyFullEnabled()` is opt-OUT and this repo ships `.pi/verify-cmd-full`, so
 * this was live on every pi-ensemble cycle.
 */

import { MAX_CI_RETRIES, nextStep } from "../src/work-driver-context.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
// #533 — nextStep returns a discriminated result; unwrap for comparisons.
const stepOf = (s: WorkState): string => {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
};

const atCi = (tail: WorkEvent, ciRetryCount = 1): WorkState =>
  ({
    issue: 1,
    issues: [1],
    pipelineState: {
      status: "running",
      currentStep: "ci",
      lastCompletedStep: "lens-review",
      reviewRound: 0,
      inFlightJobIds: [],
      ciRetryCount,
    },
    eventLog: [tail],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any as WorkState;

const verifyFull = (status: "success" | "failure"): WorkEvent =>
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  ({ kind: "verify-full-status", at: 1, status, ms: 1000 }) as any as WorkEvent;

// ------------------------------------------------------------- the canary

{
  const step = stepOf(atCi(verifyFull("failure")));
  assert(
    step !== "merged",
    `canary: a FAILING verify-full does not route to merged (got "${step}") — it did, on every cycle`,
  );
  assert(
    step === "develop",
    `...it routes back to develop, exactly as ci-status:failure does (got "${step}")`,
  );
}

// ------------------------------------------- success is unchanged, and matters

{
  assert(
    stepOf(atCi(verifyFull("success"))) === "merged",
    "a PASSING verify-full still routes to merged — the fix must not stall the happy path",
  );
}

// -------------------------------- the two events agree, because they must

{
  // `ci-status` was always routed correctly. The bug was that its sibling was
  // not, so the two are asserted together: whatever the retry policy is, it is
  // the same policy for both.
  const ciFail = { kind: "ci-status", at: 1, status: "failure" } as unknown as WorkEvent;
  for (const count of [0, 1, MAX_CI_RETRIES, MAX_CI_RETRIES + 1]) {
    const viaCi = stepOf(atCi(ciFail, count));
    const viaFull = stepOf(atCi(verifyFull("failure"), count));
    assert(
      viaCi === viaFull,
      `at ciRetryCount=${count} both failure signals route the same way (ci-status→${viaCi}, verify-full→${viaFull})`,
    );
  }
}

{
  // And the cap still terminates. A permanently failing verification must not
  // spin develop → adversarial → lens → ci forever.
  assert(
    stepOf(atCi(verifyFull("failure"), MAX_CI_RETRIES)) === "handoff",
    "canary: at the retry cap a failing verify-full parks rather than looping",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
