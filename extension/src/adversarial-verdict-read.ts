/**
 * adversarial-verdict-read — which lines of a reviewer's reply are allowed to
 * state its verdict (#2312).
 *
 * `parseVerdict` used to ask the shared reader, `readEnumMarker`, what verdict
 * the WHOLE reply contained. That reader answers a different question — it
 * takes the LAST case-insensitive match anywhere in the string, deliberately:
 * a reviewer that muses "I will return VERDICT: ISSUES_FOUND if the parser is
 * wrong" and then closes with `VERDICT: APPROVED` must be read as approving
 * (#408). The rule is right for a musing and wrong for a quotation, because it
 * cannot tell the two apart: it has no idea where a line begins, that a fence
 * is open, or that the text sits in a block quote.
 *
 * The incident (job mwj6am6d-8ve1rl, PR #2304, round 2): the reviewer filed an
 * ISSUES section, wrote `VERDICT: ISSUES_FOUND`, and then, under
 * `### TESTED SCENARIOS`, wrote a bullet quoting that line as an example —
 * `` `VERDICT: APPROVED` ``. The last match was the quotation, so the loop
 * printed "Adversarial APPROVED after round 2." and wrote a `passed:true`
 * ledger row for a review that objected. No log line marked the misread.
 *
 * The fix is not another tie-break on the whole string. It is a line-level
 * question, answered once, in this module:
 *
 *   - **Candidate lines** are the lines a verdict may be read from. Either the
 *     inline form — the `VERDICT` token AT COLUMN 0, optionally preceded by up to
 *     two asterisks of emphasis IMMEDIATELY touching it, with the shared reader's
 *     separator tolerance, then a status value (trailing text allowed) — or the
 *     heading form: `### VERDICT` alone on its line at column 0, whose value is
 *     the next non-blank line, which must be exactly one value after trimming and
 *     stripping ``**``.
 *   - **Exclusions** remove the shapes that are quotation rather than signature:
 *     a line inside a ``` or ~~~ fence (by fence parity, so an unclosed fence
 *     fences everything below it), a line indented by ANY space or by a tab, a
 *     list marker (`- `, `* `, `+ `, `1. `, `1) `), a `>` block quote, a `|` table
 *     row, and every line of a MENU RUN — CONSECUTIVE VERDICT-token lines, with no
 *     blank line between them, that name two or more distinct values and offer the
 *     protocol rather than sign a verdict. See the run walk below for the exact
 *     test and for why it is not simply "two token lines, two values".
 *   - **The verdict is the LAST candidate line**, which keeps today's
 *     closing-line rule that the canary in `test-adversarial-verdict.ts` pins.
 *     No candidate line means no verdict was signed: `parseVerdict` reports
 *     `verdictParsed: false` and the loop's existing unreadable paths take it
 *     unchanged (fix round mid-loop, `incomplete` at the terminal round).
 *
 * The menu run matters on its own. A reply that carries nothing but a
 * recitation of the protocol — the brief's four lines echoed back, and no
 * verdict the reviewer signed — yields no candidate from any line of the run,
 * so it reads `verdictParsed: false`. That mirrors the live post-verdict stop's
 * `blockRefusesVerdict` refusal (`review-bounds-verdict.ts`): a reply that
 * recites the menu did not choose, and an unreadable reply is the answer this
 * gate gives when nothing signed it.
 *
 * Consecutiveness is what keeps a run from eating a real signature. A blank line
 * breaks the run, so a reviewer that echoes the menu, leaves a gap, and then
 * closes with `VERDICT: ISSUES_FOUND` is read as closing with it: the echo is one
 * block and the signature another. A rule that ignored blank lines would fold the
 * two into one run and report no verdict at all, which is the opposite of what
 * this module is for.
 *
 * `readMarker`/`readEnumMarker` are deliberately unchanged. The post-verdict
 * stop's own selector and the /plan gap gate's parser read this token
 * differently and are separate concerns with their own suites; only this one
 * production read of the reviewer's reply changed.
 */

import { VERDICT_STATUSES } from "./adversarial-verdict.ts";
import { escapeRegExpLiteral } from "./open-points-contract.ts";
import type { AdversarialVerdictStatus } from "./types.ts";

/** The four verdict values as a regex alternation, most severe first —
 *  `CRITICAL_ISSUES_FOUND` contains `ISSUES_FOUND`, so the declaration order of
 *  `VERDICT_STATUSES` is what makes the first alternative the right one. Shared
 *  by the bare and the inline value matchers below, which differ only in what
 *  they anchor on either side: two copies is how they would drift.
 *
 *  Built lazily (hence the function) because `VERDICT_STATUSES` lives in
 *  `adversarial-verdict.ts`, which imports THIS module: evaluated at module load
 *  it would read that const before its own module body has run. */
