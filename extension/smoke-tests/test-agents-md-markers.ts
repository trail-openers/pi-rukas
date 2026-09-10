#!/usr/bin/env bun
/**
 * section-detect + one-pass strip (ticket M2, companion to M1/#680).
 *
 * The marker-era test exercised parseMarkers/splice/appendSection/
 * insertSectionAfter/presentIds/sectionContent directly, including the
 * #253 byte-preservation regression spec and the marker corruption shapes
 * (orphan, nested, duplicate, mismatched, LOOSE_RE tripwire). Under M2 the
 * markers are deleted: managed sections are identified by HEADING TEXT, and
 * this test re-expresses the same invariants against the heading-based
 * detector (section-detect.ts) and the one-pass migration strip
 * (stripLegacyMarkers).
 *
 * The guarantee is the same structural one from #253: `spliceManagedSection`
 * reconstructs the file as `heading + verbatim-separator + new body + verbatim
 * rest`, so every byte of hand-written prose (before, between, and after the
 * managed sections) and a SECOND OWNER's foreign comment block must be
 * byte-identical to the input. Only the managed section content may change.
 */

import {
  appendManagedSection,
  findManagedSections,
  insertManagedSectionAfter,
  managedIdForHeading,
  managedSectionBody,
  presentManagedIds,
  spliceManagedSection,
  stripLegacyMarkers,
} from "../src/agents-md/section-detect.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// A heading-delimited managed section (post-M2 shape): heading + blank + body.
const section = (heading: string, body: string) => `${heading}\n\n${body}`;

const HAND_WRITTEN_BEFORE =
  "# Project Guide\n\nThis paragraph is the notary's.\nIt must survive any update, byte for byte.\n";
const HAND_WRITTEN_BETWEEN =
  "\n## A human section between managed ones\n\nHand-written doctrine that a regenerator must not touch:\n- rule one\n- rule two\n";
const HAND_WRITTEN_AFTER =
  "\n## Closing notes\n\nThe end-of-file prose lives after the last section.\n";

// A second owner's foreign comment block, different prefix, different id.
const FOREIGN =
  "<!-- other-owner:begin notes v1 -->\nforeign managed content\n<!-- other-owner:end notes -->\n";

// Build a realistic brownfield file: prose + one managed heading section +
// foreign comment + prose.
const managedBody = "- **gate** — `bun run test`";
const input =
  HAND_WRITTEN_BEFORE +
  section("## Quality Gates", managedBody) +
  HAND_WRITTEN_BETWEEN +
  FOREIGN +
  section(
    "## Decision Ledger (legacy, in-file)",
    "| key | value | provenance |\n| --- | --- | --- |\n| x | y | [auto:2026-01-01] |",
  ) +
  HAND_WRITTEN_AFTER;

// --------------------------------------------------------------- the #253 spec

{
  // A new body for the managed section — the "update".
  const newBody = "- **gate** — `bun run test`\n- **gate** — `bun run check`";
  const out = spliceManagedSection(input, "quality-gates", newBody);

  // Only the managed section's content changed. The hand-written prose BEFORE
  // the first managed heading is byte-identical.
  const before = out.slice(0, out.indexOf("## Quality Gates"));
  assert(
    before === input.slice(0, input.indexOf("## Quality Gates")),
    "#253: hand-written prose BEFORE the first managed section is byte-identical",
  );

  // The region between the quality-gates section and the next heading (the
  // human section + foreign comment) must be byte-identical.
  const startOfHuman = input.indexOf("## A human section");
  const outStartOfHuman = out.indexOf("## A human section");
  const nextManaged = input.indexOf("## Decision Ledger");
  const outNextManaged = out.indexOf("## Decision Ledger");
  const betweenIn = input.slice(startOfHuman, nextManaged);
  const betweenOut = out.slice(outStartOfHuman, outNextManaged);
  assert(
    betweenIn === betweenOut,
    "#253: hand-written prose AND the foreign owner block BETWEEN managed sections are byte-identical",
  );

  // Everything after the last managed section (the closing notes) is identical.
  const lastIn = input.indexOf("## Closing notes");
  const lastOut = out.indexOf("## Closing notes");
  assert(
    input.slice(lastIn) === out.slice(lastOut),
    "#253: hand-written prose AFTER the last managed section is byte-identical",
  );

  // The managed content actually changed. (managedSectionBody returns the
  // caller-facing shape: leading blank separator + content + trailing
  // newline; strip both to compare against the raw body.)
  const splicedBody = (managedSectionBody(out, "quality-gates") ?? "")
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  assert(
    splicedBody === newBody,
    "#253: and the managed section itself DID change (the update took effect)",
  );

  // The foreign block content survives verbatim and is NOT mistaken for a
  // managed section.
  assert(
    out.includes("foreign managed content"),
    "#253: the foreign owner's block content survives verbatim",
  );
  assert(
    !presentManagedIds(out).includes("notes"),
    "#253: the foreign block's id is NOT mistaken for a managed section",
  );
}

