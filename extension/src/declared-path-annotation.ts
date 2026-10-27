/**
 * declared-path-annotation — #1862 (c): the leading word a planner or a spec
 * author puts in FRONT of a path to say how it came to be, and the one strip
 * that removes it.
 *
 * A deliverable's `[paths:]` slot is free text, and specs write
 * `"new tests/test_x*.py"` / `"a new docs/x.md"` the way a changelog does. The
 * trailing annotation (`tests/x.py (new)`) has always been stripped by
 * `normaliseDeclaredPath`; the LEADING one has not, so the declared slot
 * `new tests/test_x*.py` matched no diff file, the unit count said 0/1, and a
 * deliverable whose files were all present in the diff was reported `partial` —
 * or `absent`, which caps the cycle at develop.
 *
 * Why a word list and not a general "strip leading words until it looks like a
 * path" rule: the prefix has to be recognised, not guessed. `new src/index.ts`
 * is an annotation over `src/index.ts`; `new-repo/README.md` and
 * `newman/test.ts` are file names, and a rule that stripped anything before the
 * first separator would delete real directories. The strip is therefore:
 *
 *   - an EXACT word list (`new`, `added`), case-insensitive, optionally
 *     preceded by an article (`a`, `an`, `the`);
 *   - a word boundary on both sides — `new` is a word, never the head of a
 *     longer one (`newline.ts` is a file);
 *   - and a non-empty remainder, so a slot that IS the word `new` stays `new`
 *     rather than becoming the empty string.
 *
 * Idempotent: a value already stripped comes back unchanged, which is what
 * lets every normaliser in the path grammar call it without coordinating.
 */

/** The annotation words that may precede a declared path, lower-cased. */
const ANNOTATION_WORDS = new Set(["new", "added"]);

/** Articles that may precede the annotation word (`a new x.ts`, `the added y`). */
const ARTICLES = new Set(["a", "an", "the"]);

/**
 * The leading annotation, or the slot unchanged. Strips ONE word plus an
 * optional article (`a new x.ts`), never a run: `new tests new docs` is two
 * declarations and the gates that read slots split on `,` and `|`.
 */
export function stripLeadingPathAnnotation(slot: string): string {
  const trimmed = slot.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return trimmed;
  const first = words[0]?.toLowerCase() ?? "";
  let consumed = ANNOTATION_WORDS.has(first) ? 1 : 0;
  if (consumed === 0 && !ARTICLES.has(first)) return trimmed;
  if (consumed === 0) {
    if (!ANNOTATION_WORDS.has(words[1]?.toLowerCase() ?? "")) return trimmed;
    consumed = 2;
  }
  // A slot that is nothing but the annotation word stays as written — the
  // caller's emptiness filter, not this function, decides it is not a path.
  const rest = words.slice(consumed).join(" ");
  return rest.length > 0 ? rest : trimmed;
}

/**
 * The matcher's unit: a slot's alternatives with the leading annotation removed.
 *
 * The strip belongs here — with the rule that defines it — and the splitter
 * that applies it lives beside the grammar it splits, so this function takes the
 * already-split alternatives and answers one question about each. It is a
 * separate function from `stripLeadingPathAnnotation` because a caller that has
 * one raw slot must split before it strips: stripping `"a.ts or new b.ts"` as
 * one string would strip nothing and hand the matcher `or new b.ts`.
 */
export function stripAnnotationsFromAlternatives(alternatives: readonly string[]): string[] {
  return alternatives.map(stripLeadingPathAnnotation).filter((alt) => alt.length > 0);
}

/**
 * The slots of a `[paths:]` list with BOTH annotations gone — the unit the two
 * gates agree a slot is (#1707: one representation, so a glob slot is a glob at
 * the plan gate and at converge and there is no raw/normalised pair to keep
 * straight). A slot's own text is otherwise the planner's, kept verbatim for the
 * prompts that read it.
 */
export function normaliseDeclaredSlots(
  slots: readonly string[],
  normalise: (text: string) => string,
): string[] {
  return slots.map((s) => normalise(stripLeadingPathAnnotation(s))).filter((s) => s.length > 0);
}

/** One slot, both annotations gone — the single-slot form of the rule above. */
export function normaliseDeclaredSlot(slot: string, normalise: (t: string) => string): string {
  return normalise(stripLeadingPathAnnotation(slot));
}
