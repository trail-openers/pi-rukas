/**
 * The character-level primitives the credential-run walk is built from, factored out of
 * `decision-redact-window.ts` so that module reads as the pass it performs rather than as the
 * eleven comparisons and the sticky regex underneath it.
 *
 * Nothing here decides whether a secret is present. These answer three questions — is this
 * character part of a credential run, does a line break start here, how far does the run from
 * here reach — and carry the walk both callers use: {@link walkRunOneBreak}, which crosses at
 * most one break because that is as far as the net's own class reaches. The measurement and the
 * sweep share that one walk, and the cap is what keeps a measurement from promising a replacement
 * the class cannot deliver.
 */

/**
 * Membership in `CREDENTIAL_RUN`'s character class, spelled for a per-character walk. A regex
 * would re-enter the engine on every step of a walk that can run the whole scan cap deep; the
 * class is eleven codepoints, so a comparison chain is both cheaper and free of `lastIndex`
 * hazards. The ranges are the same eleven characters the regex in `decision-redact-window.ts`
 * carries — `test-decision-redaction-tail-sweep.ts` pins the two against each other through the
 * exported class source.
 */
export function isCredentialChar(code: number): boolean {
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
 * One line break with the blanks hugging it, anchored (`y`) so the walk can ask the engine
 * "does a break sit right here?" in constant time and never reconsider an earlier start.
 *
 * Both legs are written as a FORWARD sticky match over the text the leg walks, and the
 * backward leg walks the REVERSED text. That is not a flourish, it is the only shape that
 * works: a regex has no backward quantifier, so probing leftward for a break would have to
 * scan the candidate starts of a `\r\n` and take the longest that ends at the cursor, which
 * reads the same characters in the wrong order and can accept a trailing blank run belonging
 * to the next line — precisely the boundary the walk is looking for. Reversing once makes the
 * backward leg forward, so the two legs are one piece of code and cannot drift apart.
 *
 * The forms are the physical breaks of `secret-patterns`'s `SEP`; the escaped pair is prose,
 * not a line, and is deliberately not here.
 */
const LINE_BREAK = /[ \t]*(?:\r\n|\n|\r)[ \t]*/y;

/** The widest line break the walk can step across in one go, blanks included. */
const LINE_BREAK_MAX = 7;

/**
 * Does a line break start at `at`? Returns its length, or 0. `LINE_BREAK` is sticky, so
 * `m.index === at` is the "right here" test and a non-match costs one engine step.
 */
export function breakAt(src: string, at: number): number {
  if (at < 0 || at >= src.length) return 0;
  LINE_BREAK.lastIndex = at;
  const m = LINE_BREAK.exec(src);
  if (!m || m.index !== at || m[0].length === 0 || m[0].length > LINE_BREAK_MAX) return 0;
  return m[0].length;
}

/**
 * The reversal cache: one `split`/`join` per text rather than one per edge. A bounded redaction
 * asks the two legs of one measurement plus the two of the sweep, and the reversal is the only
 * per-call cost the backward leg adds over a non-crossing walk.
 */
let revCache: { src: string; rev: string } | undefined;

export function reversed(text: string): string {
  if (revCache?.src === text) return revCache.rev;
  const rev = text.split("").reverse().join("");
  revCache = { src: text, rev };
  return rev;
}

/**
 * Walk a credential-class run FORWARD from `origin`, stepping across at most ONE line break —
 * which is how far the net's own class reaches.
 *
 * The cap is not caution, it is agreement. The net replaces only a match it can spell, and a
 * match it can spell carries at most one break; a measurement allowed to cross two hands it a
 * "long run" for material it cannot take, so the count rises and the fragment stays.
 */
export function walkRunOneBreak(
  src: string,
  origin: number,
  limit: number,
): { end: number; walked: number } {
  let seen = 0;
  let i = origin;
  let walked = 0;
  // The origin is classified first, and a leg that does not start inside a run walks nothing.
  // Without this the probe answers a question nobody asked: a leg handed the last character of
  // the prose `trailing tail words` — 8 characters, in the class as it happens — crossed the
  // break under it, found the 186-character body below, and called the prose a long run. The
  // edge pass then redacted a log line that had no key material in it and had survived every
  // round since the case was written. A leg starts on the DELIMITER beside the token it was
  // asked about, which is what makes "the run continues" mean the run and not the neighbourhood.
  if (i >= limit || !isCredentialChar(src.charCodeAt(i))) return { end: i, walked };
  while (i < limit) {
    if (isCredentialChar(src.charCodeAt(i))) {
      i++;
      walked++;
      continue;
    }
    const blen = breakAt(src, i);
    if (blen === 0 || i + blen > limit || seen >= 1) break;
    const after = i + blen;
    if (after >= src.length || !isCredentialChar(src.charCodeAt(after))) break;
    i += blen;
    walked += blen;
    seen++;
  }
  return { end: i, walked };
}
