#!/usr/bin/env bun
/**
 * A `boundedState()` throw abstains — it never falls back to the caller's RAW state
 * (#1393, HIGH, adversarial lens).
 *
 * `decide()` bounds and redacts the caller's state before any backend, hash or log
 * line sees it. When that pass THROWS (a getter that raises, a cyclic object) the
 * catch used to write `bounded = bounded ?? { state: req.state, count: 0 }` — and on
 * a throw `bounded` is unassigned, so the fallback is the caller's raw, UNREDACTED
 * object, handed to the backend as `BackendInput.state` with a record claiming
 * `redactions: 0`.
 *
 * Today the raw object is UNREACHABLE by luck and nothing else: the throw also leaves
 * `serialised === undefined`, and the guard immediately below it abstains. The fallback
 * is a live gun with the safety on. This test holds the trigger: it asserts the
 * backends are NEVER CALLED and no record carries the credential, so the day the guard
 * moves, inverts, or gains an `else` that trusts `bounded.state`, this file fails
 * instead of shipping a secret.
 *
 * Two shapes, both with a credential in a field the throw never reaches:
 *   - a state whose getter THROWS, so `boundedState` raises before redacting it;
 *   - a CYCLIC state — `redactDeep` overruns the stack — which `JSON.stringify`
 *     alone would also refuse, so both halves of the try block agree it is not JSON.
 *
 * Offline: every backend is a closure, nothing touches the network.
 */

import path from "node:path";
import type { Backend, BackendInput } from "../src/decision-backends.ts";
import { decide } from "../src/decision-seam.ts";
import {
  PROBE_KEY,
  fixtureSpec,
  leaksKey,
  makeAssert,
  records,
  registerFixture,
  tmpDir,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

/**
 * `enforce` so the backend block actually runs: under `shadow` the composition
 * declines to consult a model and the test would prove only that a model was not
 * needed. The env key is `envKey("PI_ENSEMBLE_DECISION_MODE", id)` — one
 * underscore, then the id uppercased with `-` mapped to `_`.
 */
function enforce(id: string): void {
  process.env[`PI_ENSEMBLE_DECISION_MODE_${id.toUpperCase().replaceAll("-", "_")}`] = "enforce";
}

/** A backend that records the exact `BackendInput` it was handed, then abstains. */
function spyBackend(): Backend & { calls: number; inputs: BackendInput[] } {
  const b = {
    name: "spy",
    source: "llm" as const,
    calls: 0,
    inputs: [] as BackendInput[],
    run: async (input: BackendInput) => {
      b.calls++;
      b.inputs.push(input);
      return { ok: false as const, error: "the spy never answers" };
    },
  };
  return b;
}

/** Serialise a value the way a leak-check must: a throw IS the leak-shape here. */
function textOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // An unserialisable object reached the backend: the raw caller object, live,
    // with its credential intact. Report it as hostile text so the assert fires.
    return "<raw unserialisable object handed to the backend> sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d";
  }
}

/** A state whose getter throws, so `boundedState` raises before it redacts `secret`. */
function throwingGetterState(): Record<string, unknown> {
  const s: Record<string, unknown> = { doc: "a doc", secret: PROBE_KEY };
  Object.defineProperty(s, "boom", {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new Error("getter exploded");
    },
  });
  return s;
}

/** A cyclic state that ALSO carries a credential in a field the walk never reaches. */
function cyclicState(): Record<string, unknown> {
  const c: Record<string, unknown> = { doc: "a doc", secret: PROBE_KEY };
  c.self = c;
  return c;
}

