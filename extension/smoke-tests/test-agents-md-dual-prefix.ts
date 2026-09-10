#!/usr/bin/env bun
/**
 * Migration strip (ticket M2, companion to M1/#680).
 *
 * The marker-era dual-prefix test asserted that legacy `pi-ensemble:` marker
 * pairs and current `pi-rukas:` pairs both parse and splice, preserving
 * prefixes byte-for-byte. Under M2 the markers are deleted: the one-pass
 * migration strip (`stripLegacyMarkers`) removes EXACTLY the recognised
 * begin/end marker lines (both pi-rukas and pi-ensemble prefixes, any version
 * shape) and the `:managed` preamble comment, preserving every other byte
 * verbatim — and a second application is a byte-identical no-op.
 *
 * This test loads the dual-prefix fixture and verifies:
 *   1. The fixture contains both prefixes (pre-migration input).
 *   2. The one-pass strip removes EXACTLY the 6 marker lines (3 pi-ensemble
 *      + 3 pi-rukas begin/end pairs), leaving every other byte verbatim.
 *   3. The strip result is idempotent: a second application is a no-op.
 *   4. The `:managed` preamble comment is stripped in the same pass.
 *   5. A foreign owner's comment block (`<!-- other-owner:... -->`) survives
 *      byte-for-byte — the strip only touches pi-rukas/pi-ensemble pairs.
 *
 * The other two golden fixtures (ruby-greenfield, rich-manifest-no-codestyle)
 * are exercised by test-agents-md-markers.ts (now a heading-detect test);
 * the dual-prefix fixture is the ONLY one carrying the legacy pi-ensemble
 * prefix, which is the property this file exists to pin.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { stripLegacyMarkers } from "../src/agents-md/section-detect.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fixturePath = path.join(
  import.meta.dirname,
  "fixtures",
  "agents-md",
  "dual-prefix-agents-md.md",
);
const text = readFileSync(fixturePath, "utf8");

// --- 1. The fixture contains both prefixes (pre-migration input).

assert(
  text.includes("pi-ensemble:agents-md:begin quality-gates"),
  "dual-prefix fixture: contains a legacy pi-ensemble pair",
);
assert(
  text.includes("pi-rukas:agents-md:begin commands"),
  "dual-prefix fixture: contains a current pi-rukas pair",
);

// --- 2. The one-pass strip removes EXACTLY the 6 marker lines.

const stripped = stripLegacyMarkers(text);
// Every recognised marker line (both prefixes, begin + end) is gone.
assert(
  !stripped.includes("pi-ensemble:agents-md:begin"),
  "strip: no pi-ensemble begin line remains",
);
assert(!stripped.includes("pi-ensemble:agents-md:end"), "strip: no pi-ensemble end line remains");
assert(!stripped.includes("pi-rukas:agents-md:begin"), "strip: no pi-rukas begin line remains");
assert(!stripped.includes("pi-rukas:agents-md:end"), "strip: no pi-rukas end line remains");
// Zero `<!--` bytes of any recognised shape remain in the managed regions.
assert(!stripped.includes("agents-md:begin"), "strip: no `agents-md:begin` substring remains");
assert(!stripped.includes("agents-md:end"), "strip: no `agents-md:end` substring remains");
assert(
  !stripped.includes("agents-md:managed"),
  "strip: no `:managed` preamble remains (none in this fixture)",
);

// Every non-marker byte survives verbatim. Rebuild the expected output by
// deleting exactly the 6 marker lines from the input and compare byte-for-byte.
const inputLines = text.split("\n");
const isMarkerLine = (l: string) =>
  /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:(?:begin|end)\b.*-->/s.test(l.trim());
const expectedLines = inputLines.filter((l) => !isMarkerLine(l));
assert(
  stripped === expectedLines.join("\n"),
  "strip: result is byte-identical to the input minus exactly the 6 marker lines",
);

// The hand-written prose and section bodies are intact.
assert(
  stripped.includes("Hand-written prose survives byte-for-byte between managed sections."),
  "strip: hand-written prose survives verbatim",
);
assert(stripped.includes("- **test** — `bun run test`"), "strip: the quality-gates body survives");
assert(stripped.includes("| kind | command |"), "strip: the commands table survives");
assert(stripped.includes("- Manifest: `package.json`"), "strip: the environment body survives");

// --- 3. Idempotence: a second application is a byte-identical no-op.

assert(
  stripLegacyMarkers(stripped) === stripped,
  "strip: a second application is a no-op (idempotent)",
);

// --- 4. The `:managed` preamble comment is stripped in the same pass.

const withPreamble =
  "# T\n\n<!-- pi-rukas:agents-md:managed — the sections below are maintained -->\nbody\n";
const p = stripLegacyMarkers(withPreamble);
assert(!p.includes("agents-md:managed"), "strip: the :managed preamble comment is removed");
assert(p.includes("body"), "strip: the body after the preamble survives");
assert(
  p === "# T\n\nbody\n",
  "strip: preamble removal preserves surrounding bytes (no heading synthesis)",
);

// --- 5. A foreign owner's comment block survives byte-for-byte.

const foreign =
  "# T\n\n<!-- other-owner:begin notes v1 -->\nforeign managed content\n<!-- other-owner:end notes -->\n\n<!-- pi-rukas:agents-md:begin commands v1 -->\n| kind | command |\n<!-- pi-rukas:agents-md:end commands -->\n";
const foreignOut = stripLegacyMarkers(foreign);
assert(
  foreignOut.includes("<!-- other-owner:begin notes v1 -->") &&
    foreignOut.includes("foreign managed content") &&
    foreignOut.includes("<!-- other-owner:end notes -->"),
  "strip: a foreign owner's comment block survives byte-for-byte",
);
assert(
  !foreignOut.includes("pi-rukas:agents-md:"),
  "strip: the pi-rukas pair is removed while the foreign block is kept",
);

// --------------------------------------- 6. Ruby greenfield fixture (strip)

{
  const rubyPath = path.join(
    import.meta.dirname,
    "fixtures",
    "agents-md",
    "ruby-greenfield-agents-md.md",
  );
  const rubyText = readFileSync(rubyPath, "utf8");
  assert(
    rubyText.includes("pi-rukas:agents-md:begin quality-gates"),
    "ruby-greenfield fixture: contains a quality-gates pair (pre-migration)",
  );
  const rubyStripped = stripLegacyMarkers(rubyText);
  assert(
    !rubyStripped.includes("agents-md:begin"),
    "ruby-greenfield: strip removes all marker begin lines",
  );
  assert(
    !rubyStripped.includes("agents-md:end"),
    "ruby-greenfield: strip removes all marker end lines",
  );
  assert(
    rubyStripped.includes("| kind | command |"),
    "ruby-greenfield: the commands table body survives",
  );
  assert(
    rubyStripped.includes("- Manifest: `Gemfile`"),
    "ruby-greenfield: the environment body survives",
  );
  // The in-file decision-ledger span's CONTENT (the legacy table) survives
  // the strip verbatim (M1's job is to migrate it to the sidecar; M2 only
  // removes the marker lines, never the ledger table bytes).
  assert(
    rubyStripped.includes("[detected:agent,2026-01-01]"),
    "ruby-greenfield: the in-file ledger table content survives the strip (M1 concern)",
  );
  assert(stripLegacyMarkers(rubyStripped) === rubyStripped, "ruby-greenfield: strip is idempotent");
}

// --------------------------------------- 7. Rich manifest, no code-style fixture

{
  const richPath = path.join(
    import.meta.dirname,
    "fixtures",
    "agents-md",
    "rich-manifest-no-codestyle-agents-md.md",
  );
  const richText = readFileSync(richPath, "utf8");
  assert(
    richText.includes("pi-rukas:agents-md:begin quality-gates"),
    "rich-manifest fixture: contains a quality-gates pair (pre-migration)",
  );
  const richStripped = stripLegacyMarkers(richText);
  assert(
    !richStripped.includes("agents-md:begin"),
    "rich-manifest: strip removes all marker begin lines",
  );
  assert(
    !richStripped.includes("agents-md:end"),
    "rich-manifest: strip removes all marker end lines",
  );
  assert(
    richStripped.includes("- Manifest: `package.json`"),
    "rich-manifest: the environment body survives",
  );
  assert(
    richStripped.includes("[auto:2026-01-01]"),
    "rich-manifest: the in-file ledger [auto] rows survive the strip",
  );
  assert(stripLegacyMarkers(richStripped) === richStripped, "rich-manifest: strip is idempotent");
}

console.log(exit === 0 ? "\nAll dual-prefix (migration strip) checks passed." : "\nFAILED");
process.exit(exit);
