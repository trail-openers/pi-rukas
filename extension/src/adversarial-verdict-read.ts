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
 *     heading form: `### VERDICT` (a trailing colon and surrounding bold are the
 *     same heading) alone on its line at column 0, whose value is the next
 *     non-blank line, which must be exactly one value after trimming and stripping
 *     ``**``, and must itself be a column-0 line: the judgement below applies to
 *     the VALUE line of a heading, not only to its token line (#2322).
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
 *
 * The per-line patterns — what a marker is spelled like, and what markdown
 * decoration it is wearing — are `adversarial-verdict-line.ts`, which this walk
 * consults through `isTokenLine`/`inlineValue`/`headingValueLine`/`structuralLine`
 * so the token line and a heading's value line cannot be judged by two different
 * rules.
 */

import {
  FENCE_RE,
  headingValueLine,
  inlineValue,
  isTokenLine,
  structuralLine,
} from "./adversarial-verdict-line.ts";
import type { AdversarialVerdictStatus } from "./types.ts";

/** One candidate line and why it is or is not eligible to state the verdict.
 *
 * `index` is the token line's position in the reply — what the menu-run walk
 * groups on. `valueIndex` is the line whose text carries the value: the same
 * line for the inline form, the next non-blank line for a heading, whose own
 * indentation and fence position therefore govern it (D1b).
 *
 * `fenced` places `valueIndex` inside a ``` or ~~~ block by parity; `structural`
 * marks a block quote, a list item, a line with any leading whitespace or a
 * table row — for a heading, judged on the VALUE line as well as the token line
 * (#2322); `menuRun` marks every line of a run of CONSECUTIVE token lines (a
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
  const inline = inlineValue(lines[index] as string);
  if (inline !== undefined) return { status: inline, valueIndex: index };
  // Not an inline marker, so `isTokenLine` accepted it as the heading form; its
  // value is on the next non-blank line, and `headingValueLine` is what judges
  // that line.
  for (let j = index + 1; j < lines.length; j++) {
    if ((lines[j] as string).trim() === "") continue;
    const status = headingValueLine(lines[j] as string);
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
  // signed, which is a reviewer that chose. The four values a run is built from
  // are `VERDICT_STATUSES` — `APPROVED`, `MINOR_OBSERVATIONS`, `ISSUES_FOUND` and
  // `CRITICAL_ISSUES_FOUND` — so a reply that names all four in marker position
  // with no gap between the lines is the brief's menu recited back, and is refused
  // however a reviewer chose to indent it. It is the same distinction the live
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
    const value = tokenValue.get(i);
    ownEligible.set(
      i,
      value !== undefined &&
        !FENCE_RE.test(line) &&
        !structuralLine(line) &&
        // The heading form's value sits on its OWN line, so that line is judged
        // by the same rules as the token line: an indented or quoted value under a
        // column-0 heading is a quotation (#2322). The inline form's value line IS
        // its token line, so this term is the same test twice there.
        !structuralLine(lines[value.valueIndex] as string) &&
        (fencesAbove[value.valueIndex] ?? 0) % 2 === 0,
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
      // Nothing is exempted, not even the line that ends the run, and the reason is
      // measured rather than assumed. The obvious relaxation — let the line a run
      // stopped on sign, which is what saves a reviewer that pasted the brief's menu
      // and signed on the very next line — cannot be taken: the brief's menu ENDS on
      // `VERDICT: CRITICAL_ISSUES_FOUND`, so a reply that echoes the protocol and
      // signs nothing ends on a value, and exempting the tail reads the echo as a
      // choice (`verdictCandidateLines` of the four-line menu then leaves
      // CRITICAL_ISSUES_FOUND standing, and a menu followed by a fenced APPROVED reads
      // APPROVED). The two shapes differ only in whether a line follows the run, and
      // the run walk makes them indistinguishable: a run is maximal by construction,
      // so "a marker sits below" and "the run ended before the reply" are the same
      // test and both are true of a glued signature. Refusing the whole block is the
      // direction this gate is built to fail in — a fix round mid-loop, `incomplete`
      // at the terminal round, never a pass on a reply that chose nothing.
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
      // Structure is judged on BOTH lines of the heading form: leading whitespace,
      // a `>` or a list marker on the TOKEN line makes the pair a quotation, and so
      // does wearing them on the VALUE line — `### VERDICT` at column 0 over an
      // indented `    APPROVED` is a reviewer showing a verdict, not signing one
      // (#2322). The fence position of the value line is carried by `fenced` above.
      // For the inline form the token line IS the value line, so each test runs
      // twice on the same bytes. A heading that is not at column 0 is nested in
      // something — a list item or an indented block — and a nested verdict is
      // indistinguishable from a code block quoting one, so it reads as unparsed.
      structural: structuralLine(line) || structuralLine(lines[value.valueIndex] as string),
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
