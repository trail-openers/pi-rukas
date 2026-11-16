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
 *     inline form — at most three leading spaces, optional `**`, the `VERDICT`
 *     token with the shared reader's separator tolerance, then a status value
 *     (trailing text allowed) — or the heading form: `### VERDICT` alone on its
 *     line, whose value is the next non-blank line, which must be exactly one
 *     value after trimming and stripping ``**``.
 *   - **Exclusions** remove the shapes that are quotation rather than signature:
 *     a line inside a ``` or ~~~ fence (by fence parity, so an unclosed fence
 *     fences everything below it), a line indented 4+ spaces or by a tab, a
 *     `>` block quote, a `|` table row, and every line of a MENU RUN — adjacent
 *     VERDICT-token lines (blank lines between them ignored) that offer the
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
 * `readMarker`/`readEnumMarker` are deliberately unchanged. The post-verdict
 * stop's own selector and the /plan gap gate's parser read this token
 * differently and are separate concerns with their own suites; only this one
 * production read of the reviewer's reply changed.
 */

import { VERDICT_STATUSES } from "./adversarial-verdict.ts";
import type { AdversarialVerdictStatus } from "./types.ts";

/** At most three leading spaces may sit in front of an inline marker. Four is
 *  an indented code block in markdown, where every line is quotation. */
const MAX_INLINE_INDENT = 3;

/** A line that opens or closes a ``` or ~~~ fenced block. `~~~` needs three
 *  markers, like CommonMark: `~~x~~` is a strikethrough idiom, and reading two
 *  tildes as a fence would fence half a report. */
