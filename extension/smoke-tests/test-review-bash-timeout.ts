#!/usr/bin/env bun
/**
 * test-review-bash-timeout.ts — the #2140 per-call bash bound a REVIEWER child
 * carries, driven at the HOOK level through the child-guards fake-pi harness
 * (shared with the #2377 developer arm, which lives in
 * `test-developer-bash-timeout.ts`).
 *
 * What is under test is the mutation of `event.input.timeout`, not Pi's
 * enforcement of it: the hook lowers the timeout and Pi's own bash tool answers
 * the child with its timeout error result (Pi's behaviour is Pi's to test).
 * Every case asks one question of the event object after the loaded hooks have
 * run — is the bound there, is the model's own value kept, is the call
 * untouched — with the role, the caps switch and the knob pinned per case.
 *
 * Nested calls matter: a `bash` made by a codemode script reaches these same
 * handlers with `parentToolCallId` set, and it must be bounded like any other.
 */

import { reviewBashBoundSeconds } from "../src/review-bash-timeout.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  REVIEWER_BOUND as BOUND,
  call,
  reviewer,
  throughFrozenInput,
} from "./lib/bash-timeout-harness.ts";
import { assert, exit as failureExit } from "./merge-guard-helpers.ts";

// ============================================================
// 1. The bound is applied: nothing to clamp, and a too-large value clamped.
// ============================================================
{
  const bare = await reviewer(
    { PI_ENSEMBLE_ROLE: "adversarial-developer" },
    { command: "sleep 99999" },
  );
  assert(
    bare.timeout === BOUND,
    `reviewer bash call with no timeout gets the bound (${BOUND}s; got ${String(bare.timeout)})`,
  );

  const clamped = await reviewer({}, { command: "make", timeout: 7200 });
  assert(
    clamped.timeout === BOUND,
    `a larger timeout is clamped to the bound (got ${String(clamped.timeout)})`,
  );

  const negative = await reviewer({}, { command: "make", timeout: -5 });
  assert(
    negative.timeout === BOUND,
    `a negative timeout is not "smaller" and is replaced (got ${String(negative.timeout)})`,
  );
}

// ============================================================
// 2. A bound the model chose for itself is kept: the hook only ever lowers.
// ============================================================
{
  const kept = await reviewer({}, { command: "bun test", timeout: 240 });
  assert(kept.timeout === 240, `a smaller timeout is kept (got ${String(kept.timeout)})`);

  const exact = await reviewer({}, { command: "bun test", timeout: BOUND });
  assert(
    exact.timeout === BOUND,
    `a timeout equal to the bound is left alone (got ${String(exact.timeout)})`,
  );
}

// ============================================================
// 3. Role scoping: only the two bounded roles are touched, and no other tool is.
//    #2377 R1 — `developer` moved OUT of this loop into the bounded case below;
//    ops, explore and the unset role (the PM session) stay untouched.
// ============================================================
for (const role of ["ops", "explore", undefined]) {
  const out = await call({ PI_ENSEMBLE_ROLE: role }, "bash", { command: "sleep 99999" });
  assert(
    !("timeout" in out),
    `role ${String(role)}: bash call is untouched (input ${JSON.stringify(out)})`,
  );
}

const readUntouched = await call({ PI_ENSEMBLE_ROLE: "code-review-specialist" }, "read", {
  file_path: "docs/configuration.md",
});
assert(
  !("timeout" in readUntouched),
  `a non-bash tool call is untouched (read input ${JSON.stringify(readUntouched)})`,
);

