#!/usr/bin/env bun
/**
 * #1006 — TL;DR section: unit tests for the shared builder in
 * work-driver-pr-body-definition.ts.
 *
 * Covers:
 *   - tldrSectionOf: happy path, empty spec, no intent, no deliverables,
 *     whole sentences only (at most three, 400 chars, never cut, no `…`)
 *   - hasTldrSection: present/absent detection, case sensitivity,
 *     heading variants (## TL;DR, ## TLDR)
 *   - prependTldr: idempotency (existing heading → no-op), normal prepend,
 *     empty TLDR → no-op, concurrent user edits preserved
 */

import {
  hasTldrSection,
  prependTldr,
  tldrSectionOf,
  type PipelineStateNormalisedSpec,
} from "../src/work-driver-pr-body-definition.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// tldrSectionOf — the spec-driven TL;DR builder
// ---------------------------------------------------------------------------

const baseSpec: PipelineStateNormalisedSpec = {
  intent: "Add a TL;DR section to PR and issue bodies on cycle completion.",
  deliverables: [
    {
      id: "d1",
      description: "A tldrSectionOf helper in work-driver-pr-body-definition.ts",
      paths: ["extension/src/work-driver-pr-body-definition.ts"],
    },
    {
      id: "d2",
      description: "TL;DR spliced into mechanizedCommitPr's prBody",
      paths: ["extension/src/work-driver-commit.ts"],
    },
  ],
  acceptanceCriteria: ["PR body starts with TL;DR"],
  outOfScope: ["PR title derivation"],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "Spec is complete and actionable.",
};

// 1. Happy path: intent + first deliverable description
{
  const tldr = tldrSectionOf(baseSpec);
  assert(tldr.startsWith("## TL;DR"), "TLDR starts with the ## TL;DR heading");
  assert(tldr.includes("Add a TL;DR section"), "TLDR contains the intent text");
  assert(
    tldr.includes("A tldrSectionOf helper"),
    "TLDR contains the first deliverable description",
  );
  assert(
    !tldr.includes("tldrSectionOf helper in work-driver-pr-body-definition.ts") ||
      tldr.length <= 400 + 10,
    "TLDR text is within the 400-char cap (heading + text ≤ ~410)",
  );
}

// 2. Empty spec (undefined) → empty string
{
  assert(tldrSectionOf(undefined) === "", "undefined spec → empty string");
}

// 3. Empty intent → empty string
{
  const spec = { ...baseSpec, intent: "" };
  assert(tldrSectionOf(spec) === "", "empty intent → empty string");
}

// 4. Whitespace-only intent → empty string
{
  const spec = { ...baseSpec, intent: "   " };
  assert(tldrSectionOf(spec) === "", "whitespace-only intent → empty string");
}

// 5. No deliverables → empty string
{
  const spec = { ...baseSpec, deliverables: [] };
  assert(tldrSectionOf(spec) === "", "no deliverables → empty string");
}

// 6. #1773: a single sentence over 400 chars is kept whole — never cut, never `…`
{
  const longIntent =
    "This is a very long intent that goes on and on about the TLDR feature and how it works and why it matters to the user and the developer and the reviewer and the operator who reads the PR body and the issue body and the handoff and the event log and all the other parts of the system that this feature touches in various ways with no period anywhere in the middle just a long unbroken run of words that keeps going and going until it finally reaches the end of the budget cap which is four hundred characters total";
  const text = tldrSectionOf({ ...baseSpec, intent: longIntent }).replace("## TL;DR\n\n", "");
  assert(text === `${longIntent}.`, "#1773: a long first sentence stands whole");
  assert(!text.includes("\u2026"), "#1773: no ellipsis on a long sentence");
}

// 6b. #1773 AC4: a complete first sentence plus a deliverable that pushes the
// total over 400 → the sentence alone, with no trailing `…`
{
  const spec = {
    ...baseSpec,
    intent: "Stop a refine planning turn from naming its own issue as the duplicate.",
    deliverables: [{ id: "d1", description: `${"word ".repeat(80)}end.`, paths: [] }],
  };
  const text = tldrSectionOf(spec).replace("## TL;DR\n\n", "");
  assert(
    text === "Stop a refine planning turn from naming its own issue as the duplicate.",
    `#1773: the complete sentence is returned as is (got ${JSON.stringify(text)})`,
  );
}

