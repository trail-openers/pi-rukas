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
 * level-2 heading in the body — or, for a `### Spec`, up to the parent `##`'s
 * next sibling (the #826 shape, where an earlier `## Workstreams` would
 * otherwise sever the spec from its fields).
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

// Escape each non-alphanumeric char for the alternation; a regex-class escape
// here would not survive string-literal → RegExp construction, so map per char.
// Escape each non-alphanumeric, non-alternation char for the regex; `|` is the
// alternation separator itself and must not be escaped (a `\\|` would make it
// a literal `|` and break the alternation).
const SPEC_FIELD_NAME_ALTERNATIVE = SPEC_FIELD_NAMES.join("|")
  .split("")
  .map((c) => (/[a-zA-Z0-9|]/.test(c) ? c : `\\${c}`))
  .join("");

/**
 * The terminator for `sliceSpecField`.
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
 * A bullet line opens with `-` or a digit, so it never terminates a section
 * early; a `#` or a `**label**` inside prose (not at a line start) never
 * matches.
 */
const FIELD_TERMINATOR = new RegExp(
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
 * All three terminate at `FIELD_TERMINATOR` — the next heading of any
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
    const next = after.match(FIELD_TERMINATOR);
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
 *
 * One extra rule, for the #826 shape only: when the `### Spec` is nested
 * under a parent `## <x>`, the body extends to that parent's next sibling
 * `## <y>` — a level-2 heading that PRECEDES the `### Spec` is part of the
 * parent section's own layout (the fixture's `## Workstreams` sits above
 * `### Spec`), not a terminator, and `## <y>` is where the parent section —
 * and with it the nested spec — ends.
 */
export function sliceSpecSectionH2OrH3(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`^(?:##|###)\\s+${name}\\s*$`, "im"));
  if (!m || m.index === undefined) return undefined;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s(?!#)/m);
  let end = next?.index ?? after.length;
  if (m[0].startsWith("###")) {
    // Find the parent level-2 heading preceding this level-3 section, if any.
    let parentEnd: number | null = null;
    for (const pm of text.matchAll(/^##\s/gm)) {
      if (pm.index === undefined || pm.index > m.index) break;
      parentEnd = pm.index;
    }
    if (parentEnd !== null) {
      // The parent's sibling `##` — the first level-2 heading after the
      // parent and before this section — is where the parent (and the
      // nested spec) ends; any level-2 heading between the parent and this
      // section is the parent's own content, not a terminator.
      for (const pm of text.matchAll(/^##\s(?!#)/gm)) {
        if (pm.index !== undefined && pm.index > parentEnd && pm.index < m.index) {
          end = pm.index;
          break;
        }
      }
    }
  }
  const body = after.slice(0, end);
  return body.replace(/\n\s*-{3,}\s*$/, "\n");
}
