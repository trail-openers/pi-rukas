/**
 * decision-redact-window — the scan-window moves `redactBounded` is built from (#1393):
 * widening a cut outward to a token boundary, failing closed on a kept window the scan
 * never reached, and measuring how far a token at the edge of a clipped window reaches in
 * the text that was clipped.
 *
 * Split out of `decision-log.ts` along the natural seam (the file was heading for the
 * 500-line cap). `redactBounded` stays the only caller, and stays the place that owns
 * redact-then-clip ordering and the returned count; these are the geometry of the window
 * it scans.
 */

import { REDACTED } from "./secret-patterns.ts";

/**
 * The token boundary `widenPastCut` walks to, hoisted out of the loop (#1393 round 5,
 * item 6). A literal `RegExp` in the body is re-created on every character of a walk
 * that can run `SCAN_CAP` deep, and the walk is on the hot path of every bounded pass.
 * `\s` carries no `g` flag, so a single shared instance cannot leak `lastIndex`.
 */
const WHITESPACE = /\s/;

/**
 * The characters a credential is written in — the same class the post-loop `TAIL_SWEEP`
 * eats after a marker (#1393). A run of these long enough to be a key body that the scan
 * never reached is what the bounded pass fails closed on.
 *
 * The 64 is a fail-closed NET for unanchored runs of 64 or more, not "the shortest body
 * any arm in `secret-patterns.ts` matches" — that claim was never true of every arm, and
 * stating it invited the wrong inference in both directions: that a 60-char run is safe,
 * and that anything under 64 is definitionally ordinary text. It is a threshold set so the
 * ordinary identifiers an operator reads in a log — a 40-char git SHA, a 36-char UUID, a
 * path, a URL — sit below it and survive, while anything long enough to be a base64 key
 * body sits above it and is replaced. A 64+ hex hash landing in a clipped window is
 * therefore redacted, and that is the accepted cost of the net rather than a defect.
 *
 * The `g` flag lives here rather than at the use site, so the passes below cannot disagree
 * about whether they walk the whole window. The class carries no `\s`, and a fresh
 * `String.replace` resets `lastIndex`, so one shared instance cannot leak state.
 */
const CREDENTIAL_CLASS = /[A-Za-z0-9._\-/+=]{64,}/g;

/** The floor the fail-closed net judges a token by. */
const CREDENTIAL_RUN_MIN = 64;

/**
 * Membership in {@link CREDENTIAL_CLASS}'s character class, spelled for a per-character
 * walk. A regex would re-enter the engine on every step of a walk that can run the whole
 * scan cap deep; the class is eleven codepoints, so a comparison chain is both cheaper and
 * free of `lastIndex` hazards. The ranges are the same eleven characters the regex above
 * carries — `test-decision-redaction-tail-sweep.ts` pins the two against each other.
 */
function isCredentialChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 45 || // -
    code === 46 || // .
    code === 47 || // /
    code === 43 || // +
    code === 61 || // =
    code === 95 // _
  );
}

/**
 * Pull a scan cut outward to a token boundary, into the side being DROPPED.
 *
 * The cut must not land in the middle of a token, because that is exactly the
 * position that amputates a pattern's context: `https://user:pass@host` kept
 * from `user:` has no `://`, and `Bearer <token>` kept from `<token>` has no
 * `Bearer `. So from the window's own edge (`from`) walk outward to the nearest
 * whitespace — the boundary of the token the edge fell inside — and then TWO
 * more whitespace-separated tokens.
 *
 * The WHOLE walk, both legs together, is capped at `SCAN_CAP` from `from`:
 * clamping only the first leg would let a 2 MB whitespace-free run drag the scan
 * to offset 0 and make the bound decorative. Returns an offset on the dropped
 * side of `from`, no further from it than `SCAN_CAP` (#1393).
 *
 * When the walk finds no whitespace inside `SCAN_CAP` it stops AT the cap rather
 * than sweeping to offset 0 for the answer — the run is unbounded, so a scan over
 * it is, and a window that wide is what made the bound decorative. `gaveUp` is the
 * whole point of the second field: the caller cannot tell that offset apart from a
 * walk that happened to end at a token start.
 *
 * `gaveUp` is NOT what the fail-closed net keys on (see {@link redactUnscannedRuns}): it
 * reports that the WALK terminated, not that the SCAN saw the kept window, and one
 * whitespace inside the budget is enough to make it false over a body no arm anchored on.
 * It remains the caller's signal for whether the widening reached a token start.
 *
 * The offset it returns is a TOKEN START, not merely a token boundary, and that
 * distinction is load-bearing rather than tidy. No pattern is `^`-anchored — the
 * prefix rules dropped their leading `\b` deliberately (see secret-patterns.ts) — so what
 * makes a mid-token slice useless is not an anchor but the combination of a GREEDY body and
 * the token-end lookahead: a body swallows everything its class allows and the lookahead
 * then refuses a continuation, so a slice that opens one character into a run has to match
 * the pattern starting there, and for a prefix rule the prefix is behind it — no match at
 * all, and zero redactions reported over a window full of keys. Walking to the whitespace
 * and then stopping ON the delimiter leaves the walk one short of the character that begins
 * the token; the `+1`/`-1` below is the step onto it. A window that begins mid-token is the
 * shape that hid the glued credential from the bounded scan (#1393).
 */
