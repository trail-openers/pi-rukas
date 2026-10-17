#!/usr/bin/env bun
/**
 * THE TAIL A BOUNDED RULE LEAVES BEHIND (#1393, final round).
 *
 * The key/value arm caps its body at `{12,4096}` — deliberately, because an
 * open-ended `{12,}` over a multi-megabyte keyword-first run exhausts the stack
 * inside `String.replace` (asserted in test-decision-secret-pattern-coverage.ts).
 * The cap is right. The residue was not: a value longer than 4096 is replaced only
 * for its first 4096 characters, so the marker is written with the rest of the
 * credential still welded to its right, and `leaksKey` finds real twelve-character
 * windows of the key in the "redacted" output.
 *
 * Why this needs a pass AFTER the loop rather than one more arm inside it: the
 * marker and its tail are produced by the SAME `replace` call, so a rule that had
 * already run cannot see a residue that did not exist when it ran. Measured with
 * the sweep as an arm of `SECRET_PATTERNS`: `count: 1`, tail untouched, i.e. it
 * never fired. That measurement is the reason `TAIL_SWEEP` sits outside the array.
 *
 * Three claims, each one something the existing fixture set cannot see:
 *
 *   1. a credential past the cap leaves NO 12-char window, both unbounded and
 *      through `redactBounded(…, 600, "start")` — the bounded path is the one the
 *      shadow seams actually use, and a scan window can no more fix this than it
 *      could fix the pattern gaps, because the arm matched and simply stopped;
 *   2. base64 padding welded to a marker is gone (`==`, `+`, `/seg`);
 *   3. ORDINARY PROSE after a marker survives — the sweep must eat only characters
 *      a credential is written in, never a space or a word, or it would delete the
 *      sentence that reports the redaction.
 *
 * And the negative that keeps the sweep from being a new refusal rule:
 * `vipune.ts`'s `looksLikeSecret` is `SECRET_PATTERNS.some(re => re.test(text))`,
 * and the sweep is not an arm of that array — so a plain secret is refused exactly
 * as before and text carrying a marker is not newly refused on its own.
 *
 * Offline: pure string work, no I/O, no network, no child process.
 */

import { boundField, redactBounded, redactSecrets } from "../src/decision-log.ts";
import { REDACTED, SECRET_PATTERNS, TAIL_SWEEP } from "../src/secret-patterns.ts";
import { looksLikeSecret } from "../src/vipune.ts";
import { leaksKey, makeAssert } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

// A 53-char base64-shaped run, repeated past the arm's 4096-character cap: 200
// repeats is 10 600 characters, so the first pass replaces 4096 of them and the
// remaining ~6 500 are what the sweep exists to take.
const SEGMENT = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d";
const LONG = SEGMENT.repeat(200);

// ------------------------------------------------ 1. a value past the cap leaves nothing

{
  const text = `token=${LONG}`;
  const whole = redactSecrets(text);
  assert(
    !leaksKey(whole.text, SEGMENT),
    `unbounded: no 12-char window of an over-cap credential survives (${whole.count} redaction(s), ${whole.text.length} chars out of ${text.length})`,
  );
  assert(
    whole.text === REDACTED,
    `unbounded: the whole keyword/value pair collapses to one marker (${JSON.stringify(whole.text.slice(0, 40))})`,
  );
  assert(whole.count >= 1, `...and the pass still reports what it replaced (${whole.count})`);

  const bounded = redactBounded(text, 600, "start");
  assert(
    !leaksKey(bounded.text, SEGMENT),
    `bounded(600,"start"): no 12-char window survives the seam's own clip (${bounded.count} redaction(s), ${JSON.stringify(bounded.text.slice(0, 40))})`,
  );
  assert(
    bounded.text.length <= 600,
    `...and the bound still holds after the sweep (${bounded.text.length})`,
  );
}

