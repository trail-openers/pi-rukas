/**
 * citation-units — the whole-sentence units of a markdown document (#1381).
 *
 * The policy judge's citation check needs to ask "is this quote one whole
 * sentence of the file?" and cannot ask it of a string that has already been
 * flattened: `normaliseForCitation` removes the newlines and bullets a sentence
 * boundary is read from. So splitting runs here, on the RAW source, and each
 * unit is normalised afterwards.
 *
 * ## What is a unit
 *
 * Two kinds, and nothing else:
 *
 *   - a sentence of a paragraph, ended by `.`/`!`/`?` followed by whitespace or
 *     end of text (the closed abbreviation set never ends one), and
 *   - the whole content of a markdown list item, which is **never** split on
 *     interior punctuation — a bullet is one assertion, and splitting it would
 *     hand back the fragments this rule exists to refuse.
 *
 * Markdown headings, fenced code blocks and table rows are excluded outright. A
 * heading is a title rather than a claim; a fenced block is an example, and this
 * repo's own `AGENTS.md` fences a `BREAKING CHANGE:` line a judge could quote as
 * if it were a rule; a table row is cells, not prose. Neither is a blockquoted
 * line (someone else's words), a thematic break (`---`, a separator with no
 * content), or a 4-space indented code line — markdown's other code block, the
 * one with no fence marker to track.
 *
 * **Inline code spans are removed before a unit is built**, and this is the one
 * exclusion that has to be absolute. `normaliseUnit` deletes the backticks that
 * delimit a span, so under plain flattening the words inside it sit in the unit
 * as though the document had written them in its own voice: a rule reading
 * "the policy never says `agents may merge anything at any time`" would offer
 * its own contents back as a quotable grant. A span is an example or a
 * quotation whatever surrounds it, so the region goes and the rest of the line
 * stays prose.
 *
 * ## Which line breaks split a paragraph
 *
 * A paragraph is delimited by a blank line, and within it a line break is
 * normally soft — the sentence simply wrapped, and the two lines are one unit.
 * A break is hard in exactly two shapes, both of them a rule written one clause
 * per line rather than a sentence that ran out of room:
 *
 *   - the previous line ends with a colon — a lead-in (`**Merge policy**:`) or
 *     a conditional (`…may be met:`) — so what follows is its consequence;
 *   - or it ends with a terminator **sealed by a closer** — `…stop."`, `…met.)`
 *     — where the closer is part of the sentence and the sentence is finished.
 *     The closed abbreviation set still refuses the boundary, sealed or not:
 *     `…etc.` and `…etc.)` both continue, which is how this repo's §9 grant is
 *     punctuated and what keeps it quotable at all.
 *
 * A **bare** terminator at end of line stays soft. That is what a wrapped
 * sentence looks like — prose breaks at `”. “` as easily as at `”.` and the
 * sentence goes on — and doctrine files are full of paragraphs wrapped that way
 * at sentence ends. Closing the unit there would deny a sentence an honest judge
 * copied whole, so the line joins the next and the sentence stays one quotable
 * thing.
 *
 * Measured over this repo's `AGENTS.md`, `README.md` and `docs/`: splitting at
 * every terminator cuts 601 of 756 line joins and would break hundreds of real
 * quotes; splitting only at sealed closers cuts 90 and breaks none. An earlier
 * attempt gated the split on permission verbs (`may`, `must`, …) instead; it
 * broke the moment a condition said "approved", and any list of English modals
 * is a list somebody has to keep correct forever. Both surviving rules are
 * structural — answerable from the text alone.
 *
 * Consequence, which is the point: a conditioned rule cannot be quoted without
 * its condition — and "its condition" is read across block types. A condition
 * that does not close a unit is joined to what follows whether that is a wrapped
 * line, a bullet under it, or the next item in a list, so the condition can never
 * be quoted away by restructuring the rule as a list.
 *
 * ## The limit this splitter does not try to cross
 *
 * A heading, table row or blockquote is never a unit, so it can never *carry* a
 * condition either: a rule written "`## Only on green CI`" above a permissive
 * sentence reads as unconditional here. Whether a structural heading conditions
 * the prose under it is a question of relevance, and relevance is the judge's
 * job, not the splitter's — the splitter only ever decides what a unit is.
 */

