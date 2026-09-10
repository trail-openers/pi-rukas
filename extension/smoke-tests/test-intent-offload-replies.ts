#!/usr/bin/env bun
/**
 * #682 — the offloaded-spec reply shape, tested against the actual fixture.
 *
 * A live `/work 674` cycle produced an explore reply where the resolver
 * offloaded the full spec to a scratch file and kept only a summary plus
 * a fenced `INTENT-VERDICT: proceed-with-assumptions` token inline. The
 * reply has NO `## Spec` heading, so `parseNormalisedSpec` returns `undefined`
 * before the present, valid INTENT-VERDICT token is even consulted. The
 * driver then fired `cap-hit: explore-needs-clarification` — a false park.
 *
 * This is the FIXTURE HALF of #682. The fix (task-a) adds an offload
 * fallback to the intent-parse seam: when the reply has a parseable
 * INTENT-VERDICT, no `## Spec` heading, and a cited path under the
 * cycle's scratch dir, read that file and parse the `## Spec` block
 * from ITS content.
 *
 * This test asserts two things:
 *   1. The 674.txt fixture is still the raw reply (anti-vacuity).
 *   2. The 674-report.md fixture — the file the resolver offloaded to —
 *      recovers a complete NormalisedSpec via `parseNormalisedSpec` +
 *      `reconcileVerdict`, with exactly the field counts the live reply
 *      promised (6 deliverables, 6 acceptance criteria, 14 confirmed
 *      evidence rows). If task-a's offload fallback feeds this file
 *      through the same two functions, the driver gets the correct spec
 *      and no false park.
 *
 * The offload path must be content-equivalent to the inline path: the
 * spec parsed from the file must be the same object that `reconcileVerdict`
 * would produce for an inline spec of the same content. No weaker parse,
 * no second channel.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNormalisedSpec,
  reconcileVerdict,
  specIsActionable,
} from "../src/work-driver-intent.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPLY = path.join(__dirname, "fixtures", "explore-replies", "674.txt");
const REPORT = path.join(__dirname, "fixtures", "explore-replies", "674-report.md");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const reply = readFileSync(REPLY, "utf8");
const report = readFileSync(REPORT, "utf8");

// ---------------------------------------------------------------------------
// Anti-vacuity: the fixtures must still be the raw things
// ---------------------------------------------------------------------------

assert(
  reply.includes("INTENT-VERDICT: proceed-with-assumptions"),
  "674.txt: has a fenced INTENT-VERDICT: proceed-with-assumptions (the verdict the resolver actually made)",
);
assert(
  !/^##\s+Spec\s*$/m.test(reply),
  "674.txt: has NO `## Spec` heading — this is what broke; the resolver offloaded it to a file",
);
assert(
  /scratch.*(?:tmp|\.pi\/work-state)\//.test(reply) || /saved to scratch/.test(reply),
  "674.txt: cites a scratch-dir file path (the offload citation the fallback must read)",
);
assert(
  report.includes("## Spec"),
  "674-report.md: contains a `## Spec` heading (the spec the resolver wrote to the offload file)",
);

// ---------------------------------------------------------------------------
// The reply itself: no inline spec, so parseNormalisedSpec returns undefined
// ---------------------------------------------------------------------------

{
  const parsed = parseNormalisedSpec(reply);
  assert(
    parsed === undefined,
    "parseNormalisedSpec(674.txt) === undefined — no `## Spec` heading inline, so the current parse returns undefined (the bug)",
  );
}

// ---------------------------------------------------------------------------
// The offloaded file: parseNormalisedSpec must recover a complete spec
// ---------------------------------------------------------------------------

{
  const parsed = parseNormalisedSpec(report);
  assert(
    parsed !== undefined,
    "parseNormalisedSpec(674-report.md) !== undefined — the offloaded file parses",
  );

  if (parsed) {
    // --- field counts promised by the reply's summary block ---
    assert(
      parsed.deliverables.length === 6,
      `6 deliverables parsed (got ${parsed.deliverables.length})`,
    );
    assert(
      parsed.acceptanceCriteria.length === 6,
      `6 acceptance criteria parsed (got ${parsed.acceptanceCriteria.length})`,
    );
    assert(
      parsed.evidence.length === 14,
      `14 evidence rows parsed (got ${parsed.evidence.length})`,
    );

    // --- all 14 evidence rows are confirmed ---
    assert(
      parsed.evidence.every((e) => e.verdict === "confirmed"),
      "all 14 evidence rows parse as confirmed (no downgrades)",
    );

    // --- the intent is non-empty and grounded ---
    assert(
      parsed.intent.trim().length > 0,
      "intent is non-empty",
    );
    assert(
      /handoff|worktree|consolidat|retry/i.test(parsed.intent),
      "intent is about the handoff/worktree/consolidation topic (not empty or garbage)",
    );

    // --- the offloaded spec is actionable ---
    assert(
      specIsActionable(parsed),
      "specIsActionable: intent + at least one deliverable with a description",
    );
  }

  // --- reconcileVerdict: the offloaded file's verdict must survive ---
  const resolved = parsed ? reconcileVerdict(parsed) : undefined;
  assert(
    resolved?.verdict === "proceed-with-assumptions",
    `reconcileVerdict resolves to proceed-with-assumptions (got ${resolved?.verdict})`,
  );
  assert(
    resolved?.parkReason === undefined,
    "no parkReason on a proceed verdict — the false park is gone",
  );

  // --- assumptions from the offloaded file survive reconciliation ---
  if (resolved) {
    assert(
      resolved.assumptions.length >= 5,
      `≥5 assumptions from the offloaded file (got ${resolved.assumptions.length})`,
    );
    // The offloaded file has 5 assumptions + possibly the override assumption.
    // A proceed-with-assumptions with a complete spec does NOT add the override
    // (that only fires on an explicit `park` + `underspecified` + complete spec),
    // so we expect exactly 5.
    assert(
      resolved.assumptions.length === 5,
      `exactly 5 assumptions (the offloaded file's own, no synthetic override) (got ${resolved.assumptions.length})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Edge case: a file with no `## Spec` heading falls through to no-signal
// ---------------------------------------------------------------------------

{
  const noSpecFile = "INTENT-VERDICT: proceed-with-assumptions\n\nSome prose with no ## Spec block at all.\n";
  const parsed = parseNormalisedSpec(noSpecFile);
  assert(
    parsed === undefined,
    "a file with no `## Spec` heading → undefined (the fallback must not manufacture a spec from prose)",
  );
}

// ---------------------------------------------------------------------------
// Edge case: path outside the scratch dir is ignored (no read attempted)
// ---------------------------------------------------------------------------

// This is a content test: parseNormalisedSpec doesn't read files, so we
// verify the caller (task-a's offload fallback) would reject the path before
// calling parseNormalisedSpec. The fixture 674.txt itself cites a valid
// scratch path; the test for path rejection is task-a's responsibility
// (unit-level test in test-intent-resolution.ts). We pin here that the
// offloaded file parses correctly so the integration is sound.

console.log(`\nexit ${exit}`);
process.exit(exit);
