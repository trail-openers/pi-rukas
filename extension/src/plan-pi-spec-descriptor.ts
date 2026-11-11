/**
 * plan-pi-spec-descriptor — the drafted body read as markdown, for the two
 * fields `piSpecFromDraft` takes out of it.
 *
 * `piSpecFromDraft` bounds the fields it emits, but where the `problem` and the
 * criteria come FROM is a parsing question about the drafted body, and it is the
 * part of the mapper that has to read markdown. It lives here so
 * `plan-pi-spec.ts` keeps its bounds, placement and omission logic in one file
 * and this stays the one place that decides what the plan actually said.
 *
 * Both readers go through the one section walker below, and that is the point:
 * `plan-pi-spec-text.ts`'s `SECTION_SLICE` is a regex over raw lines, so a
 * section ends at the next line BEGINNING `## ` wherever it sits. A drafted body
 * QUOTES markdown — an angle item that shows what an issue looks like puts a real
 * `## Acceptance criteria` line inside a code sample — and the slice stops there,
 * so the criteria below it are invisible, zero bullets come back, and the mapper
 * files NO machine block at all. The silence is what makes that expensive: a
 * zero-criteria draft is a legitimate shape and the title fallback sits behind
 * the zero-criteria return, so nothing says why the block vanished.
 */
import { closesFenceLine } from "./lean/spec.ts";
import { AC_FALLBACK } from "./plan-validate.ts";

/** The line `plan-draft.ts` renders the caller's descriptor as, in `## Context & motivation`. */
const DESCRIPTOR_PREFIX = "Descriptor:";

/**
 * A first line that is a markdown block construct rather than a sentence: a
 * heading, a thematic break, a list or blockquote marker, a table row, a raw-HTML
 * block, or a fence opener. `plan-draft.ts` writes a `Descriptor:` line here, and
 * the drafter's own output is prose; what does arrive instead is a hand-edited or
 * angle-populated section whose first line is a rule, a table row or a heading.
 *
 * Such a line is refused rather than carried, for two reasons. The machine field
 * is printed UNFENCED by `lean/specify-prompt.ts` and `lean/challenge-prompt.ts`
 * between `## The problem` and the next heading, so `### Notes` in that slot is a
 * section of the oracle's brief the step never wrote — `neutraliseFenceRuns` in
 * `plan-pi-spec.ts` refuses fence RUNS in a field, never `#`, `-` or `|`. And a rule or a table row says nothing about what
 * is wrong: the issue's V2 licenses the TITLE as the fallback, not the first
 * decoration the section happens to hold. So a refusal falls through to the next
 * line, and if none survives, to the title.
 *
 * The class is deliberately narrow, and it is asked ONLY of a line the walker saw
 * OUTSIDE a code sample (see `sectionLines`' second return). A line is refused only
 * when a construct marker sits at its START and what follows is blank, a space, or
 * — for a pipe — another pipe, which is what a table row's leading cell boundary
 * looks like: `---` is a rule, `# heading` is a heading, `- item` is a bullet,
 * `> ` is a blockquote, `| a | b |` is a table row. A bullet or quote marker
 * followed directly by a WORD is kept, because an issue body that begins its section
 * with `-3 degrees is wrong` or `> the helper is wrong` is saying something, and the
 * guard's job is to refuse decoration, not to throw away the sentence that happened
 * to start with a punctuation mark. The one ordinary line this does refuse is the
 * `**bold**` opener of a section that began with an emphasis run instead of a
 * sentence — a drafter never writes one, and the fallback is the title, not a wrong
 * statement.
 */
