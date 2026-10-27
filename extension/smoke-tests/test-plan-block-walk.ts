#!/usr/bin/env bun
/**
 * #1855 round 3 — a DIRECT test for `walkBlock`, the one per-block walk.
 *
 * Every other parser pin in this suite runs `parseOperatorDirectivesWithLines`
 * or `draftSpec` and reads the CHANNELS, so a walk bug surfaced only as "the AC
 * section is empty" or "a bullet is missing from the inventory" — the assertion
 * was about the product, never about the walk's own three outputs. The two
 * copies of the block rules that drifted apart in rounds 1 and 2 each produced a
 * wrong `items`/`consumed`/`nextIndex` triple, and no test could name which one
 * was wrong.
 *
 * So this pins the triple directly, for each shape the walk has a rule about:
 * a fence-closed block, the `=`-wrapped fences the round-3 regression let
 * through, a blank run followed by bullets, a blank run followed by prose, a
 * following keyword heading, and the residual sitting on the heading line.
 *
 * The last section pins the property that made the drift possible in the first
 * place: the walk's `KEYWORD_LINE_RE` and the parser's `HEADING_RE` are built
 * from the same sources, so for every keyword they must agree on "is this line
 * a heading" — the walk's terminator and the parser's channel opener cannot
 * disagree about what a heading is.
 */

import {
  FENCE_RE,
  KEYWORD_LINE_RE,
  KEYWORD_PREFIX_SOURCE,
  KEYWORD_SOURCE,
  KEYWORD_TAIL_SOURCE,
  walkBlock,
} from "../src/plan-block-walk.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One case: context bytes, heading index/residual, and the expected triple. */
interface WalkCase {
  ctx: string;
  /** Index into the trimmed lines where the heading sits (always 0 here). */
  headingIndex?: number;
  /** The heading's colon residual, exactly as `HEADING_RE` group 2 hands it over. */
  residual: string;
  /** The caller's own heading fact: the heading closes its block on its line. */
  fenceClosed?: boolean;
  items: string[];
  consumed: number[];
  nextIndex: number;
  label: string;
}

/** Trim-and-split exactly as the parser does, so indices mean the same thing. */
const linesOf = (ctx: string): string[] => ctx.trim().split("\n");

function runCase(c: WalkCase): void {
  const lines = linesOf(c.ctx);
  const demotedBlanks: number[] = [];
  const w = walkBlock(lines, c.headingIndex ?? 0, c.residual, {
    fenceClosed: c.fenceClosed ?? false,
    demotedBlanks,
  });
  assert(
    w.items.join("\u0000") === c.items.join("\u0000"),
    `${c.label}: items are ${JSON.stringify(c.items)} (got ${JSON.stringify(w.items)})`,
  );
  assert(
    w.consumed.join(",") === c.consumed.join(","),
    `${c.label}: consumed is [${c.consumed}] (got [${w.consumed}])`,
  );
  // No line the walk did not visit may appear in the set — the #858 exclusion
  // depends on it, and a stray index would silently drop an operator line from
  // the filed inventory.
  assert(
    w.consumed.every((n: number) => n >= 0 && n < lines.length),
    `${c.label}: every consumed index is a real line (got [${w.consumed}] of ${lines.length})`,
  );
  assert(
    w.consumed[0] === (c.headingIndex ?? 0),
    `${c.label}: the heading line leads the consumed set`,
  );
  assert(
    w.consumed.every((n: number) => n >= (c.headingIndex ?? 0)),
    `${c.label}: no consumed index precedes the heading (got [${w.consumed}])`,
  );
  assert(
    w.nextIndex === c.nextIndex,
    `${c.label}: nextIndex is ${c.nextIndex} (got ${w.nextIndex})`,
  );
}

// ------------------------------------------------------- the walk's own shapes

