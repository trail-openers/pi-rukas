#!/usr/bin/env bun
/**
 * Pi version-claim gate: the census-consistency assertion (#787 / #959).
 *
 * Moved here VERBATIM from ./pi-version-census.ts so that file could stay under
 * the 500-line cap while keeping its comments intact (move code, not compress
 * comments — the comments are load-bearing). This is the half of the census gate
 * that CHECKS the census comments: it re-derives every grounding figure the
 * comments assert from the detector, so none of them is transcribed and none can
 * rot. Intentionally NOT named test-*.ts — verify-loop.sh runs only test-*.ts as
 * tests; coverage comes through test-pi-version-drift.ts, which imports it.
 */
import {
  PI_CLAIM_MARKER_NAMES,
  PI_CLAIM_MARKERS,
  piLiteralClaims,
  type ClaimDetector,
  type GroundingCitation,
} from "./pi-version-census.ts";

/** The "the literal follows" terminator a citation may end with. */
const ELLIPSIS = "\u2026";

/**
 * The census-consistency assertion, replacing the hand-transcribed grounding
 * block. For each (file, literal) it checks the DETECTED CLAIM SET is exactly
 * the cited set - no more (a claim nothing grounds), no fewer (a citation whose
 * text has gone), no duplicates (one occurrence counted twice) - and pairs each
 * citation to a distinct claim whose marker name and forward gap it names
 * correctly. `quoted` is the text just BEFORE the literal, ending in an
 * ellipsis for "the literal follows": quoting the digits themselves would put
 * the citation, which lives inside the file under inspection, in a marker's
 * window and manufacture the claim it was meant to describe. Every message
 * carries the detector's own answer, so a failure is readable without a probe.
 * `detect` is the gate's detector; passing a detector that finds nothing shows the
 * block fails closed, i.e. is observed to redden rather than assumed to.
 */

export function censusGroundingErrors(textByFile: Record<string, string>, expected: Record<string, Record<string, GroundingCitation[]>>, detect: ClaimDetector): string[] {
  const errors: string[] = [];
  // One masked scan text per file: the declarations `declaredGroundingTable`
  // writes for that file, blanked to equal length. Keyed on the table's own
  // content, not on a line number, so it cannot go stale when the file moves.
  const scans = maskGroundingTable(textByFile, expected);
  for (const [rel, byLiteral] of Object.entries(expected)) {
    const text = textByFile[rel];
    if (text === undefined) {
      errors.push(`${rel}: no text read - cannot check its grounding citations`);
      continue;
    }
    for (const [literal, citations] of Object.entries(byLiteral)) {
      // A declared row with no citations would be compared against the detector's
      // own empty answer whenever the file holds no claim - both sides zero, and
      // the row green without checking anything. Every entry in the table states
      // claims, so an empty list is a deletion, not a fact.
      if (citations.length === 0) {
        errors.push(`${rel} ${literal}: declared no citations - a checked (file, literal) row must state at least one claim, or the count check compares two empties and passes by silence`);
        continue;
      }
      // `scan` is this file's bytes with its own declarations blanked, so the
      // table cannot manufacture the claims it describes.
      const detected = piLiteralClaims(text, literal, detect, scans[rel]);
      const say = (list: { marker: string; gap: number }[]) => list.map((d) => `${d.marker}@${d.gap}`).join(", ");
      const sayCit = (list: GroundingCitation[]) => list.map((x) => `${x.quoted}=${x.marker}@${x.gap}`).join(", ");
      if (detected.length !== citations.length) {
        errors.push(`${rel} ${literal}: detector found ${detected.length} claim(s) [${say(detected)}] but the citations declare ${citations.length} [${sayCit(citations)}]`);
        continue;
      }
      // One-to-one pairing, fewest-candidates-first so an unambiguous citation
      // claims its occurrence before an ambiguous one can take it.
      const taken = new Set<number>();
      const cands = citations.map((cit) => ({ cit, opts: detected.map((_, i) => i).filter((i) => anchors(text, detected[i] as number, cit)) }));
      for (const c of cands.sort((x, y) => x.opts.length - y.opts.length)) {
        const free = c.opts.filter((i) => !taken.has(i));
        if (free.length === 0) {
          errors.push(`${rel} ${literal}: cited ${JSON.stringify(c.cit.quoted)} matches no claim at marker \`${c.cit.marker}\` gap ${c.cit.gap} (detector says [${say(detected)}])`);
          continue;
        }
        taken.add(free[0] as number);
      }
    }
  }
  return errors;
}

