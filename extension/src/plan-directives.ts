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
   * terminator (the same one the main loop applies; see `nextItemInBlock`).
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

// #1855: the OUTCOME aliases (DONE WHEN / ACCEPTANCE) open their own channel,
// NOT `acceptanceCriteria`: an outcome block is a weaker claim than the typed
// directive, and a channel that merged the two would make `ACCEPTANCE` alone
// the directive. JS regex alternation is ORDERED, not longest-match: at the one
// position the engine reaches, the first alternative that matches wins, so
// `ACCEPTANCE[\s-]*CRITERIA` is listed before bare `ACCEPTANCE` to keep the
// directive form matching its own heading, and bare `ACCEPTANCE` is reached only
// when the longer forms do not match. (Anchored at this position the order is
// not load-bearing — a keyword running into a word char matches nothing and
// backtracks either way — but the claim the old comment made about the engine
// was wrong.)
const KEYWORD =
  "(ACCEPTANCE[\\s-]*CRITERIA|PITFALLS|EDGE[\\s-]*CASES|OUT[\\s-]*OF[\\s-]*SCOPE|TEST[\\s-]*SURFACE|DECOMPOSITION\\s*\\/\\s*SUB[\\s-]*ISSUES?|DECOMPOSITION|SUB[\\s-]*ISSUES?|NEVER[\\s-]*CLAIM|FORBIDDEN|DONE[\\s-]*WHEN|ACCEPTANCE)";

/**
 * A keyword line is a heading ONLY when the keyword (with optional
 * `#`/`=`/`*`/backtick wrappers and an optional parenthetical, D4) is
 * followed by a colon (+ optional residual first item), a BEGIN/END fence
 * token, closing wrapper chars, or end-of-line. A keyword flowing into
 * ordinary prose ("Out of scope for this round was…") no longer hijacks
 * the open block (round-9 bonus defect).
 */
const HEADING_RE = new RegExp(
  `^(?:[#=*\`]+\\s*)?${KEYWORD}(?:\\s*\\([^)]*\\))?\\s*(?:(?:[#=*\`]+)?\\s*[:：]\\s*(.*)$|(BEGIN|END)\\s*(?:[#=*\`]+\\s*)?$|[#=*\`]*\\s*$)`,
  "i",
);

/** A bare fence line inside an open block: END terminates, BEGIN is skipped. */
const FENCE_RE = /^[-=\s]*(BEGIN|END)[-=\s]*$/i;

/** Bullet-list continuation marker (also keeps spaced lists open across blanks). */
const BULLET_RE = /^(?:[-*]+|\d+[.)])\s+/;

/**
 * A bare `Label:` line (1-3 capitalised words, nothing after the colon) that
 * is NOT a recognised keyword. Inside an open block it closes the block: an
 * unrecognised heading such as `Decisions:` must not be absorbed as an item
 * of the adjacent typed section. Longer prose lines ending in a colon ("The
 * following must hold:") still read as items.
 */
const LABEL_RE = /^[A-Z][A-Za-z/-]*(?: [A-Za-z/-]+){0,2}:$/;

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
 * An item candidate — the colon residual on a heading, or a line inside an open
 * block. Wrapper chars ("**Done when:**") and a bare `BEGIN`/`END` token are
 * delimiters, never items. ONE predicate, shared by the outcome lookahead below
 * and the main parser loop, so "does this block have an item?" cannot drift from
 * "is this line an item?" (the parser's own residual rule and its in-block
 * `FENCE_RE` rule are the two halves this unifies).
 */