let statusAlt: string | undefined;
function statusAlt_(): string {
  if (statusAlt === undefined) statusAlt = VERDICT_STATUSES.map(escapeRegExpLiteral).join("|");
  return statusAlt;
}

/** A line that opens or closes a ``` or ~~~ fenced block. `~~~` needs three
 *  markers, like CommonMark: `~~x~~` is a strikethrough idiom, and reading two
 *  tildes as a fence would fence half a report. */
const FENCE_RE = /^ {0,3}(```|~~~)/;

/** A block quote, a table row, a line with ANY leading whitespace (a tab, one to
 *  three spaces of markdown list/paragraph slack, or the 4+ spaces that make an
 *  indented code block), or a markdown list marker. Every one of these is a line
 *  the reviewer is showing rather than signing — a quoted, tabled, bulleted or
 *  indented verdict is a quotation of somebody else's line, and the reply's own
 *  signature sits at column 0. A 4+ space indent cannot be told apart from a code
 *  block quoting a verdict, so it fails closed with the rest: unparsed, never
 *  guessed. */
const QUOTED_OR_TABLE_RE = /^(?:>|[ \t]|\||[-*+] |[0-9]+[.)] )/;

/** A markdown list marker, after any run of spaces or tabs: the line is an item
 *  of a list, which is structure, not emphasis. `* ` and `- ` at column 0 are how
 *  a reviewer files a bullet, and a bullet quoting a verdict line is the
 *  incident's own shape. */
const LIST_MARKER_RE = /^[ \t]*(?:[-*+] |[0-9]+[.)] )/;

/** `#{1,6} VERDICT` with optional emphasis and nothing else on the line: the
 *  heading form, at column 0. Its value sits on the next non-blank line. */
const HEADING_RE = /^#{1,6} +\** *VERDICT *\** *$/i;

/** Everything before the status value on an inline candidate: the token at
 *  column 0, optionally preceded by up to two asterisks of emphasis that touch
 *  it, then the shared reader's separator tolerance (optional colon, optional
 *  bold, optional colon). Written out here rather than imported so this reader
 *  and `readMarker` cannot drift on what a marker is spelled like — the one
 *  deliberate difference is that this one is ANCHORED to the start of its line,
 *  which is what makes the exclusions possible at all.
 *
 *  "Start of its line" counts the markdown decorations a line can wear in front
 *  of the marker — a `>` block-quote marker, a `|` table-cell delimiter, an
 *  indentation or a list bullet — as part of what this prefix tolerates rather
 *  than as something the anchor has to swallow. Each shape is then a
 *  CANDIDATE that the quote/table exclusion refuses, which is the point of
 *  `verdictCandidateLines` marking exclusions instead of dropping lines: a
 *  reviewer whose only verdict line sits in a block quote is the difference
 *  between "said nothing" and "had a verdict, quoted away", and a prefix that
 *  simply failed to match would report the first for the second.
 *
 *  Emphasis is `\**`, capped at two: `**VERDICT:**` and `VERDICT:** ` are what
 *  reviewers actually write, while `* VERDICT:` is a bullet — the prefix matches
 *  it and `LIST_MARKER_RE` refuses it. Every separator is `[ \t]` and never `\s`:
 *  `\s` matches a newline, and a prefix or separator that could cross one would
 *  judge a line against text that is not on it.
 *
 *  The prefix is deliberately BROAD: it also accepts leading whitespace, a list
 *  marker or a `|` table delimiter in front of the token, and the narrow column-0
 *  rule is enforced by `structural` in the candidate pass rather than by failing
 *  to match here. That is the difference between "this line was refused" and
 *  "this line never existed" — the refused shapes are what the suites assert on,
 *  and a prefix that simply did not match them would report a forged verdict as
 *  silence. `|` is never written unescaped inside this source: an unescaped one
 *  would swallow the alternation bar of the whole group, so the structural test
 *  is what carries it. */
const INLINE_PREFIX =
  /^(?:>|\||[ \t]*[-*+] |[ \t]*[0-9]+[.)] )?[ \t]*(?:\**[ \t]*)?VERDICT(?:[ \t]*:?[ \t]*\**[ \t]*:?[ \t]*)?/i;