const cases: WalkCase[] = [
  {
    label: "fence-closed block",
    // An END fence terminates the block and the walk resumes AFTER it; the
    // prose past the fence is not the block's, so it is neither item nor
    // consumed.
    ctx: "PITFALLS:\n- one\nEND\nnot an item",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2],
    nextIndex: 3,
  },
  {
    label: "BEGIN fence is a delimiter and does not close",
    ctx: "PITFALLS:\nBEGIN\n- one\nEND",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2, 3],
    nextIndex: 4,
  },
  {
    label: "=END= fence closes the block",
    // The round-3 regression: this landed as the block's FIRST item, so an
    // `ACCEPTANCE CRITERIA` block filed `- =END=` as a criterion.
    ctx: "PITFALLS:\n=END=\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "END= fence closes the block",
    ctx: "PITFALLS:\nEND=\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "END = fence closes the block",
    ctx: "PITFALLS:\nEND =\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "END== fence closes the block",
    ctx: "PITFALLS:\nEND==\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "==END== fence closes the block",
    ctx: "PITFALLS:\n==END==\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "BEGIN= fence is a delimiter and does not close",
    ctx: "PITFALLS:\nBEGIN=\n- one",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2],
    nextIndex: 3,
  },
  {
    label: "== BEGIN == fence is a delimiter and does not close",
    ctx: "PITFALLS:\n== BEGIN ==\n- one",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2],
    nextIndex: 3,
  },
  {
    label: "long decorative rule closes the ACCEPTANCE CRITERIA block",
    // The #1855 follow-up: main's fence had UNBOUNDED padding, so this decorative
    // rule was a fence there, while the {1,12} bound round 3 introduced turned it
    // into the block's only criterion.
    ctx: "ACCEPTANCE CRITERIA\n================ END ================\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "bullet-prefixed long decorative rule closes the block",
    ctx: "ACCEPTANCE CRITERIA\n- ================ END ================\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "blank run then bullets keeps the block open",
    // The blanks AND the bulleted line are consumed, and the bullet is an item:
    // the walk steps over the run rather than testing the blank itself.
    ctx: "PITFALLS:\n\n\n- one\n- two",
    residual: "",
    items: ["one", "two"],
    // The blank run's blanks and the bulleted line the lookahead inspected all
    // land in the set; the bullet is listed twice because the walk pushes the
    // lookahead it stepped to AND stepLine pushes it again on the next turn. As
    // a Set in the caller that is invisible, so it is pinned as-is rather than
    // quietly de-duplicated here.
    consumed: [0, 1, 2, 3, 3, 4],
    nextIndex: 5,
  },
  {
    label: "blank run then prose demotes the block",
    // Nothing past the run belongs to the block: the walk stops AT the blank it
    // inspected and yields no item. The blank itself is the caller's blank
    // branch's line (reported through `demotedBlanks`), not the walk's.
    ctx: "PITFALLS:\n\nthe following must hold",
    residual: "",
    items: [],
    consumed: [0],
    nextIndex: 1,
  },
  {
    label: "items collected before a demoting blank run are kept",
    ctx: "PITFALLS:\n- one\n\nprose after",
    residual: "",
    items: ["one"],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "a following keyword heading ends the block",
    // The keyword line is NOT a line of this block: not an item, not consumed,
    // and the caller resumes the main loop exactly there.
    ctx: "PITFALLS:\n- one\nNEVER CLAIM:\n- forbidden",
    residual: "",
    items: ["one"],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "a following keyword heading ends a block opened by a bullet run",
    ctx: "PITFALLS:\n- one\n\n- two\nOUT OF SCOPE:\n- later",
    residual: "",
    items: ["one", "two"],
    consumed: [0, 1, 2, 3, 3],
    nextIndex: 4,
  },
  {
    label: "residual on the heading line is the first item",
    ctx: "PITFALLS:",
    residual: "the retry path leaks",
    items: ["the retry path leaks"],
    consumed: [0],
    nextIndex: 1,
  },
  {
    label: "residual plus bullets: residual first, then the block's lines",
    ctx: "PITFALLS: the retry path leaks\n- one",
    residual: "the retry path leaks",
    items: ["the retry path leaks", "one"],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "a wrapper-only residual is not an item",
    ctx: "PITFALLS:",
    residual: "**",
    items: [],
    consumed: [0],
    nextIndex: 1,
  },
  {
    label: "a fence residual on the heading closes it on its own line",
    // The caller's `fenceClosed` fact: nothing under the heading is scanned.
    ctx: "PITFALLS: END\n- one",
    residual: "END",
    fenceClosed: true,
    items: [],
    consumed: [0],
    nextIndex: 1,
  },
  {
    label: "an unrecognised label closes the block and is not consumed",
    ctx: "PITFALLS:\n- one\nDecisions:\n- kept in the inventory",
    residual: "",
    items: ["one"],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "an END fence mid-block stops collection there",
    ctx: "PITFALLS:\n- one\nEND\n- two",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2],
    nextIndex: 3,
  },
  {
    label: "a bullet-prefixed ==END== fence closes the block",
    // The round-4 regression: main's fence class was `[-=\s]*`, so the bullet's
    // `-` opened an unbroken `-`/`=`/space run straight into the token and these
    // three lines WERE fences there. Narrowing the class to the heading wrapper
    // chars alone made them items again.
    ctx: "PITFALLS:\n- ==END==\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "a bullet-prefixed =END= fence closes the block",
    ctx: "PITFALLS:\n- =END=\n- one",
    residual: "",
    items: [],
    consumed: [0, 1],
    nextIndex: 2,
  },
  {
    label: "a bullet-prefixed == BEGIN == fence is a delimiter and does not close",
    ctx: "PITFALLS:\n- == BEGIN ==\n- one",
    residual: "",
    items: ["one"],
    consumed: [0, 1, 2],
    nextIndex: 3,
  },
  {
    label: "a bulleted keyword line opens the channel (pinned current behaviour)",
    // PINNED, not endorsed: `stepLine` tests the whole trimmed line against
    // `KEYWORD_LINE_RE`, whose wrapper class includes `-`, so `- ACCEPTANCE
    // CRITERIA` terminates the block above and the main loop then opens the
    // channel for it on that same line. The criterion below lands in it.
    ctx: "ACCEPTANCE CRITERIA\n- a criterion",
    residual: "",
    items: ["a criterion"],
    consumed: [0, 1],
    nextIndex: 2,
  },
];

