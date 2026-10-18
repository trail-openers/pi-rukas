#!/usr/bin/env bun
/**
 * FAIL CLOSED ON EVERY CLIPPED WINDOW, NOT ONLY A GIVEN-UP WALK (#1393, final round).
 *
 * The shipped gate was `head.gaveUp ? redactUnscannedRuns(kept) : …`, i.e. the fail-closed
 * net ran only when `widenPastCut` reported it had walked its whole budget without finding
 * whitespace. That report does not mean what the gate needed it to mean. `gaveUp: false`
 * says the WALK terminated; it says nothing about whether the SCAN saw the kept window.
 * Three hundred characters of `"w "` filler between a key and the cut makes the walk
 * succeed on its first step, and the PEM arm's anchor still sits behind `PEM_HEADER_REACH`,
 * so no arm matches, `count` is 0, and the kept window ships live key body — measured, at
 * `count: 0`, on all four shapes below.
 *
 * The second shipped gate was `kept.startsWith(REDACTED) → return unchanged`, on the
 * reasoning that a window opening on a marker has already been handled by `TAIL_SWEEP`. It
 * has not: `TAIL_SWEEP` eats credential-class GLUE welded to a marker, which is one
 * position, whereas the early return declines the WHOLE window because its first token was
 * redacted — so a key sitting anywhere behind that marker escaped the net entirely.
 *
 * Four claims, each measured RED against the shipped code (the pre-fix shape is reproduced
 * verbatim below, not assumed):
 *
 *   1. **The lens's repro** — filler, a keyword, whitespace filler, then a base64 body —
 *      at `redactBounded(…, 600, "end")`. The walk succeeds (`gaveUp: false`), the scan
 *      matches nothing, and the body shipped. The net must take it and `leaksKey` must be
 *      clean.
 *   2. **The adversarial repro** — a PEM header, 100 lines of 186-char base64, then a
 *      prose tail — at BOTH 600 and 1000. Same shape, and it is the case `PEM_HEADER_REACH`
 *      was supposed to cover: the header is 17 610 characters behind the window, past the
 *      reach, so backing up to it is not available and only the net stands between the clip
 *      and the key.
 *   3. **A fragment is not a short token.** A clipped body line leaves the kept window
 *      opening on the HEAD of a line the scan never reached — 19 characters of key body in
 *      the measured PEM repro. Nineteen is under the 64-character floor and `leaksKey`'s
 *      twelve-character window sees every twelve of them, so the floor cannot judge a token
 *      a clip has cut in half. Its length is measured in the ORIGINAL text, across the cut.
 *   4. **A marker at the left edge is not a clean window.** `[REDACTED] ` followed by an
 *      86-character run: the run is not glue, the net must take it, and the count must say
 *      so.
 *
 * And the side that must NOT change: the ordinary identifiers an operator reads in a log —
 * git SHAs, UUIDs, paths, URLs, hyphenated prose — stay untouched in a clipped window, and
 * a 64+ hex hash that gets taken there is recorded as the accepted cost of failing closed.
 *
 * Offline: pure string work, no I/O, no network, no child process.
 */

import { boundField, redactBounded } from "../src/decision-log.ts";
import { redactUnscannedRuns } from "../src/decision-redact-window.ts";
import { widenPastCut } from "../src/decision-redact-window.ts";
import { redactSecrets } from "../src/secret-patterns.ts";
import { leaksKey, makeAssert } from "./lib/decision-fixtures.ts";
import { MUST_NOT_REDACT } from "./lib/redaction-context-cases.ts";

const { assert, state } = makeAssert();

/** Deterministic base64-shaped line of exactly `n` characters (no PRNG, no Date). */
function b64Line(seed: number, n: number): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  let x = seed;
  while (s.length < n) {
    x = (x * 1103515245 + 12345) % 2147483647;
    s += A[x % 64];
  }
  return s.slice(0, n);
}

const PEM_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";
/** The scan budget `redactBounded` uses; mirrored here only for the diagnostic labels. */
const SCAN_CAP = 2048 + 4096;