export function widenPastCut(
  text: string,
  from: number,
  side: "head" | "tail",
  scanCap: number,
): { offset: number; gaveUp: boolean } {
  const isSpace = (i: number) => WHITESPACE.test(text[i] ?? "");
  // One clamp, not two. The walk may never pass `stop`, and `stop` is already
  // `SCAN_CAP` away from `from`, so the offset IS the length bound: a separate
  // `walked < budget` counter walked in lockstep with it and could only ever
  // agree. Clamping the offset alone (an earlier cut here did) turns the
  // widening into a no-op on a short text, where the cap would place the stop at
  // 0 and every walk back to 0 is then legal — which is what `stop` is derived
  // from `from` for, rather than from the text's own ends.
  if (side === "head") {
    const stop = Math.max(0, from - scanCap);
    let i = from;
    while (i > stop && !isSpace(i)) i--;
    // Out of budget with no whitespace found: the run is unbounded, so stop.
    if (i === stop) return { offset: stop, gaveUp: true };
    // `i` sits ON the delimiter; step back onto the token's first character.
    i--;
    let tokens = 0;
    while (i > stop && tokens < 2) {
      if (isSpace(i - 1)) tokens++;
      i--;
    }
    // The last decrement crossed a token start, so land back on the delimiter
    // and hand the caller a slice that opens on a token.
    return { offset: tokens === 2 ? i + 1 : i, gaveUp: false };
  }
  const stop = Math.min(text.length, from + scanCap);
  let i = from;
  while (i < stop && !isSpace(i - 1)) i++;
  // Only a walk that actually reached the cap gave up: a walk that stopped at the
  // text's own end saw the whole remaining string.
  if (i === stop && stop < text.length) return { offset: stop, gaveUp: true };
  // `i` sits just past the delimiter; step back onto the token's first character.
  let tokens = 0;
  while (i < stop && tokens < 2) {
    if (isSpace(i)) tokens++;
    i++;
  }
  return { offset: tokens === 2 ? i - 1 : i, gaveUp: false };
}

/**
 * Fail closed on a kept window the scan never reached (#1393).
 *
 * When the scan did not cover the kept window, no arm anchored on what it contains and the
 * pass reports `count: 0` while the kept half ships the material whole — measured on
 * `"f".repeat(5000) + " password=" + <10 KB base64> + " tail words"` through
 * `redactBounded(…, 600, "end")`. Widening cannot fix that (an unbroken run has no
 * whitespace to walk to) and neither can the PEM arm (no header inside the reach).
 *
 * So the window is judged by its own contents: any run of credential-class characters that
 * reaches {@link CREDENTIAL_RUN_MIN} and survives unredacted is replaced.
 *
 * It runs on EVERY clipped window, not only the one whose walk gave up (#1393). `gaveUp`
 * cannot be the gate: `widenPastCut` reports `gaveUp: false` as soon as it finds ONE
 * whitespace inside `SCAN_CAP`, so a few hundred characters of `"w "` filler between the
 * run and the cut makes the walk succeed — while the scan still never reached a key sitting
 * beyond `PEM_HEADER_REACH`, which is where the PEM arm's anchor was dropped. `gaveUp:
 * false` means "the walk terminated", not "the scan saw the kept window", and a kept window
 * the scan did not see is exactly the shape this pass exists for. The unclipped case cannot
 * reach it: `redactBounded` returns `redactSecrets(text)` wholesale when
 * `text.length <= max`, so a text that was never CLIPPED has had every arm run over all of
 * it.
 *
 * LINEAR: one global regex pass over at most `max` kept characters, so the fail-closed path
 * costs less than the scan it follows.
 *
 * There is no `kept.startsWith(REDACTED)` early return. It read as "a window that opens on
 * a marker has already been handled", and that is false: one redaction at the LEFT edge of
 * the scan window says nothing about the rest of the kept window, so a key sitting behind
 * that marker escaped the net entirely.
 *
 * What `TAIL_SWEEP` handles is the narrower case — credential-class GLUE butting straight
 * against a marker, with no separator — so that one position is left to it: a
 * credential-class run beginning in the character immediately after `[REDACTED]` is not
 * replaced here, and every other run of 64 or more is.
 */
