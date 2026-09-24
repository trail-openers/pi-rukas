#!/usr/bin/env bun
/**
 * #830 — the scoped h2-or-h3 Spec slicer, unit-tested in isolation.
 *
 * `sliceSpecSectionH2OrH3` and `sliceSpecField` are the new module that
 * `parseNormalisedSpec` uses to find and parse the Spec section. They are
 * deliberately scoped to the intent path: `sliceMarkdownSection` (shared by
 * parseWorkstreams, parseWorktreesBlock, and intent-offload) is unchanged.
 *
 * This file exercises the two functions directly, without going through
 * `parseNormalisedSpec`, so a regression in the slicer is caught before it
 * reaches the full parser.
 */

import {
  SPEC_FIELD_NAMES,
  sliceSpecSectionH2OrH3,
  sliceSpecField,
} from "../src/work-driver-intent-spec-slice.ts";
import { sliceMarkdownSection } from "../src/work-driver-plan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ============================================================================
// SPEC_FIELD_NAMES regex safety
// ============================================================================

{
  // The module builds its terminators by joining SPEC_FIELD_NAMES with `|`
  // and no escaping; that is only safe while every entry is letters/spaces.
  for (const name of SPEC_FIELD_NAMES) {
    assert(/^[A-Za-z ]+$/.test(name), `field name regex-safe: ${name}`);
  }
}

// ============================================================================
// sliceSpecSectionH2OrH3
// ============================================================================

{
  // Level-2 Spec (the existing shape) — must still parse.
  const h2 = "## Spec\n\n### Intent\nDo the thing\n\n## Next\n";
  const section = sliceSpecSectionH2OrH3(h2, "Spec");
  assert(section !== undefined, "h2: finds a level-2 Spec");
  assert(section !== undefined && section.includes("Do the thing"), "h2: includes the content");
  assert(section !== undefined && !section.includes("## Next"), "h2: terminates at the next level-2 heading");
}

{
  // Level-3 Spec nested under a parent h2 — the #826 shape.
  const h3 = "## Intent resolution\n\n### Spec\n\n**Intent** — Do the thing\n\n## Rationale\n";
  const section = sliceSpecSectionH2OrH3(h3, "Spec");
  assert(section !== undefined, "h3: finds a level-3 Spec nested under an h2");
  assert(section !== undefined && section.includes("Do the thing"), "h3: includes the content");
  assert(section !== undefined && !section.includes("## Rationale"), "h3: terminates at the next level-2 heading");
}

{
  // A level-3 Spec with its own level-3 subsections — the subsections are
  // INSIDE the spec block, not terminators.
  const h3withSubs = [
    "## Intent resolution",
    "",
    "### Spec",
    "",
    "### Intent",
    "Do the thing",
    "",
    "### Deliverables",
    "- d1: do it [paths: src/a.ts]",
    "",
    "### Rationale",
    "because",
    "",
    "## Next section",
    "- d2: must not leak in [paths: src/b.ts]",
  ].join("\n");
  const section = sliceSpecSectionH2OrH3(h3withSubs, "Spec");
  assert(section !== undefined, "h3+subs: finds the level-3 Spec");
  assert(
    section !== undefined && section.includes("Do the thing") && section.includes("d1: do it"),
    "h3+subs: includes both the intent AND the deliverables (subsections are inside)",
  );
  assert(
    section !== undefined && !section.includes("d2: must not leak"),
    "h3+subs: terminates before the next ## heading — no leak",
  );
}

{
  // No Spec heading at all — returns undefined.
  const noSpec = "## Intent resolution\n\nSome prose with no Spec heading.\n";
  const section = sliceSpecSectionH2OrH3(noSpec, "Spec");
  assert(section === undefined, "no-heading: returns undefined when no Spec heading exists");
}

{
  // A level-4 heading is NOT a Spec heading — returns undefined.
  const h4 = "#### Spec\n\nThis is level 4, not 2 or 3.\n";
  const section = sliceSpecSectionH2OrH3(h4, "Spec");
  assert(section === undefined, "h4: a level-4 Spec is not found (only h2 or h3)");
}

{
  // The body with no trailing heading — extends to end of text.
  const noTrailing = "## Intent resolution\n\n### Spec\n\n**Intent** — The last section";
  const section = sliceSpecSectionH2OrH3(noTrailing, "Spec");
  assert(section !== undefined && section.includes("The last section"), "no-trailing: extends to end of text");
}

// ============================================================================
// sliceSpecField
// ============================================================================

{
  // A ### subheading field (337.txt shape).
  const text = "### Intent\nDo the thing\n\n### Deliverables\n- d1: x\n";
  const intent = sliceSpecField(text, "Intent");
  assert(intent !== undefined && intent.includes("Do the thing"), "### heading: finds the field");
  assert(intent !== undefined && !intent.includes("Deliverables"), "### heading: terminates at next ###");
}