// The mirror image: the credential so far into the text that a 600-char END clip
// keeps only its tail. Two shapes, and they are NOT the same case.
//
// The FIRST is the leak this round closes. With `password=` as the separator the
// filler-to-credential seam sits more than `SCAN_CAP` before the kept window, so
// `widenPastCut` walks its whole budget without finding whitespace and gives up: the scan
// window opens inside an unbroken base64 run, no arm anchors on it, and before the fix
// the pass reported `count: 0` while shipping 600 characters of live key material. That
// is exactly the shape a bound must fail closed on — widening cannot reach the arm's
// anchor and there is no PEM header to back up to — so `redactUnscannedRuns` replaces any
// credential-class run the scan did not reach. It is asserted with `leaksKey`, not with a
// length: `length <= 600` was true while the leak was live, which is why the length alone
// is not the claim here (the bound is separately pinned by the control block below).
{
  const text = `${"f".repeat(5000)} password=${LONG} tail words`;
  const bounded = redactBounded(text, 600, "end");
  assert(
    !leaksKey(bounded.text, SEGMENT),
    `the end clip fails closed on an unscanned window (${bounded.count} redaction(s), ${JSON.stringify(bounded.text.slice(0, 40))})`,
  );
  // The seam-driven bound is the same path the shadow fields take, so the leak and its
  // fix have to be asserted there too rather than only on the lower-level helper.
  const viaField = boundField(text, { max: 600, from: "end" });
  assert(
    !leaksKey(viaField.text, SEGMENT),
    `boundField({from:"end"}) fails closed the same way (${viaField.count} redaction(s), ${JSON.stringify(viaField.text.slice(0, 40))})`,
  );
  assert(
    viaField.count === bounded.count && viaField.text === bounded.text,
    "...and the seam path and the helper path agree, so neither is the one holding the fix",
  );

  // The SECOND is the shape the sweep genuinely cannot serve, and naming it is still
  // the point: with ` token=` — a space before the keyword — the arm's 4096-character cap
  // starts the replacement at `token=`, ~4 800 characters before the kept window, so no
  // pattern reaches it, and the walk finds whitespace immediately so the window is not
  // one the scan gave up on and `redactUnscannedRuns` does not fire. The kept 600
  // characters are the far end of a run no pass was asked to scan; `redactBounded` is
  // documented to keep `max` of the already-redacted SCAN WINDOW, so a credential wholly
  // outside that window is never-shipped-at-all rather than shipped-unredacted, and the
  // shadow seams keep the tail deliberately because a failure's last words are its tail.
  const dropped = `${"f".repeat(1500)} token=${LONG} trailing words here`;
  const clipped = redactBounded(dropped, 600, "end");
  assert(
    clipped.text.length <= 600,
    `the end clip keeps exactly its bound (${clipped.text.length} of ${dropped.length})`,
  );
  // What the sweep DOES guarantee on this input: a marker that IS in the window
  // never leaves a glued tail. Placed so the marker lands inside the kept 600.
  const inWindow = `${"f".repeat(900)} password=${SEGMENT}${SEGMENT}${SEGMENT}${SEGMENT} tail`;
  const b2 = redactBounded(inWindow, 600, "end");
  assert(
    !leaksKey(b2.text, SEGMENT),
    `an over-cap value whose marker lands in the END window leaves no 12-char run (${JSON.stringify(b2.text.slice(0, 40))})`,
  );
}

// --------------------------------------------------------- 2. padding and separator tails

for (const [name, text, mustNotContain] of [
  ["padded-key", `sk-ant-api03-${SEGMENT}==`, ["=="]],
  ["plus-tail", `sk-ant-api03-${SEGMENT}+`, ["+"]],
  ["segment-tail", `sk-ant-api03-${SEGMENT}/seg`, ["/seg"]],
  ["kv-base64-pad", `secret=${SEGMENT}==`, ["=="]],
] as const) {
  const r = redactSecrets(text);
  assert(r.count >= 1, `${name}: something matched at all (${r.count})`);
  for (const leak of mustNotContain) {
    assert(
      !r.text.includes(leak),
      `${name}: ${JSON.stringify(leak)} stayed welded to the marker (${JSON.stringify(r.text)})`,
    );
  }
  assert(
    r.text === REDACTED,
    `${name}: the credential and its tail collapse to one marker (${JSON.stringify(r.text)})`,
  );
}

// ------------------------------------------------- 3. prose after a marker is untouched

{
  const prose = "the value is [REDACTED] and the sentence continues normally";
  const r = redactSecrets(prose);
  assert(
    r.text === prose,
    `ordinary words after a marker separated by a space stay intact (${JSON.stringify(r.text)})`,
  );
  assert(r.count === 0, `...and a bare marker in prose counts as nothing (${r.count})`);
}

{
  const r = redactSecrets("clone with password=abcdefghij1234567890 done");
  assert(
    r.count === 1 && r.text === "clone with [REDACTED] done",
    `an under-cap pair still replaces whole, once (${r.count}, ${JSON.stringify(r.text)})`,
  );
}

// A marker with a credential-class word glued to it IS swept — that glue is the leak.
{
  const r = redactSecrets("note: [REDACTED]AbCdEf continues");
  assert(
    r.text === "note: [REDACTED] continues" && r.count === 1,
    `a glued run after a marker is taken with it (${r.count}, ${JSON.stringify(r.text)})`,
  );
}

// ------------------------------- the sweep is not a new reason to refuse a vipune write

{
  // `looksLikeSecret` reads `SECRET_PATTERNS`, which the sweep deliberately is NOT
  // part of. A plain secret is refused exactly as before; a marker alone is not a
  // secret shape, and the sweep must not have smuggled one in.
  assert(
    !SECRET_PATTERNS.some((re) => re.test(TAIL_SWEEP.source)),
    "the sweep is not an arm of SECRET_PATTERNS, so vipune's refusal set is unchanged",
  );
  assert(
    looksLikeSecret(`token: sk-abcdefghijklmnop1234`),
    "a plain secret is still refused by looksLikeSecret",
  );
  assert(
    !looksLikeSecret("the value is [REDACTED] and the sentence continues"),
    "a line carrying a marker is not newly refused on the sweep's account",
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
