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
 * The prefix on the ONE error that is a refusal to compare rather than a
 * comparison that failed. The fail-closed canary must exclude these: the empty-row
 * guard is the block's sole vacuity barrier, and with that guard neutered and the
 * table emptied it still produced one error per row, so
 * `failClosed.length === literalCount` held while `detected` was compared against
 * nothing. Counting rows declared is not counting comparisons performed.
 */
export const NO_CITATIONS_MARKER = "[no-citations]";

/** The pairing predicate's shape; `armRelaxed` produces a laxer copy of it. */
export type ArmMutation = (text: string, d: { index: number; marker: string; gap: number }, cit: GroundingCitation) => boolean;

/**
 */
export function censusGroundingErrors(textByFile: Record<string, string>, expected: Record<string, Record<string, GroundingCitation[]>>, detect: ClaimDetector, anchorsFn?: ArmMutation): string[] {
  const errors: string[] = [];
  const anchors = anchorsFn ?? anchorsShips;
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
        errors.push(`${NO_CITATIONS_MARKER} ${rel} ${literal}: declared no citations - a checked (file, literal) row must state at least one claim, or the count check compares two empties and passes by silence`);
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
      // claims its occurrence before an ambiguous one can take it. Shared with
      // `armUnmatched` so a relaxation is judged by the same pairing the gate runs.
      const unmatched = pairCitations(text, detected, citations, anchors);
      if (unmatched > 0) {
        errors.push(`${rel} ${literal}: ${unmatched} cited claim(s) matched no distinct claim at their stated marker/gap/quote (detector says [${say(detected)}] / citations [${sayCit(citations)}])`);
      }
    }
  }
  return errors;
}

/**
 */
function pairCitations(text: string, detected: { index: number; marker: string; gap: number }[], citations: GroundingCitation[], anchors: ArmMutation): number {
  const taken = new Set<number>();
  const cands = citations.map((cit) => ({ cit, opts: detected.map((_, i) => i).filter((i) => anchors(text, detected[i] as number, cit)) }));
  let unmatched = 0;
  for (const c of cands.sort((x, y) => x.opts.length - y.opts.length)) {
    const free = c.opts.filter((i) => !taken.has(i));
    if (free.length === 0) {
      unmatched++;
      continue;
    }
    taken.add(free[0] as number);
  }
  return unmatched;
}

/**
 * How many citations of `corrupt(base)` pair with no claim, under the shipped
 * predicate and under a relaxed one. This is one arm's NEGATIVE witness.
 *
 * A relaxed predicate on the SHIPPED table proves nothing — correct citations
 * satisfy any laxity, so every relaxation looks harmless. Corrupting one citation
 * makes the refusing arm observable; relaxing that arm then lets the corrupted
 * citation pair again, which is what "unwitnessed" means. The gate requires
 * `shipped >= 1 && relaxed === 0`: both 0 means the corruption does not exercise
 * the arm, both >=1 means the arm refuses nothing anyway.
 *
 * Counts CITATIONS, not error strings — a lax arm that pairs a corrupted citation
 * with a different claim emits no message at all while never doing the work the arm
 * exists to do, and only the pairing itself sees that.
 */
export function armUnmatched(textByFile: Record<string, string>, base: Record<string, Record<string, GroundingCitation[]>>, detect: ClaimDetector, corrupt: (table: Record<string, Record<string, GroundingCitation[]>>) => void, relaxed: ArmMutation): { shipped: number; relaxed: number } {
  const table = structuredClone(base);
  corrupt(table);
  let shipped = 0;
  let lax = 0;
  for (const [rel, byLiteral] of Object.entries(base)) {
    const text = textByFile[rel];
    if (text === undefined) continue;
    for (const literal of Object.keys(byLiteral)) {
      const citations = (table[rel] as Record<string, GroundingCitation[]>)[literal] as GroundingCitation[];
      const detected = piLiteralClaims(text, literal, detect);
      if (detected.length !== citations.length) {
        // The corruption moved the claim count, so nothing could pair: that IS the
        // refusal, counted for both predicates so the arm cannot pass by muteness.
        shipped += citations.length;
        lax += citations.length;
        continue;
      }
      shipped += pairCitations(text, detected, citations, anchorsShips);
      lax += pairCitations(text, detected, citations, relaxed);
    }
  }
  return { shipped, relaxed: lax };
}

/**
 * The shipped pairing predicate with ONE arm neutered. The shipped citations are
 * correct, so the three refusing arms never fire on the real table and the suite
 * never saw them return false; each was measured (round 2 adversarial) to keep the
 * gate green when relaxed — `nearest === cit.gap` → `nearest !== null` with the gap
 * bumped, the quote-suffix comparison dropped with the quote corrupted, the
 * whole-name marker guard dropped with a wrong-family marker. Pair each with the
 * `corrupt` that names its own field and `armUnmatched` observes the refusal.
 *
 * Only the marker arm needs a branch: it lives in `citesMarker`, so that predicate
 * is passed in as a parameter instead of closing over the module binding.
 */
export function armRelaxed(arm: "gap" | "quote"): ArmMutation {
  return (text, d, cit) => {
    if (!citesMarker(cit, d.marker)) return false;
    const body = cit.quoted.endsWith(ELLIPSIS) ? cit.quoted.slice(0, -ELLIPSIS.length) : cit.quoted.replace(/\u002e\u002e\u002e$/, "");
    // An empty quote is never vacuously true: it "matches" at every position, so
    // accepting it would make the whole per-occurrence check unfalsifiable (that was
    // the shipped defect - blanking every quote kept the gate green).
    if (body === "" || d.index < body.length) return false;
    if (arm !== "quote" && text.slice(d.index - body.length, d.index) !== body) return false;
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
    return arm === "gap" ? nearest !== null : nearest === cit.gap;
  };
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
 *
 * Each arm is witnessed by `armRelaxed` + `armUnmatched` in the gate: an arm that
 * stops refusing anything makes that canary red.
 */
function anchorsShips(text: string, d: { index: number; marker: string; gap: number }, cit: GroundingCitation): boolean {
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
