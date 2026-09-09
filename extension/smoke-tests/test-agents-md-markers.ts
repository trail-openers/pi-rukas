#!/usr/bin/env bun
/**
 * markers — the #253 regression, plus splice idempotence and corruption.
 *
 * clud-bug #253: an AGENTS.md regenerator "updated" the file and deleted a
 * hand-written notary paragraph that lived OUTSIDE every marker pair, and
 * touched three unrelated files. The whole class of failure is "the tool
 * rewrote more than its own marker pairs". This test is the regression spec:
 * after an `update`-shaped splice, every byte of hand-written prose (before,
 * between, and after the managed pairs) and a SECOND OWNER's foreign marker
 * block must be byte-identical to the input. Only the managed section content
 * may change.
 *
 * The guarantee is structural, not accidental: `splice` reconstructs the file
 * as `text[:contentStart] + body + text[contentEnd:]`, so bytes outside the
 * managed content are copied straight through. This test proves it, and the
 * corruption cases prove the parser refuses to operate on a file it cannot
 * parse (a bad splice detected BEFORE writing is an error; after writing it is
 * data loss).
 */

import {
  MarkerError,
  appendSection,
  insertSectionAfter,
  parseMarkers,
  presentIds,
  renderSection,
  sectionContent,
  splice,
} from "../src/agents-md/markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HAND_WRITTEN_BEFORE =
  "# Project Guide\n\nThis paragraph is the notary's.\nIt must survive any update, byte for byte.\n";
const HAND_WRITTEN_BETWEEN =
  "\n## A human section between managed ones\n\nHand-written doctrine that a regenerator must not touch:\n- rule one\n- rule two\n";
const HAND_WRITTEN_AFTER =
  "\n## Closing notes\n\nThe end-of-file prose lives after the last marker.\n";

// A second owner's foreign marker block, different prefix, different id.
const FOREIGN =
  "<!-- other-owner:begin notes v1 -->\nforeign managed content\n<!-- other-owner:end notes -->\n";

// Build a realistic brownfield file: prose + one managed pair + foreign pair + prose.
const managedBody = "- **gate** — `bun run test`\n";
const input =
  HAND_WRITTEN_BEFORE +
  renderSection("quality-gates", managedBody) +
  HAND_WRITTEN_BETWEEN +
  FOREIGN +
  renderSection(
    "decision-ledger",
    "| key | value | provenance |\n| --- | --- | --- |\n| x | y | [auto:2026-01-01] |",
  ) +
  HAND_WRITTEN_AFTER;

// --------------------------------------------------------------- the #253 spec

{
  // A new body for the managed section — the "update".
  const newBody = "- **gate** — `bun run test`\n- **gate** — `bun run check`\n";
  const out = splice(input, "quality-gates", newBody);

  // Only the managed section's content changed. Every other byte is identical.
  const before = out.slice(0, out.indexOf("<!-- pi-rukas:agents-md:begin quality-gates"));
  assert(
    before === input.slice(0, input.indexOf("<!-- pi-rukas:agents-md:begin quality-gates")),
    "#253: hand-written prose BEFORE the first managed pair is byte-identical",
  );

  // The region between the quality-gates end marker and the next managed begin
  // (the human section + foreign pair) must be byte-identical.
  const startOfHuman = input.indexOf("<!-- pi-rukas:agents-md:end quality-gates -->");
  const outStartOfHuman = out.indexOf("<!-- pi-rukas:agents-md:end quality-gates -->");
  const nextManagedBegin = input.indexOf("<!-- pi-rukas:agents-md:begin decision-ledger");
  const outNextManagedBegin = out.indexOf("<!-- pi-rukas:agents-md:begin decision-ledger");
  const betweenIn = input.slice(startOfHuman, nextManagedBegin);
  const betweenOut = out.slice(outStartOfHuman, outNextManagedBegin);
  assert(
    betweenIn === betweenOut,
    "#253: hand-written prose AND the foreign owner block BETWEEN managed pairs are byte-identical",
  );

  // Everything after the last managed pair (the closing notes) is identical.
  const lastEndIn = input.lastIndexOf("<!-- pi-rukas:agents-md:end decision-ledger -->");
  const lastEndOut = out.lastIndexOf("<!-- pi-rukas:agents-md:end decision-ledger -->");
  assert(
    input.slice(lastEndIn) === out.slice(lastEndOut),
    "#253: hand-written prose AFTER the last managed pair is byte-identical",
  );

  // The managed content actually changed.
  assert(
    sectionContent(out, "quality-gates") === `${newBody}`,
    "#253: and the managed section itself DID change (the update took effect)",
  );

  // The foreign block still parses as absent from OUR markers, and is present verbatim.
  assert(
    out.includes("foreign managed content"),
    "#253: the foreign owner's block content survives verbatim",
  );
  assert(
    !presentIds(out).includes("notes"),
    "#253: the foreign block's id is NOT mistaken for a pi-ensemble managed section",
  );
}

