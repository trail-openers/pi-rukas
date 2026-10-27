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
import type { OperatorDirectives } from "../src/plan-directives.ts";
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
    // A demoted outcome heading consumes NOTHING — not even the blank it opens
    // with — because the loop's blank branch only accounts for a blank it stepped
    // over while a block was OPEN. A heading that never opened one leaves every
    // line, blanks included, to the filed inventory, exactly as an unrecognised
    // heading's lines do. (A TYPED heading that demotes the same way does keep
    // its blank; `PITFALLS:` below is that shape.)
    ["Done when:\n\nsome prose after", "some prose after", 0],
    ["Done when:\nDecisions:\n- a decision", "Done when:", 0],
    ["Done when:\nBEGIN\nEND", "Done when:", 0],
    // Fences only: every line is a delimiter, so no item exists.
    ["Done when:\nBEGIN\n\nEND", "Done when:", 0],
    // A fence residual or the `KEYWORD END` form closes the block on its own
    // heading line, so nothing under it is scanned.
    ["Done when: END\n- x\nEND", "Done when: END", 0],
    ["Done when END\n- x", "Done when END", 0],
    ["Done when:\nEND\n- x", "Done when:", 0],
    // #1855 review round 2 — an END fence matched the way the loop matches it:
    // `FENCE_RE` is UNANCHORED, so `-- END --` is a fence line too, closes the
    // block, and no bullet below it is an outcome. The superseded second copy
    // anchored its fence and walked straight past this one. (`--` is also a
    // bullet marker, so this row pins that the fence test runs first.)
    ["Done when:\n-- END --\n- x", "Done when:", 0],
    // A blank run followed by prose is the loop's own demotion: no item, and the
    // prose after the blank is not an outcome either.
    ["Done when:\n\nthe following must hold", "the following must hold", 0],
    // #1855 review round 3 — the seven wrapper-fence forms, pinned the way base
    // 27d950e0 read them. The shared walk's `FENCE_RE` had narrowed its padding
    // class to `[-=\s]*`, so these landed as operator items instead and the AC
    // channel filed `- END=` as a criterion. An `END` fence closes the block, so
    // the bullets under it are not an outcome; a `BEGIN` fence does NOT, so the
    // block stays open and the bullet IS the outcome (pinned separately below,
    // in both channels — the close/open decision is on the bare token alone).
    ["Done when:\nEND=\n- x", "Done when:", 0],
    ["Done when:\nEND =\n- x", "Done when:", 0],
    ["Done when:\n=END=\n- x", "Done when:", 0],
    ["Done when:\nEND==\n- x", "Done when:", 0],
    ["Done when:\n==END==\n- x", "Done when:", 0],
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
    // #1855 review round 2 — the shapes a SECOND copy of the block rules got
    // wrong while the loop got them right. Each is the loop's own rule,
    // restated: a blank run the walk steps PAST (never testing the blank itself
    // against), an END fence matched the way `FENCE_RE` matches it, and a
    // following typed heading that ENDS the block rather than being swallowed
    // as its item. Now that one `walkBlock` reads every block, these agree by
    // construction — and `test-plan-block-walk.ts` pins the same shapes on the
    // walk's own items/consumed/nextIndex triple.
    ["Done when:\n- the tool registers\nPITFALLS:\n- a pitfall", "following PITFALLS heading"],
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
  // #1855 review round 3 — the same seven wrapper fences, pinned on a TYPED
  // channel. A fence that is not a fence is worse than an invented outcome: it
  // becomes an ITEM of the operator's block, so `NEVER CLAIM` filed `- END=` as
  // a forbidden phrase and `ACCEPTANCE CRITERIA` filed it as the spec's only
  // acceptance criterion. Every form must be consumed as a delimiter and
  // contribute no item, and `END`-bearing forms must close the block so the
  // bullet below it is not typed either.
  const typedCases: [string, keyof OperatorDirectives, string][] = [
    ["ACCEPTANCE CRITERIA:\nEND=\n- a criterion", "acceptanceCriteria", "END="],
    ["ACCEPTANCE CRITERIA:\nEND =\n- a criterion", "acceptanceCriteria", "END ="],
    ["ACCEPTANCE CRITERIA:\n=END=\n- a criterion", "acceptanceCriteria", "=END="],
    ["ACCEPTANCE CRITERIA:\nEND==\n- a criterion", "acceptanceCriteria", "END=="],
    ["ACCEPTANCE CRITERIA:\n==END==\n- a criterion", "acceptanceCriteria", "==END=="],
    // A BEGIN-form fence does NOT close the block, so the bullet stays an item —
    // the item asserted below is the operator's, never the fence's text.
    ["ACCEPTANCE CRITERIA:\nBEGIN=\n- a criterion", "acceptanceCriteria", "BEGIN="],
    ["ACCEPTANCE CRITERIA:\n== BEGIN ==\n- a criterion", "acceptanceCriteria", "== BEGIN =="],
    // The round-4 regression: main's fence class was `[-=\s]*`, so the bullet's
    // `-` ran straight into the `=`/`#`/space wrapper and these three lines WERE
    // fences there. Narrowing the padding to `WRAPPER_CHARS` alone made them
    // items again — `- ==END==` filed as an acceptance criterion.
    ["ACCEPTANCE CRITERIA:\n- a\n- ==END==\n- b", "acceptanceCriteria", "- ==END=="],
    ["ACCEPTANCE CRITERIA:\n- a\n- =END=\n- b", "acceptanceCriteria", "- =END="],
    ["ACCEPTANCE CRITERIA:\n- == BEGIN ==\n- a criterion", "acceptanceCriteria", "- == BEGIN =="],
    ["NEVER CLAIM:\nEND=\n- a phrase", "neverClaim", "END="],
    ["NEVER CLAIM:\nEND =\n- a phrase", "neverClaim", "END ="],
    ["NEVER CLAIM:\n=END=\n- a phrase", "neverClaim", "=END="],
    ["NEVER CLAIM:\nEND==\n- a phrase", "neverClaim", "END=="],
    ["NEVER CLAIM:\n==END==\n- a phrase", "neverClaim", "==END=="],
    ["NEVER CLAIM:\nBEGIN=\n- a phrase", "neverClaim", "BEGIN="],
    ["NEVER CLAIM:\n== BEGIN ==\n- a phrase", "neverClaim", "== BEGIN =="],
    ["NEVER CLAIM:\n- a phrase\n- ==END==\n- b", "neverClaim", "- ==END=="],
    ["NEVER CLAIM:\n- a phrase\n- =END=\n- b", "neverClaim", "- =END="],
    ["NEVER CLAIM:\n- == BEGIN ==\n- a phrase", "neverClaim", "- == BEGIN =="],
  ];
  for (const [ctx, channel, fence] of typedCases) {
    const { directives } = parseOperatorDirectivesWithLines(ctx);
    const items = directives[channel] as string[];
    const wanted = channel === "neverClaim" ? "a phrase" : "a criterion";
    // The AC rows with a bullet-prefixed BEGIN fence hold one operator line, so
    // the expectation differs per shape rather than per channel: an END form
    // closes the block before the bullet, so the channel is empty, and a BEGIN
    // form leaves it open, so the channel holds exactly the operator's line. A
    // BULLETED fence keeps the bullets above it, which is what main did and what
    // these rows pin. Either way the fence text is never an item — and the bullet-prefixed rows
    // below are the round-4 regression: main fenced them, and the class narrowed
    // to `WRAPPER_CHARS` alone filed `- ==END==` as an acceptance criterion.
    const expected = fence.startsWith("- ")
      ? fence.includes("BEGIN")
        ? [wanted]
        : wanted === "a phrase"
          ? ["a phrase"]
          : ["a"]
      : fence.includes("END")
        ? []
        : [wanted];
    assert(
      items.join("\u0000") === expected.join("\u0000"),
      `wrapper fence ${JSON.stringify(fence)} on a typed block yields ${JSON.stringify(expected)} (got ${JSON.stringify(items)})`,
    );
    assert(
      !items.some((i) => /^\s*[#=*`-]*\s*(BEGIN|END)\s*[#=*`-]*\s*$/i.test(i)),
      `wrapper fence ${JSON.stringify(fence)} never reaches the ${channel} channel as an item`,
    );
  }
}

{
  // #1855 review round 3 — `BEGIN=` OPENS nothing on its own line: the block
  // stays open under a BEGIN-form fence (it is only an `END` that closes), so
  // the bullets under it are still the block's items. The `END` forms above
  // close; these two do not, which is the close/open decision the shared walk
  // makes on the BARE token rather than on the wrapper chars around it.
  for (const fence of ["BEGIN=", "== BEGIN =="]) {
    const { directives } = parseOperatorDirectivesWithLines(
      `ACCEPTANCE CRITERIA:\n${fence}\n- a criterion`,
    );
    assert(
      directives.acceptanceCriteria.length === 1 &&
        directives.acceptanceCriteria[0] === "a criterion",
      `BEGIN-form wrapper fence ${JSON.stringify(fence)} leaves the block open, so the bullet is an item`,
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
