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
 * heading nested under a parent `##`) and keeps everything down to the next
 * level-2 heading in the body.
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
 * label line naming a spec field.
 */

/** #830 — the exact field names `parseNormalisedSpec` reads via sliceSpecField. */
export const SPEC_FIELD_NAMES = [
  "Intent",
  "Deliverables",
  "Acceptance criteria",
  "Out of scope",
  "Assumptions",
  "Open questions",
  "Evidence",
] as const;

// field names are letters and spaces only, so no regex escaping is needed
const SPEC_FIELD_NAME_ALTERNATIVE = SPEC_FIELD_NAMES.join("|");

/**
 * The boundary for `sliceSpecField`.
 *
 * Matches at a line start, whether or not a blank line precedes it: the
 * earlier version anchored on the `\n` of a blank line, so a compact reply
 * (`### Intent\nDo the thing\n### Deliverables\n- d1: x`) never terminated at
 * the next heading and the previous field's body swallowed the next one.
 *
 * Two alternatives:
 *
 *   1. A markdown heading of any level (`#`–`######`) — every real spec
 *      separator is a heading, and a heading inside a field body is the end
 *      of the field, whatever it names.
 *   2. A bare bold-label line naming a SPEC field (`**Deliverables**`, with
 *      only the spec field names, case-insensitive). `**<name>**` is only a
 *      terminator when it names a field the parser reads, so a
 *      `**Note** — …` line inside a field body does NOT end the field.
 *
 * A heading of ANY level ends a field (load-bearing: it keeps a trailing
 * `## Rationale` / `## Workstreams` block out of the last parsed field),
 * but only `###`–`######` headings and spec-field bold labels open one, so
 * `## Deliverables` ends the field above it without starting a new one.
 *
 * A bullet line opens with `-` or a digit, so it never terminates a section
 * early; a `#` or a `**label**` inside prose (not at a line start) never
 * matches.
 */
const FIELD_END = new RegExp(
  `^\\s*(?:#{1,6}\\s|\\*\\*\\s*(?:${SPEC_FIELD_NAME_ALTERNATIVE})\\s*\\*\\*\\s*(?:[—–:-]|$))`,
  "im",
);

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
 * All three terminate at `FIELD_END` — the next heading of any
 * level, or the next bare bold-label line naming a spec field.
 */
export function sliceSpecField(text: string, name: string): string | undefined {
  const heading = new RegExp(`^#{3,6}\\s+${name}\\s*$`, "im");
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
    const next = after.match(FIELD_END);
    return next?.index !== undefined ? after.slice(0, next.index) : after;
  }
  return undefined;
}

/**
 * The `Spec` section at level 2 or 3.
 *
 * Matches `## Spec` or `### Spec` (case-insensitive). The body ends at the
 * next level-2 `## ` heading only — `###` and deeper headings stay inside
 * (including a sibling `###` section after a `### Spec`, which is accepted),
 * because those headings ARE the field separators `sliceSpecField` uses;
 * stopping at `###` would sever the spec from its own `###` fields.
 */
export function sliceSpecSectionH2OrH3(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`^(?:##|###)\\s+${name}\\s*$`, "im"));
  if (!m || m.index === undefined) return undefined;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s(?!#)/m);
  const body = next?.index !== undefined ? after.slice(0, next.index) : after;
  return body.replace(/\n\s*-{3,}\s*$/, "\n");
}
