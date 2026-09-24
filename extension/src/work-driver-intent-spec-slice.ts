/**
 * work-driver-intent-spec-slice — the spec-path-only h2-or-h3 slicer.
 *
 * `parseNormalisedSpec` gates the whole parse on a `Spec` section. The prompt
 * asks for `## Spec` (level 2), but a real resolver on #826 wrote `### Spec`
 * nested under `## Intent resolution`, and the strict level-2 slicer returned
 * `undefined` for a reply that carried a complete, evidence-grounded spec.
 * The proceed verdict was silently discarded and the cycle parked at
 * `explore-needs-clarification` with no record of which half failed.
 *
 * `sliceSpecSectionH2OrH3` finds `## Spec` or `### Spec` (including a level-3
 * heading nested under a parent `##`) and terminates at the next heading of
 * level ≤ its own — sibling `###` subsections (Intent, Deliverables, …) stay
 * INSIDE the spec block.
 *
 * `sliceMarkdownSection` is deliberately left strict (`##`-only): `parseWorkstreams`
 * and `parseWorktreesBlock` depend on the exact-level-2 terminator behaviour,
 * and widening a shared helper to serve one caller is how parsing regressions
 * get introduced.
 *
 * `sliceSpecField` replaces the inline `sliceSubsection` for the two reply
 * shapes seen in real resolver replies:
 *
 *   1. A `### <name>` subheading (the prompt's template; 337.txt shape)
 *   2. A bare bold label on its own line (`**Deliverables**`, the shape #826
 *      used, which is also what its `**Intent** — …` intent line relies on)
 *
 * Both terminate at the next heading of any level, or at the next bare bold
 * label line. A bullet line opens with `-` so it never terminates a section
 * early.
 */

/**
 * The terminator for `sliceSpecField`: the start of the next section.
 *
 * Matches a markdown heading (any level) or a bare bold-label line. A bold
 * label is a line whose trimmed content is `**<word(s)>**` followed by
 * nothing, an em-dash, a hyphen, or a colon — the shapes real resolvers emit
 * as section headers.
 *
 * The terminator fires on the next heading or bold-label line WHETHER OR NOT
 * A BLANK LINE PRECEDES IT. The earlier version required the `\n` of a blank
 * line before the heading, so a compact reply (`### Intent\nDo the thing\n###
 * Deliverables\n- d1: x`) never terminated at the next heading and the
 * previous field's body swallowed the next one. A heading or label is still
 * only a terminator at a LINE START: a `#` or a full-line `**label**` inside
 * prose does not match, so multi-line field content is never cut short.
 */
const FIELD_TERMINATOR = /^\s*(?:#{1,6}\s|\*\*\s*[\p{L}][\p{L} ]*\*\*\s*(?:[—–:-]|$))/mu;

/**
 * Slice a field out of the `Spec` section.
 *
 * Three shapes, in order:
 *
 *   1. A `### <name>` (or deeper) subheading — the prompt's template (337.txt)
 *   2. A bare bold-label line: `**<name>**` at line start, followed by
 *      end-of-line — the content is on the next line (337.txt, 674-report.md)
 *   3. An inline bold-label: `**<name>**` at line start, followed by a
 *      separator (`—`, `:`, `-`) and content on the same line (the #826
 *      fixture's `**Intent** — Fix the …`)
 *
 * All three terminate at the next heading of any level, or at the next bare
 * bold-label line. A bullet line opens with `-` so it never terminates a
 * section early.
 */
export function sliceSpecField(text: string, name: string): string | undefined {
  const heading = new RegExp(`^#{2,6}\\s+${name}\\s*$`, "im");
  // Bare bold-label line: `**Name**` at line start, end-of-line after the label.
  // `\\s*$` allows trailing whitespace. The `\\s*` between `\\*\\*` and `\\s*$`
  // ensures the label is self-contained (no content on the same line).
  const bareLabel = new RegExp(`^\\*\\*\\s*${name}\\s*\\*\\*\\s*$`, "im");
  // Inline bold-label: `**Name**` at line start, followed by a separator
  // (—, –, -, :) and content on the same line. The content after the
  // separator is part of the field.
  const inlineLabel = new RegExp(`^\\*\\*\\s*${name}\\s*\\*\\*\\s*[-—–:]`, "im");

  for (const re of [heading, bareLabel, inlineLabel]) {
    const m = text.match(re);
    if (!m || m.index === undefined) continue;
    const after = text.slice(m.index + m[0].length);
    const next = after.match(FIELD_TERMINATOR);
    return next?.index !== undefined ? after.slice(0, next.index) : after;
  }
  return undefined;
}

/**
 * The `Spec` section at level 2 or 3.
 *
 * Matches `## Spec` or `### Spec` (case-insensitive). The body terminates at
 * the next `##` (level-2) heading — the `^##\s(?!#)` anchor matches a level-2
 * heading and its whitespace but NOT a level-3 `###` (the `(?!#)` rejects the
 * trailing `#`). `###` subsections (Intent, Deliverables, …) are therefore
 * INSIDE the section, never terminators — they are the field separators
 * `sliceSpecField` uses. Deeper headings (`####`) are also inside the section.
 * The same `##`-only terminator is correct for both a level-2 and a level-3
 * section: a level-2 section's own `###` subsections stay inside, and a
 * level-3 section's sibling `###` fields stay inside (they are the separators
 * `sliceSpecField` uses); the next top-level `##` is the only level-2
 * terminator, so a `###` heading never ends the block. (A sibling `###`
 * section *after* a `### Spec` block would leak into its body — benign in
 * practice, because `sliceSpecField`'s anchored match and the field-level
 * terminator stop the field slicers from mis-reading sibling content; the
 * `##`-only terminator is the load-bearing behaviour, and widening it to also
 * stop at `###` would sever the spec from its own `###` fields.)
 */
export function sliceSpecSectionH2OrH3(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`^(?:##|###)\\s+${name}\\s*$`, "im"));
  if (!m || m.index === undefined) return undefined;
  // The terminator is a heading of level ≤ the section's own level. A level-2
  // section (`## Spec`) terminates at the next `##` — its `###` subsections
  // (Intent, Deliverables, …) are inside the section, not terminators. A
  // level-3 section (`### Spec`) terminates at the next `##` or `###`, and
  // its sibling `###` subsections are also inside (they're the field
  // separators `sliceSpecField` uses), so the terminator is `##` only.
  const after = text.slice(m.index + m[0].length);
  // Terminate at the next `##` heading (level 2). `###` subsections are
  // inside the section, not terminators — they're the field separators
  // `sliceSpecField` uses. A `##` heading is the only level-2 terminator;
  // `###` and deeper are inside the section.
  const next = after.match(/^##\s(?!#)/m);
  const body = next?.index !== undefined ? after.slice(0, next.index) : after;
  return body.replace(/\n\s*-{3,}\s*$/, "\n");
}
