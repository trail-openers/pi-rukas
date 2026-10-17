#!/usr/bin/env bun
/**
 * What a redaction must NOT touch, and the nested-string arm's own bound (#1393).
 *
 * The companion to test-decision-shadow-redaction-context.ts, which drives
 * credentials through `decide()` and asserts they never reach the prompt or the
 * log. This file is the two claims that file's fixtures make hardest to satisfy
 * at once, split out to keep each under the repository's file-size cap:
 *
 *   1. **No over-redaction.** Every widening of a character class is a new
 *      opportunity to eat something that is not a credential, and a log that
 *      redacts git SHAs, UUIDs and ordinary hyphenated words is worse than one
 *      that leaks a key — the operator stops trusting it. The per-rule token-end
 *      rewrite is exactly such a widening: it had to make `sk-ant-…==`,
 *      `sk-ant-…+` and `sk-ant-…/seg` match while `…<sha>==`, a UUID and
 *      `task-list`/`desk-top` keep matching NOTHING. Asserted at every position
 *      each shape can appear at, unbounded AND bounded, in both directions.
 *
 *   2. **`redactDeep`'s string arm widens too.** `boundField` covers only the
 *      fields a seam DECLARES; an undeclared or nested string reaches the model
 *      through `redactDeep`, whose arm used to do `slice(bound + slack)` →
 *      redact → `slice(bound)` with no widening at the keep edge. A credential
 *      straddling `bound` was amputated before any pattern saw it: the fragment
 *      shipped and the count read zero — the #1393 leak one level of nesting
 *      deeper. It now routes through `redactBounded`, the same scan the declared
 *      fields get.
 *
 *   3. **A bound that is not a positive number keeps nothing and claims nothing.**
 *      The old shape scanned the head and returned `""` with `count: 1`: a record
 *      reporting redactions over a string it never shipped.
 *
 * Offline: no network, no child process.
 */

import { redactBounded, redactDeep, redactSecrets } from "../src/decision-log.ts";
import { PROBE_KEY, leaksKey, makeAssert } from "./lib/decision-fixtures.ts";
import { MUST_NOT_REDACT } from "./lib/redaction-context-cases.ts";
import { BODY_CLASS_OVERREACH } from "./lib/redaction-context-cases.ts";
import { PEM_TAIL_PRESERVES } from "./lib/redaction-context-cases.ts";

const { assert, state } = makeAssert();

/**
 * Filler for the over-reach probes: `n` characters broken by a space roughly every 80.
 *
 * These probes ask whether a pattern eats something that is not a credential, so their
 * filler must sit in the regime a scan actually covers — a whitespace-separated run,
 * which `widenPastCut` walks to a token boundary and `redactSecrets` judges. A bare
 * `"f".repeat(2048)` puts the probe on the far side of `SCAN_CAP` from the kept window,
 * where `widenPastCut` gives up and the fail-closed pass below replaces the whole run
 * with a marker on purpose: correct behaviour for a window that is one unscannable
 * credential-class token, and a false over-reach alarm for a probe that is not one.
 */
function filler(n: number, ch = "f"): string {
  const word = ch.repeat(80);
  return (`${word} `.repeat(Math.ceil(n / 80)) + word).slice(0, n);
}

// ------------------- no over-redaction: what the patterns must keep matching NOTHING

for (const { name, text } of MUST_NOT_REDACT) {
  const positions: [string, string][] = [
    ["as-is", text],
    ["glued to a run", `${filler(120)}${text}${filler(400, "t")}`],
    ["double-quoted", `"${text}"`],
    ["in a JSON field", String.raw`{"note":"${name}"}`],
    ["at the tail of a long run", `${filler(2048)} ${text}`],
    ["at the head of a long run", `${text} ${filler(2048)}`],
  ];
  for (const [where, probe] of positions) {
    const unb = redactSecrets(probe);
    assert(
      unb.count === 0 && unb.text === probe,
      `${name} ${where}: NOTHING is redacted and the text is unchanged (${unb.count})`,
    );
    for (const from of ["start", "end"] as const) {
      const b = redactBounded(probe, 200, from);
      assert(
        b.count === 0,
        `${name} ${where} (from="${from}"): the bounded pass reports no redaction either`,
      );
    }
  }
}

// --------- the fail-closed pass: a kept window that is one giant token is redacted ON PURPOSE

