#!/usr/bin/env bun
/**
 * #1383 test helpers shared by the two halves of the dropped-section suite,
 * which is split across two files to respect the 500-line cap (AGENTS.md §12)
 * the fix itself had to respect. The pass/fail counter is shared so the pair
 * reports one verdict between them.
 */

import type { DroppedInvestigationItem } from "../src/plan-draft-conflicts.ts";
import { droppedSection } from "../src/plan-dropped-section.ts";

let failed = false;

/** Report the pair's verdict; each file calls this at its end. */
export function finish(): number {
  console.log(`\nexit ${failed ? 1 : 0}`);
  return failed ? 1 : 0;
}

export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    failed = true;
  }
}

/**
 * `n` fully-loaded dropped items — the worst case the renderer can be handed
 * (two 900-char deciding sources clipped to 160 each, plus a 1,200-char item
 * text). The observed 56,738-char section was ~170 of these. Built directly
 * rather than through `draftSpec`'s conflict stages, which re-partition any
 * candidate set handed to them — the render bound is what this pins, not the
 * drop decision (test-plan-operator-conflicts.ts owns that).
 */
export function droppedFixture(n: number): DroppedInvestigationItem[] {
  return Array.from({ length: n }, (_, i) => ({
    item: {
      kind: "edge-case",
      text: `${"s".repeat(1200)} item ${i} must never keep unbounded dropped disclosure`,
      angle: `a${i % 3}`,
    },
    against: "s".repeat(900),
    sibling: "s".repeat(900),
    reason: "settled",
  }));
}

/** The reported failure shape: a body whose bytes are almost all dropped items. */
export const DROPPED_DOMINATED_BODY = `${droppedSection(droppedFixture(120)).trimStart()}
## Acceptance criteria

- keep me

## Test surface

- keep me too

## Open Questions

- (none)
`;