// --------------------------------------------- splice-twice equals splice-once

{
  const a = splice(input, "quality-gates", "body-v1\n");
  const b = splice(a, "quality-gates", "body-v1\n");
  assert(a === b, "splice applied twice with the same body equals applying it once");
  // And the idempotent re-splice did not corrupt the other sections.
  assert(
    sectionContent(b, "decision-ledger") === sectionContent(input, "decision-ledger"),
    "...and the ledger section is untouched by the no-op re-splice",
  );
}

// ------------------------------------------------------------ append + splice

{
  const fresh = "# T\n";
  const withOne = appendSection(fresh, "commands", "- cmd\n");
  assert(presentIds(withOne).join(",") === "commands", "appendSection adds a managed section");
  const withTwo = appendSection(withOne, "decision-ledger", "| k | v | p |\n| --- | --- | --- |\n");
  assert(
    presentIds(withTwo).join(",") === "commands,decision-ledger",
    "a second append appends in order",
  );
  assert(
    withTwo.endsWith("<!-- pi-rukas:agents-md:end decision-ledger -->\n"),
    "...ending on a complete marker pair",
  );
}

// ------------------------------------------------------------------ corruption

{
  // Nested: a begin inside another open span.
  const nested = `${
    renderSection("a", "x").replace("<!-- pi-rukas:agents-md:end a -->", "") +
    renderSection("b", "y")
  }<!-- pi-rukas:agents-md:end a -->\n`;
  assert(
    throws(() => parseMarkers(nested)),
    "nested markers → MarkerError, not silent pass",
  );

  // Duplicate id: two sections with the same id.
  const dup = renderSection("a", "1") + renderSection("a", "2");
  assert(
    throws(() => parseMarkers(dup)),
    "duplicate section id → MarkerError",
  );

  // Mismatched: begin a, end b.
  const mismatch =
    "<!-- pi-rukas:agents-md:begin a v1 -->\nbody\n<!-- pi-rukas:agents-md:end b -->\n";
  assert(
    throws(() => parseMarkers(mismatch)),
    "mismatched begin/end ids → MarkerError",
  );

  // Orphan begin: begin with no end.
  const orphanBegin = "<!-- pi-rukas:agents-md:begin a v1 -->\nbody\n";
  assert(
    throws(() => parseMarkers(orphanBegin)),
    "begin with no matching end → MarkerError",
  );

  // Orphan end: end with no begin.
  const orphanEnd = "<!-- pi-rukas:agents-md:end a -->\n";
  assert(
    throws(() => parseMarkers(orphanEnd)),
    "end with no matching begin → MarkerError",
  );
}

// splice must not silently "succeed" on a corrupt file either
{
  const corrupt = "<!-- pi-rukas:agents-md:begin a v1 -->\nbody\n"; // orphan begin
  let threw = false;
  try {
    splice(corrupt, "a", "new");
  } catch (e) {
    threw = e instanceof MarkerError;
  }
  assert(threw, "splice refuses to act on a corrupt file (throws MarkerError)");
}

// ------------------------------------------------------------ tripwire shapes
//
// The corruption tripwire's invariant: a marker-shaped token that neither
// BEGIN_RE nor END_RE recognised must be refused, never silently accepted.
// A mis-versioned END (trailing `v<N>`) is the load-bearing shape — if it
// were accepted, a drift of this kind would be spliced around verbatim and
// the corruption would be permanently invisible.

