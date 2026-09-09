#!/usr/bin/env bun
/**
 * Dual-prefix scaffold round-trip (rename #630, epic #626).
 *
 * Emission uses the new pi-rukas:agents-md markers; legacy user repos that
 * went through the pi-ensemble era carry pi-ensemble:agents-md pairs. The
 * scaffold primitives (parse, splice, render) must handle BOTH prefixes
 * without corrupting recognised pairs — a mixed file parses every
 * recognised pair and never silently drops one, and splicing a legacy pair
 * preserves its original prefix (an operator's file is never re-encoded
 * behind their back).
 *
 * This test loads the dual-prefix fixture and verifies:
 *   1. The fixture contains both prefixes.
 *   2. A mixed file parses cleanly — every pair recognised, no tripwire.
 *   3. Each legacy pi-ensemble pair parses and splices cleanly; splicing one
 *      pair leaves sibling pairs (legacy AND current) byte-for-byte, and the
 *      spliced pair KEEPS its pi-ensemble prefix.
 *   4. The current pi-rukas pair parses and splices cleanly, keeping its
 *      prefix.
 *   5. renderSection emits the CURRENT prefix and round-trips through
 *      parse + splice.
 *   6. A stray pair under EITHER prefix with a shape the strict regexes do
 *      not accept still trips the LOOSE_RE corruption tripwire — the
 *      dual-prefix parser must not have widened the corruption detection.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMarkers, renderSection, splice } from "../src/agents-md/markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fixturePath = path.join(import.meta.dirname, "fixtures", "agents-md", "dual-prefix-agents-md.md");
const text = readFileSync(fixturePath, "utf8");

// --- 1. The fixture contains both prefixes.

assert(
  text.includes("pi-ensemble:agents-md:begin quality-gates"),
  "dual-prefix fixture: contains a legacy pi-ensemble pair",
);
assert(
  text.includes("pi-rukas:agents-md:begin commands"),
  "dual-prefix fixture: contains a current pi-rukas pair",
);

// --- 2. Mixed file parses cleanly: every pair recognised, no tripwire.

let mixedError: Error | null = null;
let mixedSpans: { id: string }[] = [];
try {
  mixedSpans = parseMarkers(text).spans;
} catch (e) {
  mixedError = e as Error;
}
assert(mixedError === null, "dual-prefix: mixed file parses (both prefixes recognised)");
assert(
  JSON.stringify(mixedSpans.map((s) => s.id).sort()) ===
    JSON.stringify(["commands", "environment", "quality-gates"]),
  "dual-prefix: all three pairs recognised (got " +
    JSON.stringify(mixedSpans.map((s) => s.id).sort()) +
    ")",
);

// --- 3. Splice a legacy pair: content updates, legacy prefix preserved,
//        sibling pairs (legacy AND current) byte-for-byte.

const splicedLegacy = splice(text, "quality-gates", "- **test** — `bun run test` (updated)\n");
assert(
  splicedLegacy.includes("- **test** — `bun run test` (updated)"),
  "dual-prefix: splice updates legacy pair content",
);
assert(
  splicedLegacy.includes("pi-ensemble:agents-md:begin quality-gates"),
  "dual-prefix: spliced legacy pair KEEPS its pi-ensemble prefix (never re-encoded)",
);
assert(
  splicedLegacy.includes("pi-rukas:agents-md:begin commands v1"),
  "dual-prefix: sibling current pair survives byte-for-byte",
);
assert(
  splicedLegacy.includes("pi-ensemble:agents-md:end environment"),
  "dual-prefix: sibling legacy pair survives byte-for-byte",
);
assert(
  splicedLegacy.includes("<!-- pi-rukas:agents-md:end commands -->"),
  "dual-prefix: sibling current end marker survives byte-for-byte",
);

// --- 4. Splice the current pair: prefix preserved, legacy siblings untouched.

const splicedCurrent = splice(text, "commands", "| kind | command | (updated)\n");
assert(
  splicedCurrent.includes("(updated)"),
  "dual-prefix: current pair splices cleanly",
);
assert(
  splicedCurrent.includes("pi-rukas:agents-md:begin commands v1"),
  "dual-prefix: current pair keeps its pi-rukas prefix",
);
assert(
  splicedCurrent.includes("pi-ensemble:agents-md:begin quality-gates"),
  "dual-prefix: legacy pair untouched by a current-pair splice",
);

// --- 5. renderSection emits the CURRENT prefix and round-trips.

const rendered = renderSection("decision-ledger", "| key | value | provenance |\n");
assert(
  rendered.includes("pi-rukas:agents-md:begin decision-ledger v1"),
  "renderSection: emits the current pi-rukas prefix",
);
assert(
  !rendered.includes("pi-ensemble:agents-md:"),
  "renderSection: never emits the legacy prefix",
);
const { spans: reParsed } = parseMarkers(rendered);
assert(
  reParsed.length === 1 && reParsed[0]?.id === "decision-ledger",
  "renderSection: round-trips through parseMarkers",
);
const reSpliced = splice(rendered, "decision-ledger", "| key | value | provenance | (re-spliced)\n");
assert(
  reSpliced.includes("(re-spliced)"),
  "renderSection: emitted pair splices cleanly",
);

// --- 6. The corruption tripwire still fires under either prefix — the
//        dual-prefix parser did not widen the corruption detection.

const strayLegacy = "<!-- pi-ensemble:agents-md:begin x -->\nq\n<!-- pi-ensemble:agents-md:end x -->\n";
let legacyTripwired = false;
try {
  parseMarkers(strayLegacy);
} catch (e) {
  legacyTripwired = e instanceof Error && /corrupt or mis-versioned marker/.test(e.message);
}
assert(legacyTripwired, "tripwire: stray legacy-pair shape still throws MarkerError");

const strayCurrent = "<!-- pi-rukas:agents-md:begin x -->\nq\n<!-- pi-rukas:agents-md:end x -->\n";
let currentTripwired = false;
try {
  parseMarkers(strayCurrent);
} catch (e) {
  currentTripwired = e instanceof Error && /corrupt or mis-versioned marker/.test(e.message);
}
assert(currentTripwired, "tripwire: stray current-pair shape still throws MarkerError");

// ------------------------------------------------------ 7. Ruby greenfield fixture

{
  const rubyPath = path.join(import.meta.dirname, "fixtures", "agents-md", "ruby-greenfield-agents-md.md");
  const rubyText = readFileSync(rubyPath, "utf8");
  assert(
    rubyText.includes("pi-rukas:agents-md:begin quality-gates"),
    "ruby-greenfield fixture: contains a quality-gates pair",
  );
  assert(
    rubyText.includes("pi-rukas:agents-md:begin code-style"),
    "ruby-greenfield fixture: contains a code-style pair",
  );
  assert(
    rubyText.includes("Gemfile"),
    "ruby-greenfield fixture: references Gemfile as the manifest",
  );
  assert(
    rubyText.includes("[detected:agent,2026-01-01]"),
    "ruby-greenfield fixture: ledger carries [detected:agent] rows",
  );
  // The fixture must parse cleanly (no corruption tripwire).
  let rubyParsed: { id: string }[] = [];
  let rubyErr: Error | null = null;
  try {
    rubyParsed = parseMarkers(rubyText).spans;
  } catch (e) {
    rubyErr = e as Error;
  }
  assert(rubyErr === null, "ruby-greenfield fixture: parses cleanly (no tripwire)");
  const rubyIds = rubyParsed.map((s) => s.id).sort();
  assert(
    rubyIds.includes("quality-gates") && rubyIds.includes("commands") && rubyIds.includes("environment") && rubyIds.includes("code-style") && rubyIds.includes("decision-ledger"),
    "ruby-greenfield fixture: all 5 managed sections recognised",
  );
}

// --------------------------------------- 8. Rich manifest, no code-style fixture

{
  const richPath = path.join(import.meta.dirname, "fixtures", "agents-md", "rich-manifest-no-codestyle-agents-md.md");
  const richText = readFileSync(richPath, "utf8");
  assert(
    richText.includes("pi-rukas:agents-md:begin quality-gates"),
    "rich-manifest-no-codestyle fixture: contains a quality-gates pair",
  );
  assert(
    !richText.includes("pi-rukas:agents-md:begin code-style"),
    "rich-manifest-no-codestyle fixture: does NOT contain a code-style pair (the trigger case)",
  );
  assert(
    richText.includes("package.json"),
    "rich-manifest-no-codestyle fixture: references package.json as the manifest",
  );
  assert(
    richText.includes("[auto:2026-01-01]"),
    "rich-manifest-no-codestyle fixture: ledger carries [auto] rows (not [detected:agent])",
  );
  // The fixture must parse cleanly.
  let richParsed: { id: string }[] = [];
  let richErr: Error | null = null;
  try {
    richParsed = parseMarkers(richText).spans;
  } catch (e) {
    richErr = e as Error;
  }
  assert(richErr === null, "rich-manifest-no-codestyle fixture: parses cleanly (no tripwire)");
  const richIds = richParsed.map((s) => s.id);
  assert(
    richIds.includes("quality-gates") && richIds.includes("commands") && richIds.includes("environment") && richIds.includes("decision-ledger"),
    "rich-manifest-no-codestyle fixture: the 3 fact sections + ledger are recognised",
  );
  assert(
    !richIds.includes("code-style"),
    "rich-manifest-no-codestyle fixture: code-style is NOT among the parsed ids",
  );
}

console.log(exit === 0 ? "\nAll dual-prefix checks passed." : "\nFAILED");
process.exit(exit);