for (const c of cases) runCase(c);

// The one blank the loop's blank branch keeps on a demotion is reported through
// the sink, and only on the demoting shape.
{
  const demoted: number[] = [];
  walkBlock(linesOf("PITFALLS:\n\nprose"), 0, "", { fenceClosed: false, demotedBlanks: demoted });
  assert(
    demoted.join(",") === "1",
    `a demoting blank run reports its first blank through demotedBlanks (got [${demoted}])`,
  );
  const kept: number[] = [];
  walkBlock(linesOf("PITFALLS:\n\n- one"), 0, "", { fenceClosed: false, demotedBlanks: kept });
  assert(
    kept.length === 0,
    `a blank run the list survives reports no demoted blank (got [${kept}])`,
  );
  const closed: number[] = [];
  walkBlock(linesOf("PITFALLS: END\n\nprose"), 0, "END", {
    fenceClosed: true,
    demotedBlanks: closed,
  });
  assert(
    closed.length === 0,
    "a heading that closed its own block never reaches the blank branch",
  );
}

// ------------------------------------------- one grammar for both heading tests

{
  // The parser's `HEADING_RE` and the walk's `KEYWORD_LINE_RE` are assembled
  // from the same exported sources, and only differ in that the parser captures
  // the keyword. One row per keyword pins that agreement: a keyword the walk
  // does not recognise as a terminator is a line the main loop would open a
  // block for and the walk would swallow as an item — the exact drift that made
  // the round-1 and round-2 walks wrong.
  const KEYWORDS = [
    "ACCEPTANCE CRITERIA",
    "PITFALLS",
    "EDGE CASES",
    "OUT OF SCOPE",
    "TEST SURFACE",
    "DECOMPOSITION/SUB-ISSUES",
    "DECOMPOSITION",
    "SUB-ISSUES",
    "NEVER CLAIM",
    "FORBIDDEN",
    "DONE WHEN",
    "ACCEPTANCE",
  ];
  // The parser's own regex, assembled exactly as `plan-directives.ts` assembles
  // it: the keyword as a CAPTURING group, then the shared tail. If either file
  // changes how it puts the pieces together, this is what says so.
  const HEADING_RE = new RegExp(
    `^${KEYWORD_PREFIX_SOURCE}${KEYWORD_SOURCE}${KEYWORD_TAIL_SOURCE}`,
    "i",
  );
  for (const kw of KEYWORDS) {
    for (const form of [kw, `${kw}:`, `${kw}: x`, `**${kw}:**`, `## ${kw}`, `${kw} END`]) {
      const walks = KEYWORD_LINE_RE.test(form);
      const heads = HEADING_RE.test(form);
      assert(
        walks === heads,
        `KEYWORD_LINE_RE and HEADING_RE agree on ${JSON.stringify(form)} (walk ${walks}, heading ${heads})`,
      );
    }
    // The bare keyword is a heading to BOTH — a terminator that only fires with
    // a colon would leave a `DONE WHEN` line as an item of the block above it.
    assert(KEYWORD_LINE_RE.test(kw), `${JSON.stringify(kw)} is a heading to the walk`);
  }
  // Prose that merely starts with a keyword is a heading to NEITHER: the walk
  // must keep it as an item and the loop must not open a block for it.
  for (const prose of [
    "Out of scope for this round was the migration",
    "Acceptance testing is manual here",
    "Never claim anything about latency",
  ]) {
    assert(
      !KEYWORD_LINE_RE.test(prose) && !HEADING_RE.test(prose),
      `keyword-shaped prose ${JSON.stringify(prose)} is not a heading to either grammar`,
    );
  }
  // Fence agreement: the walk's fence test is the parser's fence test, and the
  // `=`-wrapped forms are inside it.
  for (const fence of [
    "END=",
    "END =",
    "=END=",
    "END==",
    "==END==",
    "BEGIN=",
    "== BEGIN ==",
    // The three bullet-prefixed forms main fenced and round 3 filed as items.
    "- ==END==",
    "- =END=",
    "- == BEGIN ==",
    // The two long decorative rules main fenced and the {1,12} bound lost.
    "================ END ================",
    "- ================ END ================",
  ]) {
    assert(FENCE_RE.test(fence), `FENCE_RE matches the wrapper fence ${JSON.stringify(fence)}`);
  }
  for (const prose of ["END OF THE LINE", "ENDURANCE", "- a criterion", "none — no code"]) {
    assert(!FENCE_RE.test(prose), `FENCE_RE does not match the prose ${JSON.stringify(prose)}`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