function itemCandidate(text: string): boolean {
  return !!text && !/^[#=*`]+$/.test(text) && !/^BEGIN$/i.test(text) && !/^END$/i.test(text);
}

/**
 * The FIRST item the block a heading opens yields (#1855), or `undefined` when
 * it yields none. Pure read over `lines`; the caller decides what an absence
 * means. A colon residual that is itself an item ("Done when: the tool
 * registers") answers immediately.
 *
 * Otherwise the scan runs the block to its REAL terminator using the SAME rules
 * the main parser loop applies to that block: a blank line is skipped and the
 * scan continues past it — but a blank run followed by a NON-bullet line ends it
 * with no item, because that is precisely where the loop's own blank-line
 * lookahead demotes the block — a `LABEL_RE` line (`Decisions:`) or an `END`
 * fence line terminates the block, a `BEGIN` token is a delimiter the scan walks
 * past, and any other line supplies the item when `itemCandidate` accepts it and
 * stripping its bullet marker leaves text (contiguous non-bulleted lines are
 * items for every typed block, so they do here too). A heading that closes its
 * own block on the spot — an `END` colon residual (`Done when: END`), the
 * `KEYWORD END` wrapper form (`Done when END`), or an `END` fence line directly
 * under the heading — yields no item, exactly as the parser's own loop leaves it.
 *
 * Stopping at the first meaningful line is what made the old version wrong: it
 * answered on that line alone, so `Done when: the following must hold\n- x` and
 * `Done when:\n\n- x` were both reported as "no outcome" even though the
 * parser's own loop produces those bullets. A heading counts as no outcome only
 * when its block holds NO item at all.
 */
function nextItemInBlock(
  lines: string[],
  headingIndex: number,
  residual: string,
  fenceClosed: boolean,
): string | undefined {
  // The two ways a heading line closes its own block on the spot, both of them
  // the parser's own rules below: a colon residual that is an `END` token
  // (`Done when: END`) and the `KEYWORD END` wrapper form (`Done when END`,
  // captured as m[3]). Such a heading is treated as no outcome — it is left
  // unconsumed and its lines stay in the inventory — so the scan never runs.
  if (fenceClosed || /^END$/i.test(residual)) return undefined;
  if (itemCandidate(residual)) return residual;
  let j = headingIndex + 1;
  while (j < lines.length) {
    const l = (lines[j] ?? "").trim();
    // Blank lines do not end the scan, but a run of them followed by anything
    // that is NOT a bullet does: that is the main loop's own blank-line
    // lookahead, which demotes the block on a non-bullet lookahead. Keeping the
    // two answers identical is the point of the shared predicate.
    const blankRun = !l;
    if (blankRun) {
      j++;
      continue;
    }
    if (LABEL_RE.test(l)) return undefined;
    // The parser's own fence rule: END terminates, BEGIN is a skipped token.
    if (FENCE_RE.test(l)) {
      if (/END/i.test(l)) return undefined;
      j++;
      continue;
    }
    if (!itemCandidate(l)) {
      // A prose line the loop would have consumed as an item — but only while
      // the block is still open. After a run of blanks the loop closes it (the
      // demotion above), so no item exists past that point.
      return blankRun ? undefined : l;
    }
    return stripBullet(l) || undefined;
  }
  return undefined;
}

/**
 * Iterated bullet strip. Whitespace after the marker is REQUIRED, so
 * digit-leading prose ("42 is the answer", "3.14 pi") and PEM-style
 * "-----BEGIN X-----" lines survive intact; "- 1) x" still double-strips
 * to "x" (the old single-pass class regex ate any run of `-*digits.)`).
 */
function stripBullet(line: string): string {
  let out = line;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(BULLET_RE, "");
  }
  return out.trim();
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
      // Blank line: the block ends unless the list continues with a bullet
      // (one-token lookahead); a following heading re-opens its own block.
      if (target !== null) {
        let j = i + 1;
        while (j < lines.length && !(lines[j] ?? "").trim()) j++;
        const next = j < lines.length ? (lines[j] ?? "").trim() : "";
        // A bulleted lookahead is a typed-block line (an item under a closed
        // block — consumed as it always was, now visible to the exclusion);
        // a non-bullet lookahead just demotes the block.
        if (BULLET_RE.test(next)) consumed.add(j < lines.length ? j : i);
        else target = null;
      }
      continue;
    }
    const m = line.match(HEADING_RE);
    if (m) {
      const channel = channelFor(m[1] ?? "");
      const rest = (m[2] ?? "").trim();
      // A heading that opens an OUTCOME block is consumed only if the block
      // yields an item ANYWHERE before its terminator (#1855): a bare `Done
      // when:`, prose with no item at all, or a block holding only fence tokens
      // is no outcome, and its lines stay unconsumed so the inventory keeps them
      // exactly as it keeps any other unrecognised heading. A lead-in, a blank
      // line or a fence token before real bullets does NOT void the block —
      // `nextItemInBlock` is the scan, and it shares the parser's own item
      // predicate and blank-line handling.
      if (
        channel === "operatorOutcomes" &&
        nextItemInBlock(lines, i, rest, (m[3] ?? "").toUpperCase() === "END") === undefined
      ) {
        // A bare `Done when:` whose block yields no item is an OUTCOME the
        // operator believes they stated and the plan will not carry, so the
        // demotion is never silent: the heading is traced when it is demoted to
        // "no outcome" (its lines stay in the inventory, but the AC section will
        // fall back).
        traceWarn(`plan: ${JSON.stringify(line)} yields no item — no operator outcome`);
        target = null;
        continue;
      }
      consumed.add(i);
      target = channel;
      if ((m[3] ?? "").toUpperCase() === "END") {
        target = null; // "TEST SURFACE END" closes the block
        continue;
      }

      // Colon residual becomes the first item ("PITFALLS: the retry path")
      // — unless it is wrapper chars ("**ACCEPTANCE CRITERIA:**") or a
      // fence token ("TEST SURFACE: BEGIN").
      if (/^END$/i.test(rest)) target = null;
      else if (itemCandidate(rest)) out[channel].push(rest);
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
      if (/END/i.test(line)) target = null;
      continue;
    }
    const bullet = stripBullet(line);
    if (bullet) out[target].push(bullet);
  }
  return { directives: out, consumedLines: [...consumed].sort((a, b) => a - b) };
}
