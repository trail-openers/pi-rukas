/**
 * decision-redact-window — the two scan-window moves `redactBounded` is built from
 * (#1393): widening a cut outward to a token boundary, and failing closed when that
 * widening gives up.
 *
 * Split out of `decision-log.ts` along the natural seam (the file was heading for the
 * 500-line cap). `redactBounded` stays the only caller, and stays the place that owns
 * redact-then-clip ordering and the returned count; these two are the geometry of the
 * window it scans.
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
 * never reached is what the bounded pass fails closed on; the threshold is the shortest
 * body any arm in `secret-patterns.ts` matches, so a run below it cannot be a credential
 * that was missed, and ordinary prose (which contains spaces) never forms one.
 */
const CREDENTIAL_CLASS = /[A-Za-z0-9._\-/+=]{64,}/g;

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
 * walk that happened to end at a token start, and `redactBounded` needs to know
 * which half of its window the scan never saw.
 *
 * The offset it returns is a TOKEN START, not merely a token boundary, and that
 * distinction is load-bearing rather than tidy. No pattern is `^`-anchored — the
 * prefix rules dropped their leading `\b` deliberately (see secret-patterns.ts) —
 * so what makes a mid-token slice useless is not an anchor but the combination of a
 * GREEDY body and the token-end lookahead: a body swallows everything its class
 * allows and the lookahead then refuses a continuation, so a slice that opens one
 * character into a run has to match the pattern starting there, and for a prefix
 * rule the prefix is behind it — no match at all, and zero redactions reported over
 * a window full of keys. Walking to the whitespace and then stopping ON the
 * delimiter leaves the walk one short of the character that begins the token; the
 * `+1`/`-1` below is the step onto it. A window that begins mid-token is the shape
 * that hid the glued credential from the bounded scan (#1393).
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
 * When `widenPastCut` gives up, the scan window opens on the middle of an unbroken
 * credential-class run, so no arm anchors on it and the pass reports `count: 0` while the
 * kept half ships the run whole — measured on `"f".repeat(5000) + " password=" + <10 KB
 * base64> + " tail words"` through `redactBounded(…, 600, "end")`. Widening cannot fix
 * that (the run has no whitespace to walk to) and neither can the PEM arm (no header).
 *
 * So the window is judged by its own contents instead: any run of credential-class
 * characters long enough to be a key body that survives unredacted is replaced. It is
 * LINEAR — one global regex pass over at most `max` kept characters plus one
 * `startsWith` — so the fail-closed path costs less than the scan it follows, and
 * `redactBounded` calls it only on the side whose widening gave up. A window that opens on
 * a marker followed by glue is not this case: `TAIL_SWEEP` already ate the glue, and this
 * pass would only count what was already redacted.
 */
export function redactUnscannedRuns(kept: string): { text: string; count: number } {
  if (kept.startsWith(REDACTED)) return { text: kept, count: 0 };
  let count = 0;
  const text = kept.replace(CREDENTIAL_CLASS, () => {
    count++;
    return REDACTED;
  });
  return { text, count };
}
