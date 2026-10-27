/**
 * plan-directives — the operator's TRUSTED typed channel into a /plan spec.
 *
 * The `context` param is the one input the driver treats as authority (D7):
 * typed blocks parsed here take precedence over specialist output for their
 * fields. This is the deliberate counterpart to DESCRIPTOR_DATA_FRAMING —
 * children are told quoted text is never instructions, so instructions must
 * arrive through this structural channel instead.
 *
 * Grammar (vipune round-9 fixture, 2026-09-10): a heading line opens a
 * block; the block ends at the NEXT heading, an END fence, or a blank line
 * followed by a non-bullet line. Contiguous unbulleted lines are items;
 * bare BEGIN/END fence lines are delimiters, never items. The old parser
 * had no terminator at all — the tester's `TEST SURFACE:\nBEGIN\nnone\nEND`
 * block leaked both fences as bullets and swallowed every trailing prose
 * paragraph into the section. Lines a terminator demotes are NOT lost: the
 * whole context param independently flows into the prior-context inventory.
 *
 * Split out of plan-draft.ts along the 500-line seam (AGENTS.md §12);
 * plan-draft re-exports for existing consumers.
 */

import {
  BULLET_RE,
  FENCE_RE,
  KEYWORD_SOURCE,
  KEYWORD_TAIL_SOURCE,
  LABEL_RE,
  isEndFence,
  stripBullet,
  walkBlock,
} from "./plan-block-walk.ts";
import { traceWarn } from "./trace.ts";

export interface OperatorDirectives {
  acceptanceCriteria: string[];
  pitfalls: string[];
  outOfScope: string[];
  /**
   * TEST SURFACE block — the operator's test-surface items replace the
   * angle-derived ones (vipune fixture run C2: "the Test surface section
   * must contain exactly 'none — no code shipped'" had no structural
   * channel and was ignored). Optional so existing literals stay valid.
   */
  testSurface?: string[];
  /**
   * DECOMPOSITION (or SUB-ISSUES) block — constraints on an epic's
   * decomposition, threaded into the decomposition-surface angle prompt
   * and readable by the pinned-count validator (C5).
   */
  decomposition?: string[];
  /**
   * NEVER CLAIM (or FORBIDDEN) block (#677) — the operator's verbatim
   * forbidden phrases. Each item is one phrase; the post-filter drops
   * any structured item whose normalised text contains the phrase as an
   * exact normalised substring (disclosed, never silent), and the prompt
   * seam threads the phrases verbatim into every angle and the gap-gate
   * prompt. Same block-termination grammar as every other directive block.
   */
  neverClaim?: string[];
  /**
   * #1855: the OPERATOR OUTCOME channel — a `Done when` heading or a bare
   * `ACCEPTANCE` heading. `ACCEPTANCE CRITERIA` is NEVER an outcome alias: it
   * always stays on the directive channel (`acceptanceCriteria`), whatever case
   * or wrapper chars the operator used. An operator who states the outcome in
   * prose had those bullets land only in the Prior context inventory, so a
   * feature plan could never fill its Acceptance criteria section and halted
   * draft-invalid. Bullets under one of the two outcome headings feed the SAME
   * operator-authority AC source as an ACCEPTANCE CRITERIA block (rendered
   * verbatim, never clipped or count-capped on the angle cap). A heading whose
   * block holds NO item at all is NOT an outcome: the channel stays empty and
   * the heading is left unconsumed, so it stays in the inventory exactly as an
   * unrecognised heading does. A lead-in line, a blank line or a fence token
   * BEFORE real bullets does not void the block — the scan runs to the block's
   * terminator (the same one the main loop applies; see `walkBlock`).
   *
   * REQUIRED (review round 1): this is the single channel carrying the
   * operator's outcome to both draftSpec call sites, so nothing downstream may
   * treat its absence as "the operator wrote no outcome".
   */
  operatorOutcomes: string[];
}

