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
 *   headings open the decomposition channel;
 * - #1855: an operator OUTCOME heading (`Done when` / `Acceptance` /
 *   `Acceptance criteria` without the directive form) consumes its heading and
 *   bullets into `operatorOutcomes`, while a heading that yields no item is
 *   treated as no outcome at all and stays in the inventory.
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

// ------------------------------------------------- #1855 operator outcomes

{
  // The golden fixture: the exact bytes the field reports copied from operator
  // context, as the ONLY outcome statement in the context param.
  const ctx = "Done when:\n- the tool registers\n- dryRun never files";
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(ctx);
  assert(
    directives.operatorOutcomes?.length === 2 &&
      directives.operatorOutcomes[0] === "the tool registers" &&
      directives.operatorOutcomes[1] === "dryRun never files",
    "outcome heading: bullets populate the operatorOutcomes channel verbatim",
  );
  assert(
    directives.acceptanceCriteria.length === 0,
    "outcome heading: the directive channel is NOT what an outcome block fills",
  );
  assert(
    consumedLines.join(",") === "0,1,2",
    `outcome heading: heading and both bullets are consumed (got ${consumedLines.join(",")})`,
  );
  const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
  assert(
    inventoryContext.length === 0,
    "outcome heading: consumed lines leave the filed inventory (#858)",
  );
}

{
  // The issue names three aliases; the FOURTH is the directive grammar itself
  // written in prose ("Acceptance criteria:" as an English heading, not a
  // typed directive). That form has always routed to the directive channel and
  // AC-4 requires the directive path be unchanged, so it stays there — which
  // is also why the two forms cannot be distinguished by their bullets.
  for (const heading of ["Acceptance:", "DONE WHEN", "Done when:", "DONE-WHEN"]) {
    const { directives } = parseOperatorDirectivesWithLines(`${heading}\n- the tool registers`);
    assert(
      directives.operatorOutcomes?.length === 1 &&
        directives.operatorOutcomes[0] === "the tool registers",
      `outcome alias ${JSON.stringify(heading)} opens the outcome channel`,
    );
  }
}

{
  // The directive form still routes to the directive channel, not the outcome one.
  const { directives } = parseOperatorDirectivesWithLines(
    "ACCEPTANCE CRITERIA:\n- the tool registers",
  );
  assert(
    directives.acceptanceCriteria.length === 1 &&
      (directives.operatorOutcomes?.length ?? 0) === 0,
    "ACCEPTANCE CRITERIA keeps the directive channel (unchanged path, AC-4)",
  );
}

{
  // A heading with NO item after it is no outcome at all: the channel stays
  // empty and the heading is left unconsumed, so the inventory keeps it.
  for (const ctx of [
    "Done when:",
    "Done when:\n\nsome prose after",
    "Done when:\nDecisions:\n- a decision",
    "Done when:\nBEGIN\nEND",
  ]) {
    const { directives, consumedLines } = parseOperatorDirectivesWithLines(ctx);
    assert(
      (directives.operatorOutcomes?.length ?? 0) === 0 && consumedLines.length === 0,
      `empty outcome block ${JSON.stringify(ctx)}: no item, nothing consumed`,
    );
    const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
    assert(
      inventoryContext.some((e) => e.fact === "Done when:"),
      `empty outcome block ${JSON.stringify(ctx)}: the heading stays in the inventory`,
    );
  }
}

{
  // A prose lead-in after the colon counts as the block's one item (the same
  // colon-residual grammar every other typed block has).
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(
    "Done when: the tool registers on start",
  );
  assert(
    directives.operatorOutcomes?.length === 1 &&
      directives.operatorOutcomes[0] === "the tool registers on start",
    "outcome heading: colon residual reads as the first item",
  );
  assert(consumedLines.length === 1, "outcome heading: the residual line is consumed");
}

{
  // An outcome block does not swallow an adjacent unrecognised block.
  const ctx = "Done when:\n- the tool registers\nDecisions:\n- keep the old flag";
  const { directives } = parseOperatorDirectivesWithLines(ctx);
  assert(
    directives.operatorOutcomes?.length === 1,
    "outcome block: an unrecognised label closes it",
  );
  const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
  assert(
    inventoryContext.some((e) => e.fact === "- keep the old flag"),
    "outcome block: the following unrecognised block stays in the inventory",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