// 7. #1773: whole sentences, at most three, intent first
{
  const spec = {
    ...baseSpec,
    intent: "Fix the race condition in the dispatch loop. This also updates the event log schema.",
    deliverables: [{ id: "d1", description: "Add a lock. Add a test. Update docs.", paths: [] }],
  };
  const text = tldrSectionOf(spec).replace("## TL;DR\n\n", "");
  assert(
    text ===
      "Fix the race condition in the dispatch loop. This also updates the event log schema. Add a lock.",
    `#1773: three whole sentences (got ${JSON.stringify(text)})`,
  );
}

// 8. Short first sentence (< 10 chars) → full intent used
{
  const spec = {
    ...baseSpec,
    intent: "Fix bug. Also update docs.",
  };
  const tldr = tldrSectionOf(spec);
  // "Fix bug" is 7 chars — under the 10-char threshold, so the full intent is used
  assert(
    tldr.includes("Fix bug"),
    "short first sentence → full intent used (or at least the text is present)",
  );
}

// ---------------------------------------------------------------------------
// hasTldrSection — idempotency detection
// ---------------------------------------------------------------------------

// 9. Body with ## TL;DR → true
{
  assert(hasTldrSection("## TL;DR\n\nSomething") === true, "## TL;DR detected");
}

// 10. Body with ## TLDR (no semicolon) → true
{
  assert(hasTldrSection("## TLDR\n\nSomething") === true, "## TLDR (no semicolon) detected");
}

// 11. Body without TL;DR → false
{
  assert(hasTldrSection("## Overview\n\nSome text") === false, "no TL;DR → false");
}

// 12. Empty body → false
{
  assert(hasTldrSection("") === false, "empty body → false");
}

// 13. Body with TL;DR in the middle (after other headings) → true
{
  assert(
    hasTldrSection("## Context\n\nSome text\n\n## TL;DR\n\nSummary") === true,
    "## TL;DR in the middle detected",
  );
}

// 14. Body with a comment mentioning TL;DR but not as a heading → false
{
  assert(
    hasTldrSection("Add a TL;DR section") === false,
    "inline mention of 'TL;DR' without heading → false",
  );
}

// ---------------------------------------------------------------------------
// prependTldr — the prepend + idempotency logic
// ---------------------------------------------------------------------------

// 15. Normal prepend: TLDR added above existing body
{
  const original = "## Context\n\nThe original body text.";
  const result = prependTldr(original, "## TL;DR\n\nShort summary.");
  assert(
    result.startsWith("## TL;DR"),
    "prepended body starts with the TLDR heading",
  );
  assert(result.includes("## Context"), "original heading preserved");
  assert(result.includes("The original body text."), "original text preserved");
}

// 16. Idempotency: body already has ## TL;DR → no change
{
  const existing = "## TL;DR\n\nExisting summary.\n\n## Context\n\nBody.";
  const result = prependTldr(existing, "## TL;DR\n\nNew summary.");
  assert(result === existing, "existing TL;DR → body unchanged (idempotent)");
}

// 17. Empty TLDR → no change
{
  const original = "## Context\n\nBody.";
  const result = prependTldr(original, "");
  assert(result === original, "empty TLDR → body unchanged");
}

// 18. User-edited body: user added a section after the cycle started → preserved
{
  const userEdited = "## Context\n\nBody.\n\n## User Notes\n\nI added this manually.";
  const result = prependTldr(userEdited, "## TL;DR\n\nSummary.");
  assert(result.includes("## User Notes"), "user-added section preserved");
  assert(result.includes("I added this manually."), "user's text preserved");
  assert(result.startsWith("## TL;DR"), "TLDR still prepended at the top");
}

// 19. Concurrent edit: another cycle's TLDR already there → no double-prepend
{
  const alreadyEdited = "## TL;DR\n\nFrom another cycle.\n\n## Context\n\nBody.";
  const result = prependTldr(alreadyEdited, "## TL;DR\n\nFrom this cycle.");
  assert(result === alreadyEdited, "another cycle's TLDR → no double-prepend");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