{
  const v3begin =
    "<!-- pi-rukas:agents-md:begin x v3 -->\nq\n<!-- pi-rukas:agents-md:end x v2 -->\n";
  const err = throwsCorrupt(
    v3begin,
    "strict-captured begin v3 + strict-missed end v2 → MarkerError",
  );
  assert(
    err?.includes("mis-versioned"),
    "...and the diagnostic names the mis-versioned marker (not an orphan pairing)",
  );

  // The other strict-missed END shapes, so the invariant holds for the class,
  // not just the one probe that motivated it.
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x v99 -->\nq\n<!-- pi-rukas:agents-md:end x v2 -->\n",
    "begin v99 + end v2 → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x v1 -->\nq\n<!-- pi-rukas:agents-md:end x v2 -->\n",
    "begin v1 + end v2 → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x v2 -->\nq\n<!-- pi-rukas:agents-md:end x v2 -->\n",
    "begin v2 + end v2 (both strict-missed on the end) → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:end a v2 -->\n",
    "orphan END with a version → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin a v1 -->\nq\n<!-- pi-rukas:agents-md:end b v3 -->\n",
    "mismatched ids + versioned END → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x v1 -->\nq\n<!-- pi-rukas:agents-md:end x\nv9 -->\n",
    "END split across two physical lines → MarkerError",
  );

  // The shapes that used to vanish silently before the tripwire existed.
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x -->\nq\n<!-- pi-rukas:agents-md:end x -->\n",
    "begin missing its version → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin x v1 -->\nq\n<!-- pi-rukas:agents-md:end x junk -->\n",
    "end with trailing junk → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin a.b v1 -->\nq\n<!-- pi-rukas:agents-md:end a.b -->\n",
    "id with a dot → MarkerError",
  );
  throwsCorrupt(
    "<!-- pi-rukas:agents-md:begin QUALITY v1 -->\nq\n<!-- pi-rukas:agents-md:end QUALITY -->\n",
    "uppercase id → MarkerError",
  );

  // Valid shapes must keep parsing — the tripwire must not over-catch.
  const valid =
    "<!-- pi-rukas:agents-md:begin a v1 -->\nq\n<!-- pi-rukas:agents-md:end a -->\n" +
    "<!-- pi-rukas:agents-md:begin b v1 -->\nq\n<!-- pi-rukas:agents-md:end b -->\n";
  const ids = presentIds(valid);
  assert(ids.join(",") === "a,b", "valid multi-pair file still parses cleanly");
}

// ------------------------------------------------------------ code-style id
//
// The new managed id `code-style` must flow through the same parse / splice /
// insert primitives as the existing ids, without touching the tripwire regexes
// (the id charset `[a-z0-9-]` already admits it).

{
  const codeStyleBody = "- No `# type: ignore`\n- Prefer named exports\n";
  const withCodeStyle =
    "# T\n" +
    renderSection("quality-gates", managedBody) +
    renderSection("environment", "- Manifest: `package.json`\n") +
    renderSection("code-style", codeStyleBody) +
    renderSection(
      "decision-ledger",
      "| key | value | provenance |\n| --- | --- | --- |\n| x | y | [auto:2026-01-01] |",
    );

  // presentIds lists the new id between environment and decision-ledger.
  assert(
    presentIds(withCodeStyle).join(",") ===
      "quality-gates,environment,code-style,decision-ledger",
    "code-style: presentIds lists the new id in document order",
  );

  // sectionContent round-trips the body.
  assert(
    sectionContent(withCodeStyle, "code-style") === codeStyleBody,
    "code-style: sectionContent returns the managed body",
  );

  // A re-splice of the code-style section is byte-identical and leaves the
  // ledger untouched.
  const re = splice(withCodeStyle, "code-style", codeStyleBody);
  assert(re === withCodeStyle, "code-style: re-splice with the same body is byte-identical");
  assert(
    sectionContent(re, "decision-ledger") === sectionContent(withCodeStyle, "decision-ledger"),
    "code-style: the ledger is untouched by the code-style re-splice",
  );

  // insertSectionAfter places a code-style pair AFTER the environment end marker
  // and BEFORE the decision-ledger begin marker.
  const before =
    "# T\n" +
    renderSection("quality-gates", managedBody) +
    renderSection("environment", "- Manifest: `package.json`\n") +
    renderSection(
      "decision-ledger",
      "| key | value | provenance |\n| --- | --- | --- |\n| x | y | [auto:2026-01-01] |",
    );
  const inserted = insertSectionAfter(before, "code-style", codeStyleBody, "environment");
  const envEnd = inserted.indexOf("<!-- pi-rukas:agents-md:end environment -->");
  const csBegin = inserted.indexOf("<!-- pi-rukas:agents-md:begin code-style");
  const dlBegin = inserted.indexOf("<!-- pi-rukas:agents-md:begin decision-ledger");
  assert(csBegin > envEnd, "code-style insert: the pair lands AFTER the environment end marker");
  assert(csBegin < dlBegin, "code-style insert: the pair lands BEFORE decision-ledger");
  assert(
    presentIds(inserted).join(",") === "quality-gates,environment,code-style,decision-ledger",
    "code-style insert: the pair is a well-formed managed section",
  );
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof MarkerError;
  }
}

function throwsCorrupt(input: string, msg: string): string | undefined {
  try {
    parseMarkers(input);
    console.error(`✗ ${msg}`);
    exit = 1;
    return undefined;
  } catch (e) {
    if (e instanceof MarkerError) {
      console.log(`✓ ${msg}`);
      return e.message;
    }
    console.error(`✗ ${msg} (wrong error type: ${(e as Error).message})`);
    exit = 1;
    return undefined;
  }
}

console.log(exit === 0 ? "\nAll marker checks passed." : "\nFAILED");
process.exit(exit);