const NOT_A_STATEMENT =
  /^(?:#{1,6}(?:\s|$)|-+|_+|=+|\*+|`{3,}|~{3,}|\[[ \/xX]?\]|<[a-zA-Z/!]|-(?=\s|$)|>(?=\s|$)|\|[^|]*\|)/;

/**
 * The classification line `plan-draft.ts` renders under the descriptor. The colon
 * may be flanked by spaces or tabs — `Type\t:` or `Type:` are both the label — and
 * a bare `Type` with no colon is a word of prose, not the classification.
 */
const TYPE_LINE = /^Type\s*:/i;

/** A line that OPENS a fenced code sample: up to 3 spaces, then 3+ of one char. */
const FENCE_OPENER = /^(?: {0,3})(?<run>`{3,}|~{3,})/;

/**
 * Whether `line` closes a sample opened by `char`/`len`.
 *
 * `lean/spec.ts`'s {@link closesFenceLine}, imported rather than restated — there
 * is deliberately NO local closer pattern in this file. This reader and that
 * module's strips judge the SAME bytes, and a closer one accepted and the other
 * refused is the drift that makes one body read two ways: a sample the strip
 * called closed (and so removed from the oracle seat) while this walk was still
 * inside it carries the sample's quoted `## Acceptance criteria` line as a
 * boundary that ends the section early — zero bullets, a legitimate shape, so
 * `piSpecFromDraft` returns before its title fallback and the draft files NO
 * machine block at all, silently.
 *
 * That is why the "nothing but whitespace after the run" half is not restated
 * here either, neither as a `[ \t]*$` nor as a `\s*$` anchor: each reader that
 * supplied that half for itself got a different tail class, and the classes differ
 * on real characters (JS treats U+2028/U+2029 as line terminators, so `.` in the
 * shared pattern does not match them, while `\s` does). The shape that separates a
 * reader that honours the length rule from one that merely looks for a fence line —
 * a four-run opener with a three-run "closer" — is pinned for both readers, here in
 * `test-plan-pi-spec-problem.ts`, there in `test-lean-spec.ts`, and the tail class
 * in `test-plan-pi-spec-fence-closer.ts`.
 *
 * The 0–3 indent is carried by the shared predicate, as it is by `FENCE_OPENER`
 * above: a sample written under a list item closes on a run indented as deeply as
 * that item's content, and a reader that recognised openers at 0–3 but closers only
 * at column 0 never closes that sample — so its lines are read as section text and a
 * bullet inside the sample is filed as a criterion, which `placePiSpecSection` then
 * embeds in the contract.
 */
const closesFence = closesFenceLine;

/** The heading line that opens a named section. */
const sectionHead = (heading: string): RegExp =>
  new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*$`);

/**
 * The raw lines of one `## <heading>` section, read the way markdown is read.
 *
 * A line only ends the section when it is a HEADING, which means it has to sit
 * OUTSIDE every code sample. So this walks the body once, tracking the fence that
 * `lean/spec.ts`'s `fencedBlocks` recognises — up to three leading spaces, a run
 * of three or more of one character, and a closer of the same character at least
 * as long — and takes nothing from inside a CLOSED sample, headings or bullets
 * alike: a `Descriptor:` line inside a sample is not the statement, and a bullet
 * inside one is not a criterion.
 *
 * An UNTERMINATED fence is not a block, which makes it the case a fence-blind
 * reader and an eat-to-end reader both get wrong, in opposite directions. The
 * scan looks ahead for the closer before it decides: a fence with one is a
 * sample and is skipped whole, a fence without one is a truncated body and every
 * line from its opener onward is ordinary text that the section keeps — and is
 * reported as such on the line's own tag, so a later reader can tell kept sample
 * text apart from a heading the author wrote. That is the contract `lean/spec.ts`'s
 * strips honour for the same bytes, and it is what keeps "a draft lost its closing
 * fence" a cosmetic difference rather than a draft that files no machine block at
 * all.
 *
 * The second element of each pair says whether the line is KEPT SAMPLE TEXT: the
 * body's own markdown, written where a code sample was opened and never closed, so
 * CommonMark reads every line from its opener to the end as text. Nothing else in
 * this module needs the distinction — criteria bullets are filtered by their marker
 * either way — and `descriptorProblem` is exactly where it matters: a section whose
 * first line is `### Notes` is decoration to fall through, but a sample that opens
 * with `### Notes` and lost its closer is kept content the reader may not silently
 * drop. The flag is carried out of the one walk that made the judgement, rather than
 * guessed again downstream. `criteriaBullets` reads the pairs and ignores it.
 *
 * The return is tuples so the fence verdict travels with the line; a caller that
 * wants the plain lines takes `.map(([l]) => l)`.
 */
export function sectionLines(body: string, heading: string): [string, boolean][] {
  const lines = body.split(/\r?\n/);
  const head = sectionHead(heading);
  const out: [string, boolean][] = [];
  let inSection = false;
  // Whether the line about to be pushed is text kept from a sample that has no
  // closer. It is a property of the LINE, not of the body, and the walk already
  // knows it: a sample with a closer is jumped whole (its lines never reach `out`
  // at all), so the only way a line gets here from inside a fence is the `continue`
  // below — the look-ahead found no closer and the lines are kept. Latching this
  // instead (one sample lost its closer, so everything below is text) is wrong in
  // the other direction: a draft whose `## Context & motivation` quotes an
  // unterminated sample then has its `## Acceptance criteria` read as sample text,
  // and the bullets of every LATER section — References, Test surface, Out of scope
  // — are filed as criteria. It is also the one fact `descriptorProblem` needs, so
  // that a heading-shaped line the AUTHOR wrote is refused as decoration while the
  // same shape kept out of an unclosed sample is carried as content.
  let keptSampleText = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const opener = FENCE_OPENER.exec(line)?.groups?.run;
    keptSampleText = false;
    if (opener !== undefined) {
      const char = opener[0] as string;
      const len = opener.length;
      // Look ahead for this fence's own closer. Without it the fence is prose and
      // the lines under it are read as prose, so the walk simply falls through
      // them; with it the whole sample is jumped, and `i` lands ON the closer so
      // the next iteration reads the line after it.
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (closesFence(lines[j] as string, char, len)) {
          end = j;
          break;
        }
      }
      // A run that is not this fence's closer is NOT jumped: the scan stays on the
      // opener's line and reads the short run as prose. Jumping to a line that
      // failed the predicate swallows everything below it, and a body that merely
      // lost the long half of its closing fence would then lose its criteria —
      // zero bullets, which is a legitimate shape, so `piSpecFromDraft` files no
      // machine block and says nothing while doing it.
      if (end >= 0) {
        i = end;
        continue;
      }
      // …and here it found none: this line is kept sample text, and the walk falls
      // through to read it and the lines under it as prose.
      keptSampleText = true;
    }
    if (!inSection) {
      if (head.test(line)) inSection = true;
      continue;
    }
    // A `## ` line ends the section only when it is a HEADING, and it is one only
    // where no sample is open — `keptSampleText` says a sample opened above and
    // never closed, so everything from there on is text, heading-shaped or not.
    if (/^## /.test(line) && !keptSampleText) break;
    // What is pushed here is either the author's own markdown or a line kept from
    // an unclosed sample — the distinction the tag carries and `descriptorProblem`
    // acts on. A line before the heading can never reach here.
    out.push([line, keptSampleText]);
  }
  return out;
}

/**
 * The statement of the problem a drafted body carries: the text of the
 * `Descriptor:` line, with its prefix removed — the sentence the plan actually
 * says is wrong, which is what the machine `problem` field should hold.
 *
 * `plan-draft.ts` renders that section as `Descriptor: …` then `Type: …`, so the
 * scan skips any `Type:` line and takes the first non-blank line that is not one
 * of the two labels — which is also what makes a body that states the descriptor
 * as bare prose yield a problem rather than the literal word `Type:`. `Type:` is
 * skipped rather than accepted: `Type: feature` is a classification, and
 * `parsePiSpec` refuses an empty `problem` but cannot tell a useless one from a
 * real one. A line that is markdown structure rather than a sentence is skipped
 * for the same reason — see `NOT_A_STATEMENT` — but only when the walker read it as
 * the author's own markdown: text kept from an UNTERMINATED sample is content, and
 * refusing it would be the eat-to-end strip this module's other tests refuse. A
 * `Descriptor:` line is read for its text FIRST, so the guard never refuses the one
 * line the drafter writes; an empty prefixed line contributes nothing and the walk
 * simply continues.
 *
 * Returns "" when the section holds none, which is the title-fallback case.
 */
export function descriptorProblem(body: string): string {
  for (const [raw, keptSampleText] of sectionLines(body, "Context & motivation")) {
    const trimmed = raw.trim();
    if (trimmed === "" || TYPE_LINE.test(trimmed)) continue;
    if (trimmed.startsWith(DESCRIPTOR_PREFIX)) {
      const text = trimmed.slice(DESCRIPTOR_PREFIX.length).trim();
      if (text !== "") return text;
      continue;
    }
    if (!keptSampleText && NOT_A_STATEMENT.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

/**
 * The `## Acceptance criteria` bullets, in order, status-only bullets dropped —
 * the criteria the machine block carries, read through the same fence-aware
 * section walker as the statement above.
 *
 * The filter is `plan-pi-spec-text.ts`'s `sectionBullets`' and has to stay in
 * step with it: `_italic_` lines are status notes, `AC_FALLBACK` is the
 * placeholder `validateDraft` refuses a plan over, and `...` is the drafter's
 * continuation marker. It is applied to lines `sectionLines` has ALREADY cut —
 * `sectionBullets` itself cannot be called on them because it slices by the same
 * fence-blind regex this reader exists to replace, and re-slicing already-sliced
 * text is how a second boundary creeps back in. What differs between the two
 * readers is only WHERE the section ends: here at a heading outside a code
 * sample, there at the next line starting `## `.
 */
export function criteriaBullets(body: string): string[] {
  return sectionLines(body, "Acceptance criteria")
    .map(([l]) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(
      (l) => l !== "" && !l.startsWith("_") && !l.startsWith(AC_FALLBACK) && !l.startsWith("..."),
    );
}