/**
 * The closed set of final-period tokens that never end a sentence. A period
 * inside one of these is not a boundary, however it looks to a naive splitter.
 */
const SENTENCE_ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "cf."]);

/** Quote/bracket characters that can seal a terminator (`…stop."`, `…met.)`). */
const CLOSERS = /["')\]}”’»]/;

/**
 * A run of closers at the end of a string, as one regex.
 *
 * Three call sites below strip "the quote/bracket run sitting after (or before)
 * the terminator", each spelling the class out again. One alphabet in one place
 * — a character added to `CLOSERS` has to be a closer here too, or the three
 * disagree about where a sentence ends.
 */
const TRAILING_CLOSERS = /["')\]}”’»]+$/;

/**
 * Inline code spans (`like this`), matched as a pair of backtick runs.
 *
 * The whole matched region is dropped whichever way the runs parse: an unclosed
 * span is read as code rather than as prose the document asserts, which is the
 * conservative direction for a grant source. `normaliseUnit` deletes backticks,
 * so without this the words inside a span would sit in a unit as though the
 * document had written them in its own voice.
 *
 * Built fresh per use (no /g state shared between readers).
 */
const codeSpans = () => /`+[^`]*`+/g;

/** An ATX heading: 1-6 `#`, then a space or nothing. Six is the markdown ceiling. */
const HEADING = /^\s*#{1,6}(\s|$)/;

/**
 * The fence marker of a line that really is a fence delimiter, else undefined.
 *
 * Three things have to be true, and a single regex over the raw line gets all
 * three wrong.
 *
 *   - **The marker is the line's text, not words beside it.** A line is a
 *     delimiter only if nothing but ≤3 spaces precede the marker and nothing but
 *     the info string follows it — which is also how CommonMark defines it. A
 *     line of backticks followed by prose is a sentence about a fence, and
 *     treating it as a delimiter would hide the document's own rules below it.
 *   - **The marker is not itself quoted inside a code span.** A document that
 *     talks about fences writes the marker inline (`` ``` ``), so that line
 *     carries the marker *plus* the wrapping span: an EVEN number of backtick
 *     runs. A real delimiter is one ODD run. Parity settles it without reading
 *     the span structure — and stripping spans first, which is the tempting
 *     order, would blank the line and silently un-fence the example under it,
 *     the exact hole #1381 closes.
 *   - **Three spaces of indentation, no more.** Past that a line of backticks is
 *     markdown's indented code block — an example being shown, not a block to
 *     hide — and must not flip the document in or out of code mode.
 *
 * Tildes follow the same shape. The info string (`` ```json ``) is allowed and is
 * fenced metadata, never a unit, so it needs no special handling here.
 */
function fenceMarker(raw: string): string | undefined {
  const open = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*$/);
  if (!open?.[1]) return undefined;
  // Even number of marker-character runs => the marker is quoted inside a code
  // span (`` ``` ``) => the line is prose describing a fence, not a delimiter.
  // Only the marker's OWN character counts: a backtick fence whose info string
  // quotes a tilde (`~~~ closes a block`) is still one backtick run, and calling
  // that even would silently un-fence the example below it.
  const runs = open[1][0] === "`" ? "`" : "~";
  if ((raw.match(new RegExp(`${runs}+`, "g"))?.length ?? 0) % 2 === 0) return undefined;
  return open[1][0];
}

/**
 * The whole-sentence units of a document — the strings a quote may equal.
 *
 * Returns normalised units in source order. Nothing depends on the order: the
 * one question ever asked of this list is "is this string in it".
 */