/** The bare value form: exactly one enum value with nothing but optional
 *  emphasis around it — the spelling the heading form's value line takes. The
 *  value is matched against the enum rather than a permissive `[A-Z_]+` so a
 *  heading whose value line is prose (`APPROVED, because the gate covers it`)
 *  states no verdict; the inline form is the one that tolerates trailing text.
 *
 *  Both this and the inline value below are built lazily because
 *  `VERDICT_STATUSES` lives in `adversarial-verdict.ts`, which imports this
 *  module: built at module load they would read the const before its own module
 *  body has run. Most severe first because `CRITICAL_ISSUES_FOUND` contains
 *  `ISSUES_FOUND`, which is the order `VERDICT_STATUSES` is declared in. */
let bareValueRe: RegExp | undefined;
function bareValueRe_(): RegExp {
  if (bareValueRe === undefined) {
    bareValueRe = new RegExp(`^\\**\\s*(${statusAlt_()})\\s*\\**$`, "i");
  }
  return bareValueRe;
}

/** The status value an inline candidate states, or undefined. A line carrying
 *  the token but no in-enum value (`VERDICT: <APPROVED|…>`, a prose mention) is
 *  not a candidate; it may still be part of a menu run, which is judged on the
 *  token alone.
 *
 *  The value must be the FIRST thing after the separator, and must not open an
 *  angle-bracket placeholder: `VERDICT: <APPROVED|ISSUES_FOUND|…>` is the brief
 *  showing the reviewer its choices, and a reader that matched `APPROVED` inside
 *  it turned every reply that quotes the template into an approval. A value
 *  buried later in the line is not in marker position either — that is prose
 *  which happens to name a verdict, and the whole-reply matcher's habit of
 *  finding those is the defect this module closes. */
/** The inline value, anchored to the start of what follows the separator, built
 *  lazily for the reason given on `bareValueRe_`. */
let inlineValueRe: RegExp | undefined;
function inlineValueRe_(): RegExp {
  if (inlineValueRe === undefined) {
    inlineValueRe = new RegExp(`^(${statusAlt_()})(?![A-Za-z0-9_])`, "i");
  }
  return inlineValueRe;
}

function inlineValue(line: string): AdversarialVerdictStatus | undefined {
  const prefix = INLINE_PREFIX.exec(line);
  if (prefix === null) return undefined;
  const rest = line.slice(prefix[0].length);
  // `VERDICT: <APPROVED|ISSUES_FOUND|…>` is the brief SHOWING the reviewer its
  // choices; matching `APPROVED` inside it would read every reply that quotes the
  // template as an approval.
  if (rest.startsWith("<")) return undefined;
  // Anchored: the value must be the first thing after the separator, so a
  // verdict named later in the line is prose, not a marker. This is the one
  // place this reader is STRICTER than `readMarker`, and the two together
  // (anchored prefix + anchored value) are what make the whole-reply
  // quotation class unrepresentable. The look-ahead excludes letters, digits and
  // `_` rather than letters alone, so `ISSUES_FOUND` cannot match inside a
  // lower-case `critical_issues_found`.
  const matched = inlineValueRe_().exec(rest)?.[1];
  if (matched === undefined) return undefined;
  return VERDICT_STATUSES.find((s) => s.toLowerCase() === matched.toLowerCase());
}

/** The status value a heading's value line states: exactly one value after
 *  trimming and stripping `**`, or undefined. */
function headingValue(line: string): AdversarialVerdictStatus | undefined {
  const bare = bareValueRe_().exec(line.trim());
  const candidate = bare?.[1];
  if (candidate === undefined) return undefined;
  return VERDICT_STATUSES.find((s) => s.toLowerCase() === candidate.toLowerCase());
}

/** Does this line carry the token inside marker syntax (inline form) or is it
 *  the heading form? What makes a line a member of a menu run. A list item is not
 *  a marker line at all — it is a bullet that happens to quote one — so it neither
 *  signs nor joins a run. */
function isTokenLine(line: string): boolean {
  return INLINE_PREFIX.test(line) || HEADING_RE.test(line);
}

/** One candidate line and why it is or is not eligible to state the verdict.
 *
 * `index` is the token line's position in the reply — what the menu-run walk
 * groups on. `valueIndex` is the line whose text carries the value: the same
 * line for the inline form, the next non-blank line for a heading, whose own
 * indentation and fence position therefore govern it (D1b).
 *
 * `fenced` places `valueIndex` inside a ``` or ~~~ block by parity; `structural`
 * marks a block quote, a list item, a line with any leading whitespace or a
 * table row; `menuRun` marks every line of a run of CONSECUTIVE token lines (a
 * blank line breaks the run) that names two or more distinct values and signs
 * none of them — the protocol laid out and picked from rather than a verdict
 * somebody wrote.
 */
