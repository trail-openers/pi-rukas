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

import { breakAt, isCredentialChar, reversed, walkRunOneBreak } from "./credential-walk.ts";
import { REDACTED } from "./secret-patterns.ts";

/**
 * The token boundary `widenPastCut` walks to, hoisted out of the loop (#1393 round 5,
 * item 6). A literal `RegExp` in the body is re-created on every character of a walk
 * that can run `SCAN_CAP` deep, and the walk is on the hot path of every bounded pass.
 * `\s` carries no `g` flag, so a single shared instance cannot leak `lastIndex`.
 */
const WHITESPACE = /\s/;

/**
 * The characters the fail-closed net writes a credential in — exported as SOURCE so the sweep
 * test can pin `isCredentialChar` against it character by character. The class literal is the
 * members below, which `CREDENTIAL_RUN` is built from; a copy in a test would be a second claim
 * that drifts.
 */
const CREDENTIAL_RUN_CLASS_MEMBERS = "A-Za-z0-9._\\-/+=";

/**
 * The same eleven characters as a one-character class, so the pin below asks the ENGINE the
 * question it asks the comparison chain. Derived, never written out: a literal that has to be
 * kept in step with `CREDENTIAL_RUN` is the second claim this export exists to remove.
 */
export const CREDENTIAL_RUN_CLASS_SOURCE = `[${CREDENTIAL_RUN_CLASS_MEMBERS}]`;

/**
 * The floor the fail-closed net judges a token by, and the characters a credential is
 * written in — the same class the post-loop `TAIL_SWEEP` eats after a marker (#1393). A run
 * of these long enough to be a key body that the scan never reached is what the bounded pass
 * fails closed on.
 *
 * The 64 is a fail-closed NET for unanchored runs of 64 or more, not "the shortest body any
 * arm in `secret-patterns.ts` matches" — that claim was never true of every arm, and stating
 * it invited the wrong inference in both directions: that a 60-char run is safe, and that
 * anything under 64 is definitionally ordinary text. It is a threshold set so the ordinary
 * identifiers an operator reads in a log — a 40-char git SHA, a 36-char UUID, a path, a URL —
 * sit below it and survive, while anything long enough to be a base64 key body sits above it
 * and is replaced. A 64+ hex hash landing in a clipped window is therefore redacted, and that
 * is the accepted cost of the net rather than a defect.
 *
 * question is pinned by the exported `CREDENTIAL_RUN_CLASS_SOURCE` the literal is built from.
 *
 * The `g` flag lives on {@link CREDENTIAL_RUN} rather than at the use site, so the passes
 * below cannot disagree about whether they walk the whole window. A fresh `String.replace`
 * resets `lastIndex`, so one shared instance cannot leak state.
 */
const CREDENTIAL_RUN_MIN = 64;

/**
 * A run of credential-class characters that may continue across ONE line break — the shape
 * a bare `{64,}` class cannot express, and the reason it must.
 *
 * The 64-character floor is a judgement about a TOKEN, and in a PEM a token is a base64
 * BODY, which is written over many lines. Judged line by line, the last line of a key whose
 * body wraps is whatever is left over — 40 characters in the measured repro, 19 in the
 * adversarial one — and a run that short is invisible to the net however much key material it
 * carries. So the net matches the run the way the arm does: body characters, an optional
 * single break with the blanks hugging it, more body characters. A run of blanks with no break
 * in it matches nothing, so the net still never reaches a credential across an empty line, and
 * each branch begins with a mandatory member of its own class, so no two branches match what
 * the other matches and a failed continuation backtracks in one step. The break is one
 * alternation over three physical forms, not a quantified group, so the pass stays linear at
 * the sizes {@link test-decision-secret-regex-linear} measures.
 *
 * The match is the whole run, marker to marker, and the replacement is one marker, so the
 * blanks and the break a key was wrapped over are taken with it — they are part of the leaked
 * material's layout, not content an operator needed.
 */