export function citationUnits(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // An unclosed fence is a typo, not a veto. ` ``` ` opened with no matching
  // close before EOF would otherwise mark the whole tail of the file as code and
  // silently delete every rule after it — including a grant the operator wrote
  // on purpose. Only a TERMINAL orphan — a marker with no later marker of its
  // kind anywhere in the file — is treated as never opened. Every marker that
  // does have a partner stays a delimiter, so one stray ``` can never re-pair
  // the blocks around it and turn a genuine example into quotable prose.
  const fences = fenceRanges(lines);
  const units: string[] = [];
  let inFence = false;
  let paragraph: string[] = [];
  // The list item an indented line continues, if one is still open, and the
  // column its content begins at. An indented line belongs to the item only
  // while it sits at that column (CommonMark: one space past the marker);
  // anything deeper is a nested block — a code block or a sub-list — which the
  // document shows rather than asserts, so it is not a unit.
  let openItem: string | undefined;
  let contentColumn = 0;
  const flush = () => {
    if (paragraph.length > 0) {
      for (const sentence of splitParagraph(paragraph.join(" "))) units.push(sentence);
    }
    paragraph = [];
    openItem = undefined;
  };
  const startItem = (content: string, markerEnd: number) => {
    // Read the pending text BEFORE `flush()`, which clears the paragraph and the
    // open item — asking afterwards always answered "nothing is pending" and
    // every condition carried into a list stayed orphaned above it.
    const carried = pendingCondition();
    flush();
    if (!content.trim()) return;
    // A list item is a new block in markdown's eyes, and a new block is how a
    // writer ends a condition — but a rule written as "condition line, then the
    // permission as the bullet under it" is one assertion wearing two block
    // types. If what came immediately before does not close a unit (no
    // terminator, no colon lead-in), the item is that condition's consequence and
    // joins it rather than standing alone, exactly as a wrapped line under a
    // paragraph does. Applies item-to-item too: an unterminated numbered item is
    // not a finished rule, so the item after it belongs to it.
    //
    // A FINISHED line above still ends the unit — that is what `pendingCondition`
    // asks — and the item then starts its own. It never inherits the finished
    // line's text, which would hand back a string no human read as one sentence.
    if (carried !== undefined) {
      openItem = `${carried} ${content}`;
      units[units.length - 1] = openItem;
      contentColumn = markerEnd;
      return;
    }
    openItem = content;
    units.push(content);
    contentColumn = markerEnd;
  };
  /**
   * The text a new list item would continue, if the block above it is still
   * unfinished: the last pending paragraph line, or the open item's content.
   * `undefined` when nothing is pending OR when that text closes a unit — in
   * which case the condition was stated and finished, and the item is its own
   * assertion.
   *
   * The last shape is the §9 grant split across two blocks — condition as a
   * paragraph line with no terminator, permission as the bullet under it — and
   * joining it is the point: without the join the permission verifies alone, with
   * its condition left behind, which is this whole rule in list clothing.
   */
  const pendingCondition = (): string | undefined => {
    const last = paragraph.length > 0 ? (paragraph[paragraph.length - 1] ?? "") : (openItem ?? "");
    if (!last.trim() || closesUnit(last) || isHardBreak(last)) return undefined;
    return last;
  };
  for (const [i, rawLine] of lines.entries()) {
    // Fence delimiters are decided on the RAW line (see {@link fenceMarker}): a
    // span-strip run first would blank a line that merely *writes about* a fence
    // and un-fence the example below it. The info string is then stripped like
    // any other inline code, since it is not prose the document asserts.
    const marker = fenceMarker(rawLine);
    if (marker) {
      flush();
      if (fences.has(i)) inFence = !inFence;
      continue;
    }
    // Inline code next. A span sits inside prose, inside a heading, or inside a
    // table row, and none of those decisions change — it is not asserted text
    // wherever it sits. A line that is nothing but a span becomes blank, which is
    // what the document actually said there.
    const line = rawLine.replace(codeSpans(), "");
    if (inFence) continue;
    if (line.trim() === "") {
      flush();
      continue;
    }
    // An indented line continues the block above it. Under an open list item it
    // joins that item while it sits at the item's content column (past that it
    // is a nested block — a code block or a sub-list — which the document shows
    // rather than asserts). Under a plain paragraph it is the same thing markdown
    // does with any soft-wrapped line: a continuation of the sentence, joined and
    // then split like any other. Only an indented line with no open block above it
    // is markdown's indented code block, and only that one is dropped.
    const indent = line.match(/^(\s*)\S/)?.[1]?.length ?? -1;
    if (indent >= 2) {
      if (openItem !== undefined && indent <= contentColumn) {
        openItem = `${openItem} ${line.trim()}`;
        units[units.length - 1] = openItem;
        continue;
      }
      if (paragraph.length > 0) {
        if (isHardBreak(paragraph[paragraph.length - 1] ?? "")) flush();
        paragraph.push(line.trim());
        continue;
      }
      continue;
    }
    // An ATX heading — up to six `#`, then a space or nothing. Six is the
    // markdown ceiling, and `#######` is literal text, not a title.
    if (HEADING.test(line)) {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      continue;
    }
    // A blockquoted line is another author's words, quoted rather than asserted
    // by this document; a thematic break (`---`, `***`, `___`) is a separator
    // carrying no content. Neither states a rule in the document's own voice.
    if (/^\s*>/.test(line) || isThematicBreak(line)) {
      flush();
      continue;
    }
    const bullet = line.match(/^\s*([-+*])\s+(.*)$/);
    if (bullet?.[1] && bullet[2] !== undefined) {
      // The column the marker ENDS at, which is where a continuation line has to
      // sit (CommonMark: indented at least as far as the item's content). Passing
      // the marker's *start* instead made every continuation look too deep, so
      // nothing ever joined and a wrapped item lost its tail.
      startItem(bullet[2], line.indexOf(bullet[1]) + bullet[1].length + 1);
      continue;
    }
    // A numbered item is a list item too: the enumerator is markdown's
    // structure, not part of what the document claims, and a bare `1.`/`1)` on a
    // line of its own is not something a judge may quote as a grant.
    const numbered = line.match(/^\s*(\d+[.)])\s*(.*)$/);
    if (numbered?.[1] && numbered[2] !== undefined) {
      startItem(numbered[2], line.indexOf(numbered[1]) + numbered[1].length + 1);
      continue;
    }
    // A plain paragraph line. It joins the running paragraph unless the break
    // before it is hard (see the module header), so a condition on one line and
    // its permission on the next can never be quoted apart.
    openItem = undefined;
    if (paragraph.length > 0 && isHardBreak(paragraph[paragraph.length - 1] ?? "")) flush();
    paragraph.push(line.trim());
  }
  flush();
  return units.map(normaliseUnit).filter((u) => u.length > 0);
}