const FENCE_RE = /^ {0,3}(```|~~~)/;

/** A block quote, an indented code block (4 spaces or a tab), or a table row. */
const QUOTED_OR_TABLE_RE = /^(?:>| {4}|\t|\|)/;

/** `#{1,6} VERDICT` with optional emphasis and nothing else on the line: the
 *  heading form. Its value sits on the next non-blank line. */
const HEADING_RE = /^ {0,3}#{1,6} +\** *VERDICT *\** *$/i;

/** Everything before the status value on an inline candidate: up to three
 *  spaces, optional `**`, the token, then the shared reader's separator
 *  tolerance (optional colon, optional bold, optional colon). Written out here
 *  rather than imported so this reader and `readMarker` cannot drift on what a
 *  marker is spelled like — the one deliberate difference is that this one is
 *  ANCHORED to the start of its line, which is what makes the exclusions
 *  possible at all.
 *
 *  "Start of its line" counts the markdown decorations a line can wear in front
 *  of the marker — a `>` block-quote marker and a `|` table-cell delimiter, each
 *  optionally followed by spaces — as part of the prefix rather than as
 *  something the anchor has to swallow. Both shapes are then
 *  CANDIDATES that the quote/table exclusion refuses, which is the point of
 *  `verdictCandidateLines` marking exclusions instead of dropping lines: a
 *  reviewer whose only verdict line sits in a block quote is the difference
 *  between "said nothing" and "had a verdict, quoted away", and a prefix that
 *  simply failed to match would report the first for the second. A 4+ space
 *  indent is deliberately NOT in the prefix: at most three spaces are allowed
 *  through, so an indented marker stays a candidate its `structural` flag
 *  refuses. */
const INLINE_PREFIX = /^ {0,3}(?:>[ ]?|\|[ ]?|\**\s*)VERDICT\s*:?\s*\**\s*:?\s*/i;

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
    bareValueRe = new RegExp(
      `^\\**\\s*(${VERDICT_STATUSES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*\\**$`,
      "i",
    );
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
    inlineValueRe = new RegExp(
      `^(${VERDICT_STATUSES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`,
      "i",
    );
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
 *  the heading form? What makes a line a member of a menu run. */
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
 * marks a block quote, an indented code block or a table row; `menuRun` marks
 * every line of a run of adjacent token lines (blank lines between them
 * ignored) that names two or more distinct values and signs none of them — the
 * protocol laid out and picked from rather than a verdict somebody wrote.
 */
export interface VerdictLine {
  status: AdversarialVerdictStatus;
  index: number;
  valueIndex: number;
  fenced: boolean;
  structural: boolean;
  menuRun: boolean;
}

/** The line a token line's value sits on: its own line for the inline form, the
 *  next non-blank line for a heading, or undefined when the heading states no
 *  value. One definition, used both by the run walk's eligibility test and by
 *  the candidate pass, so the two cannot disagree about which line to judge. */
function headingValueIndex(lines: string[], index: number): number | undefined {
  const line = lines[index] as string;
  if (inlineValue(line) !== undefined) return index;
  if (!HEADING_RE.test(line)) return undefined;
  for (let j = index + 1; j < lines.length; j++) {
    if ((lines[j] as string).trim() === "") continue;
    return headingValue(lines[j] as string) === undefined ? undefined : j;
  }
  return undefined;
}

/** The value a token-bearing line states, for the menu-run count: inline form
 *  first, then the heading form's following value line. */
function tokenLineStatus(lines: string[], index: number): AdversarialVerdictStatus | undefined {
  const line = lines[index] as string;
  const inline = inlineValue(line);
  if (inline !== undefined) return inline;
  if (!HEADING_RE.test(line)) return undefined;
  for (let j = index + 1; j < lines.length; j++) {
    if ((lines[j] as string).trim() === "") continue;
    return headingValue(lines[j] as string);
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

  // The menu runs. A run is a maximal group of token-bearing lines separated from
  // each other by nothing but blank lines — the shape `buildAdversarialPrompt`
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
  // The adjacency test is what keeps this from eating an ordinary review: prose
  // between two token lines breaks the group, so "This is ISSUES_FOUND rather than
  // CRITICAL_ISSUES_FOUND …\n\nVERDICT: ISSUES_FOUND" — arguing about two verdicts
  // and then closing with one — is two runs of one line and parses. It is the same
  // distinction the live post-verdict stop draws in `blockRefusesVerdict` (#1827),
  // drawn here for the same reason: a reply that recites the protocol did not
  // choose, and this gate must not read a choice out of it.
  const menuRun = new Set<number>();
  const tokenIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTokenLine(lines[i] as string)) tokenIdx.push(i);
  }
  // Each token line's own value, judged once. A heading reads the next non-blank
  // line, which is why this cannot simply call `inlineValue`.
  const ownValue = new Map<number, AdversarialVerdictStatus | undefined>();
  for (const i of tokenIdx) ownValue.set(i, tokenLineStatus(lines, i));
  // Whether that line would survive the other exclusions on its own — the fence
  // parity and the quote/indent/table test, decided the same way the candidate
  // pass below decides them, so the two cannot disagree about what is eligible.
  const ownEligible = new Map<number, boolean>();
  for (const i of tokenIdx) {
    const line = lines[i] as string;
    const valueIndex = headingValueIndex(lines, i) ?? i;
    ownEligible.set(
      i,
      !FENCE_RE.test(line) &&
        !QUOTED_OR_TABLE_RE.test(line) &&
        (fencesAbove[valueIndex] ?? 0) % 2 === 0,
    );
  }
  let run: number[] = [];
  const flush = (): void => {
    const offered = new Set<AdversarialVerdictStatus>();
    const eligible = new Set<AdversarialVerdictStatus>();
    for (const i of run) {
      const v = ownValue.get(i);
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
    if (run.length > 0) {
      const prev = run[run.length - 1] as number;
      if (!lines.slice(prev + 1, i).every((l) => l.trim() === "")) flush();
    }
    run.push(i);
  }
  flush();

  const out: VerdictLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // A fence line is never itself a candidate: it is the delimiter, and the
    // parity below is what decides about the lines it delimits.
    if (FENCE_RE.test(line)) continue;
    let status = inlineValue(line);
    let valueIndex = i;
    if (status === undefined && HEADING_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && (lines[j] as string).trim() === "") j++;
      if (j >= lines.length) continue;
      status = headingValue(lines[j] as string);
      if (status === undefined) continue;
      valueIndex = j;
    }
    if (status === undefined) continue;
    out.push({
      status,
      index: i,
      valueIndex,
      fenced: (fencesAbove[valueIndex] ?? 0) % 2 === 1,
      // The TOKEN line decides structure: a 4-space indent, a tab or a `>` is
      // what makes the line a quotation, and for the inline form the token line
      // IS the value line. For a heading, `>` or `|` around the heading is what
      // makes the pair a quotation — an indented heading is not, because four
      // spaces in front of `### VERDICT` is a heading inside an indented block
      // either way, and the value line's own prose indentation must not silently
      // decide it.
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
 * A fenced, quoted, indented, tabled or menu-run line is not a signature, and a
 * reply whose only such lines are a recitation of the protocol states nothing:
 * undefined, which `parseVerdict` reports as `verdictParsed: false`.
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
