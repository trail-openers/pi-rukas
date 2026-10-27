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
    directives.operatorOutcomes.length === 2 &&
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
      directives.operatorOutcomes.length === 1 &&
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
      directives.operatorOutcomes.length === 0,
    "ACCEPTANCE CRITERIA keeps the directive channel (unchanged path, AC-4)",
  );
}

{
  // A heading whose block holds NO ITEM AT ALL is no outcome (PM decision 2,
  // sharpened in review round 1): the channel stays empty and the heading is
  // left unconsumed, so the inventory keeps it. A lead-in line, a blank line or
  // a fence token BEFORE real bullets does not void the block — those cases are
  // pinned below.
  // #1855 review round 1: a `Done when:` heading whose block holds only prose is
  // a block whose items happen to be unbulleted — exactly what every OTHER typed
  // block accepts (`PITFALLS:` followed by plain lines is items, not a lead-in),
  // and the parser's own loop produces those lines. So that IS an outcome; what
  // closes a block is a `label:` line or an `END`/`BEGIN` fence, never the shape
  // of the first line. `inventoryLine` is the line the filed inventory is
  // expected to still carry, and `consumed` how many lines the parser took as
  // typed-block lines (0 for a heading that never opened a block; 1 for a heading
  // it consumed and then demoted at a blank line — the loop's own behaviour).
  const emptyCases: [string, string, number][] = [
    ["Done when:", "Done when:", 0],
    ["Done when:\n\nsome prose after", "some prose after", 1],
    ["Done when:\nDecisions:\n- a decision", "Done when:", 0],
    ["Done when:\nBEGIN\nEND", "Done when:", 0],
    // Fences only: every line is a delimiter, so no item exists.
    ["Done when:\nBEGIN\n\nEND", "Done when:", 0],
    // A fence residual or the `KEYWORD END` form closes the block on its own
    // heading line, so nothing under it is scanned.
    ["Done when: END\n- x\nEND", "Done when: END", 0],
    ["Done when END\n- x", "Done when END", 0],
    ["Done when:\nEND\n- x", "Done when:", 0],
    // A blank run followed by prose is the loop's own demotion: no item, and the
    // prose after the blank is not an outcome either.
    ["Done when:\n\nthe following must hold", "the following must hold", 1],
  ];
  for (const [ctx, inventoryLine, consumed] of emptyCases) {
    const { directives, consumedLines } = parseOperatorDirectivesWithLines(ctx);
    assert(
      directives.operatorOutcomes.length === 0 && consumedLines.length === consumed,
      `empty outcome block ${JSON.stringify(ctx)}: no outcome (${consumed} line(s) consumed)`,
    );
    const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
    assert(
      inventoryContext.some((e) => e.fact === inventoryLine),
      `empty outcome block ${JSON.stringify(ctx)}: ${JSON.stringify(inventoryLine)} stays in the inventory`,
    );
  }
}

{
  // #1855 review round 1 — the shapes the first-meaningful-line lookahead got
  // WRONG. Each has an item somewhere in its block, so each IS an outcome, and
  // the parser's own item loop would have produced the bullet anyway: the
  // lookahead must agree with what the parser does, not with what the line right
  // below the heading looks like.
  const cases: [string, string][] = [
    // A prose lead-in before the bullets.
    ["Done when: the following must hold\n- the tool registers", "lead-in line"],
    // A blank line (even a run of them) before the bullets.
    ["Done when:\n\n- the tool registers", "blank line"],
    // A BEGIN fence token before the bullets.
    ["Done when:\nBEGIN\n- the tool registers\nEND", "BEGIN fence"],
    // Prose-only block: unbulleted contiguous lines are items for every typed
    // block, so they are the outcome here too.
    ["Done when:\nthe following must hold\n- the tool registers", "prose items"],
  ];
  for (const [ctx, label] of cases) {
    const { directives, consumedLines } = parseOperatorDirectivesWithLines(ctx);
    const items = directives.operatorOutcomes;
    assert(
      items.length > 0 && items[items.length - 1] === "the tool registers",
      `outcome block with a ${label} before the bullets yields the outcome (got ${JSON.stringify(items)})`,
    );
    assert(
      consumedLines.length > 1,
      `outcome block with a ${label}: the heading and the item are consumed (#858)`,
    );
    const { inventoryContext } = assemblePriorContext(ctx, EMPTY_INV);
    assert(
      !inventoryContext.some((e) => e.fact === "- the tool registers"),
      `outcome block with a ${label}: the bullet is not double-listed in the inventory`,
    );
  }
}

{
  // The troubleshooting doc advertises bare `Acceptance criteria:` (as an
  // English heading, not the typed directive) as an outcome alias. The parser
  // has always routed that exact keyword to the DIRECTIVE channel — see
  // `channelFor` and the note on `parseOperatorDirectives` — so the assertion
  // below is that it still fills an Acceptance-criteria source, whichever
  // channel it lands in. If the two docs and the code ever disagree, this is
  // the row that says so.
  const { directives } = parseOperatorDirectivesWithLines("ACCEPTANCE\n- the tool registers");
  assert(
    directives.operatorOutcomes.length === 1 &&
      directives.operatorOutcomes[0] === "the tool registers",
    "bare ACCEPTANCE (no colon) opens the outcome channel, as the troubleshooting doc claims",
  );
  const spelled = parseOperatorDirectivesWithLines("Acceptance criteria:\n- the tool registers");
  assert(
    spelled.directives.acceptanceCriteria.length === 1 &&
      spelled.directives.operatorOutcomes.length === 0,
    "`Acceptance criteria:` keeps the DIRECTIVE channel (the doc's alias claim is by that route)",
  );
}

{
  // A prose lead-in after the colon counts as the block's one item (the same
  // colon-residual grammar every other typed block has).
  const { directives, consumedLines } = parseOperatorDirectivesWithLines(
    "Done when: the tool registers on start",
  );
  assert(
    directives.operatorOutcomes.length === 1 &&
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
    directives.operatorOutcomes.length === 1,
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
