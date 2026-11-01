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
  type ClaimDetector,
  type GroundingCitation,
  PI_CLAIM_MARKERS,
  PI_CLAIM_MARKER_NAMES,
  piLiteralClaims,
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
export type ArmMutation = (
  text: string,
  d: { index: number; marker: string; gap: number },
  cit: GroundingCitation,
) => boolean;

/**
 */
export function censusGroundingErrors(
  textByFile: Record<string, string>,
  expected: Record<string, Record<string, GroundingCitation[]>>,
  detect: ClaimDetector,
  anchorsFn?: ArmMutation,
): string[] {
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
        errors.push(
          `${NO_CITATIONS_MARKER} ${rel} ${literal}: declared no citations - a checked (file, literal) row must state at least one claim, or the count check compares two empties and passes by silence`,
        );
        continue;
      }
      // `scan` is this file's bytes with its own declarations blanked, so the
      // table cannot manufacture the claims it describes.
      const detected = piLiteralClaims(text, literal, detect, scans[rel]);
      const say = (list: { marker: string; gap: number }[]) =>
        list.map((d) => `${d.marker}@${d.gap}`).join(", ");
      const sayCit = (list: GroundingCitation[]) =>
        list.map((x) => `${x.quoted}=${x.marker}@${x.gap}`).join(", ");
      if (detected.length !== citations.length) {
        errors.push(
          `${rel} ${literal}: detector found ${detected.length} claim(s) [${say(detected)}] but the citations declare ${citations.length} [${sayCit(citations)}]`,
        );
        continue;
      }
      // One-to-one pairing, fewest-candidates-first so an unambiguous citation
      // claims its occurrence before an ambiguous one can take it. Shared with
      // `armUnmatched` so a relaxation is judged by the same pairing the gate runs.
      const unmatched = pairCitations(text, detected, citations, anchors);
      if (unmatched > 0) {
        errors.push(
          `${rel} ${literal}: ${unmatched} cited claim(s) matched no distinct claim at their stated marker/gap/quote (detector says [${say(detected)}] / citations [${sayCit(citations)}])`,
        );
      }
    }
  }
  return errors;
}

/**
 */