export interface VerdictLine {
  status: AdversarialVerdictStatus;
  index: number;
  valueIndex: number;
  fenced: boolean;
  structural: boolean;
  menuRun: boolean;
}

/** What a token line states, and on which line: `undefined` for a line that
 *  carries the token but names no value (`VERDICT: <APPROVED|…>`), otherwise the
 *  value and the line it sits on — the token's own line for the inline form, the
 *  next non-blank line for a heading, whose indentation and fence position
 *  therefore govern it.
 *
 *  ONE walk, because the run walk's eligibility test and the candidate pass must
 *  never disagree about which line to judge: they take these fields as given.
 *  The search for a heading's value stops at the first non-blank line whether or
 *  not it states one, so a heading whose value line is prose is not a value line
 *  and the search does not run on to the paragraph below it. */
/** The value a token line states, or undefined for a line that carries the token
 *  but signs nothing: a placeholder template (`VERDICT: <APPROVED|…>`), a bullet
 *  (`* VERDICT: APPROVED` — a bullet is markdown structure, not emphasis, so it
 *  never signs), or a heading whose value line is prose. The prefix still matches
 *  these shapes so the candidate pass can MARK them refused rather than let them
 *  read as a line that was never there. */
function tokenLineValue(
  lines: string[],
  index: number,
): { status: AdversarialVerdictStatus; valueIndex: number } | undefined {
  const line = lines[index] as string;
  const inline = inlineValue(line);
  if (inline !== undefined) return { status: inline, valueIndex: index };
  if (!HEADING_RE.test(line)) return undefined;
  for (let j = index + 1; j < lines.length; j++) {
    if ((lines[j] as string).trim() === "") continue;
    const status = headingValue(lines[j] as string);
    return status === undefined ? undefined : { status, valueIndex: j };
  }
  return undefined;
}

/**
 * Every candidate line of a reviewer reply, with the exclusions MARKED rather
 * than dropped.
 *
 * They are marked, not filtered, because the shapes this reader exists to
 * distinguish are invisible in a filtered list: "no candidate" and "every
 * candidate was a quotation" look identical to a caller, and between them lies
 * the difference between a reviewer that crashed and a reviewer whose verdict
 * was forged. `readAdversarialVerdict` takes the eligible ones;
 * `test-adversarial-verdict.ts` asserts on the excluded ones, which is the only
 * way a shape removed from the candidate set is ever observed failing.
 */