// ============================================================
// 4. The caps master switch makes the hook inert, like every other bound.
// ============================================================
{
  const inert = await reviewer({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, { command: "sleep 99999" });
  assert(
    !("timeout" in inert),
    `PI_ENSEMBLE_DISPATCH_CAPS=0 leaves the call untouched (${JSON.stringify(inert)})`,
  );
}

// ============================================================
// 5. The knob: garbage, zero, negative or empty means NO bound at all — the
//    dangerous direction (an unbounded call) beats an invented one (0 or NaN,
//    which Pi's schema rejects and the child loses the call over).
// ============================================================
// An EMPTY knob is the operator saying "default", the same rule the sibling
// review knobs apply; garbage, zero and negative are NO bound — the dangerous
// direction (an unbounded call) beats an invented one (0 or NaN, which Pi's
// schema rejects and the child loses the call over).
{
  const empty = await reviewer(
    { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "" },
    { command: "sleep 99999" },
  );
  assert(
    empty.timeout === BOUND,
    `an empty knob is the default, not garbage (got ${String(empty.timeout)})`,
  );
}
for (const garbage of ["0", "-1", "abc", "NaN", "Infinity"]) {
  const out = await reviewer(
    { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: garbage },
    { command: "sleep 99999" },
  );
  assert(
    !("timeout" in out),
    `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS="${garbage}" means no bound (got ${String(out.timeout)})`,
  );
}

// `Number()` alone was too generous a reader: an exponent is a bound no one can
// honour, a hex literal is a bound no one typed, a fraction of a millisecond is
// a bound no one means, and a value past Pi's own ceiling is one the bash schema
// would reject — all of them mean no bound. A sub-second bound ("999") is refused
// outright: the hook's unit is Pi's whole second, so 999 ms would round up to a
// 1 s bound the operator never typed.
for (const unparseable of [
  "1e308",
  "0x10",
  "2147484000",
  "2147483647000",
  "1.5",
  "0.4",
  "999",
  "2147482999.9",
]) {
  const out = await reviewer(
    { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: unparseable },
    { command: "sleep 99999" },
  );
  assert(
    !("timeout" in out),
    `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS="${unparseable}" is not a whole ms count in range — no bound (got ${String(out.timeout)})`,
  );
}

const raised = await reviewer(
  { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "90000" },
  { command: "sleep 99999" },
);
assert(
  raised.timeout === 90,
  `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS=90000 bounds to 90s (got ${String(raised.timeout)})`,
);

const rounded = await reviewer(
  { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "1500" },
  { command: "sleep 99999" },
);
assert(
  rounded.timeout === 2,
  `a 1500 ms knob rounds UP to a whole second, never to 0 (got ${String(rounded.timeout)})`,
);

// The floor of the accepted range: exactly one second, in the knob's own unit.
const floor = await reviewer(
  { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "1000" },
  { command: "sleep 99999" },
);
assert(floor.timeout === 1, `the 1000 ms floor is accepted as 1s (got ${String(floor.timeout)})`);

// The top of the accepted range, judged on the SECONDS the hook writes: Pi
// re-expands `seconds * 1000` and throws past its own maximum, so the last
// accepted ms count is the one that still rounds to a runnable second, and the
// next whole ms count is out of range rather than a bound Pi would refuse (#2377).
const atCeiling = await reviewer(
  { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "2147483000" },
  { command: "sleep 99999" },
);
assert(
  atCeiling.timeout === 2_147_483,
  `the ceiling itself is accepted as ${2_147_483}s (got ${String(atCeiling.timeout)})`,
);

for (const over of ["2147483001", "2147483647"]) {
  const out = await reviewer(
    { PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: over },
    { command: "sleep 99999" },
  );
  assert(
    !("timeout" in out),
    `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS="${over}" rounds to seconds Pi would refuse — no bound (got ${String(out.timeout)})`,
  );
}

// The reader itself, so the documented default and the hook's cannot drift.
await withEnv({ PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: undefined }, async () => {
  assert(
    reviewBashBoundSeconds() === BOUND,
    `the knob's default is ${BOUND}s / 600000 ms (got ${String(reviewBashBoundSeconds())})`,
  );
});

// ============================================================
// 6. Nested calls (a codemode script's bash) reach the same handlers and are
//    bounded too.
// ============================================================
{
  const nested = await reviewer({}, { command: "sleep 99999" }, "call_1/2");
  assert(
    nested.timeout === BOUND,
    `a nested call (parentToolCallId set) is clamped to the bound (got ${String(nested.timeout)})`,
  );

  const nestedClamped = await reviewer({}, { command: "sleep 99999", timeout: 3600 }, "call_1/2");
  assert(
    nestedClamped.timeout === BOUND,
    `a nested call's larger timeout is clamped (got ${String(nestedClamped.timeout)})`,
  );
}

// ============================================================
// 6. Values the model itself wrote that are not usable timeouts. A huge or
//    non-numeric timeout is CLAMPED to the bound (it is the model's, not the
//    operator's, so there is no knob to disbelieve); a missing or non-object
//    input is left alone; a frozen input must not throw — into the companion's
//    fail-closed wrapper a throw would read as a refusal of the call.
// ============================================================
{
  const huge = await reviewer({}, { command: "sleep 99999", timeout: 9e15 });
  assert(
    huge.timeout === BOUND,
    `a model timeout of 9e15 is clamped to the bound (got ${String(huge.timeout)})`,
  );

  const stringy = await reviewer({}, { command: "sleep 99999", timeout: "120" });
  assert(
    stringy.timeout === BOUND,
    `a string timeout is replaced by the bound (got ${String(stringy.timeout)})`,
  );

  // A null input reaches the handler as `null` (the harness mirrors Pi's event
  // shape), so the early return is the only thing standing between it and the
  // write below. Removed, the assignment throws `null is not an object`.
  const nullInput = await call({ PI_ENSEMBLE_ROLE: "code-review-specialist" }, "bash", null);
  assert(
    nullInput === null,
    `a null input neither throws nor is written to (${JSON.stringify(nullInput)})`,
  );

  // A frozen object: the write neither throws nor blocks, and the call keeps
  // the shape the model wrote (an unbounded call beats a refused one).
  const frozen = Object.freeze({ command: "sleep 99999" }) as Record<string, unknown>;
  const frozenRun = await throughFrozenInput("code-review-specialist", frozen);
  assert(
    !frozenRun.threw && !frozenRun.blocked && !("timeout" in frozen),
    `a frozen input neither throws nor blocks (${JSON.stringify(frozenRun)})`,
  );
}

console.log(`\nexit ${failureExit}`);
process.exit(failureExit);
