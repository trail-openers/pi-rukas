#!/usr/bin/env bun
/**
 * #1756 round 2 — `echoMatchesCall`: the rule that binds a companion's echo of
 * the arguments it recorded to the CALL it claims to describe.
 *
 * The echo is untrusted input. Bound to nothing it is a second channel for the
 * same fields, and one that can WIDEN `paths` (the authorised set every scope
 * gate reads), EMPTY `outOfScope` (deleting the fence the developer is held to)
 * or MINT an id the transcript never contains is an override of the plan, not a
 * report of it (lens HIGH + MEDIUM). So the parent accepts an echoed value only
 * when it is a COERCION of the raw call, field by field, and refuses it with
 * "the recorded workstream does not match the call" otherwise.
 *
 * What a normalisation may do — and therefore what an echo may be — is exactly
 * two things: a single string standing in for a one-element array, and a
 * number/boolean standing in for its `String(...)`. Plus Pi's
 * `normalizeOptionalNulls`, which DROPS a `null` optional. Nothing else: no
 * added key, no dropped non-null key, no renamed `id`, no changed element.
 *
 * This file judges the RULE, pure, in both directions — a gate that has only
 * ever been observed refusing is as unproven as one never observed accepting —
 * and the one fixture-hygiene invariant the simulated child must hold: a call
 * the companion would REFUSE carries no echo.
 * The reader's use of the rule (refusals, traceWarns, duplicates, the no-echo
 * fallback) is the other half: test-plan-coercion-1756.ts.
 */

import { echoMatchesCall } from "../src/plan-workstream-schema.ts";
import { planResultFromRawCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CALL = {
  id: "task-a",
  scope: "the fix",
  paths: ["src/a.ts", "src/b.ts"],
  outOfScope: ["docs/"],
  dependsOn: ["task-b"],
};

// ---------------------------------------- accepted: what a coercion really is

{
  const accepted: Array<[string, unknown, unknown]> = [
    ["an identical object", CALL, { ...CALL }],
    [
      "a single string standing for a one-element array",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: "docs/" },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: ["docs/"] },
    ],
    [
      "a number standing for its string",
      { id: "task-a", scope: 7, paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: "7", paths: ["src/a.ts"], outOfScope: [] },
    ],
    [
      "a boolean standing for its string",
      { id: "task-a", scope: true, paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: "true", paths: ["src/a.ts"], outOfScope: [] },
    ],
    [
      "a number element standing for its string",
      { id: "task-a", scope: "s", paths: [5], outOfScope: [] },
      { id: "task-a", scope: "s", paths: ["5"], outOfScope: [] },
    ],
    [
      "a scalar standing for a one-element array of its string",
      { id: "task-a", scope: "s", paths: "src/a.ts", outOfScope: [] },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: [] },
    ],
    [
      "a null optional dropped (normalizeOptionalNulls)",
      { ...CALL, integrationTest: null },
      { ...CALL },
    ],
    [
      "a whole string standing for a one-element array, punctuation included",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: "docs/, src/secret.ts" },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: ["docs/, src/secret.ts"] },
    ],
    [
      "a null optional present as null in the echo too",
      { ...CALL, dependsOn: null },
      { ...CALL, dependsOn: null },
    ],
  ];
  for (const [label, raw, echo] of accepted) {
    const r = echoMatchesCall(raw, echo);
    assert(r.ok === true, `${label} is a coercion the binding accepts (got ${JSON.stringify(r)})`);
  }
}

// -------------------------------------- refused: what an echo must never be