{
  // The mirror of the over-reach claim above, and deliberately its opposite. When the
  // filler is one whitespace-free run longer than `SCAN_CAP`, `widenPastCut` gives up
  // (there is no whitespace to walk to), no arm anchors on the run, and the kept window
  // opens on live credential-class material with `count: 0`. That is the shape
  // `redactUnscannedRuns` fails closed on — a 10 KB base64 body shipped by
  // `redactBounded(…, 600, "end")` reported zero redactions while carrying key material.
  // So the rule is: over-reach is judged inside a scannable window, and a window that is
  // ONE unscannable token is treated as a credential. A `:` breaks the run into words so
  // the window stays scannable and the same shape reports nothing.
  const SEG = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d";
  const giant = `${"f".repeat(5000)} password=${SEG.repeat(200)} tail words`;
  const closed = redactBounded(giant, 600, "end");
  assert(
    closed.count >= 1 && !closed.text.includes(SEG),
    `a whitespace-free run past the scan budget is redacted on purpose (${closed.count}, ${JSON.stringify(closed.text.slice(0, 32))})`,
  );
  // The control shows what the pass keys on: not the length of the window but whether a
  // credential-class RUN reaches it. Here the kept window opens on 600 characters of an
  // unbroken `g`-class run — the same unscannable shape — and that run is itself replaced.
  // That is the intended cost of failing closed: when the scan could not reach the window,
  // anything long enough to be a key body is treated as one, filler included. Shorter
  // tokens in the same window (the `tail words` behind it) survive untouched, which is the
  // part that keeps a real error tail readable.
  const scannable = redactBounded(`${"g".repeat(5000)} tail words`, 600, "end");
  assert(
    scannable.count === 1 &&
      scannable.text === "[REDACTED] tail words" &&
      !scannable.text.includes("g"),
    `...and the fail-closed pass takes the run, never the short words after it (${scannable.count}, ${JSON.stringify(scannable.text)})`,
  );
}

// ---- the key/value body class is a credential alphabet, not `\S`: a JSON object
// literal welded to a keyword names a credential without carrying one, and must
// report no redaction at all (#1393).

for (const { name, text } of BODY_CLASS_OVERREACH) {
  const r = redactSecrets(text);
  assert(r.count === 0, `${name}: NOTHING is redacted (${r.count} for ${JSON.stringify(text)})`);
}

// ------- the PEM arm stops at the end of the KEY BODY and does not eat the log after it
//
// The old body was `[\s\S]*?(?:-----END|$)`. On a clipped key the lazy span had nothing
// to stop at, so it ran to end-of-string and the error tail behind the key was erased
// with it — over-redaction the "the body is gone" assertion cannot see, because a span
// that swallows the tail also satisfies it. So both sides are asserted here (#1393).

for (const { name, text, mustNotContain, mustContain } of PEM_TAIL_PRESERVES) {
  const r = redactSecrets(text);
  assert(r.count >= 1, `${name}: the clipped PEM is redacted (${r.count})`);
  for (const leak of mustNotContain) {
    assert(!r.text.includes(leak), `${name}: the KEY BODY is gone (${JSON.stringify(leak)})`);
  }
  for (const keep of mustContain) {
    assert(
      r.text.includes(keep),
      `${name}: the log line AFTER a clipped key survives (${JSON.stringify(keep)})`,
    );
  }
}

// ------------------------- redactDeep: the nested-string arm keeps its context too

{
  const NESTED_BOUND = 60;
  for (const [name, secret, body] of [
    ["sk", PROBE_KEY, PROBE_KEY],
    ["url", "https://user:hunter2Sup3rSecretValue@origin.internal/x", "hunter2Sup3rSecretValue"],
    ["kv", "password=Sup3rSecretValue99", "Sup3rSecretValue99"],
  ] as const) {
    for (const offset of [0, 8, 20, NESTED_BOUND - 4, NESTED_BOUND, NESTED_BOUND + 4]) {
      // The key starts at `offset` inside the string, so for `offset < bound`
      // the character at `bound` falls INSIDE the credential — the exact shape
      // that used to be cut into an unrecognisable fragment.
      const inner = `${"p".repeat(offset)}${secret}${"z".repeat(4 * NESTED_BOUND)}`;
      // Same rule as the `key-value` glued-before note in the companion file: a
      // keyword welded onto filler is a substring of an identifier, not a
      // credential, so a zero there is the shape-with-context rule working. The
      // `offset === 0` case is the one that must match, and does.
      if (name === "kv" && offset > 0) continue;
      const unb = redactSecrets(inner);
      assert(
        unb.count >= 1 && !leaksKey(unb.text, body),
        `nested ${name} @ offset ${offset}: real credential shape unbounded (${unb.count})`,
      );
      if (unb.count === 0) continue;
      const counter = { n: 0 };
      const out = redactDeep({ nested: { deep: inner } }, counter, NESTED_BOUND) as {
        nested: { deep: string };
      };
      assert(
        !leaksKey(out.nested.deep, body),
        `nested ${name} straddling bound ${NESTED_BOUND} at offset ${offset}: no credential window in the kept string`,
      );
      assert(
        out.nested.deep.length <= NESTED_BOUND,
        `nested ${name} @ ${offset}: the kept string respects the bound (${out.nested.deep.length})`,
      );
      assert(
        counter.n >= 1,
        `nested ${name} @ ${offset}: the nested pass counted the redaction it made (${counter.n})`,
      );
    }
  }
}

// A non-positive or NaN bound keeps NOTHING and must not claim it redacted
// something.
for (const max of [0, -1, Number.NaN]) {
  const text = `prefix ${PROBE_KEY} suffix ${"y".repeat(200)}`;
  const r = redactBounded(text, max, "start");
  assert(
    r.text === "" && r.count === 0,
    `redactBounded with max=${String(max)} returns "" with a count of ZERO, not one (${JSON.stringify(r)})`,
  );
  const e = redactBounded(text, max, "end");
  assert(e.text === "" && e.count === 0, `...and the same from="end" (${JSON.stringify(e)})`);
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
