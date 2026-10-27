/**
 * plan-block-walk — the ONE per-block walk the operator-directive parser runs.
 *
 * #1855: the parser used to keep TWO copies of the block rules — the main loop's
 * body and a hand-written lookahead that decided whether an OUTCOME heading
 * counted as an outcome. They disagreed on sight: the lookahead's blank-run rule
 * tested the wrong line and was always false where it was read, it anchored its
 * END fence where the loop matches the unanchored `FENCE_RE`, and it kept
 * walking past a following typed heading. So the rules moved here, and the loop
 * and the outcome decision are now both callers of `walkBlock` — there is no
 * second copy to drift.
 *
 * What lives here is the block's grammar: `stepLine` (one line under an open
 * heading) and `walkBlock` (the run of them, which is also the only question the
 * outcome gate asks — does this block yield an item at all?). The
 * heading's own facts — whether it closes its block, whether its colon residual
 * is an item, which channel it opens — stay with the caller that matches
 * `HEADING_RE`, and so does the loop's blank-line accounting, which is the
 * parser's #858 exclusion contract, not a property of a block.
 */

/** The wrapper/padding chars a heading or fence line may wear on either side. */
export const WRAPPER_CHARS = "[#=*`-]";

/**
 * A bare fence line inside an open block: END terminates, BEGIN is skipped.
 *
 * The padding class is `WRAPPER_CHARS` — the same set `HEADING_RE` allows on
 * either side of its keyword — so a line cannot be a fence to one grammar and
 * an item to the other. #1855 round 3: a narrower class (`[-=\s]*`) dropped the
 * `#`, `*` and backtick wrappers and required the run to touch the token, so
 * `END=`, `END =`, `=END=`, `END==`, `==END==`, `BEGIN=` and `== BEGIN ==` fell
 * through as operator ITEMS: an `END=` fence landed in the AC / NEVER CLAIM
 * channels and a spec could file with `- END=` as its only criterion.
 *
 * The token sits UNANCHORED inside that padding, so `-- END --` and
 * `*** END ***` are fences while `END OF THE LINE` and `ENDURANCE` stay prose.
 * Whether the line CLOSES the block is decided on the bare token by
 * `isEndFence`, never by which side carries the wrapper chars.
 *
 * `#`/`*`/backtick/`-` alone is not enough: main's fence class was `[-=\s]*`, so
 * `- ==END==`, `- =END=` and `- == BEGIN ==` were fences there, and a class that
 * stopped at `WRAPPER_CHARS` re-filed them as operator ITEMS — the same bug, one
 * character class over. So the padding is ONE UNBOUNDED run per side over the
 * union of the two sets (`WRAPPER_CHARS` plus main's `=` and `_`) and whitespace,
 * with no adjacent `\s*` groups: one run per side is linear matching, and bound
 * the run instead of unbounding it and a long decorative rule like
 * `================ END ================` stops being a fence, which is exactly
 * the regression this closes. Each side's run sits in ONE group so no alternative
 * can escape its own side of the token, and every run stays on the whitespace-and-
 * punctuation alphabet: a run may not contain a letter, so `END OF THE LINE`,
 * `ENDURANCE` and `- the END` stay items, while every line either grammar ever
 * fenced stays a fence.
 */
const FENCE_PADDING = `[=_${WRAPPER_CHARS.slice(1, -1)}\\s]*`;

export const FENCE_RE = new RegExp(`^${FENCE_PADDING}(?:BEGIN|END)${FENCE_PADDING}$`, "i");

/** True when a fence line CLOSES its block: the bare token is END. */
export function isEndFence(line: string): boolean {
  return /END/i.test(line);
}

/** Bullet-list continuation marker (also keeps spaced lists open across blanks). */
export const BULLET_RE = /^(?:[-*]+|\d+[.)])\s+/;

/**
 * A bare `Label:` line (1-3 capitalised words, nothing after the colon) that
 * is NOT a recognised keyword. Inside an open block it closes the block: an
 * unrecognised heading such as `Decisions:` must not be absorbed as an item
 * of the adjacent typed section. Longer prose lines ending in a colon ("The
 * following must hold:") still read as items.
 */
export const LABEL_RE = /^[A-Z][A-Za-z/-]*(?: [A-Za-z/-]+){0,2}:$/;

/**
 * The keyword test the walk uses for ONE purpose: a keyword line ENDS the block
 * it sits in, because the parser opens a new block for it rather than reading it
 * as an item. Exported so the parser and the walk can never hold two copies of
 * "what is a heading" — the parser matches it for the channel, the walk matches
 * it for the terminator. Built from the same three sources `HEADING_RE` is
 * built from, so "what is a heading" has exactly one definition.
 */
export const KEYWORD_PREFIX_SOURCE = `(?:${WRAPPER_CHARS}+\\s*)?`;