/**
 * Indices of the lines that really are fence delimiters, paired open→close.
 *
 * Pairing is **sequential and stack-like**: the first marker opens, the next
 * marker of the same character closes it, the one after that opens again, and so
 * on. Pairing each marker with "the next one anywhere" instead — the shape this
 * function used to have — lets one stray marker re-pair everything around it:
 * the stray swallows a real opener, and the real closer then pairs forward onto
 * the NEXT block's opener, so the block a fabricated grant was written inside
 * stops being code and becomes quotable prose. Sequential pairing cannot do
 * that; blocks pair with their own neighbours.
 *
 * The one thing that stays a no-op is the terminal orphan: a final marker with
 * no later marker of its kind is a typo at the end of the file, and the prose
 * below it is read as the prose it is. An orphan anywhere else — a stray marker
 * in the middle of a document — pairs with what follows it, because treating it
 * as "just a typo" is what let a fenced example become a grant.
 */
function fenceRanges(lines: readonly string[]): Set<number> {
  const accepted = new Set<number>();
  const markerAt = (line: string) => fenceMarker(line);
  let open: { at: number; marker: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const marker = markerAt(lines[i] ?? "");
    if (!marker) continue;
    if (!open) {
      open = { at: i, marker };
      continue;
    }
    // A marker of the other character sits inside an open block as content —
    // `~~~` inside a ``` example does not close it — so it is not a closer and
    // the open block keeps running.
    if (marker !== open.marker) continue;
    accepted.add(open.at);
    accepted.add(i);
    open = undefined;
  }
  // `open` is set only for a marker with no partner of its kind after it: the
  // terminal orphan. It, and it alone, is left out of the delimiter set.
  return accepted;
}

/**
 * Must the line break after `previous` open a new unit?
 *
 * See the module header: a colon lead-in is one shape, a closer-sealed
 * terminator the other, and everything else — including a bare `.` at end of
 * line — is a wrapped sentence that stays together.
 */
