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
 * its condition. The §9 conditional closes `…type checks etc)`, with no
 * terminator at all, so its two lines join and the grant quotes whole as
 * written; a permission clause carries no terminator of its own, so it is never
 * a unit on its own.
 */

/**
 * The closed set of final-period tokens that never end a sentence. A period
 * inside one of these is not a boundary, however it looks to a naive splitter.
 */
const SENTENCE_ABBREVIATIONS = new Set(["e.g.", "i.e.", "etc.", "vs.", "cf."]);

/** Quote/bracket characters that can seal a terminator (`…stop."`, `…met.)`). */
const CLOSERS = /["')\]}”’»]/;

/**
 * The whole-sentence units of a document — the strings a quote may equal.
 *
 * Returns normalised units in source order. Nothing depends on the order: the
 * one question ever asked of this list is "is this string in it".
 */
export function citationUnits(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // An unclosed fence is a typo, not a veto. ` ``` ` opened with no matching
  // close before EOF would otherwise mark the whole tail of the file as code
  // and silently delete every rule after it — including a grant the operator
  // wrote on purpose. A fence is only a fence if it closes; otherwise the
  // region is read as the prose it is.
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
  const startItem = (content: string, contentAt: number) => {
    flush();
    if (!content.trim()) return;
    openItem = content;
    contentColumn = contentAt;
    units.push(content);
  };
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      if (fences.has(i)) inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      flush();
      continue;
    }
    // An indented line continues the list item above it while it sits at the
    // item's content column; past that it is a nested block, not a sentence the
    // document is still writing.
    const indent = line.match(/^(\s*)\S/)?.[1]?.length ?? -1;
    if (indent >= 2) {
      if (openItem !== undefined && indent <= contentColumn) {
        openItem = `${openItem} ${line.trim()}`;
        units[units.length - 1] = openItem;
      }
      continue;
    }
    // An ATX heading — up to six `#`, then a space or nothing. Six is the
    // markdown ceiling, and `#######` is literal text, not a title.
    if (/^\s*#{1,6}(\s|$)/.test(line)) {
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
 * A delimiter is only a delimiter when something closes it. Each ` ``` `/`~~~ `
 * line is matched against the next one of the same marker; an unmatched opener
 * is left out, so the prose below it is read as prose.
 */
function fenceRanges(lines: readonly string[]): Set<number> {
  const accepted = new Set<number>();
  const markerAt = (line: string) => line.trimStart().match(/^(`{3,}|~{3,})/)?.[1]?.[0];
  for (let i = 0; i < lines.length; i++) {
    if (accepted.has(i)) continue;
    const marker = markerAt(lines[i] ?? "");
    if (!marker) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (markerAt(lines[j] ?? "") !== marker) continue;
      accepted.add(i);
      accepted.add(j);
      break;
    }
  }
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
  return closesUnit(t) && endsSealed(t);
}

/**
 * Does this line end in a terminator sealed by a closer (`…stop."`, `…met.)`)?
 *
 * `closesUnit` strips the closer run to read the token behind it; this asks
 * whether anything was stripped at all. A line written to finish an assertion
 * seals it (`"…"`, `(...)`); a line that merely ran out of room stops at the
 * bare `.` — that one is a wrap, and its sentence continues on the next line.
 */
function endsSealed(line: string): boolean {
  const t = line.trimEnd();
  return t.length > 1 && t !== t.replace(/["')\]}”’»]+$/, "");
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
  const before = t.replace(/[\"')\]}”’»]+$/, "");
  const last = before[before.length - 1];
  if (!".!?".includes(last ?? "")) return false;
  return !SENTENCE_ABBREVIATIONS.has(before.slice(before.lastIndexOf(" ") + 1));
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
  return !SENTENCE_ABBREVIATIONS.has(before.slice(before.lastIndexOf(" ") + 1));
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
