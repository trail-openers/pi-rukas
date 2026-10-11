#!/usr/bin/env bun
/**
 * plan-directives retention (#1087, task-a parser leg).
 *
 * Pins three parser behaviours:
 * - bullets under an UNRECOGNISED heading (e.g. `Decisions:`) are not
 *   consumed, so the filed-body inventory keeps them verbatim;
 * - an unrecognised bare label closes an open typed block instead of being
 *   absorbed as one of its items;
 * - the advertised `DECOMPOSITION/SUB-ISSUES` and `DECOMPOSITION / SUB-ISSUES`
 *   headings open the decomposition channel.
 */

import { parseOperatorDirectivesWithLines } from "../src/plan-directives.ts";
import { assemblePriorContext } from "../src/plan-prior-context-assembly.ts";
import type { MechanicalInventory } from "../src/plan-inventory.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const EMPTY_INV: MechanicalInventory = { memory: [], related: [], errors: [] };

{
  const ctx = "Decisions:\n- use the retry seam\n- keep the old flag";
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(ctx);
  assert(consumedLines.length === 0, "unrecognised heading: no line is consumed");
  assert(directives.acceptanceCriteria.length === 0, "unrecognised heading: no AC item invented");
  const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
  const facts = inventoryContext.map((e) => e.fact);
  assert(facts.includes("Decisions:"), "unrecognised heading: heading line kept in inventory");
  assert(facts.includes("- use the retry seam"), "unrecognised heading: first bullet kept in inventory");
  assert(facts.includes("- keep the old flag"), "unrecognised heading: second bullet kept in inventory");
}

{
  const ctx = "ACCEPTANCE CRITERIA:\n- a criterion\nDecisions:\n- b decision";
  const { directives } = parseOperatorDirectivesWithLines(ctx);
  assert(
    directives.acceptanceCriteria.length === 1 && directives.acceptanceCriteria[0] === "a criterion",
    "unrecognised label closes the open AC block (no `Decisions:` item)",
  );
  const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
  const facts = inventoryContext.map((e) => e.fact);
  assert(facts.includes("- b decision"), "unrecognised label: its bullet survives in inventory");
}

{
  const { directives } = parseOperatorDirectivesWithLines(
    "ACCEPTANCE CRITERIA:\nThe following must hold:\n- x",
  );
  assert(
    directives.acceptanceCriteria.includes("The following must hold:"),
    "longer prose ending in a colon still reads as an AC item",
  );
}

for (const heading of ["DECOMPOSITION/SUB-ISSUES:", "DECOMPOSITION / SUB-ISSUES:"]) {
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(
    `${heading}\n- split by surface\n- one sub-issue per module`,
  );
  assert(
    directives.decomposition?.length === 2 && directives.decomposition[0] === "split by surface",
    `slash heading ${JSON.stringify(heading)} populates the decomposition channel`,
  );
  assert(consumedLines.length === 3, `slash heading ${JSON.stringify(heading)}: heading and items consumed`);
}

{
  const { directives } = parseOperatorDirectivesWithLines(
    "TEST SURFACE:\nBEGIN\n- case one\nEND\n\nprose after",
  );
  assert(
    directives.testSurface?.length === 1 && directives.testSurface[0] === "case one",
    "TEST SURFACE BEGIN/END fence grammar unaffected",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