/**
 * One parse of the operator's `context` param: the typed channels plus the
 * 0-based source-line indices the parser CONSUMED as typed-block lines
 * (#858). A consumed line is one that became a heading, a fence, or a
 * typed-block item (or a bulleted line inside a closed block). Untyped
 * prose lines stay unlisted — they are the Prior context inventory's only
 * operator content; consumed lines must NOT be re-listed there.
 *
 * The split is line-level and conservative: the parser's blank-line
 * lookahead only ever DEMOTES (a bullet under a closed block is consumed as
 * an item of the block as it always was, a plain prose line cannot be typed
 * and is left unlisted), so no consumed line is missed.
 *
 * LINE-INDEX INVARIANT (#858 review): `consumedLines` are indices into
 * `context.trim().split("\n")`, not into the raw string. The parser trims
 * the context BEFORE splitting (see parseOperatorDirectivesWithLines), so
 * a consumer that splits `context.trim()` — the prior-context inventory
 * (plan-prior-context-assembly.ts) — indexes the SAME array and a
 * consumed index excludes exactly that line. Trimming here, at the single
 * split site, is what keeps that alignment true for contexts with leading
 * or trailing blank lines.
 */
export interface OperatorDirectiveParse {
  directives: OperatorDirectives;
  consumedLines: number[];
}

// #1855: the OUTCOME aliases (DONE WHEN / a bare ACCEPTANCE) open their own
// channel, NOT `acceptanceCriteria`: an outcome block is a weaker claim than the
// typed directive, and a channel that merged the two would make `ACCEPTANCE`
// alone the directive. `ACCEPTANCE[\s-]*CRITERIA` is therefore the DIRECTIVE
// heading and the only acceptance-criteria keyword that is NOT an outcome alias;
// the outcome headings are `DONE WHEN` (any of `Done when:`, `DONE WHEN`,
// `DONE-WHEN`, colon optional) and a bare `ACCEPTANCE`.
//
// The heading grammar itself — prefix, keyword alternation, tail — has ONE
// source: the three exported pieces `plan-block-walk.ts` builds its own
// `KEYWORD_LINE_RE` from. The parser matches a heading for its CHANNEL and the
// walk matches the same pattern for its TERMINATOR, so the two grammars cannot
// disagree about what a heading is. (#1855 round 3 deleted the hand-copied
// `KEYWORD` twin that sat here, along with the local `FENCE_RE`, `BULLET_RE`,
// `LABEL_RE` and `stripBullet` copies — the two `FENCE_RE` copies had already
// drifted apart and disagreed on `END=`, `=END=` and `== BEGIN ==`.)

/**
 * A keyword line is a heading ONLY when the keyword (with optional
 * `#`/`=`/`*`/backtick wrappers and an optional parenthetical, D4) is
 * followed by a colon (+ optional residual first item), a BEGIN/END fence
 * token, closing wrapper chars, or end-of-line. A keyword flowing into
 * ordinary prose ("Out of scope for this round was…") no longer hijacks
 * the open block (round-9 bonus defect).
 *
 * Group 1 is the keyword (for `channelFor`), group 2 the colon residual, group 3
 * a keyword-attached BEGIN/END token. This regex and the walk's `KEYWORD_LINE_RE`
 * are the same pattern with ONE difference: this one captures the keyword — the
 * exported `KEYWORD_SOURCE` is written as a capturing group precisely so — while
 * the walk's wraps it non-capturing. The walk reads no group at all; it only
 * asks whether the line is a heading.
 */
const HEADING_RE = new RegExp(`^${KEYWORD_SOURCE}${KEYWORD_TAIL_SOURCE}`, "i");