export function redactUnscannedRuns(kept: string): { text: string; count: number } {
  const markerTail = REDACTED.length;
  let count = 0;
  const text = kept.replace(CREDENTIAL_CLASS, (match: string, index: number) => {
    // `TAIL_SWEEP` already ate glue that butts against a marker; replacing that run here
    // would only count what another arm already redacted. Anywhere else the run is the
    // net's — after a space, after any other character, anywhere in the window.
    if (index === markerTail) return match;
    count++;
    return REDACTED;
  });
  return { text, count };
}

/**
 * How far the token touching each edge of a clipped window reaches in the FULL text
 * ({@link redactBounded}, #1393).
 *
 * The 64-char floor is a judgement about a WHOLE token, so a clipped window must not be
 * judged on its own slice of one. A base64 key body is a single token thousands of
 * characters long; when the clip falls inside it, the kept window opens on a fragment —
 * 19 characters of key body in the measured PEM repro — that is shorter than the floor,
 * invisible to {@link redactUnscannedRuns}, and yet carries real credential bytes past
 * `leaksKey`'s twelve-character window. So the fragment is measured where its length
 * actually lives: in the text that was clipped, across the cut. If the edge token is part
 * of a run that reaches the threshold in the full text, the fragment goes however short it
 * looks.
 *
 * Nothing else takes a lower threshold. A token that is genuinely short in the full text —
 * a git SHA, a UUID, a path segment, a word — is reported `false` and survives, which is
 * the over-reach half of the contract; this function makes no judgement of its own.
 *
 * `walkCap` is supplied by the caller because the walk may have to cross an unbounded run,
 * and a scan over such a run is itself unbounded — the same reason `widenPastCut` stops at
 * its cap rather than sweeping to offset 0 for an answer. A walk that hits `walkCap`
 * without finding the run's end reports `true`: out of budget the run is not KNOWN short,
 * and a fail-closed net treats unknown as long.
 *
 * Linear: one bounded walk per edge, over at most `walkCap` characters, on the text the
 * caller already holds.
 */
export function edgeRunReaches(
  text: string,
  windowStart: number,
  windowEnd: number,
  walkCap: number,
): { head: boolean; tail: boolean } {
  const reaches = (from: number, step: -1 | 1): boolean => {
    const stop = step === -1 ? Math.max(0, from - walkCap) : Math.min(text.length, from + walkCap);
    let i = from;
    while (i !== stop && isCredentialChar(text.charCodeAt(i))) i += step;
    const walked = Math.abs(i - from);
    // Out of budget with no break: the run may continue, so it is not known to be short.
    return walked >= walkCap || walked >= CREDENTIAL_RUN_MIN;
  };
  // `windowStart` is the window's first character: if it is a credential character the
  // window opens inside a token, and the walk extends LEFT into the dropped side.
  const head =
    windowStart < windowEnd && isCredentialChar(text.charCodeAt(windowStart))
      ? reaches(windowStart, -1)
      : false;
  // `windowEnd` is one past the window's last character: the walk extends RIGHT.
  const last = windowEnd - 1;
  const tail =
    windowStart <= last && isCredentialChar(text.charCodeAt(last)) ? reaches(windowEnd, 1) : false;
  return { head, tail };
}

/**
 * Replace the token at one edge of a clipped window — the one {@link edgeRunReaches}
 * measured as part of a run that reaches the threshold in the full text — and nothing else.
 *
 * `side: "head"` is the window's first token, `side: "tail"` its last. The walk is bounded
 * by `walkCap` for the same reason as above, and an out-of-budget walk takes the token it
 * was shown: the caller has already been told the run is not known short.
 */
export function redactEdgeRun(
  kept: string,
  side: "head" | "tail",
  walkCap: number,
): { text: string; count: number } {
  if (!kept.length) return { text: kept, count: 0 };
  if (side === "head") {
    if (!isCredentialChar(kept.charCodeAt(0))) return { text: kept, count: 0 };
    let i = 0;
    while (i < kept.length && i < walkCap && isCredentialChar(kept.charCodeAt(i))) i++;
    return { text: REDACTED + kept.slice(i), count: 1 };
  }
  let i = kept.length;
  while (i > 0 && kept.length - i < walkCap && isCredentialChar(kept.charCodeAt(i - 1))) i--;
  if (i === kept.length) return { text: kept, count: 0 };
  return { text: kept.slice(0, i) + REDACTED, count: 1 };
}