// --------------------------------------------- splice-twice equals splice-once

{
  const a = spliceManagedSection(input, "quality-gates", "body-v1");
  const b = spliceManagedSection(a, "quality-gates", "body-v1");
  assert(a === b, "splice applied twice with the same body equals applying it once");
  assert(
    (managedSectionBody(b, "quality-gates") ?? "")
      .replace(/^\n/, "")
      .replace(/\n$/, "") === "body-v1",
    "...and the managed section holds the spliced body",
  );
}

// ------------------------------------------------------------ append + splice

{
  const fresh = "# T\n";
  const withOne = appendManagedSection(fresh, "commands", "- cmd");
  assert(
    presentManagedIds(withOne).join(",") === "commands",
    "appendManagedSection adds a managed section",
  );
  const withTwo = appendManagedSection(withOne, "environment", "- Manifest: `package.json`");
  assert(
    presentManagedIds(withTwo).join(",") === "commands,environment",
    "a second append appends in order",
  );
  assert(withTwo.includes("## Commands"), "appended section carries its heading");
  assert(withTwo.includes("## Environment"), "second appended section carries its heading");
}

// ------------------------------------------------------- heading-level boundary
//
// The load-bearing delimiter rule: a managed h1 section (a scaffold section
// like "# Git Workflow") contains internal h2 sub-headings and does NOT end
// at them — it ends at the next h1 (or EOF). A fact section emitted as ##
// ends at the next ## or #, never at an internal ###. This is why the old
// wrap.ts findSections (which split on /^##\s+/ only) was h1-blind.

{
  // An h1 scaffold section with internal h2 sub-headings (the concrete
  // boundary condition from scaffold.ts SCAFFOLD_BODIES).
  const h1Section = [
    "# Git Workflow",
    "",
    "## Conventional commits",
    "",
    "<type>(<scope>): <description>",
    "",
    "## Branch protection",
    "",
    "- NO direct commits to main",
  ].join("\n");
  const file = `# Title\n\n${h1Section}\n\n# Next h1 section\n\nbody of next\n`;
  const spans = findManagedSections(file);
  const git = spans.find((s) => s.id === "git-workflow");
  assert(git !== undefined, "h1 scaffold section is detected by its heading text");
  assert(git?.level === 1, "git-workflow is detected as an h1 section");
  assert(
    git?.body.includes("## Conventional commits") && git?.body.includes("## Branch protection"),
    "h1 section CONTAINS its internal h2 sub-headings (the delimiter is level ≤ own)",
  );
  assert(
    !git?.body.includes("# Next h1 section"),
    "h1 section ends at the next h1 (does not swallow the following h1 section)",
  );

  // A ## fact section ends at the next ## or #, not at an internal ###.
  const h2File = [
    "## Commands",
    "",
    "### Sub detail",
    "",
    "| kind | command |",
    "",
    "## Environment",
    "",
    "- Manifest: `package.json`",
  ].join("\n");
  const h2Spans = findManagedSections(h2File);
  const cmd = h2Spans.find((s) => s.id === "commands");
  assert(cmd !== undefined, "## fact section is detected");
  assert(cmd?.body.includes("### Sub detail"), "## section contains its internal ### sub-heading");
  assert(!cmd?.body.includes("## Environment"), "## section ends at the next ##");
  const env = h2Spans.find((s) => s.id === "environment");
  assert(
    env?.body.includes("- Manifest: `package.json`"),
    "the following ## section is detected too",
  );
}

// ------------------------------------------- heading-name → id exactness
{
  // Exact word-set matching only (the wrap.ts doctrine). Scoped so the
  // heading-detection assertions below are isolated from the file-level state.
  const _block = true; // block scope anchor
  // Exact word-set matching only (the wrap.ts doctrine).
  assert(
    managedIdForHeading("## Quality Gates") === "quality-gates",
    "'## Quality Gates' → quality-gates",
  );
  assert(
    managedIdForHeading("## Quality Gates (blocking)") === undefined,
    "'## Quality Gates (blocking)' is NOT quality-gates (word count)",
  );
  assert(
    managedIdForHeading("## My Commands") === undefined,
    "'## My Commands' is NOT commands (exact word set)",
  );
  assert(
    managedIdForHeading("# Git Workflow") === "git-workflow",
    "'# Git Workflow' → git-workflow (any level)",
  );
  assert(
    managedIdForHeading("## Quality_Gates") === "quality-gates",
    "word-separator tolerant (underscore)",
  );
  assert(managedIdForHeading("## quality gates") === "quality-gates", "case-insensitive");
  assert(
    managedIdForHeading("# Testing Standards") === "testing-standards",
    "'# Testing Standards' → testing-standards",
  );
}