function channelFor(name: string): keyof OperatorDirectives {
  const up = name.toUpperCase();
  return up.startsWith("ACCEPTANCE")
    ? // #1855: a bare `ACCEPTANCE` heading is the OUTCOME channel; the typed
      // directive form is `ACCEPTANCE CRITERIA` (matched ahead of it by KEYWORD).
      up === "ACCEPTANCE"
      ? "operatorOutcomes"
      : "acceptanceCriteria"
    : up.startsWith("OUT")
      ? "outOfScope"
      : up.startsWith("TEST")
        ? "testSurface"
        : up.startsWith("DECOMPOSITION") || up.startsWith("SUB")
          ? "decomposition"
          : up.startsWith("NEVER") || up.startsWith("FORBIDDEN")
            ? "neverClaim"
            : up.startsWith("DONE")
              ? "operatorOutcomes"
              : "pitfalls";
}

/**
 * Parse operator-supplied typed fields out of the `context` param (D7).
 * Headings: ACCEPTANCE CRITERIA, PITFALLS (or EDGE CASES), OUT OF SCOPE,
 * TEST SURFACE, DECOMPOSITION (or SUB-ISSUES), NEVER CLAIM (or FORBIDDEN), and
 * the #1855 outcome headings DONE WHEN / ACCEPTANCE. `ACCEPTANCE CRITERIA` is
 * the DIRECTIVE heading, NOT an outcome alias: `channelFor` routes the
 * `ACCEPTANCE…` prefix by the exact keyword, so the directive form keeps its own
 * channel and only a bare `ACCEPTANCE` heading opens the outcome one.
 * Grammar in the module header.
 */
export function parseOperatorDirectives(context: string | undefined): OperatorDirectives {
  return parseOperatorDirectivesWithLines(context).directives;
}

/**
 * `parseOperatorDirectives` plus the 0-based source-line indices the parser
 * CONSUMED as typed-block lines (#858). The driver keeps its own line loop
 * feeding the child-prompt channel (D2: the operator is authority) and uses
 * `consumedLines` only to exclude typed-block lines from the FILED-body
 * Prior context inventory. Untyped prose lines stay unlisted — they are the
 * inventory's only operator content.
 *
 * The OUTCOME headings are `DONE WHEN` and a bare `ACCEPTANCE` heading; an
 * `ACCEPTANCE CRITERIA` heading ALWAYS stays on the directive channel, so
 * nothing on the directive path is affected by the outcome channel (#1855).
 */