/**
 * Blank, from each file's bytes, the region that declares that file's citations.
 * The expected block quotes marker text (`MIN_PI_VERSION`, the `pi-tui` pin, …),
 * so a detector that read it would find claims the assertion itself created - the
 * reason the earlier version sliced its own file at a hand-written marker.
 * Masking the rendered declaration rather than slicing at an address means there
 * is no address to maintain, and each run is replaced by spaces of IDENTICAL
 * length so every index stays an index into the original bytes. A declaration not
 * found in the file it claims to describe masks nothing: the check then runs on
 * raw bytes, so a fabricated citation surfaces as a mismatch, never hidden.
 */
function maskGroundingTable(textByFile: Record<string, string>, expected: Record<string, Record<string, GroundingCitation[]>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [rel, byLiteral] of Object.entries(expected)) {
    const text = textByFile[rel];
    if (text === undefined) continue;
    let scan = text;
    for (const citations of Object.values(byLiteral))
      for (const cit of citations) {
        const decl = `{ quoted: ${JSON.stringify(cit.quoted)}, marker: ${JSON.stringify(cit.marker)}, gap: ${cit.gap} }`;
        const at = scan.indexOf(decl);
        if (at >= 0) scan = `${scan.slice(0, at)}${" ".repeat(decl.length)}${scan.slice(at + decl.length)}`;
      }
    out[rel] = scan === text ? undefined : scan;
  }
  return out;
}

/**
 * Does `cit` describe claim `d`? Three facts must all hold, each falsifiable on
 * its own: (1) it names that claim's MARKER; (2) the QUOTE is the text
 * immediately BEFORE the literal, so with the trailing ellipsis stripped it ends
 * AT the literal (an empty quote matches nothing - it is never vacuously true);
 * (3) the GAP is RE-DERIVED as the distance from the nearest occurrence of the
 * CITATION'S marker lying inside the quoted span to the literal, computed from
 * the citation rather than read back from `d.gap` - the detector reports the
 * globally nearest marker of any family, so trusting its number would leave this
 * arm unfalsifiable whenever another marker happened to sit the declared distance
 * away.
 *
 * This used to admit a second reading - "the quote ends where the literal starts,
 * `gap` unchecked" - for the fixture object whose own `pi-tui` name grounds both
 * pins in it. That reading fired UNCONDITIONALLY, so it exempted every citation:
 * any gap in 0..window passed, and blanking all quotes passed too. The rule here
 * is what that one case actually is - the marker name sits inside the quote -
 * stated so that getting the number wrong still fails.
 */
function anchors(text: string, d: { index: number; marker: string; gap: number }, cit: GroundingCitation): boolean {
  if (!citesMarker(cit, d.marker)) return false;
  const body = cit.quoted.endsWith(ELLIPSIS) ? cit.quoted.slice(0, -ELLIPSIS.length) : cit.quoted.replace(/\u002e\u002e\u002e$/, "");
  // An empty quote is never vacuously true: it "matches" at every position, so
  // accepting it would make the whole per-occurrence check unfalsifiable (that was
  // the shipped defect - blanking every quote kept the gate green).
  if (body === "" || d.index < body.length) return false;
  if (text.slice(d.index - body.length, d.index) !== body) return false;
  const k = PI_CLAIM_MARKER_NAMES.findIndex((n) => n.toLowerCase() === cit.marker.trim().toLowerCase());
  if (k < 0) return false;
  const re = new RegExp((PI_CLAIM_MARKERS[k] as RegExp).source, "gi");
  const lo = d.index - body.length;
  let hit: RegExpExecArray | null;
  let nearest: number | null = null;
  while ((hit = re.exec(text.slice(lo, d.index))) !== null) {
    const g = d.index - (lo + (hit.index as number) + hit[0].length);
    if (g >= 0 && (nearest === null || g < nearest)) nearest = g;
    if (hit.index === re.lastIndex) re.lastIndex++;
  }
  return nearest === cit.gap;
}

/**
 * Does a citation name this claim's marker? A citation names a marker by the label
 * at the same index of `PI_CLAIM_MARKER_NAMES` as the regex that matched it, and
 * the test is precise in both directions: the regex must match the WHOLE name, not
 * merely occur inside it (the detector scans unanchored, and `pi-tui` is a
 * substring of `@earendil-works/pi-tui`, so a loose comparison would pass a
 * `pi-tui` citation on a claim grounded only by the `@earendil-works/pi` regex),
 * and it is compared case-INSENSITIVELY because that is how the detector's own
 * regexes match (`/pi-tui/i`).
 */
function citesMarker(cit: GroundingCitation, markerName: string): boolean {
  const idx = PI_CLAIM_MARKER_NAMES.findIndex((n) => n.toLowerCase() === cit.marker.trim().toLowerCase());
  if (idx < 0) return false;
  const re = new RegExp((PI_CLAIM_MARKERS[idx] as RegExp).source, "i");
  return re.test(markerName) && markerName.toLowerCase() === (PI_CLAIM_MARKER_NAMES[idx] as string).toLowerCase();
}