function pairCitations(
  text: string,
  detected: { index: number; marker: string; gap: number }[],
  citations: GroundingCitation[],
  anchors: ArmMutation,
): number {
  const taken = new Set<number>();
  const cands = citations.map((cit) => ({
    cit,
    opts: detected.map((_, i) => i).filter((i) => anchors(text, detected[i] as number, cit)),
  }));
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
 *
 * Returns `pairedRows` (rows whose claim count survived the corruption and so
 * actually reached `pairCitations`) for the same reason: an arm canary whose
 * corruption moves the count is a canary that never called the relaxed predicate.
 */
export function armUnmatched(
  textByFile: Record<string, string>,
  base: Record<string, Record<string, GroundingCitation[]>>,
  detect: ClaimDetector,
  corrupt: (table: Record<string, Record<string, GroundingCitation[]>>) => void,
  relaxed: ArmMutation,
): { shipped: number; relaxed: number; pairedRows: number } {
  const table = structuredClone(base);
  corrupt(table);
  let shipped = 0;
  let lax = 0;
  // Rows that actually reached PAIRING. A corruption that moves the claim count
  // short-circuits above and never calls either predicate, so `shipped >= 1` alone
  // is satisfiable by the count check firing — the arm canary then proves nothing
  // about the relaxed half, which is the only thing telling a real witness apart
  // from an untested copy of `anchorsShips`. The caller asserts this equals the
  // table's row count so a corruption that skips pairing reddens instead of passing.
  let paired = 0;
  for (const [rel, byLiteral] of Object.entries(base)) {
    const text = textByFile[rel];
    if (text === undefined) continue;
    for (const literal of Object.keys(byLiteral)) {
      const citations = (table[rel] as Record<string, GroundingCitation[]>)[
        literal
      ] as GroundingCitation[];
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
      paired++;
    }
  }
  return { shipped, relaxed: lax, pairedRows: paired };
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
    const body = cit.quoted.endsWith(ELLIPSIS)
      ? cit.quoted.slice(0, -ELLIPSIS.length)
      : cit.quoted.replace(/\u002e\u002e\u002e$/, "");
    // An empty quote is never vacuously true: it "matches" at every position, so
    // accepting it would make the whole per-occurrence check unfalsifiable (that was
    // the shipped defect - blanking every quote kept the gate green).
    if (body === "" || d.index < body.length) return false;
    if (arm !== "quote" && text.slice(d.index - body.length, d.index) !== body) return false;
    const k = PI_CLAIM_MARKER_NAMES.findIndex(
      (n) => n.toLowerCase() === cit.marker.trim().toLowerCase(),
    );
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
export function maskGroundingTable(
  textByFile: Record<string, string>,
  expected: Record<string, Record<string, GroundingCitation[]>>,
  relax: { fill?: string } = {},
): Record<string, string | undefined> {
  // `maskBarrierClaims` witnesses this loop's two failure modes: never blanking (the
  // `at >= 0` test below, i.e. `at = -1` always) and blanking with a character that is
  // not whitespace (`MASK_FILL` below, i.e. a fill the marker regexes still match).
  // Both were measured to leave the gate green, so each is asserted, not assumed.
  // `relax.fill` is how `maskBarrierClaims` exercises the non-whitespace blanking without
  // this file carrying a second copy of the loop; production callers pass nothing.
  const fill = relax.fill ?? MASK_FILL;
  const out: Record<string, string | undefined> = {};
  for (const [rel, byLiteral] of Object.entries(expected)) {
    const text = textByFile[rel];
    if (text === undefined) continue;
    let scan = text;
    for (const citations of Object.values(byLiteral))
      for (const cit of citations) {
        const decl = declarationText(cit);
        const at = MASK_NEVER_BLANK ? -1 : scan.indexOf(decl);
        if (at >= 0)
          scan = `${scan.slice(0, at)}${fill.repeat(decl.length)}${scan.slice(at + decl.length)}`;
      }
    out[rel] = scan === text ? undefined : scan;
  }
  return out;
}

/**
 * The mask's blanking character. It MUST be whitespace: a declaration blanked with any
 * other character re-constitutes the marker names the citations quote, and the detector
 * then reads claims out of the very table the mask exists to deny. Witnessed by
 * `maskBarrierClaims`, which reddens if this is changed.
 */
const MASK_FILL = " ";

/** Whether the mask blanks at all. Witnessed by `maskBarrierClaims`; never true. */
const MASK_NEVER_BLANK = false;

/**
 * The mask barrier's witness. `maskGroundingTable` hides each file's citations from the
 * detector by blanking them to spaces of IDENTICAL length, and until now nothing checked
 * that it does: forcing `at = -1` (never blank) and blanking with `"x"` were both measured
 * to leave the gate green, because the shipped declarations happen to hold no in-window
 * `1.x` literal. So the barrier rested on a property of the current table rather than on
 * the mask.
 *
 * The fixture is one declaration whose `quoted` field is a marker name followed by a
 * fresh literal (`1.4.2` — a version no other check in this repo reads, so the fixture is
 * its only source) and whose `marker` field names that marker, so the detector calls the
 * literal a claim while those bytes are visible. Three legs then report what the detector
 * sees at the claim's own index:
 *
 * - `masked` — the shipped mask. Must be 0: this is the barrier.
 * - `unmasked` — no blanking at all (the `at = -1` mutation). Must be 1.
 * - `filler` — a non-whitespace fill. Reports 0, and the zero IS the finding: `"x"`
 *   destroys the marker text it blanked, so on this fixture it behaves exactly like a
 *   space. The mutation the reviewer measured was invisible here not because the barrier
 *   watches it but because it cannot, on any fixture — a claim is a MARKER and a literal
 *   together, and a fill that removes the bytes of both removes the claim whichever
 *   character it uses. What a non-whitespace fill really breaks is the identical-length
 *   contract the mask's own comment states, so that is what this witness asserts as a
 *   hard invariant of every leg: an index the grounding check compares must stay an index
 *   into the same bytes.
 *
 * A mask that blanks nothing, or one whose output disagrees with its own constants, is an
 * error rather than a silent pass — so editing `MASK_FILL` or `MASK_NEVER_BLANK` reddens
 * this instead of passing quietly, which is the half of the reviewer's finding the count
 * alone could never carry.
 */
export function maskBarrierClaims(
  text: string,
  literal: string,
  detect: ClaimDetector,
  relax: { fill?: string } = {},
): { masked: number; unmasked: number; filler: number } {
  const cit = declarationFor(literal);
  const maskable = declarationText(cit);
  const withSynth = `${text}\n${maskable}`;
  const synthIndex = withSynth.lastIndexOf(literal);
  const sees = (scan: string) => (new Set(detect(scan)).has(synthIndex) ? 1 : 0);
  const declAt = withSynth.indexOf(maskable);
  if (declAt < 0)
    throw new Error(
      "maskBarrierClaims: the synthesised declaration is not in the text it claims to describe - the mask would be a no-op and the witness meaningless",
    );
  const shipped = maskGroundingTable({ f: withSynth }, { f: { [literal]: [cit] } }).f;
  if (shipped === undefined)
    throw new Error(
      "maskBarrierClaims: maskGroundingTable masked nothing at all - the barrier is absent, which is the failure this witness exists to catch",
    );
  if (
    shipped !==
    `${withSynth.slice(0, declAt)}${MASK_FILL.repeat(maskable.length)}${withSynth.slice(declAt + maskable.length)}`
  )
    throw new Error(
      "maskBarrierClaims: the mask's output disagrees with MASK_FILL - the witness no longer describes the shipped mask",
    );
  const filler =
    maskGroundingTable({ f: withSynth }, { f: { [literal]: [cit] } }, { fill: relax.fill ?? "x" })
      .f ?? withSynth;
  // The contract the mask states in prose and nothing checked: blanking preserves every
  // index. A fill that changes the length turns every citation index into an index into
  // the wrong bytes, which is the real damage a non-whitespace fill does.
  for (const [label, scan] of [
    ["shipped", shipped],
    ["fill", filler],
  ] as const)
    if (scan.length !== withSynth.length)
      throw new Error(
        `maskBarrierClaims: the ${label} mask changed the file's length - every index the grounding check compares is now an index into the wrong bytes`,
      );
  const legs = { masked: sees(shipped), unmasked: sees(withSynth), filler: sees(filler) };
  // A fixture that is not a claim when unmasked leaves every leg zero — a pass that proves
  // nothing, the exact failure this witness exists to prevent.
  if (legs.unmasked !== 1)
    throw new Error(
      "maskBarrierClaims: the un-masked fixture is not a claim - the witness is not exercising the mask",
    );
  if (legs.masked !== 0)
    throw new Error(
      "maskBarrierClaims: the shipped mask leaves the synthesised claim visible - the barrier is not the mask",
    );
  return legs;
}

/**
 * The synthesised citation `maskBarrierClaims` masks. The marker name is BUILT by
 * concatenation rather than typed, so this file's own bytes never spell it where the
 * witness does not need it: a marker name lying loose in the gate's source would ground
 * real claims that no mask could hide, which is how earlier drafts here reported
 * "witnessed" for the wrong reason.
 */
function declarationFor(literal: string): GroundingCitation {
  const name = ["MIN", "_", "PI", "_", "VERSION"].join("");
  return { quoted: `${name} ${literal}`, marker: name, gap: 12 };
}

/** The one rendering of a declaration that both `maskGroundingTable` and the witness blank. */
function declarationText(cit: GroundingCitation): string {
  return `{ quoted: ${JSON.stringify(cit.quoted)}, marker: ${JSON.stringify(cit.marker)}, gap: ${cit.gap} }`;
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
function anchorsShips(
  text: string,
  d: { index: number; marker: string; gap: number },
  cit: GroundingCitation,
): boolean {
  if (!citesMarker(cit, d.marker)) return false;
  const body = cit.quoted.endsWith(ELLIPSIS)
    ? cit.quoted.slice(0, -ELLIPSIS.length)
    : cit.quoted.replace(/\u002e\u002e\u002e$/, "");
  // An empty quote is never vacuously true: it "matches" at every position, so
  // accepting it would make the whole per-occurrence check unfalsifiable (that was
  // the shipped defect - blanking every quote kept the gate green).
  if (body === "" || d.index < body.length) return false;
  if (text.slice(d.index - body.length, d.index) !== body) return false;
  const k = PI_CLAIM_MARKER_NAMES.findIndex(
    (n) => n.toLowerCase() === cit.marker.trim().toLowerCase(),
  );
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
  const idx = PI_CLAIM_MARKER_NAMES.findIndex(
    (n) => n.toLowerCase() === cit.marker.trim().toLowerCase(),
  );
  if (idx < 0) return false;
  const re = new RegExp((PI_CLAIM_MARKERS[idx] as RegExp).source, "i");
  return (
    re.test(markerName) &&
    markerName.toLowerCase() === (PI_CLAIM_MARKER_NAMES[idx] as string).toLowerCase()
  );
}
