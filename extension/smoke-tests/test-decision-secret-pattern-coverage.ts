#!/usr/bin/env bun
/**
 * Every arm of `SECRET_PATTERNS` has a fixture, and the two bounded passes agree
 * with the unbounded one (#1393, round 2).
 *
 * Three claims, each one a gap the previous fixture set could hide:
 *
 *   1. **Every arm matches at least one CASES entry unbounded.** A provider-alphabet
 *      gap is invisible to a fixture set that never names the shape: `ghp_…_E` and
 *      `npm_…_0` both returned `count: 0` from every pattern in the set while the
 *      whole suite stayed green, because no case contained a base64url tail for those
 *      two arms. This is the same "gate never observed to fail" defect the file-size
 *      cap guards against, applied to the pattern set: an arm with no fixture is an
 *      arm nobody has ever seen fire, and a rewrite of its character class is then
 *      untested by definition.
 *
 *   2. **The bounded passes report what the unbounded one reports.** Item 9 is a
 *      bounded-pass bug and nothing else: `redactDeep({evidence}, counter, 4000)`
 *      shipped `"password=Sup3rSecretValue99"` whole with `counter.n === 0`, and
 *      `redactBounded(t, 2600, "start")` did the same, while `redactSecrets(t)` on the
 *      identical string reported a redaction. A test that only ever asked the
 *      unbounded question could not see it — which is why the sweep below runs every
 *      case at both edges across the bound range where the walk reaches its cap.
 *
 *   3. **`redactDeep` redacts object KEYS.** It redacted values only, so
 *      `{"tok:sk-ant-…": "v"}` shipped the key verbatim while the value looked clean
 *      and the count described only half the record.
 *
 * Offline: pure string work, no I/O, no network, no child process.
 */

import { redactBounded, redactDeep, redactSecrets } from "../src/decision-log.ts";
import { SECRET_PATTERNS } from "../src/secret-patterns.ts";
import { leaksKey, makeAssert } from "./lib/decision-fixtures.ts";
import { CASES, MUST_NOT_REDACT } from "./lib/redaction-context-cases.ts";

const { assert, state } = makeAssert();

const globalOf = (re: RegExp) =>
  new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

// ------------------------------------ 1. every arm has at least one fixture that fires

/**
 * How many CASES entries each arm matches, whole. Counted per arm rather than
 * "did anything match anything", because the failure mode is one silent arm among
 * several loud ones: a shared total would be paid for entirely by the sk- arms.
 */
const hitsByArm = SECRET_PATTERNS.map(() => 0);
for (const { secret } of CASES) {
  SECRET_PATTERNS.forEach((re, i) => {
    if (re.test(secret)) hitsByArm[i] = (hitsByArm[i] ?? 0) + 1;
  });
}
SECRET_PATTERNS.forEach((re, i) => {
  assert(
    (hitsByArm[i] ?? 0) > 0,
    `arm ${i} (${re.source.slice(0, 52)}…) matches at least one CASES entry unbounded — an arm with no fixture is an arm no test has ever seen fire (${hitsByArm[i]} hit(s))`,
  );
});

// And the reverse direction on the negative list: nothing in MUST_NOT_REDACT may
// fire ANY arm, at any position. The overreach file drives the same list through
// the bounded passes; this asserts the unbounded one, which is where a widened
// class bites first.
for (const { name, text } of MUST_NOT_REDACT) {
  const armed = SECRET_PATTERNS.map((re, i) => (re.test(text) ? i : -1)).filter((i) => i >= 0);
  assert(
    armed.length === 0,
    `${name} matches NO arm unbounded (fired on arm(s) ${armed.join(", ")})`,
  );
}

// --------------------------------------------- 2. the bounded passes agree with the whole

/**
 * The bound range where item 9 lived. Below `SCAN_CAP` the widened scan reaches the
 * credential by ordinary slack; above it the token walk stops at its cap, and that
 * edge is exactly where a left-context assertion (the `\b` that used to open the
 * key/value rule) turns a match into a non-match. Sweeping one bound would have
 * passed while the other leaked, and sweeping only `start` would have missed the
 * mirror, so both edges run at every bound here.
 */
const BOUNDS = [2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 4000];

for (const { name, secret, body } of CASES) {
  if (name.startsWith("key-value")) continue; // the glued-before note in the companion file
  for (const glue of ["", " "]) {
    const text = `${"t".repeat(2047)}${glue}${secret}${"t".repeat(3000)}`;
    const whole = redactSecrets(text);
    assert(
      whole.count >= 1 && !leaksKey(whole.text, body),
      `${name} glued${glue ? " (space)" : ""} is a credential shape unbounded (${whole.count})`,
    );
    if (whole.count === 0) continue;
    for (const max of BOUNDS) {
      for (const from of ["start", "end"] as const) {
        const r = redactBounded(text, max, from);
        assert(
          !leaksKey(r.text, body),
          `${name} glued${glue ? " (space)" : ""} (max ${max}, from="${from}"): the bounded pass keeps no credential window the unbounded pass would have redacted`,
        );
      }
    }
    // The record-level path, at the bound the repro used.
    const counter = { n: 0 };
    const deep = redactDeep({ evidence: text }, counter, 4000) as { evidence: string };
    assert(
      !leaksKey(deep.evidence, body) && counter.n >= 1,
      `${name} glued${glue ? " (space)" : ""} via redactDeep(bound 4000): no window survives and the pass counted it (${counter.n})`,
    );
  }
}