// ------------------------------------------------------------------ corruption
//
// The heading-era corruption: a DUPLICATE managed heading (the same id
// appearing twice) is a structural refusal, never a silent pass.

{
  const dup = "# T\n\n## Commands\n\n| kind | command |\n\n## Commands\n\n| kind | command |";
  let threw = false;
  try {
    presentManagedIds(dup);
  } catch (e) {
    threw = e instanceof Error && /duplicate managed heading/.test(e.message);
  }
  assert(threw, "duplicate managed heading → SectionError, not silent pass");
}

// ------------------------------------------------------------ one-pass strip
//
// The migration transform removes EXACTLY the recognised managed marker
// lines (both prefixes, begin/end, any version shape) and the `:managed`
// preamble comment, preserving every other byte verbatim. Idempotent.

{
  const legacy =
    "# T\n\n" +
    "<!-- pi-rukas:agents-md:managed — preamble -->\n" +
    "<!-- pi-rukas:agents-md:begin commands v1 -->\n" +
    "| kind | command |\n" +
    "<!-- pi-rukas:agents-md:end commands -->\n" +
    "<!-- pi-ensemble:agents-md:begin environment v1 -->\n" +
    "- Manifest: `Gemfile`\n" +
    "<!-- pi-ensemble:agents-md:end environment -->\n" +
    "<!-- other-owner:begin notes v1 -->\nforeign\n<!-- other-owner:end notes -->\n";
  const stripped = stripLegacyMarkers(legacy);
  assert(!stripped.includes("agents-md:begin"), "strip: no begin marker remains");
  assert(!stripped.includes("agents-md:end"), "strip: no end marker remains");
  assert(!stripped.includes("agents-md:managed"), "strip: no :managed preamble remains");
  assert(stripped.includes("| kind | command |"), "strip: the commands body survives");
  assert(stripped.includes("- Manifest: `Gemfile`"), "strip: the environment body survives");
  assert(
    stripped.includes("<!-- other-owner:begin notes v1 -->"),
    "strip: a foreign owner's comment survives byte-for-byte",
  );
  assert(
    stripLegacyMarkers(stripped) === stripped,
    "strip: a second application is a no-op (idempotent)",
  );
}

// --------------------------------------------------------------- code-style id

{
  const codeStyleBody = "- No `# type: ignore`\n- Prefer named exports";
  // Canonical shape: sections separated by exactly one blank line, no trailing
  // blank before the next heading (matching the renderAgent output shape).
  const withCodeStyle = `# T\n\n${section("## Quality Gates", "- **gate** — `bun run test`")}\n\n${section("## Code Style", codeStyleBody)}`;
  assert(
    presentManagedIds(withCodeStyle).join(",") === "quality-gates,code-style",
    "code-style: presentManagedIds lists the new id in document order",
  );
  assert(
    (managedSectionBody(withCodeStyle, "code-style") ?? "")
      .replace(/^\n/, "")
      .replace(/\n$/, "") === codeStyleBody,
    "code-style: managedSectionBody returns the managed body",
  );
  const re = spliceManagedSection(withCodeStyle, "code-style", codeStyleBody);
  assert(re === withCodeStyle, "code-style: re-splice with the same body is byte-identical");
  // insertManagedSectionAfter places a code-style section AFTER the
  // environment heading and BEFORE the next managed heading.
  const before = `# T\n\n${section("## Quality Gates", "- **gate** — `bun run test`")}\n\n${section("## Environment", "- Manifest: `package.json`")}\n\n${section("## Closing", "end")}`;
  const inserted = insertManagedSectionAfter(before, "code-style", codeStyleBody, "environment");
  const envIdx = inserted.indexOf("## Environment");
  const csIdx = inserted.indexOf("## Code Style");
  const closingIdx = inserted.indexOf("## Closing");
  assert(csIdx > envIdx, "code-style insert: the section lands AFTER the environment heading");
  assert(csIdx < closingIdx, "code-style insert: the section lands BEFORE the next heading");
  assert(
    presentManagedIds(inserted).join(",") === "quality-gates,environment,code-style",
    "code-style insert: the section is a well-formed managed section",
  );
}

console.log(exit === 0 ? "\nAll section-detect (heading) checks passed." : "\nFAILED");
process.exit(exit);