export function parseOperatorDirectivesWithLines(
  context: string | undefined,
): OperatorDirectiveParse {
  const out: Required<OperatorDirectives> = {
    acceptanceCriteria: [],
    pitfalls: [],
    outOfScope: [],
    testSurface: [],
    decomposition: [],
    neverClaim: [],
    operatorOutcomes: [],
  };
  const consumed = new Set<number>();
  if (!context || !context.trim()) return { directives: out, consumedLines: [] };
  // TRIM BEFORE SPLIT (the line-index invariant documented on
  // OperatorDirectiveParse): consumers split `context.trim()` and index
  // `consumedLines` into that array; splitting the raw string would shift
  // every index by the leading whitespace's worth of lines.
  const lines = context.trim().split("\n");
  let target: keyof OperatorDirectives | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) {
      // A blank line: the block ends unless the list continues with a bullet
      // (one-token lookahead); a following heading re-opens its own block.
      if (target !== null) {
        // The loop's OWN blank-line rule: the walk answers "what does this block
        // contain?", never "what does the loop consume?", and the difference is
        // the #858 exclusion set, which is the parser's contract rather than a
        // property of a block.
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? "").trim()) j++;
        const next = j < lines.length ? (lines[j] ?? "").trim() : "";
        // A bulleted lookahead is a typed-block line (an item under a closed
        // block — consumed as it always was, now visible to the exclusion);
        // a non-bullet lookahead just demotes the block.
        if (BULLET_RE.test(next)) consumed.add(j < lines.length ? j : i);
        else {
          // Demotion: the loop keeps the blank it inspected (the #858 accounting
          // the retention pin reproduces) and clears the open block.
          consumed.add(i);
          target = null;
        }
      }
      continue;
    }
    const m = line.match(HEADING_RE);
    if (m) {
      const channel = channelFor(m[1] ?? "");
      const rest = (m[2] ?? "").trim();
      // ONE walk answers both questions the loop asks about a block (#1855): what
      // it contains, and — for an OUTCOME heading — whether it contains ANY item
      // at all. `walkBlock` applies the loop's own per-block rules (`stepLine`
      // plus the blank-run lookahead), so the two can never disagree: a bare
      // `Done when:`, a block of nothing but fence tokens, and a block the loop
      // would have demoted at a blank run all yield no item here exactly as they
      // yield no items there.
      //
      // The heading line itself is the caller's decision and is added below, only
      // for a block that opened: an outcome heading the gate demotes is NOT
      // consumed, so it and every line under it stay in the filed inventory
      // exactly as an unrecognised heading's do.
      const fenceClosed = (m[3] ?? "").toUpperCase() === "END" || /^END$/i.test(rest);
      // The blanks a walk demotes at a blank run: the loop's blank branch keeps
      // the first of them (#858) and the walk reports it here rather than
      // deciding it, since the branch that owns that line is in this file.
      const demotedBlanks: number[] = [];
      const walk = walkBlock(lines, i, rest, { fenceClosed, demotedBlanks });
      const hasItem = walk.items.some((item: string) => item.length > 0);
      const outcomeDemoted = channel === "operatorOutcomes" && !hasItem;
      if (outcomeDemoted) {
        // A bare `Done when:` whose block yields no item is an OUTCOME the
        // operator believes they stated and the plan will not carry, so the
        // demotion is never silent: the heading is traced when it is demoted to
        // "no outcome" (its lines stay in the inventory, but the AC section will
        // fall back).
        traceWarn(`plan: ${JSON.stringify(line)} yields no item — no operator outcome`);
        target = null;
        // Nothing under a heading that opened nothing is consumed: the heading
        // and every line below it stay in the filed inventory, exactly as an
        // unrecognised heading's lines do. There is no blank-line exception here
        // because there is no open block — the loop's blank branch only accounts
        // for a blank it stepped over WHILE a block was open.
        continue;
      }
      // A block that opened: the heading is consumed (a TYPED heading even when
      // its block is empty — the #858 rule), the walk's lines with it, and its
      // items go to the channel.
      consumed.add(i);
      for (const n of walk.consumed) consumed.add(n);
      for (const item of walk.items) out[channel].push(item);
      // "TEST SURFACE END" / "PITFALLS: END" close the block on the heading;
      // otherwise the walk's own terminator (a LABEL_RE line, an `END` fence, a
      // following keyword, or end of input) is what ends it.
      target = walk.nextIndex > i + 1 || fenceClosed ? null : channel;
      // The loop picks up where the walk stopped, and the blank the walk's own
      // blank-run lookahead demoted the block on is the loop's blank branch's
      // line to account for (#858), which is why the walk reports it rather than
      // deciding it.
      for (const n of demotedBlanks) consumed.add(n);
      i = walk.nextIndex - 1;
      continue;
    }
    if (!target) {
      // Outside an open block: a bulleted line is a typed-block line the
      // parser consumes (it never becomes an item — same as before, now
      // visible to the inventory exclusion).
      // #1087: superseded — outside an open block nothing is typed, so bullets
      // under an unrecognised heading (e.g. `Decisions:`) stay in the filed
      // inventory instead of being consumed and silently dropped.
      continue;
    }
    if (LABEL_RE.test(line)) {
      // An unrecognised heading closes the open block and is left unconsumed.
      target = null;
      continue;
    }
    consumed.add(i);
    if (FENCE_RE.test(line)) {
      if (isEndFence(line)) target = null;
      continue;
    }
    const bullet = stripBullet(line);
    if (bullet) out[target].push(bullet);
  }
  return { directives: out, consumedLines: [...consumed].sort((a, b) => a - b) };
}