// ---------------------------------------------------------------------------------------------
// 1. The lens's repro: whitespace filler makes the walk SUCCEED, and the body still shipped.
//
// Shape: 5 000 chars of unbroken `f`, a `token=` keyword (so the key/value arm is in play
// and its 4096-cap is what stops the scan reaching the body), 300 `"w "` words — which is
// what makes `gaveUp` false — and then a 159-character base64 body at the very end.
// ---------------------------------------------------------------------------------------------
{
  const BODY = b64Line(7, 159);
  const text = `f${"f".repeat(4999)} token=abcdefghij1234567890 ${"w ".repeat(300)} ${BODY} END`;
  // The premise, asserted rather than narrated: the walk does NOT give up, so the shipped
  // gate would have skipped the net. Without this the test would pass for the wrong reason.
  const walk = widenPastCut(text, text.length - 600, "head", SCAN_CAP);
  assert(walk.gaveUp === false, "premise: the walk found whitespace, so `gaveUp` is false");

  const r = redactBounded(text, 600, "end");
  assert(
    !leaksKey(r.text, BODY),
    `lens repro: no 12-char window of the body survives (${r.count})`,
  );
  assert(r.text.length <= 600, `...and the bound still holds (${r.text.length})`);
  assert(r.count >= 1, `...and the pass counted what it replaced (${r.count})`);
  assert(
    r.text.endsWith("[REDACTED] END") || r.text.includes(" END"),
    `...and the words behind the key are still readable (${JSON.stringify(r.text.slice(-24))})`,
  );
  // The seam path is what the shadow fields actually take, so the claim has to hold there
  // too rather than only on the lower-level helper.
  const viaField = boundField(text, { max: 600, from: "end" });
  assert(
    !leaksKey(viaField.text, BODY) && viaField.count === r.count,
    `boundField({from:"end"}) agrees with the helper (${viaField.count})`,
  );
}