/**
 * The keyword alternation, in the order both grammars must try it
 * (`ACCEPTANCE[\s-]*CRITERIA` ahead of bare `ACCEPTANCE`, so the directive form
 * keeps matching its own heading). Written as a CAPTURING group: the parser's
 * `HEADING_RE` uses it verbatim and needs group 1 for `channelFor`; the walk's
 * `KEYWORD_LINE_RE` wraps it in a non-capturing group and reads no group at all.
 */
export const KEYWORD_SOURCE =
  "(ACCEPTANCE[\\s-]*CRITERIA|PITFALLS|EDGE[\\s-]*CASES|OUT[\\s-]*OF[\\s-]*SCOPE|TEST[\\s-]*SURFACE|DECOMPOSITION\\s*\\/\\s*SUB[\\s-]*ISSUES?|DECOMPOSITION|SUB[\\s-]*ISSUES?|NEVER[\\s-]*CLAIM|FORBIDDEN|DONE[\\s-]*WHEN|ACCEPTANCE)";

/**
 * What a keyword must be followed by to be a heading at all: a colon (with an
 * optional residual first item), a bare BEGIN/END fence token, closing wrapper
 * chars, or end of line. Without it a keyword that runs into ordinary prose
 * ("Out of scope for this round was…") is not a heading. Both grammars add a
 * capturing keyword group in front of this one, so the residual is group 2 and
 * the fence token group 3 (`KEYWORD_LINE_RE` matches for the terminator only and
 * never reads a group).
 */
export const KEYWORD_TAIL_SOURCE =
  "(?:\\s*\\([^)]*\\))?\\s*(?:(?:[#=*`]+)?\\s*[:：]\\s*(.*)$|(BEGIN|END)\\s*(?:[#=*`]+\\s*)?$|[#=*`]*\\s*$)";

export const KEYWORD_LINE_RE = new RegExp(
  `^${KEYWORD_PREFIX_SOURCE}(?:${KEYWORD_SOURCE})${KEYWORD_TAIL_SOURCE}`,
  "i",
);

/** What one block's walk decided: the lines it took and the items it read. */
export interface BlockWalk {
  /** Lines to mark consumed (the heading only when the caller consumed it). */
  consumed: number[];
  /** The items in source order, bullet markers stripped. */
  items: string[];
  /** Index where the loop resumes. */
  nextIndex: number;
}

/** What one line under an open block decided, in the loop's own terms. */
interface StepVerdict {
  /** Lines to mark consumed; `nextIndex` is where the loop resumes. */
  consumed: number[];
  nextIndex: number;
  /** The item this line yields, bullet-stripped, or none. */
  item: string | undefined;
  /** True when the block is over and the loop must clear its open target. */
  closed: boolean;
}

/**
 * True for a line that reads as an item once its bullet marker is gone: empty
 * text is not, and neither are pure wrapper chars (`**`) or a bare fence token,
 * which are delimiters rather than content.
 */