{
  // A bare bold-label line (674-report.md shape).
  const text = "**Deliverables**\n\n- d1: x\n- d2: y\n\n**Acceptance criteria**\n- ac1\n";
  const deliv = sliceSpecField(text, "Deliverables");
  assert(deliv !== undefined && deliv.includes("d1: x") && deliv.includes("d2: y"), "bare label: finds the field");
  assert(deliv !== undefined && !deliv.includes("Acceptance criteria"), "bare label: terminates at next bare bold label");
}

{
  // An inline bold-label (the #826 shape: `**Intent** — content`).
  const text = "**Intent** — Do the thing\n\n**Deliverables**\n- d1: x\n";
  const intent = sliceSpecField(text, "Intent");
  assert(intent !== undefined && intent.includes("Do the thing"), "inline label: finds the field with content on same line");
  assert(intent !== undefined && !intent.includes("Deliverables"), "inline label: terminates at next bold label");
}

{
  // Compact form — NO blank line between the field content and the next
  // heading: `### Intent\nDo the thing\n### Deliverables\n- d1: x`. The
  // terminator must fire on the next heading line whether or not a blank line
  // precedes it — the earlier blank-line-anchored version leaked `Do the
  // thing` into the Deliverables slice.
  const compact = "### Intent\nDo the thing\n### Deliverables\n- d1: x\n";
  const compactIntent = sliceSpecField(compact, "Intent");
  assert(compactIntent !== undefined && compactIntent.includes("Do the thing"), "compact: finds the field");
  assert(
    compactIntent !== undefined && !compactIntent.includes("Deliverables"),
    "compact: terminates at the next ### heading with NO blank line before it",
  );
  const compactDeliv = sliceSpecField(compact, "Deliverables");
  assert(
    compactDeliv !== undefined && compactDeliv.includes("d1: x") && !compactDeliv.includes("Do the thing"),
    "compact: the next field starts clean — no bleed from the previous one",
  );

  // Compact bold-label form — no blank line before the next bold label.
  const compactBold = "**Intent** — Do the thing\n**Deliverables**\n- d1: x\n";
  const compactBoldIntent = sliceSpecField(compactBold, "Intent");
  assert(
    compactBoldIntent !== undefined && compactBoldIntent.includes("Do the thing") && !compactBoldIntent.includes("Deliverables"),
    "compact bold: terminates at the next bold label with no blank line before it",
  );
}

{
  // A field that doesn't exist.
  const text = "### Intent\nDo the thing\n";
  const missing = sliceSpecField(text, "Deliverables");
  assert(missing === undefined, "missing field: returns undefined");
}

{
  // #830 — a `**Note** — …` line inside a field body does NOT end the field:
  // FIELD_TERMINATOR's bold-label alternative matches only the spec field
  // names, so a non-field bold label stays inside the body.
  const text = [
    "### Deliverables",
    "- d1: fix the thing",
    "**Note** — keep me",
    "",
    "### Acceptance criteria",
    "- ac1",
  ].join("\n");
  const deliv = sliceSpecField(text, "Deliverables");
  assert(deliv !== undefined && deliv.includes("fix the thing"), "bold note: finds the field");
  assert(deliv !== undefined && deliv.includes("keep me"), "bold note: a `**Note**` line inside the body is kept");
  assert(
    deliv !== undefined && !deliv.includes("Acceptance criteria"),
    "bold note: still terminates at the next field heading",
  );
}

{
  // #830 — inside a spec, a `## Deliverables` line is NOT treated as a field
  // heading by sliceSpecField (the field slicer only accepts level 3–6), so
  // the field is not found via the heading path.
  const text = "### Intent\nDo the thing\n\n## Deliverables\n- d1: x\n";
  const deliv = sliceSpecField(text, "Deliverables");
  assert(deliv === undefined, "h2 inside spec: a `## <field>` line is not a field heading (undefined)");
  const intent = sliceSpecField(text, "Intent");
  assert(intent !== undefined && !intent.includes("Deliverables"), "h2 inside spec: the h2 line terminates the preceding field");
}

// ============================================================================
// sliceMarkdownSection (unchanged) — verify it still only matches level-2
// ============================================================================

{
  // A level-3 Spec is NOT found by sliceMarkdownSection (the shared helper).
  const h3 = "## Intent resolution\n\n### Spec\n\nSome content\n";
  const section = sliceMarkdownSection(h3, "Spec");
  assert(section === undefined, "sliceMarkdownSection: does NOT find a level-3 Spec (unchanged behaviour)");
}

{
  // A level-2 Spec IS found by sliceMarkdownSection.
  const h2 = "## Spec\n\nSome content\n\n## Next\n";
  const section = sliceMarkdownSection(h2, "Spec");
  assert(section !== undefined && section.includes("Some content"), "sliceMarkdownSection: finds a level-2 Spec (unchanged)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