const CREDENTIAL_RUN = new RegExp(
  `${CREDENTIAL_RUN_CLASS_SOURCE}+(?:[ \t]*(?:\r\n|\n|\r)[ \t]*)?${CREDENTIAL_RUN_CLASS_SOURCE}*`,
  "g",
);

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
 * The run may CROSS ONE LINE BREAK ({@link CREDENTIAL_RUN}), which is the half a line-by-line
 * net cannot see: the 40-character last line of a key whose 120-character body lines sit
 * above it is 40 characters judged alone and 160 judged as the token it is, and the 64-floor
 * only ever sees the second number. A short line in the MIDDLE of a body escapes the edge
 * probes entirely — neither edge of the window touches it — so the crossing belongs here
 * rather than only in {@link edgeRunReaches}, which judges the two tokens the clip cut.
 *
 * Judges in-window run length only; a short final line of a key body whose header is out of
 * reach is a known gap tracked in #1439.
 *
 * What `TAIL_SWEEP` handles is the narrower case — credential-class GLUE butting straight
 * against a marker, with no separator — and the net leaves exactly that position alone: the
 * run begins at the character right after a marker THAT OPENS THE WINDOW, with nothing between
 * them. A run beginning at the same OFFSET behind anything else is not glue and is the net's.
 */
export function redactUnscannedRuns(kept: string): { text: string; count: number } {
  // Computed once, outside the callback: the carve-out is about ADJACENCY to a leading
  // marker, and reading `kept` per match re-derives a fact the window cannot change.
  const opensOnMarker = kept.slice(0, REDACTED.length) === REDACTED;
  let count = 0;
  const text = kept.replace(CREDENTIAL_RUN, (match: string, index: number) => {
    // The floor judges the RUN, which is why the break it may carry is stripped before the
    // comparison rather than left in to pad a short line up to the threshold. The match IS the
    // run the net can spell — one class, at most one break — so its own length is the only
    // measurement that cannot promise a replacement the class cannot deliver.
    const body = match.replace(/[ \t]*(?:\r\n|\n|\r)[ \t]*/g, "").length;
    if (body < CREDENTIAL_RUN_MIN) return match;
    // `TAIL_SWEEP` already ate glue that butts DIRECTLY against a leading marker. Replacing
    // that run here would only count what another arm already redacted. The old test was
    // `index === REDACTED.length`, which keyed on the OFFSET rather than on adjacency and
    // never asked what preceded byte 10, so it excused any 64+ run beginning at that byte —
    // and byte 10 is where the token after any ten-character prefix begins. Measured: the net
    // answered `count: 0`, leaving the run whole, for `"0123456789" + <64-char key>`, for the
    // same key behind a mid-window marker, and for a key whose own marker did not open the
    // window. Adjacency is the property TAIL_SWEEP actually consumed, so adjacency is the test.
    if (opensOnMarker && index === REDACTED.length) return match;
    count++;
    return REDACTED;
  });
  return { text, count };
}