// ---------------------------------------------------------------------------------------------
// 2. The adversarial repro: a PEM header 17 KB behind the window, then 100 body lines.
//
// `PEM_HEADER_REACH` backs the scan up to a dropped `-----BEGIN`, and that is the right
// move for a key of a size it was sized for. Here the header is 17 610 characters behind
// the window — past 16 384 — so the backup is declined and the scan opens inside the body,
// where no arm anchors. Both windows are asserted because the reachable fragment differs:
// at 600 the kept window opens 19 characters into a line, at 1000 46 characters in, and the
// shorter of the two is the one no length floor can see.
// ---------------------------------------------------------------------------------------------
{
  const LINE = b64Line(3, 186);
  const text = `${PEM_BEGIN}\n${Array(100).fill(LINE).join("\n")}\ntrailing tail words`;
  for (const max of [600, 1000]) {
    const r = redactBounded(text, max, "end");
    assert(
      !leaksKey(r.text, LINE),
      `PEM past PEM_HEADER_REACH (${max}): no 12-char window of a body line survives (${r.count}, ${JSON.stringify(r.text.slice(0, 40))})`,
    );
    assert(r.text.length <= max, `...and the ${max} bound holds (${r.text.length})`);
    assert(r.count >= 1, `...and the pass counted its replacements (${r.count})`);
    assert(
      r.text.includes("trailing tail words"),
      `...and the prose line after the key survives (${JSON.stringify(r.text.slice(-24))})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 3. The edge fragment: measured in the ORIGINAL text, across the cut, with no lower
//    threshold for anything else.
// ---------------------------------------------------------------------------------------------
{
  const LINE = b64Line(3, 186);
  const text = `${PEM_BEGIN}\n${Array(100).fill(LINE).join("\n")}\ntrailing tail words`;
  const r = redactBounded(text, 600, "end");
  // A fragment short enough to dodge the 64-run net and long enough for `leaksKey`.
  //
  // The assertion used to be written `pieces.filter(s => LINE.includes(s))`, which asks "is
  // this kept line a substring of a body line" — and a fragment that is not, because it opens
  // mid-line and runs off the end of what the clip kept, is invisible to it. That filter is
  // what hid the leak this round found: the window's last line, 40 characters of body, was in
  // `pieces`, was not `LINE.includes`-able, and the block reported zero fragments while
  // `leaksKey` on the same string returned true. The claim is "no key material survives", so
  // it is now made with the leak probe the file already trusts, on every body line, and the
  // fragment check is stated as "no kept line is a run of body characters at all" rather than
  // as a substring test against one chosen line.
  assert(
    !leaksKey(r.text, LINE),
    `no 12-char window of a body line survives (${r.count}, ${JSON.stringify(r.text.slice(0, 40))})`,
  );
  const pieces = r.text
    .split("\n")
    .filter((s) => s.length > 0 && s !== "[REDACTED]" && s !== "trailing tail words");
  const fromBody = pieces.filter((s) => /^[A-Za-z0-9+/=]{12,}$/.test(s));
  assert(
    fromBody.length === 0,
    `no kept line is a run of body characters (${JSON.stringify(pieces)})`,
  );

  // The same shape with the header out of `PEM_HEADER_REACH`. Swept over every window because the
  // leak depends on where the cut falls inside the body.
  const LINE_FAR = b64Line(3, 186);
  const far = `${PEM_BEGIN}\n${Array(145).fill(LINE_FAR).join("\n")}`;
  for (let max = 150; max <= 4000; max += 50) {
    const f = redactBounded(far, max, "end");
    assert(
      !leaksKey(f.text, LINE_FAR),
      `body past the reach (max ${max}): the tail of the key ships (${f.count}, ${JSON.stringify(f.text.slice(-48))})`,
    );
    assert(f.text.length <= max, `...and the ${max} bound holds (${f.text.length})`);
  }

  // The other half of the rule: a token that is genuinely SHORT in the full text keeps its
  // length floor and survives. Same clip, same window shape, ordinary identifiers only —
  // so the edge probe must report `false` and replace nothing.
  const words = Array.from({ length: 60 }, (_, i) => `item-${i}-value`).join(" ");
  const ident = `commit 0123456789abcdef0123456789abcdef01234567 ${words} done`;
  const short = redactBounded(`${"x ".repeat(400)}${ident}`, 200, "end");
  assert(
    short.count === 0 || short.text.includes("done"),
    `an ordinary identifier at the edge is not taken because it is short in the full text (${short.count})`,
  );
}

// ---------------------------------------------------------------------------------------------
// 4. The marker early-return: `[REDACTED] ` + an 86-char run is not "already handled".
// ---------------------------------------------------------------------------------------------
{
  const RUN = b64Line(11, 86);
  assert(RUN.length === 86, "fixture: the run is 86 characters, over the 64 floor");
  const r = redactUnscannedRuns(`[REDACTED] ${RUN}`);
  assert(r.count === 1, `the net takes a run behind a marker (${r.count})`);
  assert(!r.text.includes(RUN), `...and the run is gone (${JSON.stringify(r.text)})`);

  // The one position that IS already handled, and the reason the early return is narrowed
  // rather than simply deleted: credential-class glue BUTTING on a marker belongs to
  // `TAIL_SWEEP`, and taking it here would count a replacement another arm already made.
  const glue = redactUnscannedRuns(`[REDACTED]${RUN}`);
  assert(
    glue.count === 0 && glue.text.includes(RUN),
    `...but glue welded to the marker is left to TAIL_SWEEP (${glue.count})`,
  );

  // And a window whose marker is not at position 0 was never in the early return's reach at
  // all — a key behind it used to escape by the same argument.
  const mid = redactUnscannedRuns(`key=abc [REDACTED] ${RUN}`);
  assert(
    mid.count === 1 && !mid.text.includes(RUN),
    `a run behind a mid-window marker is taken (${mid.count})`,
  );
}

// ---------------------------------------------------------------------------------------------
// 5. The over-reach side, and the one accepted cost.
//
// `test-decision-redaction-overreach.ts` asserts `count === 0` for these shapes, and every
// one of them is written with a filler of 80-character `f`/`t` runs — credential-class
// characters, over the floor, in the kept window. That file's own "redacted ON PURPOSE"
// block already pins that a kept window of filler is taken; the assertions there are
// therefore about the SHAPES, and they can only be made where the window is scannable.
// What this block adds is the half the shipped file could not state, because the old gate
// never ran the net here: what the net does, and does not, touch inside a clipped window.
// ---------------------------------------------------------------------------------------------
{
  function filler(n: number, ch = "f"): string {
    const w = ch.repeat(80);
    return (`${w} `.repeat(Math.ceil(n / 80)) + w).slice(0, n);
  }
  const shapes = (t: string): [string, string][] => [
    ["as-is", t],
    ["glued between filler", `${filler(120)}${t}${filler(400, "t")}`],
    ["after a long filler run", `${filler(2048)} ${t}`],
    ["before a long filler run", `${t} ${filler(2048)}`],
  ];
  for (const { name, text } of MUST_NOT_REDACT) {
    for (const [where, probe] of shapes(text)) {
      for (const from of ["start", "end"] as const) {
        const b = redactBounded(probe, 200, from);
        // The claim that survives clipping: NO arm of `SECRET_PATTERNS` matches the shape.
        // The scan's own contribution must be zero — the fail-closed pass is allowed to
        // replace the filler around it, and that is the pinned behaviour above, not a
        // regression, so it is excluded from this assertion rather than hidden by it.
        const scan = redactSecrets(probe);
        assert(
          scan.count === 0,
          `${name} ${where} unbounded: no pattern claims it (${scan.count})`,
        );
        // Whatever the pass replaced, it replaced only runs of the credential class:
        // a marker is 10 characters of `[A-Z]` and brackets, so "unchanged except for
        // markers" is the check, and it is the one that cannot be satisfied by a pass that
        // quietly ate prose. `f`/`t` filler between two words is a credential-class run of
        // its own and IS taken — that is the pinned behaviour above — so a probe welded
        // between filler legitimately loses the seam where its last word joins the filler.
        const stripped = (s: string) => s.split("[REDACTED]").join("");
        const keptOut = stripped(b.text);
        const keptProbe = stripped(probe);
        // A run the pass took that carries real content is one it had no warrant for. The
        // discriminator is the run's LENGTH in the probe, not its shape: the probes are
        // words, SHAs and URLs all under the 64-character floor, so a run of 64+ that a
        // probe contains at all only exists because the `glued` shape butted the probe's own
        // boundary word onto the filler — a filler artifact, and the window has to close on
        // it or the clip cannot be bounded at all. A run of 64+ that appears in every shape
        // (including `as-is`) is the probe's own material, and taking it is over-reach.
        const perShapeRuns = new Map<string, Set<string>>();
        for (const [, p] of shapes(text))
          perShapeRuns.set(p, new Set(p.match(/[A-Za-z0-9._\-/+=]{64,}/g) ?? []));
        const allRuns = new Set<string>();
        for (const set of perShapeRuns.values()) for (const r of set) allRuns.add(r);
        const own = [...allRuns].filter((r) => [...perShapeRuns.values()].every((s) => s.has(r)));
        const lost = own.filter((r) => !b.text.includes(r));
        assert(
          lost.length === 0,
          `${name} ${where} (from="${from}"): every run the pass took is one of the probe's own (${b.count}, lost ${lost.length})`,
        );
        assert(
          keptOut.length <= keptProbe.length,
          `${name} ${where} (from="${from}"): the pass only removes, never rewrites (${keptOut.length} vs ${keptProbe.length})`,
        );
      }
    }
  }

  // The accepted cost, stated as a test so a future "fix" for it has to delete this line
  // and say why. A 64+ hex hash is not a credential by any pattern — the probes above pin
  // `count === 0` for the same characters unclipped — and inside a window the scan did not
  // reach, the net cannot tell it from a key body. It is replaced, and that is deliberate:
  // the operator loses a hash from a truncated line; a leak would be the other outcome.
  const HEX64 = "a3f5b9c8d7e6f4a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8";
  const hash = `${filler(2048)} commit ${HEX64} built`;
  assert(redactSecrets(hash).count === 0, "a 64-char hex hash matches no pattern unbounded");
  const clipped = redactBounded(hash, 200, "end");
  assert(
    !clipped.text.includes(HEX64) && clipped.count >= 1,
    `a 64+ hex hash IS redacted in a clipped window — the accepted cost of failing closed (${clipped.count}, ${JSON.stringify(clipped.text.slice(0, 30))})`,
  );
  // ...and the shapes below the floor, in the same clipped window, are untouched: 40-char
  // SHA, 36-char UUID, path, URL. The floor is the boundary and nothing lowers it.
  for (const [label, t] of [
    ["git-sha", "commit 0123456789abcdef0123456789abcdef01234567"],
    ["uuid", "request 123e4567-e89b-12d3-a456-426614174000 accepted"],
    ["path", "/home/dev/projects/pi-rukas/extension/src/decision-log.ts"],
    ["url", "https://ci.example.com/teams/pi-rukas/runs/4271"],
  ] as [string, string][]) {
    const r = redactBounded(`${"y ".repeat(400)}${t} tail`, 200, "end");
    assert(
      r.text.includes(t),
      `${label} under the floor survives a clipped window (${r.count}, ${JSON.stringify(r.text.slice(0, 40))})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 6. THE BOUND IS A BOUND, whatever the edge sweep did to it (#1393 round 13, item 3).
//
// `redactEdgeRun` replaces the edge token with `REDACTED`, which is ten characters, so a token
// shorter than ten makes the window LONGER than the `max` it was cut to. `redactBounded` returned
// 14 characters for `max: 5` — measured on `"pre " + <104-char run> + " end"` from both ends.
// Every caller (`boundField`, `redactClip`) passes the bound on, so a bound that a redaction may
// exceed is not a bound; both branches now re-clip after the sweep.
// ---------------------------------------------------------------------------------------------
{
  const RUN64 = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6dE7fG8hJ9kL0mN1pQ2rS3Zz01";
  const body = `${RUN64}${"Z".repeat(40)}`;
  for (const from of ["start", "end"] as const) {
    for (let max = 1; max <= 40; max++) {
      const r = redactBounded(`pre ${body} end`, max, from);
      assert(
        r.text.length <= max,
        `bound ${max} from="${from}" is respected after the edge sweep (${r.text.length}, ${JSON.stringify(r.text)})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 7. The marker carve-out is about ADJACENCY, not about the offset 10 (#1393 round 13, item 4).
//
// The net skipped the run at `index === REDACTED.length` on the reasoning that `TAIL_SWEEP` owns
// glue against a marker. The test never asked whether a marker was THERE, so any 64+ run starting
// at byte 10 was excused — which is where the token after any ten-character prefix starts.
// ---------------------------------------------------------------------------------------------
{
  const KEY64 = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6dE7fG8hJ9kL0mN1pQ2rS3Zz01";
  assert(KEY64.length === 64, `fixture: the run is 64 characters, at the floor (${KEY64.length})`);
  for (let off = 7; off <= 12; off++) {
    const kept = `${"y".repeat(off)}${KEY64}${"x".repeat(20)}`;
    const r = redactUnscannedRuns(kept);
    assert(
      r.count === 1 && !r.text.includes(KEY64),
      `a 64-run starting at offset ${off} is taken (${r.count})`,
    );
  }
  // And the one position that IS TAIL_SWEEP's: a marker opening the window, glue welded to it.
  const glue = redactUnscannedRuns(`[REDACTED]${KEY64}`);
  assert(
    glue.count === 0 && glue.text.includes(KEY64),
    `...but glue on a marker that opens the window is left to TAIL_SWEEP (${glue.count})`,
  );
  // Same offset, no marker before it: the offset alone must not excuse the run. `[REDACTED` is ten
  // characters that are not the marker.
  const notGlue = redactUnscannedRuns(`[REDACTED${KEY64}`);
  assert(
    notGlue.count === 1 && !notGlue.text.includes(KEY64),
    `the same offset behind a non-marker prefix is taken (${notGlue.count})`,
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
