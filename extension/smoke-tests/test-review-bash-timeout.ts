#!/usr/bin/env bun
/**
 * test-review-bash-timeout.ts — the #2140 per-call bash bound a reviewer child
 * carries, driven at the HOOK level through the child-guards fake-pi harness.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { reviewBashBoundSeconds } from "../src/review-bash-timeout.ts";
import { assert, exit as failureExit } from "./merge-guard-helpers.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeFakePi } from "./test-child-guards-helpers.ts";

/** The default bound, in the SECONDS Pi's bash schema takes. */
const BOUND = 600;

/**
 * Drive one tool call through the hooks the companion actually installs, with
 * the child environment pinned. Returns the (possibly mutated) input.
 */
async function call(
  env: Record<string, string | undefined>,
  toolName: string,
  input: Record<string, unknown>,
  parentToolCallId?: string,
): Promise<Record<string, unknown>> {
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const event: Record<string, unknown> = { toolName, input };
  if (parentToolCallId !== undefined) event.parentToolCallId = parentToolCallId;
  await withEnv({ PI_ENSEMBLE_ROLE: "code-review-specialist", ...env }, async () => {
    for (const h of fake.handlers.tool_call ?? []) await h(event, {});
  });
  return event.input as Record<string, unknown>;
}

/** A reviewer's bash call (the role both reviewer roles share the hook with). */
const reviewer = (
  env: Record<string, string | undefined>,
  input: Record<string, unknown>,
  parentToolCallId?: string,
) => call(env, "bash", input, parentToolCallId);

// ============================================================
// 1. The bound is applied: nothing to clamp, and a too-large value clamped.
// ============================================================
{
  const bare = await reviewer({ PI_ENSEMBLE_ROLE: "adversarial-developer" }, { command: "sleep 99999" });
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
// 3. Role scoping: only reviewer roles are bounded, and no other tool is.
// ============================================================
for (const role of ["developer", "ops", undefined]) {
  const out = await call({ PI_ENSEMBLE_ROLE: role }, "bash", { command: "sleep 99999" });
  assert(
    !("timeout" in out),
    `role ${String(role)}: bash call is untouched (input ${JSON.stringify(out)})`,
  );
}

const readUntouched = await call(
  { PI_ENSEMBLE_ROLE: "code-review-specialist" },
  "read",
  { file_path: "docs/configuration.md" },
);
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
  const empty = await reviewer({ PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "" }, { command: "sleep 99999" });
  assert(
    empty.timeout === BOUND,
    `an empty knob is the default, not garbage (got ${String(empty.timeout)})`,
  );
}
for (const garbage of ["0", "-1", "abc", "NaN", "Infinity"]) {
  const out = await reviewer({ PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: garbage }, { command: "sleep 99999" });
  assert(
    !("timeout" in out),
    `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS="${garbage}" means no bound (got ${String(out.timeout)})`,
  );
}

const raised = await reviewer({ PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "90000" }, { command: "sleep 99999" });
assert(
  raised.timeout === 90,
  `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS=90000 bounds to 90s (got ${String(raised.timeout)})`,
);

const rounded = await reviewer({ PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS: "1500" }, { command: "sleep 99999" });
assert(
  rounded.timeout === 2,
  `a sub-second knob value rounds UP to a whole second, never to 0 (got ${String(rounded.timeout)})`,
);

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

console.log(`\nexit ${failureExit}`);
process.exit(failureExit);