/**
 * How far the token touching each edge of a clipped window reaches in the FULL text
 * ({@link redactBounded}, #1393).
 *
 * The walk crosses LINE BREAKS — but at most ONE, the reach of {@link CREDENTIAL_RUN} that the
 * net can actually spell ({@link walkRunOneBreak}). It measures a PEM body, and a PEM body is
 * many lines, so a run that stops at the first newline is a run the walk gave up on rather than
 * a short one. The stop
 * at the newline was the whole defect: with the header out of `PEM_HEADER_REACH` (decision-log.ts) the
 * arm cannot anchor, the clip lands mid-body, and the window's last line is a 40-character
 * base64 tail sitting under the 64-character floor. Measured at `redactBounded(text, 600,
 * "end")` on 145 lines of 120-character base64 followed by a 40-character line, the walk
 * started on the `\n` immediately left of the cut, matched none of its class, took ZERO
 * steps, and reported `head: false` — the fragment's 40 characters are all `kept` can see
 * and all the walk saw either, so the fragment shipped while `count` read 5. Stepping across
 * the break and keeping the meter running is what makes the same walk report the truth: the
 * token this fragment belongs to is 120 characters long, and 120 is over the floor.
 *
 * Crossing costs the walk its characters but not its verdict: each character crossed counts
 * toward `walked`, so an out-of-budget walk still fails closed, and a genuinely short last
 * line followed by a word boundary stops on the first non-break character outside the class
 * and returns `false` — the over-reach side is untouched, because the judgement is still
 * "how long is the run this token belongs to", only now measured across the lines a key is
 * actually written over.
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
    // Both legs walk FORWARD over `src`; the backward leg walks the reversed text, where
    // "leftward in the original" is a forward scan and the break probe is the same sticky
    // regex on both sides (see {@link walkRunOneBreak}).
    //
    // ONE break, and no further — which is what {@link CREDENTIAL_RUN} the net can spell, and
    // what HEAD's walk did by stopping at the newline under the token it was asked about.
    // Crossing a second time measures the token as the whole BODY it eventually merges into,
    // and the net then has no match to make: a clipped PEM ending on the prose line
    // `trailing tail words` came back `tail: true` — the word is 8 characters, but its newline,
    // the 186-character body above it, and that body's newline put it past the floor on the
    // measurement's word while the net, able to cross only one, had nothing to replace. The edge
    // pass, told by that flag, ate the prose. A measurement and a replacement must be able to
    // disagree about nothing, least of all about how far a run reaches.
    const backward = step === -1;
    const src = backward ? reversed(text) : text;
    const origin = backward ? text.length - 1 - from : from;
    const { end, walked } = walkRunOneBreak(src, origin, Math.min(src.length, origin + walkCap));
    // An out-of-budget walk never saw the run's end, so the run is not known to be short.
    if (end >= Math.min(src.length, origin + walkCap)) return true;
    return walked >= CREDENTIAL_RUN_MIN;
  };
  // `windowStart` is the window's first character: the head question is asked of the token
  // OPENING the window, so it is the character AT `windowStart` that has to be in the class —
  // a window opening on a space, or on the `[` of a marker, has no head token to sweep and the
  // edge pass must stay out of it. The walk then starts one back, on the delimiter the run ends
  // at, so the line leg can find the break there and keep measuring: starting on the run's own
  // last body character counted it twice and, before the break legs existed, took zero steps.
  // `windowStart` is the window's first character: the head question is asked of the token
  // OPENING the window, so the character AT `windowStart` has to be in the class. The leg then
  // stands on the delimiter just before it (`windowStart - 1`) and walks left: standing on the
  // token's own last body character instead counted it twice and left the leg with nowhere to
  // ask about a break, which is how a 186-character body line got reported as the 40-character
  // fragment the clip happened to show.
  const head =
    windowStart < windowEnd && isCredentialChar(text.charCodeAt(windowStart))
      ? reaches(windowStart - 1, -1)
      : false;
  // Mirror image of the head leg. `windowEnd` is one past the window's last character, i.e. the
  // delimiter AFTER the token, so that is where the leg stands and that is what it classifies.
  // The guard asks the character BEFORE it — the window's last — because that is the character
  // the window shows, and the flag must describe the token the clip cut, not the text next to
  // it. Standing the leg on the token instead is what over-reached: from the last body character
  // it crossed the break below, found more body, and reported the window's own prose tail as a
  // 200-character run. `trailing tail words` came back `[REDACTED]`, and the assertion that a
  // log line after a clipped key survives — green before this round — went red with it.
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
  // The sweep crosses line breaks for the same reason the measurement does ({@link
  // edgeRunReaches}): the fragment at the edge is a PIECE of a run that spans several lines, and
  // a sweep stopping at the newline replaces the piece it can see and leaves the rest of the same
  // run standing in the window. Measured on a clipped key whose body lines are 186 characters and
  // whose window opens 22 characters into one: the head sweep replaced those 22, `count` rose, and
  // the remaining 164 characters of that very line stayed readable — a redaction that reports
  // itself and does not cover the token it touched is worse than one that declines.
  //
  // Both sweeps walk FORWARD — `tail` over the reversed window — so the break probe is the same
  // forward sticky match either way and the two cannot drift. {@link walkRunOneBreak} classifies
  // the origin before probing, which is what keeps a window closing on prose from being walked
  // into the body beneath it.
  const src = side === "tail" ? reversed(kept) : kept;
  if (!isCredentialChar(src.charCodeAt(0))) return { text: kept, count: 0 };
  const { end } = walkRunOneBreak(src, 0, Math.min(src.length, walkCap));
  if (side === "head") return { text: REDACTED + kept.slice(end), count: 1 };
  if (end === 0) return { text: kept, count: 0 };
  return { text: kept.slice(0, kept.length - end) + REDACTED, count: 1 };
}
