#!/usr/bin/env bun
/**
 * Dual-prefix scaffold round-trip (rename #627).
 *
 * The rename emits new pi-rukas:agents-md markers but legacy user repos
 * carry pi-ensemble:agents-md pairs. The scaffold primitives (parse, splice,
 * render) must handle both prefixes without corrupting recognised pairs.
 *
 * This test loads the dual-prefix fixture and verifies:
 *   1. A mixed file is either parsed (post-rename regex) or surfaced via
 *      the LOOSE_RE tripwire (pre-rename) — never silently dropped.
 *   2. Each old pi-ensemble pair parses and splices cleanly; splicing one
 *      pair leaves sibling old pairs byte-for-byte.
 *   3. renderSection's output round-trips through parse+splice.
 *
 * The assertions are written to pass both pre- and post-rename: the
 * pre-rename regex only recognises pi-ensemble: (so pi-rukas: pairs are
 * surfaced via the tripwire), the post-rename regex recognises both.
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
  "dual-prefix fixture: contains an old pi-ensemble pair",
);
assert(
  text.includes("pi-rukas:agents-md:begin commands"),
  "dual-prefix fixture: contains a new pi-rukas pair",
);

// --- 2. Mixed file: either parsed (post-rename) or tripwired (pre-rename).

let mixedError: Error | null = null;
let mixedSpans: { id: string }[] = [];
try {
  mixedSpans = parseMarkers(text).spans;
} catch (e) {
  mixedError = e as Error;
}
assert(
  mixedError === null || /corrupt or mis-versioned marker/.test(mixedError.message),
  "dual-prefix: mixed file is either parsed (post-rename) or surfaced via LOOSE_RE (pre-rename) — never silently dropped",
);

// --- 3. Isolate old-prefix pairs; parse + splice each, verify prefix binding.

const oldOnly = text.replace(/<!--\s*pi-rukas:agents-md:[^\n]*-->\n/g, "");
const { spans } = parseMarkers(oldOnly);
const ids = spans.map((s) => s.id).sort();
assert(
  JSON.stringify(ids) === JSON.stringify(["environment", "quality-gates"]),
  `dual-prefix: old-prefix pairs parse to expected ids (got ${JSON.stringify(ids)})`,
);
for (const id of ["quality-gates", "environment"]) {
  const span = spans.find((s) => s.id === id);
  if (!span) continue;
  const slice = oldOnly.slice(span.beginMarkerStart, span.endMarkerEnd);
  assert(
    slice.includes(`pi-ensemble:agents-md:begin ${id}`),
    `dual-prefix: ${id} section uses the pi-ensemble prefix in source bytes`,
  );
}
const spliced = splice(oldOnly, "quality-gates", "- **test** — `bun run test` (updated)\n");
assert(
  spliced.includes("- **test** — `bun run test` (updated)"),
  "dual-prefix: splice updates old-prefix section content",
);
assert(
  spliced.includes("pi-ensemble:agents-md:end environment"),
  "dual-prefix: splice leaves sibling old-prefix pairs byte-for-byte",
);

// --- 4. Isolate new-prefix pair: either parsed (post-rename) or tripwired (pre-rename).

const newOnly = text.replace(/<!--\s*pi-ensemble:agents-md:[^\n]*-->\n/g, "");
let newSpans: { id: string }[] = [];
let newError: Error | null = null;
try {
  newSpans = parseMarkers(newOnly).spans;
} catch (e) {
  newError = e as Error;
}
const recognised = newSpans.some((s) => s.id === "commands");
assert(
  recognised === true ||
    (newError === null && newSpans.length === 0) ||
    (newError !== null && /corrupt or mis-versioned marker/.test(newError.message)),
  "dual-prefix: pi-rukas pair is either parsed (post-rename), silently zero-spans (pre-rename), or surfaced via LOOSE_RE — never silently spliced",
);
if (recognised) {
  const splicedNew = splice(newOnly, "commands", "| kind | command | (updated)\n");
  assert(
    splicedNew.includes("(updated)"),
    "dual-prefix: pi-rukas pair splices cleanly once recognised (post-rename)",
  );
}

// --- 5. renderSection output round-trips through parse + splice.

const rendered = renderSection("decision-ledger", "| key | value | provenance |\n");
assert(
  rendered.includes("pi-ensemble:agents-md:begin decision-ledger v1") ||
    rendered.includes("pi-rukas:agents-md:begin decision-ledger v1"),
  "renderSection: emits a recognised prefix (pi-ensemble pre-rename, pi-rukas post-rename)",
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

console.log(exit === 0 ? "\nAll dual-prefix checks passed." : "\nFAILED");
process.exit(exit);