/**
 * The lens's item-9 repro, verbatim rather than parameterised, so a future edit that
 * reintroduces a left-context assertion fails on the string it was reported with.
 */
{
  const t = `${"t".repeat(2047)}password=Sup3rSecretValue99${"t".repeat(3000)}`;
  const whole = redactSecrets(t);
  assert(whole.count >= 1, "item-9 repro: the unbounded pass matches it at all");
  for (const max of BOUNDS)
    for (const from of ["start", "end"] as const) {
      const r = redactBounded(t, max, from);
      assert(
        !r.text.includes("Sup3rSecretValue99"),
        `item-9 repro (max ${max}, from="${from}"): the password does not ship`,
      );
    }
  const counter = { n: 0 };
  const deep = redactDeep({ evidence: t }, counter, 4000) as { evidence: string };
  assert(
    !deep.evidence.includes("Sup3rSecretValue99") && counter.n >= 1,
    `item-9 repro via redactDeep: the password does not ship and the redaction is counted (${counter.n})`,
  );
}

// ------------------------------------------------------- 3. redactDeep reaches object keys

{
  const KEY = "tok:sk-ant-api03-aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d";
  const counter = { n: 0 };
  const out = redactDeep({ [KEY]: "v" }, counter) as Record<string, unknown>;
  const shipped = JSON.stringify(out);
  assert(
    !leaksKey(shipped, KEY),
    `redactDeep redacts object KEYS, not only values: ${shipped.slice(0, 60)}`,
  );
  // Nested one level down, and inside an array, since that is where a state's
  // undeclared strings actually live.
  const c2 = { n: 0 };
  const nested = redactDeep({ a: { [KEY]: "v" }, list: [{ [KEY]: "v" }] }, c2, 4000) as Record<
    string,
    unknown
  >;
  assert(
    !leaksKey(JSON.stringify(nested), KEY),
    `...and through nested objects and arrays too (${JSON.stringify(nested).slice(0, 60)})`,
  );
  assert(
    c2.n >= 2,
    `each redacted key is counted, and the pass counts its own replacements (${c2.n} across the three keys)`,
  );
  // A benign key is untouched: redacting keys must not mangle ordinary field names.
  const c3 = { n: 0 };
  const clean = redactDeep({ lastOutput: "ok", openPoint: "fine" }, c3, 4000) as Record<
    string,
    unknown
  >;
  assert(
    Object.keys(clean).join(",") === "lastOutput,openPoint" && c3.n === 0,
    `an ordinary key survives byte-for-byte and claims no redaction (${c3.n})`,
  );
}

// ------------------------------ 4. the key/value body is bounded, so 8 MB cannot throw

/**
 * `{12,}` over an 8 MB keyword-first run exhausted the stack inside `String.replace`
 * — a `RangeError` out of `redactSecrets`, which every caller reads as "this state is
 * not JSON" and takes its non-serialisable path, so a record ships nothing rather than
 * something redacted. `{12,4096}` fixes it; the probe asserts the absence of the throw
 * inside a generous wall-clock bound so a quadratic body is caught too, not only a
 * stack overflow.
 */
{
  const big = `password=${"a".repeat(8 * 1024 * 1024)}`;
  const t0 = Date.now();
  let threw: string | undefined;
  let count = -1;
  try {
    count = redactSecrets(big).count;
  } catch (err) {
    threw = (err as Error).name;
  }
  const ms = Date.now() - t0;
  assert(
    threw === undefined,
    `an 8 MB keyword-first string does not throw out of redactSecrets (${threw ?? "no throw"}, ${ms}ms)`,
  );
  assert(count >= 1, `...and the 8 MB probe still reports the redaction it made (${count})`);
  assert(ms < 2000, `...in under 2 seconds rather than backtracking (${ms}ms)`);
}

// The credential span is replaced by the marker rather than left in place. Asserted
// on a body inside one quantifier pass, because an 8 MB run is redacted in 4096-char
// chunks and correctly leaves the tail of an eight-megabyte identifier standing — that
// residue is the upper bound doing its job, not a leak, and the throw is the failure.
{
  const r = redactSecrets("clone with password=abcdefghij1234567890 done");
  assert(
    r.count === 1 && r.text === "clone with [REDACTED] done",
    `a key/value pair is replaced by the marker whole, not truncated (${JSON.stringify(r.text)})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