async function scenario(label: string, make: () => unknown): Promise<void> {
  const id = `fixture-bounded-${label}`;
  registerFixture(
    fixtureSpec({
      id,
      // `shadow` by default and force `enforce` through the env override, the way an
      // operator does: the contract check reads `defaultMode`, the override does not.
      defaultMode: "shadow",
      fields: { doc: { max: 400, from: "start" } },
    }),
  );
  enforce(id);
  const root = tmpDir("bounded-throw");
  const log = path.join(root, ".pi", "decisions.jsonl");
  const backend = spyBackend();
  const raw = make();

  let threw = false;
  let d: Awaited<ReturnType<typeof decide>> | undefined;
  try {
    d = await decide(id as never, { state: raw, question: "which cause?", rule: "ok" }, {
      backends: [backend],
      repoRoot: root,
    });
  } catch (err) {
    threw = true;
    assert(false, `${label}: decide() never throws (${(err as Error).message})`);
  }

  assert(!threw && d !== undefined, `${label}: decide() returned a decision`);
  // THE HEADLINE: the backends are never constructed with a BackendInput at all.
  assert(
    backend.calls === 0 && backend.inputs.length === 0,
    `${label}: the stub backend was NEVER called — no BackendInput was built (${backend.calls} calls)`,
  );
  // Belt and braces: even if a future refactor does build a BackendInput on this
  // path, it must not be the caller's object. `=== raw` is the leak in its purest
  // form — the unredacted, unbounded state, still live, still holding its getter.
  assert(
    backend.inputs.every((i) => i.state !== raw),
    `${label}: no BackendInput ever carried the caller's raw state object by identity`,
  );
  assert(
    backend.inputs.every((i) => !leaksKey(textOf(i.state), PROBE_KEY)),
    `${label}: no BackendInput carried a window of the credential (${textOf(backend.inputs[0]?.state).slice(0, 90)})`,
  );
  // THE FIX, AND THE ONLY ASSERTION THAT SEES IT. With the old `??` fallback in
  // place the throw still leaves `serialised === undefined`, so the abstention
  // below still fires and every assertion above passes on the UNFIXED code — the
  // raw object sits in `bounded.state`, one refactor away from the backend. The
  // fix is that a throw leaves `bounded` undefined AT ALL: the raw state exists
  // nowhere in the seam's reach, and the note names the fault the fix distinguishes
  // ("could not be bounded", not the merged "bounded or serialised") — the record
  // is the only place the two faults can be told apart after the fact (#1393).
  assert(
    d?.reason?.includes("state could not be bounded") === true &&
      d?.reason?.includes("or serialised") === false,
    `${label}: the note says the state could not be BOUNDED, the distinct fault the fix records (${JSON.stringify(String(d?.reason)).slice(0, 120)})`,
  );
  // And the record's own claim about what it redacted is not a lie about raw text.
  assert(
    d?.abstained === true && d?.source === "rule" && d?.backend === "rule",
    `${label}: the decision is the rule answer, abstained (${d?.source}/${d?.backend})`,
  );
  assert(
    d?.answer === "ok",
    `${label}: the caller got the rule's answer, not a model's (${JSON.stringify(d?.answer)})`,
  );
  assert(
    /state could not be bounded/.test(d?.reason ?? ""),
    `${label}: the reason names the bounding failure (${JSON.stringify(String(d?.reason)).slice(0, 110)})`,
  );

  const recs = records(log);
  assert(recs.length === 1, `${label}: exactly ONE record for the failed call (${recs.length})`);
  const r = recs[0] ?? {};
  // A redaction count is only honest about text that was actually bounded.
  assert(
    !leaksKey(textOf(r), PROBE_KEY),
    `${label}: the record contains no window of the credential (${textOf(r).slice(0, 140)})`,
  );
  assert(
    r.state === "" && r.stateChars === 0,
    `${label}: the record's state is the empty text, never the raw state (${JSON.stringify(String(r.state)).slice(0, 90)})`,
  );
  assert(
    r.redactions === 0,
    `${label}: redactions is 0, which is honest ONLY because nothing was shipped (${JSON.stringify(r.redactions)})`,
  );
}

await scenario("throwing-getter", throwingGetterState);
await scenario("cyclic", cyclicState);

// The one assertion that can tell the fix from the fallback: a state that WOULD have
// had a credential redacted — so a real bounding pass reports a non-zero count — but
// whose throw means no pass ran at all. Under the old `?? {state, count: 0}` fallback
// the record reported 0 while the raw, credential-bearing object sat in `bounded.state`;
// the fix reports 0 because there is nothing to count, and the raw object is gone.
// Distinguishing them needs an observable that survives the abstention, which `reason`
// alone does not give — hence the two half-strings asserted in `scenario`.
{
  const id = "fixture-bounded-healthy";
  registerFixture(
    fixtureSpec({ id, defaultMode: "shadow", fields: { doc: { max: 400, from: "start" } } }),
  );
  enforce(id);
  const backend = spyBackend();
  const d = await decide(id as never, { state: { doc: "a doc" }, question: "q?", rule: "ok" }, {
    backends: [backend],
  });
  assert(
    backend.calls === 1 && d?.abstained === true,
    `a healthy state still reaches the backend, so the guard above is about the throw (${backend.calls} calls)`,
  );
  assert(
    textOf(backend.inputs[0]?.state) === '{"doc":"a doc"}',
    `the healthy backend input is the bounded state (${textOf(backend.inputs[0]?.state)})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
