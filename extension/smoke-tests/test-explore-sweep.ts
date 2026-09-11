#!/usr/bin/env bun
/**
 * #712 — the /start synthesis sweep must exist as a distinct section, and the
 * shared Structured Summary Contract must survive byte-for-byte.
 *
 * The /start dispatch is being re-scoped to a smaller "synthesis tier" that
 * the PM can't derive itself (maturity judgment + gotchas not yet in
 * AGENTS.md). The PM-side rewrite of pi-prompts/start.md (sibling
 * workstream) will dispatch to this new section. The existing 8-field
 * "Structured Summary Contract" section is the /work driver's contract and
 * must not move, rename, or change — /work's inlineExplorePrompt and
 * work-driver-explore.ts read it verbatim.
 *
 * This test guards both directions:
 *   1. The new /start synthesis sweep section is present and well-formed.
 *   2. The existing 8-field Structured Summary Contract section is
 *      byte-for-byte identical to the pre-#712 snapshot.
 *   3. The two sections are distinct — the new section does not replace or
 *      absorb the 8-field contract.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPLORE = path.join(__dirname, "..", "..", "agents-base", "explore.md");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const body = await fs.readFile(EXPLORE, "utf8");

// -------------------------------------------------- the new /start section

const SYNTH_HEADING = "## /start synthesis sweep";
const synthIdx = body.indexOf(SYNTH_HEADING);

assert(synthIdx >= 0, "the new /start synthesis sweep section exists as its own H2 heading");

if (synthIdx >= 0) {
  const synthSection = body.slice(synthIdx);
  // Bound the section at the next H2 so we're not scanning the whole file.
  const nextH2 = synthSection.indexOf("\n## ", SYNTH_HEADING.length);
  const synth = nextH2 >= 0 ? synthSection.slice(0, nextH2) : synthSection;

  assert(synth.includes("maturity"), "the synthesis tier requests a maturity judgment");
  assert(
    /gotchas[\s\S]*(NOT already in|NOT yet in) AGENTS\.md/i.test(synth),
    "the synthesis tier requests gotchas not yet in AGENTS.md",
  );
  assert(
    /architecture/.test(synth),
    "the synthesis tier mentions the optional architecture / cross-file note",
  );
  assert(
    /AGENTS\.md/.test(synth),
    "the section names AGENTS.md explicitly — the PM already holds it",
  );
  assert(
    /advisory/i.test(synth) && /budget/i.test(synth),
    "the section carries an explicit ADVISORY token budget (R3 — no new code, prompt-only)",
  );
  assert(
    !/truncat|re-dispatch on overflow|overflow re-dispatch/i.test(synth),
    "the section does not promise a truncation or re-dispatch mechanism (that would be new code)",
  );
}

// ------------------------------------ the 8-field contract stays verbatim

// Snapshot of the pre-#712 "## Structured Summary Contract" section — the
// heading through the end of the Sweep pattern Step 3 line. Any change to
// this text would silently re-impose or break the /work contract.
const FENCE = "`".repeat(3);
const SNAPSHOT = [
  "## Structured Summary Contract",
  "",
  "When dispatched for /start or /work context sweeps, you must return **EXACTLY** the structured fields specified — no raw output, no prose narration. Format is the contract.",
  "",
  "### Required fields",
  FENCE,
  "project: <one-line identity from telemetry + README>",
  "maturity: <commits, contributors, hotspots — one line>",
  "current_state: <branch, dirty/clean, open PRs, recent activity — one line>",
  "conventions: <up to 3 bullets, ≤ 80 chars each>",
  "quality_gates: <test/lint/typecheck commands, one line>",
  "gotchas: <up to 3 bullets, ≤ 80 chars each>",
  "open_work: <up to 5 issues or PRs by number + title>",
  "ci_health: <last build status, one line>",
  FENCE,
  "",
  "### vipune flag exploitation",
  "",
  "| Flag | When to use |",
  "|---|---|",
  "| `--hybrid` | Default for terminology-heavy queries (semantic + BM25 with RRF fusion). |",
  '| `--recency 0.0-1.0` | Temporality weight. `0.9` for "what\'s happening lately"; `0.0-0.3` for foundational/stable knowledge. |',
  "| `--memory-type <type>` | Filter to project-defined types. Discover via `vipune list --json` first. |",
  "| `--include-candidates` | Lower-confidence entries during broad reconnaissance. |",
  "| `--limit 10-20` | Larger than default 5 when exploring breadth. |",
  '| `vipune list --limit 20` | "What\'s been touched recently" without keyword bias. |',
  "",
  "**Memory types are a fixed, closed enum** — `fact`, `preference`, `procedure`, `guard`, `observation`. There is nothing to discover, and the field is not returned by any vipune command (randomm/vipune#178), so filter by it rather than trying to read it back.",
  "",
  "### Sweep pattern",
  "",
  "**Step 0 — Discover memory types (if no prior knowledge):**",
  FENCE + "bash",
  "# Memory types are a CLOSED set: `fact`, `preference`, `procedure`, `guard`, `observation`.",
  "# Do not try to discover them — no vipune command returns the field (randomm/vipune#178).",
  FENCE,
  "Skip this step if you already know the project's memory types from this session.",
  "",
  "If this command fails for any reason, skip memory-type filtering and proceed with searches using `--hybrid` only (memory-type filtering is an optimization, not a requirement).",
  "",
  "**Step 1 — Probe vipune broadly:**",
  "Run targeted vipune searches using `--hybrid` and appropriate `--recency` values to gather what you need for each summary field. Vary `--recency` by query intent: `0.0-0.3` for foundational/stable knowledge, `0.5-0.9` for recent decisions and current activity. Use `--limit 8-10` per query; add `--include-candidates` on broad sweeps if initial results are sparse. Also run `vipune list --limit 20` for latest activity without keyword bias.",
  "",
  "**Step 2 — Collect telemetry and read docs.** Git telemetry, README.md, CONTRIBUTING.md as specified in the dispatch prompt.",
  "",
  "**Step 3 — Return the structured summary ONLY.** No command output, no intermediate results.",
].join("\n");

assert(
  body.includes(SNAPSHOT),
  "the existing 8-field Structured Summary Contract is byte-for-byte unchanged (the /work contract)",
);

// The two sections must be distinct — the new section must not be placed
// inside or absorb the existing one.
assert(
  body.indexOf("## Structured Summary Contract") < body.indexOf("## /start synthesis sweep"),
  "the /start synthesis sweep section is a SEPARATE H2, not a rename of the Structured Summary Contract",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