function itemCandidate(text: string): boolean {
  return !!text && !/^[#=*`]+$/.test(text) && !/^BEGIN$/i.test(text) && !/^END$/i.test(text);
}

/**
 * THE per-block rule for one line (#1855). Everything the parser does with a
 * line that sits under an open heading lives here: the main loop's body for a
 * non-blank line is this function's verdict applied verbatim, and the outcome
 * decision is the same function run over the block — so "is there an item?"
 * cannot drift from "does this line make an item?".
 *
 * A `LABEL_RE` line (`Decisions:`) is an unrecognised heading: it closes the
 * block and is NOT consumed. A line matching `FENCE_RE` is consumed as a
 * delimiter and an `END` one closes the block (matching the loop's in-block
 * fence branch exactly — `FENCE_RE` then `isEndFence` on the same line). Any
 * other line is an item when `itemCandidate` accepts it after bullet-stripping;
 * unbulleted contiguous lines are items for every typed block, so they are
 * items here too.
 *
 * The blanks a blank-run lookahead stepped over are consumed by `walkBlock`,
 * matching the loop (its blank branch consumes the lookahead line); the heading
 * of a block that never opened is not — the caller decides that, so an unopened
 * outcome heading still appears in the filed inventory.
 */
function stepLine(lines: string[], index: number): StepVerdict {
  const line = (lines[index] ?? "").trim();
  if (LABEL_RE.test(line)) {
    return { consumed: [], nextIndex: index, item: undefined, closed: true };
  }
  const consumed = [index];
  if (FENCE_RE.test(line)) {
    return { consumed, nextIndex: index + 1, item: undefined, closed: isEndFence(line) };
  }
  // A prose line under an open block is an item — every typed block takes
  // contiguous unbulleted lines, so it is an item here too. A line that follows
  // a blank run is read here as well: `walkBlock` steps over the run and lands
  // on the bulleted line, which is the one continuation that really adds an item
  // (only a `HEADING_RE` keyword re-opens a block, so a prose line after a blank
  // run is never reached at all — see walkBlock's blank-run branch).
  return {
    consumed,
    nextIndex: index + 1,
    item: stripBullet(line) || undefined,
    closed: false,
  };
}

/**
 * THE per-block walk (#1855): `stepLine` applied from the line after a heading
 * to the block's terminator. The main loop's block body and the outcome-heading
 * decision are the SAME call, so "does this block have an item?" cannot drift
 * from "is this line an item?". The superseded hand-written second copy
 * did drift: its blank-run rule tested the wrong line and
 * was always false where it was read, its END fence was anchored where the loop
 * uses the unanchored `FENCE_RE`, and it kept walking past a following typed
 * heading. Nothing calls it any more; `walkBlock` is the only reader of a block.
 *
 * The blank-run rule lives here and nowhere else, because it is the loop's:
 * a run of blanks keeps the block open while the first non-blank line is a
 * bullet (and those blanks count as consumed), and otherwise the block is
 * demoted — so bullets after a blank run ARE the block's items and prose after
 * a blank run is not. Two facts are the CALLER's, not the block's, and are
 * therefore its own decisions rather than this walk's: whether the heading line
 * is consumed (the loop consumes a heading the moment it opens a block; the
 * outcome gate demotes an empty one and leaves it to the filed inventory), and
 * the blank the loop's blank branch keeps on a demotion — reported through
 * `demotedBlanks` so exactly one implementation decides it.
 */
export function walkBlock(
  lines: string[],
  headingIndex: number,
  residual: string,
  opts: {
    /** The heading closes its own block on its own line (see `fenceClosed`). */
    fenceClosed: boolean;
    /** Sink for the one blank the loop's blank branch keeps on a demotion (see
     *  the blank-run branch below). The caller that owns that branch passes an
     *  array it will fold into its own consumed set; the gate passes none. */
    demotedBlanks?: number[];
  },
): BlockWalk {
  const consumed: number[] = [headingIndex];
  // The two facts about the HEADING LINE, which only the caller (the loop, with
  // its HEADING_RE match) can supply: whether the heading closes its own block
  // — an `END` colon residual (`Done when: END`) or the `KEYWORD END` wrapper
  // form (`Done when END`) — and whether its colon residual is the block's
  // first item. Neither is a rule about the lines under the heading, so neither
  // belongs in `stepLine`; both belong here, so there is still exactly one
  // place that decides what a block contains.
  if (opts.fenceClosed) return { consumed, items: [], nextIndex: headingIndex + 1 };
  const items: string[] = itemCandidate(residual) ? [residual] : [];
  let i = headingIndex + 1;
  while (i < lines.length) {
    // A HEADING_RE keyword ENDS this block: the loop leaves the block open only
    // for its own channel, and a second keyword (`NEVER CLAIM:` under a
    // `Done when:`) opens its own. The keyword line itself is not a line of this
    // block, so the walk stops before it and the caller resumes the main loop
    // there — the block's items are exactly the lines up to it.
    if (KEYWORD_LINE_RE.test((lines[i] ?? "").trim())) {
      return { consumed, items, nextIndex: i };
    }
    // The loop's blank-line rule: the block ends at a blank run unless the list
    // continues with a bullet. The blank branch of the loop consumes the FIRST
    // blank of the run plus the one lookahead line it inspects, and does not set
    // an item from the branch itself — the loop's next iteration reads that
    // bulleted line through its own in-block rules, which is where the item (or
    // the fence that closes the block) comes from. Nothing past the run belongs
    // to the block once the block is demoted, so a caller that consumes none of
    // this block takes none of those lines either.
    if (!(lines[i] ?? "").trim()) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trim()) j++;
      if (j >= lines.length) return { consumed, items, nextIndex: j };
      if (!BULLET_RE.test((lines[j] ?? "").trim())) {
        // Demotion. The loop's own blank branch consumes the FIRST blank of the
        // run even though the lookahead is prose and the block ends here (that
        // is the shape the retention pin reproduces), so the walk reports it
        // through this flag and the caller that owns the blank branch applies it.
        // The gate consumes none of a block it demotes.
        if (opts.demotedBlanks) opts.demotedBlanks.push(i);
        return { consumed, items, nextIndex: i };
      }
      for (let b = i; b < j; b++) consumed.push(b);
      consumed.push(j);
      // Re-read the bulleted lookahead through stepLine (the loop's in-block
      // branch), which is where the item and any fence closure come from.
      i = j;
      continue;
    }
    const step = stepLine(lines, i);
    for (const n of step.consumed) consumed.push(n);
    if (step.item !== undefined) items.push(step.item);
    if (step.closed) return { consumed, items, nextIndex: step.nextIndex };
    i = step.nextIndex;
  }
  return { consumed, items, nextIndex: i };
}

/**
 * Iterated bullet strip. Whitespace after the marker is REQUIRED, so
 * digit-leading prose ("42 is the answer", "3.14 pi") and PEM-style
 * "-----BEGIN X-----" lines survive intact; "- 1) x" still double-strips
 * to "x" (the old single-pass class regex ate any run of `-*digits.)`).
 */
export function stripBullet(line: string): string {
  let out = line;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(BULLET_RE, "");
  }
  return out.trim();
}