export function verdictCandidateLines(text: string): VerdictLine[] {
  const lines = text.split("\n");

  // Fence parity from the number of markers ABOVE each line. An unclosed fence
  // leaves every later line odd, which is D2's rule: a reply that opens a block
  // and never closes it has fenced everything below the opener.
  const fencesAbove: number[] = [];
  let fences = 0;
  for (const line of lines) {
    fencesAbove.push(fences);
    if (FENCE_RE.test(line)) fences += 1;
  }

  // The menu runs. A run is a maximal group of token-bearing lines that are
  // CONSECUTIVE — no blank line between them — the shape `buildAdversarialPrompt`
  // prints its four-line menu in, and the shape a reviewer echoes it in.
  //
  // A run is a RECITATION when it offers two or more distinct values AND still
  // offers two or more of them on lines that would otherwise have been eligible.
  // Both halves carry weight, and either alone is wrong:
  //
  //   - The distinct-value test is what makes a run a menu at all. Four lines
  //     naming four values is the protocol; the same value twice is a reviewer
  //     that wrote its verdict twice, and that still signs.
  //   - The ELIGIBLE test is what keeps a menu from swallowing a real verdict
  //     beside it. `VERDICT: APPROVED` followed by an indented
  //     `VERDICT: CRITICAL_ISSUES_FOUND` is two token lines naming two values, but
  //     the second is an indented quotation that was never eligible, so the run
  //     offers only one value a reader would accept: it is not offering a choice,
  //     it is agreeing with the line above it — and excluding that line too would
  //     turn "a quotation disagrees with the verdict" into "no verdict at all",
  //     which is the opposite of what this module is for. Where every line of a
  //     run is already excluded by another rule, the run is excluded with them
  //     (nothing is left to save), so this second test never resurrects a shape the
  //     fence or the quote rule refused.
  //
  // Consecutiveness — blank lines included — is what keeps this from eating an
  // ordinary review. Anything between two token lines breaks the group: a
  // paragraph of prose, a heading, or a blank line. "This is ISSUES_FOUND rather
  // than CRITICAL_ISSUES_FOUND …\n\nVERDICT: ISSUES_FOUND" is two runs of one line
  // and parses, and so is an echoed menu with a blank line under it and the
  // signature below that — the reviewer closed the block it was reciting and then
  // signed, which is a reviewer that chose. It is the same distinction the live
  // post-verdict stop draws in `blockRefusesVerdict` (#1827), drawn here for the
  // same reason: a reply that recites the protocol did not choose, and this gate
  // must not read a choice out of it — but neither must it refuse a choice that
  // was plainly made after the recitation ended.
  const menuRun = new Set<number>();
  // Token lines and what each one states, judged once, in one pass: the value
  // decides the run's distinct count and its `valueIndex`, and the same pair is
  // what the candidate pass reports below.
  const tokenIdx: number[] = [];
  const tokenValue = new Map<
    number,
    { status: AdversarialVerdictStatus; valueIndex: number } | undefined
  >();
  for (let i = 0; i < lines.length; i++) {
    if (!isTokenLine(lines[i] as string)) continue;
    tokenIdx.push(i);
    tokenValue.set(i, tokenLineValue(lines, i));
  }
  // Whether that line would survive the other exclusions on its own — the fence
  // parity and the quote/indent/table/list test, decided from the same pair the
  // candidate pass below reports, so the two cannot disagree about eligibility.
  const ownEligible = new Map<number, boolean>();
  for (const i of tokenIdx) {
    const line = lines[i] as string;
    ownEligible.set(
      i,
      tokenValue.get(i) !== undefined &&
        !FENCE_RE.test(line) &&
        !QUOTED_OR_TABLE_RE.test(line) &&
        (fencesAbove[tokenValue.get(i)?.valueIndex ?? i] ?? 0) % 2 === 0,
    );
  }
  let run: number[] = [];
  const flush = (): void => {
    const offered = new Set<AdversarialVerdictStatus>();
    const eligible = new Set<AdversarialVerdictStatus>();
    for (const i of run) {
      const v = tokenValue.get(i)?.status;
      if (v === undefined) continue;
      offered.add(v);
      if (ownEligible.get(i) === true) eligible.add(v);
    }
    if (run.length >= 2 && offered.size >= 2 && eligible.size >= 2) {
      for (const i of run) menuRun.add(i);
    }
    run = [];
  };
  for (const i of tokenIdx) {
    // A run continues only onto the immediately following line. Anything else —
    // a blank line included — ends it (F3).
    if (run.length > 0 && (run[run.length - 1] as number) !== i - 1) flush();
    run.push(i);
  }
  flush();

  const out: VerdictLine[] = [];
  for (const i of tokenIdx) {
    const line = lines[i] as string;
    // A fence line is never itself a candidate: it is the delimiter, and the
    // parity below is what decides about the lines it delimits.
    if (FENCE_RE.test(line)) continue;
    // Already judged, and judged once: `isTokenLine` accepted this line, so the
    // only reason it carries no value is a placeholder or a prose heading.
    const value = tokenValue.get(i);
    if (value === undefined) continue;
    out.push({
      status: value.status,
      index: i,
      valueIndex: value.valueIndex,
      fenced: (fencesAbove[value.valueIndex] ?? 0) % 2 === 1,
      // The TOKEN line decides structure: leading whitespace, a `>` or a list
      // marker is what makes the line a quotation, and for the inline form the
      // token line IS the value line. For a heading, `>` or `|` around the
      // heading is what makes the pair a quotation; an indented heading is refused
      // by the same test, because a heading that is not at column 0 is nested in
      // something — a list item or an indented block — and a nested verdict is
      // indistinguishable from a code block quoting one, so it reads as unparsed.
      structural: QUOTED_OR_TABLE_RE.test(line),
      menuRun: menuRun.has(i),
    });
  }
  return out;
}

/**
 * The verdict a reviewer's reply states, or undefined when it states none.
 *
 * The LAST eligible candidate line wins — the closing-line rule the shared
 * reader has always applied, now applied only to lines that could be signatures.
 * A fenced, quoted, indented, bulleted, tabled or menu-run line is not a
 * signature, and a reply whose only such lines are a recitation of the protocol
 * states nothing: undefined, which `parseVerdict` reports as
 * `verdictParsed: false`.
 */
export function readAdversarialVerdict(text: string): AdversarialVerdictStatus | undefined {
  const candidates = verdictCandidateLines(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i] as VerdictLine;
    if (c.fenced || c.structural || c.menuRun) continue;
    return c.status;
  }
  return undefined;
}