function isHardBreak(previous: string): boolean {
  const t = previous.trimEnd();
  if (!t) return false;
  if (/:$/.test(t.replace(/["'”’]+$/, ""))) return true;
  // Sealed = something was stripped. A line written to finish an assertion seals
  // it (`"…"`, `(...)`); a line that merely ran out of room stops at the bare `.`
  // — that one is a wrap, and its sentence continues on the next line.
  return closesUnit(t) && t !== t.replace(TRAILING_CLOSERS, "");
}

/**
 * Does this line end a sentence?
 *
 * A terminator at end of line — bare, or behind a closer — unless it is one of
 * the closed abbreviations (`…e.g.`), which never ends a sentence whatever sits
 * after it.
 */
function closesUnit(line: string): boolean {
  const t = line.trimEnd();
  if (!t) return false;
  const before = t.replace(TRAILING_CLOSERS, "");
  const last = before[before.length - 1];
  if (!".!?".includes(last ?? "")) return false;
  return !isAbbreviation(before.slice(before.lastIndexOf(" ") + 1));
}

/**
 * Is the terminator at `terminatorAt` the end of a sentence?
 *
 * The bracket/quote run after it is not part of the token, and what follows it
 * must be whitespace or end of text — `etc)` inside a sentence has a letter
 * after the bracket and is not a boundary.
 */
function endsSentenceAt(text: string, terminatorAt: number): boolean {
  if (!".!?".includes(text[terminatorAt] ?? "")) return false;
  let after = terminatorAt + 1;
  while (CLOSERS.test(text[after] ?? "")) after++;
  const next = text[after];
  if (next !== undefined && !/\s/.test(next)) return false;
  const before = text.slice(0, terminatorAt + 1).replace(/[)\]]+$/, "");
  return !isAbbreviation(before.slice(before.lastIndexOf(" ") + 1));
}

/**
 * Is this trailing token one of the closed abbreviations?
 *
 * Lowercased on the way in: the set is declared in lower case, and a sentence
 * routinely opens with `E.g.` or `Vs.` — where a case-sensitive lookup would
 * read that period as a boundary and split a real sentence in two.
 */
function isAbbreviation(token: string): boolean {
  return SENTENCE_ABBREVIATIONS.has(token.toLowerCase());
}

/** Split a joined paragraph into sentences, honouring the abbreviation set. */
function splitParagraph(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < paragraph.length; i++) {
    if (!".!?".includes(paragraph[i] ?? "")) continue;
    if (!endsSentenceAt(paragraph.slice(start), i - start)) continue;
    // `…" `, `…) `, `…] ` — the terminator is the sentence's, not the quoted
    // or parenthesised thing inside it, so the boundary is after the closer.
    let end = i + 1;
    while (CLOSERS.test(paragraph[end] ?? "")) end++;
    const sentence = paragraph.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** `---`, `***`, `___` and their spaced variants: a separator, not content. */
function isThematicBreak(line: string): boolean {
  const t = line.trim().replace(/\s+/g, "");
  return /^([-*_])\1{2,}$/.test(t);
}

/**
 * Remove inline code spans without flattening what remains.
 *
 * The exported twin of what `citationUnits` does to every line before it reads
 * it. `normaliseUnit` deliberately still deletes single backticks (a judge that
 * drops the `**` around a bolded word is quoting honestly), so a caller that
 * asks "does this string appear in this document?" must remove the *spans*
 * first or the words inside one — an example, a quotation, a description of the
 * very rule — become grantable text. That is the shape `verifyEvidence` compares
 * in, which is why it is exported rather than kept private to the splitter.
 */
export function codeSpanFree(s: string): string {
  return s.replace(codeSpans(), "");
}

/**
 * Normalise one unit for citation comparison.
 *
 * Verbatim "modulo formatting": a judge that copies a sentence spanning a line
 * wrap, or drops the `**` around a bolded word, is quoting honestly and should
 * pass. A judge that invents a sentence should not. Markdown emphasis, list
 * bullets and whitespace runs are therefore flattened, and nothing else is.
 *
 * Lives here because a unit is built from lines the flattening would otherwise
 * erase, and `decision-evidence` re-exports it as `normaliseForCitation` so
 * every caller keeps one definition.
 */
export function normaliseUnit(s: string): string {
  return s
    .replace(/[*_`]/g, "")
    .replace(/^\s*[-+*>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