{
  const refused: Array<[string, unknown, unknown]> = [
    [
      "widened paths — one extra authorised file",
      CALL,
      { ...CALL, paths: ["src/a.ts", "src/b.ts", "src/secret.ts"] },
    ],
    [
      "replaced paths — the authorised set swapped",
      CALL,
      { ...CALL, paths: ["src/other.ts", "src/other2.ts"] },
    ],
    ["emptied outOfScope — the fence deleted", CALL, { ...CALL, outOfScope: [] }],
    [
      "replaced outOfScope — the fence rewritten",
      CALL,
      { ...CALL, outOfScope: ["nothing at all"] },
    ],
    ["a minted id", CALL, { ...CALL, id: "task-z" }],
    ["an id coerced from a number", CALL, { ...CALL, id: 5 }],
    ["an added key", CALL, { ...CALL, extra: "x" }],
    // SYMMETRY (#1756 round 3): an unknown key was refused, but a Schema key the
    // model never SENT was not — so an echo could mint a whole optional field and
    // have it reach state. Each of the four optionals is tested on its own, so a
    // regression that reopens one is named.
    ["an added dependsOn the call never sent", CALL, { ...CALL, integrationTest: "t.test.ts" }],
    ["an added integrationTest the call never sent", CALL, { ...CALL, dependsOn: ["x"] }],
    ["an added introduces the call never sent", CALL, { ...CALL, introduces: ["Foo"] }],
    ["an added consumes the call never sent", CALL, { ...CALL, consumes: ["Bar"] }],
    [
      "an added integrationTest on a call that sent no optional at all",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: [], integrationTest: "t.ts" },
    ],
    [
      "half a fence: one string echoed as an array holding only its first part",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: "docs/, src/secret.ts" },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: ["docs/"] },
    ],
    [
      "half a fence quoted: the element is a prefix of the raw string",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: "the public API of foo" },
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: ["the public API"] },
    ],
    [
      "a number whose one-element echo is not its String()",
      { id: "task-a", scope: 7, paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: ["77"], paths: ["src/a.ts"], outOfScope: [] },
    ],
    [
      "an added schema key whose value duplicates a raw one's prefix",
      CALL,
      { ...CALL, introduces: ["src/a.ts"] },
    ],
    ["a dropped non-null key", CALL, { id: "task-a", scope: "the fix", paths: CALL.paths }],
    ["a scope that is simply different", CALL, { ...CALL, scope: "something else" }],
    [
      "an array of the wrong length",
      { id: "task-a", scope: "s", paths: "src/a.ts", outOfScope: [] },
      { id: "task-a", scope: "s", paths: ["src/a.ts", "src/b.ts"], outOfScope: [] },
    ],
    [
      "an array whose element differs",
      CALL,
      { ...CALL, paths: ["src/a.ts", "../secrets/.env"] },
    ],
    [
      "an object where a string belongs",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: { s: 1 }, paths: ["src/a.ts"], outOfScope: [] },
    ],
    [
      "a null where the call sent a string",
      { id: "task-a", scope: "s", paths: ["src/a.ts"], outOfScope: [] },
      { id: "task-a", scope: null, paths: ["src/a.ts"], outOfScope: [] },
    ],
    ["an empty echo for a real call", CALL, {}],
  ];
  for (const [label, raw, echo] of refused) {
    const r = echoMatchesCall(raw, echo);
    assert(r.ok === false, `${label} is refused (got ${JSON.stringify(r)})`);
  }
}

// ------------------------- refused payloads: not an object is not a report

{
  for (const [label, echo] of [
    ["null", null],
    ["a string", "task-a"],
    ["an array", [CALL]],
    ["undefined", undefined],
    ["a number", 5],
  ] as Array<[string, unknown]>) {
    const r = echoMatchesCall(CALL, echo);
    assert(r.ok === false, `an echo that is ${label} is refused`);
  }
  // A raw call that is not an object cannot have an echo either — including the
  // null prototype a JSON.parse of `__proto__` can produce on the other side.
  const r = echoMatchesCall(null, { ...CALL });
  assert(r.ok === false, "an echo against a call that is not an object is refused");
}

// -------------------------------------- the differing key is named, not vague

{
  const widened = echoMatchesCall(CALL, { ...CALL, paths: ["src/a.ts"] });
  assert(
    widened.ok === false && widened.keys.join() === "paths",
    `a mismatch names the differing key (got ${JSON.stringify(widened)})`,
  );
  const twoBad = echoMatchesCall(CALL, { ...CALL, scope: "x", outOfScope: [] });
  assert(
    twoBad.ok === false &&
      twoBad.keys.length === 2 &&
      twoBad.keys.includes("scope") &&
      twoBad.keys.includes("outOfScope"),
    `every differing key is named, not just the first (got ${JSON.stringify(twoBad)})`,
  );
  const unknownKey = echoMatchesCall(CALL, { ...CALL, bogus: 1 });
  assert(
    unknownKey.ok === false &&
      unknownKey.keys.length === 1 &&
      unknownKey.keys[0]?.startsWith("bogus") === true,
    `an unknown key in the echo is named and refused (got ${JSON.stringify(unknownKey)})`,
  );
  // The added-field refusal names the key AND says it was added, so an operator
  // reading the trace can tell "the echo invented a field" from "the echo
  // changed one" — the two need different follow-ups. The call never sent
  // `introduces`, and its other fields all match the echo byte for byte, so the
  // added-key rule is the ONLY rule in the binding that can refuse this pair:
  // were it removed the result would be `ok`, not a vaguer key name.
  const added = echoMatchesCall(CALL, { ...CALL, introduces: ["Thing"] });
  assert(
    added.ok === false &&
      added.keys.length === 1 &&
      added.keys[0] === "introduces(added by the echo)",
    `a field the echo invented is named as added (got ${JSON.stringify(added)})`,
  );
  // A key that exists in the call with a `null` value may still disappear — the
  // null-drop rule and the added-key rule must not collide.
  const droppedNull = echoMatchesCall({ ...CALL, integrationTest: null }, { ...CALL });
  assert(
    droppedNull.ok === true,
    `a null optional may still be dropped by the echo (got ${JSON.stringify(droppedNull)})`,
  );
}

// ---------------- a refused fixture has no echo, because nothing was recorded

{
  // The helper that SIMULATES the plan child (smoke-tests/lib/plan-workstream-
  // calls.ts) must not model a companion that recorded what it says it refused.
  // The real companion throws before it records anything, so every fixture the
  // companion would refuse — the shapes PM named (an id past the schema's 80, a
  // bare string where an array belongs) and its own refusals (a bad path, a
  // duplicate id) — has to be an error result with NO `details`. Pinned on the
  // fixture itself, not only on the reader's verdict, so a helper that grew an
  // echo on a refused call fails here rather than quietly teaching the reader to
  // accept a shape the child never recorded.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["an 81-character id", { id: "a".repeat(81), scope: "s", paths: ["p"], outOfScope: [] }],
    [
      "a bare string for an array",
      { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: "docs/" },
    ],
    ["a traversing path", { id: "task-a", scope: "a", paths: ["../x"], outOfScope: [] }],
  ];
  for (const [label, args] of cases) {
    const fixture = planResultFromRawCalls([{ id: "task-a", args }]);
    const result = fixture.toolResults[0];
    assert(
      result?.isError === true && result.details === undefined,
      `a fixture the companion refuses (${label}) is an error result with no echo (got ${JSON.stringify(result)})`,
    );
  }
  // A duplicate of an ACCEPTED call is refused by the companion's own rule, and
  // only the first call carries an echo.
  const dup = planResultFromRawCalls([
    { id: "task-a", args: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] } },
    { id: "task-a", args: { id: "task-a", scope: "b", paths: ["src/b.ts"], outOfScope: [] } },
  ]);
  assert(
    dup.toolResults[0]?.isError === false && dup.toolResults[0]?.details !== undefined,
    "the accepted call of a duplicate pair carries the echo",
  );
  assert(
    dup.toolResults[1]?.isError === true && dup.toolResults[1]?.details === undefined,
    "the duplicate call is refused and echoes nothing",
  );
  // `noEcho` models an older companion on an ACCEPTED call: success, no carrier.
  const legacy = planResultFromRawCalls([
    {
      id: "task-a",
      args: { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      noEcho: true,
    },
  ]);
  assert(
    legacy.toolResults[0]?.isError === false && legacy.toolResults[0]?.details === undefined,
    "noEcho models a success result from a companion that echoes nothing",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
