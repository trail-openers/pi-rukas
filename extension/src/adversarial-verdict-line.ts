/**
 * adversarial-verdict-line — the per-line patterns and judgements a reply's
 * verdict lines are read through (#2312, tightened #2322).
 *
 * Split out of `adversarial-verdict-read.ts` along the seam that module already
 * had: this file owns the question "what is a marker line, and what is it
 * wearing", and the candidate/menu-run walk that consumes it lives there. The
 * patterns are the part a reviewer's markdown spelling can surprise, so they sit
 * beside the one place they are consulted — `structuralLine` and
 * `headingValueLine` — rather than being re-derived per caller: two copies of
 * "what a quotation looks like" is how the token line and a heading's value line
 * came to be judged differently.
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
 *  `adversarial-verdict.ts`, which imports the reader that imports THIS module:
 *  evaluated at module load it would read that const before its own module body
 *  has run. */
let statusAlt: string | undefined;
function statusAlt_(): string {
  if (statusAlt === undefined) statusAlt = VERDICT_STATUSES.map(escapeRegExpLiteral).join("|");
  return statusAlt;
}

/** A line whose run of fence characters makes it a delimiter rather than prose:
 *  any leading whitespace, then a run of three or more of ONE fence character. The
 *  class holds backtick and tilde and no quantifier crosses between them, so a run
 *  that mixes the two is not a delimiter, and `~~~` needs three markers like
 *  CommonMark: `~~x~~` is a strikethrough idiom, and reading two tildes as a fence
 *  would fence half a report.
 *
 *  This is the SHAPE of a delimiter line and deliberately no more than the shape: it
 *  says nothing about what follows the run, so no spelling of an info string can make
 *  a line that opens nothing. `fencePositions` below decides the ROLE of such a line
 *  — opener, closer, or a delimiter the walk treats as an opener because no block is
 *  open — and the candidate walk in `adversarial-verdict-read.ts` asks only whether a
 *  line is a delimiter at all, since no signature begins on one. Both ask it of this
 *  one predicate rather than keeping their own pattern, which is what keeps the two
 *  from disagreeing about what a delimiter looks like.
 *
 *  The indent is `[ \t]*` rather than CommonMark's three spaces because a line
 *  indented 4+ spaces or by a tab is a fence the reviewer is QUOTING, and a reader
 *  that opened nothing there let a column-0 signature below it out-rank a real one —
 *  fencing more lines is the only direction this may ever err in. The line is
 *  ANCHORED at the start because a line that merely CONTAINS a fence run is prose,
 *  not a delimiter: `prose ``` inline` must not fence the rest of a report.
 *
 *  A reader that asks "how many of these sit above me" (a parity count) gets the
 *  direction wrong in both directions: a ``` line inside a ```` block flips the count
 *  and puts a forged signature OUTSIDE a block the reviewer pasted, and a ```js
 *  opener whose only closer is two backticks flips it back. `fencePositions` below is
 *  the walk that answers the question; this pattern is what a caller uses to recognise
 *  a delimiter line on its own. */
export const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** A delimiter line's fence character and run length, or null when the line is
 *  prose. The walk below is the only caller: it needs the run's character and
 *  length for both roles, and asks nothing else of the line. */
function fenceRun(line: string): { char: string; length: number } | null {
  const hit = FENCE_RE.exec(line);
  if (hit === null) return null;
  const run = hit[1] as string;
  return { char: run[0] as string, length: run.length };
}

/** A line that CLOSES a fenced block: the fence character written as a bare run —
 *  nothing before it but whitespace, nothing after it but whitespace. The closer
 *  rule is deliberately NARROWER than `FENCE_RE`, and the asymmetry is the point:
 *  a line that shows an info string is content the reviewer is displaying, not the
 *  end of a block, so reading one as a closer hands a forger every line beneath it
 *  (`~~~` opener, `~~~~bash` presented as its closer, then a forged signature that
 *  now sits outside the block and signs). Refusing to close can only ever fence too
 *  much, which is the one direction this reader is allowed to err in; refusing to
 *  open exposes lines, which is why the OPENER rule stays the broad `FENCE_RE`.
 *  `CLOSER_RE` is this rule and `closerRun` reads it, so the walk and the pattern
 *  cannot disagree about what a bare run looks like. */
const CLOSER_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** The run of a line that closes a block, or null when the line is content — a
 *  paragraph, or a delimiter carrying an info string. */
function closerRun(line: string): { char: string; length: number } | null {
  const hit = CLOSER_RE.exec(line);
  if (hit === null) return null;
  const run = hit[1] as string;
  return { char: run[0] as string, length: run.length };
}

/** Which side of a fenced block a line sits on, decided by a fence walk rather
 *  than a parity count.
 *
 *  `outside` — no fence was open above it. `inside` — an opener above it is still
 *  open at this line, which includes an opener the reply never closed: a reviewer
 *  that opens a block and dies mid-fence has fenced everything below it, so an
 *  unclosed fence fails closed. `fence` — the line IS a delimiter; no signature
 *  begins on one, and the caller decides what it delimits.
 *
 *  The walk is opener state plus ONE closer test, and that is the whole of it:
 *
 *   - **Opener.** With no block open, ANY delimiter line opens one of its character
 *     and run length — whatever text follows the run. CommonMark refuses a backtick
 *     opener whose info string carries a backtick, and this walk does not: a reply
 *     never needs that spelling, and treating it as a fence is the direction this
 *     reader is built to err in. The refusal was not moved from tildes to backticks
 *     — a rule with an info-string exception anywhere in it has one more spelling
 *     that opens nothing, and every one of them is a forgery that signs.
 *   - **Closer.** With a block open, a line closes it only when it is a BARE run of
 *     the SAME character, at least as long as the opener's run: whitespace on either
 *     side and nothing else (`CLOSER_RE`). A line that shows an info string is not a
 *     closer but content the reviewer is displaying — `~~~~bash` under a `~~~` block
 *     does not end it, exactly as a ``` line does not end a ```` block. The two
 *     directions are deliberately asymmetric: an opener that refuses to open EXPOSES
 *     lines, so the opener test is the broad `FENCE_RE`; a closer that refuses to
 *     close only HIDES them, so the closer test is the narrow bare-run one, and
 *     failing closed is the single error this reader may make.
 *   - **Content.** Every other line under an open block is fenced, and a block the
 *     reply never closes fences to the end of it. */
export type FencePosition = "outside" | "inside" | "fence";

export function fencePositions(lines: readonly string[]): FencePosition[] {
  const out: FencePosition[] = [];
  // undefined — no block is open. Otherwise the character and run length of the
  // opener that is still live: the walk's only state.
  let open: { char: string; length: number } | undefined;
  for (const line of lines) {
    const run = fenceRun(line);
    if (run === null) {
      out.push(open === undefined ? "outside" : "inside");
      continue;
    }
    if (open === undefined) open = run;
    else {
      // The closer is read by its own, narrower rule: a delimiter that carries an
      // info string is content under the open block, not the line that ends it.
      const closing = closerRun(line);
      if (closing !== null && closing.char === open.char && closing.length >= open.length)
        open = undefined;
    }
    out.push("fence");
  }
  return out;
}

/** The markdown emphasis run a marker may wear on either side — `\*{0,2}`, never
 *  `\**`. Two asterisks are what reviewers write (`**VERDICT:**`); three or more
 *  (`***VERDICT:***`, `***### VERDICT***`) are decoration rather than emphasis
 *  immediately touching the token, and a line no markdown renders as a marker
 *  signs nothing (#2322). ONE fragment for the three readers of a verdict line's
 *  decorations — `headingRe_`, `inlinePrefix_` and `bareValueRe_` below — because
 *  a cap edited into one and not the others is how they drifted apart once
 *  already: the token line was capped while a heading's value line kept the
 *  uncapped run, so `***APPROVED***` under a column-0 `### VERDICT` out-ranked a
 *  real signature above it (#2322 round 2). */
const EMPHASIS = String.raw`\*{0,2}`;

/** One asterisk of markdown emphasis — the piece a reviewer puts *after* the
 *  token (`VERDICT:** `), as opposed to the run *before* it, which is capped by
 *  `EMPHASIS`. */
const EMPHASIS_ONE = String.raw`\*`;

/** The separator a markdown decoration may sit in front of what it decorates:
 *  leading whitespace before a bullet or an ordinal — the indent a pasted or quoted
 *  line carries. Never `\s`, which matches a newline and would judge a line against
 *  text that is not on it. */
const DECORATION_SPACE = String.raw`[ \t]*`;

/** What may sit between an emphasis run and the token it decorates: a space, or
 *  nothing at all — but never a TAB, which `TAB_EMPHASIS_BULLET` below refuses as a
 *  list item's separator. A tab IS whitespace, so a group written `EMPHASIS[ \t]*`
 *  accepted `**\tVERDICT:` on its face while the space-form bullet groups above did
 *  not, and a line that fell between the two rules read as a clean column-0
 *  signature. A tab is a tab-stop, not a separator an author put between `**` and
 *  the word it bolds, and markdown needs the space form to be optional: `**VERDICT**`
 *  is bold and signs, so this group is `*` and not `+` (#2322). */
const EMPHASIS_SEPARATOR = String.raw` *`;

/** The emphasis run an inline token line may wear: exactly TWO asterisks — or none.
 *  One asterisk immediately touching the token is refused, and the reason is what
 *  makes it a signature rather than decoration: `*VERDICT: APPROVED` has no closing
 *  run, so markdown does not bold it — it opens a list item whose content is the
 *  token, a line the reviewer is showing under a bullet it wrote in passing. It also
 *  happens to be the single most convenient forgery, because it sits at column 0 and
 *  looks like emphasis, so it out-ranked a real `VERDICT: ISSUES_FOUND` above it.
 *  Two asterisks stay readable on both sides of the token (`**VERDICT:** APPROVED`,
 *  `**VERDICT: APPROVED**`): balanced emphasis is what a reviewer actually writes,
 *  and the shapes that sign are pinned in `test-adversarial-verdict-candidates.ts`.
 *  Three or more are refused by `EMPHASIS`'s cap, so the run admitted here is a
 *  subset of what that cap allows rather than a second opinion on it — one fragment
 *  still owns the maximum. */
const TOKEN_EMPHASIS = String.raw`\*{2}`;

/** The character that turns an inline `VERDICT:` into a table cell rather than a
 *  line of prose. Held as a constant so it is never written bare in a `new RegExp`
 *  template literal, where an unescaped one would swallow the alternation bar of
 *  the whole group; `QUOTED_OR_TABLE_RE` and `inlinePrefix_` below both take it
 *  from here. */
const TABLE_DELIMITER = String.raw`\|`;

/** The markdown list markers, each in its SPACE form (`* `, `- `, `+ `, `1. `,
 *  `1) `). Spelled once and used by the two patterns that must agree about what a
 *  list item is: `QUOTED_OR_TABLE_RE` (which marks such a line structural) and
 *  `INLINE_PREFIX`'s bullet alternatives (which must still MATCH a bulleted line so
 *  the candidate pass reports a bulleted verdict as REFUSED rather than as a line
 *  that never existed). The TAB form is refused by `TAB_LIST_MARKERS` below, not
 *  here: the space spellings are what these two groups can express. */
const LIST_BULLETS = String.raw`[-*+] `;
const LIST_ORDINALS = String.raw`[0-9]+[.)] `;

/** A markdown bullet or ordinal whose separator is a TAB (`*\t`, `+\t`, `-\t`,
 *  `1.\t`, `1)\t`) — the shape a completion writes when the reviewer tab-finishes
 *  a list item it was typing. It is a list item exactly as its space form is, and
 *  the two patterns above cannot refuse it: they require the literal space after
 *  the marker, so on `*\tVERDICT: APPROVED` neither the bullet group nor the
 *  leading-whitespace group matches, the whole decoration is skipped, and the
 *  column-0 rule would see a clean signature. This alternative matches such a
 *  line, and `structuralLine` then marks it the same way it marks every other
 *  quoted shape (#2322 AC2). The tab is never written raw in a template literal,
 *  hence the fragment. */
const TAB_LIST_MARKERS = String.raw`(?:[-*+]|[0-9]+[.)])[ 	]`;

/** The same shape one level up: a TAB-separated bullet whose marker is itself an
 *  emphasis run (`**\tVERDICT:`, `*\tVERDICT:`). `TAB_LIST_MARKERS` covers a single
 *  marker, and the emphasis cap admits two asterisks, so an emphasis run followed
 *  by a tab fell between that group and the space-form bullet groups — which demand
 *  a literal space — and the line read as a clean column-0 signature while no
 *  markdown renderer puts a token in marker position there: content behind a tab is
 *  content of a list item, not a signature. The run is written out per count rather
 *  than given the `EMPHASIS` quantifier, because a three-asterisk run is refused by
 *  its own cap and must stay NOT a token line at all — the candidate pass reports a
 *  tab-separated bullet as a MARKED refusal, and a doubly decorated decoration has
 *  to report the same silence `***VERDICT:***` already reports. Spaces may sit
 *  between the run and the tab, because the tab is still what separates the marker
 *  from its content: `** \tVERDICT:` is the same list item as `**\tVERDICT:`, and the
 *  space form of the bullet groups cannot refuse it — they stop at the space and
 *  `EMPHASIS_SEPARATOR` then swallows it, which left such a line as neither a marked
 *  bullet nor a token line, and the refusal became silence. */
const TAB_EMPHASIS_BULLET = String.raw`(?:\*\*|\*) *\t`;

/** A list marker whose separator is missing rather than a tab: `-VERDICT:`,
 *  `+VERDICT:`, `1.VERDICT:`, `1)VERDICT:`. The space-form bullet groups require a
 *  literal space and `TAB_LIST_MARKERS` requires a tab, so a marker that lost its
 *  separator entirely matches neither: the decoration is skipped and the rest of the
 *  line is judged as if it began at column 0. No markdown renders such a line as a
 *  list item, so it signs nothing — and it is a MARKED structural refusal rather than
 *  silence, because a forgery that leaves no trace in the candidate list is the one
 *  failure this reader cannot report. A single `*` is NOT in this group: `*VERDICT:`
 *  is one asterisk of emphasis touching the token, refused by the emphasis rules
 *  rather than as a list item, and marked the same way (`NOT_A_TOKEN_LINE`). */
const SEPARATORLESS_LIST_MARKER = String.raw`(?:[-+]|[0-9]+[.)])(?=VERDICT)`;

/** A block quote, a table row, a line with ANY leading whitespace (a tab, one to
 *  three spaces of markdown list/paragraph slack, or the 4+ spaces that make an
 *  indented code block), or a markdown list marker — space-separated or
 *  tab-separated. Every one of these is a line the reviewer is showing rather than
 *  signing: a quoted, tabled, bulleted or indented verdict is a quotation of
 *  somebody else's line, and the reply's own signature sits at column 0. A 4+
 *  space indent cannot be told apart from a code block quoting a verdict, so it
 *  fails closed with the rest: unparsed, never guessed. */
const QUOTED_OR_TABLE_RE = new RegExp(
  `^(?:>|[ \t]|${TABLE_DELIMITER}|${LIST_BULLETS}|${LIST_ORDINALS}|${TAB_LIST_MARKERS}|${TAB_EMPHASIS_BULLET}|${SEPARATORLESS_LIST_MARKER})`,
);

/** `#{1,6} VERDICT` with nothing else on the line: the heading form, at column 0.
 *  Its value sits on the next non-blank line. A trailing colon is the same heading
 *  (`### VERDICT:` is the spelling a reviewer copies from a menu written that way,
 *  and AC5 makes it read its value line exactly like the colon-less spelling);
 *  anything else in front of the hashes — including bold (`**### VERDICT**`) — is
 *  not a heading at column 0 and fails closed with the other quoted shapes
 *  (#2322). Built lazily so the emphasis cap stays the single `EMPHASIS` fragment
 *  above, shared with `inlinePrefix_` below. */
let headingRe: RegExp | undefined;
function headingRe_(): RegExp {
  if (headingRe === undefined) {
    headingRe = new RegExp(`^#{1,6} +${EMPHASIS_ONE}* *(?:VERDICT):? *${EMPHASIS_ONE}* *$`, "i");
  }
  return headingRe;
}

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
 *  Emphasis is the `EMPHASIS` fragment: `**VERDICT:**` and `VERDICT:** ` are what
 *  reviewers actually write, while `* VERDICT:` is a bullet and `*\tVERDICT:` is
 *  a bullet whose marker is followed by a tab — both are markdown structure, and
 *  the bullet alternatives above require a SPACE after the marker, so neither
 *  reaches the candidate list. Three or more asterisks (`***VERDICT:***`) are
 *  decoration rather than emphasis touching the token, and the group is bounded
 *  to two so a line no markdown would render as a marker signs nothing. Every
 *  separator is `[ \t]` and never `\s`:
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
 *  is what carries it.
 *
 *  A list marker that LOST its separator (`-VERDICT:`, `1.VERDICT:`) is in this
 *  prefix for exactly that reason: `QUOTED_OR_TABLE_RE` refuses the line, and a
 *  prefix that did not match it at all would leave no candidate to mark — the
 *  refusal would be invisible, which is the one outcome this reader must not
 *  produce. A single `*` immediately before the token is NOT added here: one
 *  asterisk touching the token is emphasis, and the emphasis rules refuse it by
 *  never matching, so `*VERDICT:` is no token line at all — the same silence
 *  `***VERDICT:***` already reports, and a line no markdown renders as a marker.
 *  It signs nothing either way, and the canary beside it proves it. */
let inlinePrefix: RegExp | undefined;
function inlinePrefix_(): RegExp {
  if (inlinePrefix === undefined) {
    inlinePrefix = new RegExp(
      `^(?:>|${TABLE_DELIMITER}|${DECORATION_SPACE}${LIST_BULLETS}|${DECORATION_SPACE}${LIST_ORDINALS}|${TAB_LIST_MARKERS}|${TAB_EMPHASIS_BULLET}|${SEPARATORLESS_LIST_MARKER})?[ \t]*(?:${TOKEN_EMPHASIS}${EMPHASIS_SEPARATOR})?VERDICT(?:[ \t]*:?[ \t]*${EMPHASIS_ONE}*[ \t]*:?[ \t]*)?`,
      "i",
    );
  }
  return inlinePrefix;
}

let valueToken: string | undefined;
/** A value in enum spelling, positioned the way both readers require it: at the
 *  start of what is being judged, and followed by nothing that could continue a
 *  word. ONE fragment for `bareValueRe_` and `inlineValueRe_` — a heading's value
 *  line and an inline value are the same token under the same rule, and two copies
 *  of it is how a heading came to refuse `APPROVED.` while the inline line
 *  `VERDICT: APPROVED.` signed. Everything outside the fragment — the emphasis a
 *  value may wear, the text that may trail it — is decided by the caller, so the
 *  caller decides shape and this decides vocabulary. */
function valueToken_(): string {
  if (valueToken === undefined) {
    valueToken = `(${statusAlt_()})(?![A-Za-z0-9_])`;
  }
  return valueToken;
}

/** The bare value form: one enum value at the start of the line — optional
 *  emphasis in front, then optional emphasis and any trailing text — the spelling a
 *  heading's value line takes. The value has to be the FIRST thing on the line,
 *  which is what keeps a heading over prose that merely names a verdict
 *  (`— no call yet`) unsigned while `APPROVED: no blocking issues` — a verdict with
 *  its reason — signs. That trailing tolerance is the inline form's: both spellings
 *  take their value from `valueToken_`, so neither can accept a suffix the other
 *  refuses. The value is matched against the enum rather than a permissive
 *  `[A-Z_]+` so a heading whose value line is prose states no verdict.
 *
 *  The emphasis run it strips is `EMPHASIS`, the same cap the token line wears:
 *  a value line is judged by the inline rules (#2322), so the number of asterisks
 *  it tolerates has to be the same number — otherwise `### VERDICT` over
 *  `***APPROVED***` signs while `***VERDICT:*** APPROVED` is refused, and the
 *  decoration that fails closed on one line would open the other.
 *
 *  Both this and the inline value below are built lazily because
 *  `VERDICT_STATUSES` lives in `adversarial-verdict.ts`, which imports the reader
 *  that imports this module: built at module load they would read the const before
 *  its own module body has run. Most severe first because `CRITICAL_ISSUES_FOUND`
 *  contains `ISSUES_FOUND`, which is the order `VERDICT_STATUSES` is declared
 *  in. */
let bareValueRe: RegExp | undefined;
function bareValueRe_(): RegExp {
  if (bareValueRe === undefined) {
    bareValueRe = new RegExp(`^(?:${EMPHASIS}[\\s]*)?${valueToken_()}[\\s\\S]*$`, "i");
  }
  return bareValueRe;
}

/** The inline value, anchored to the start of what follows the separator, built
 *  lazily for the reason given on `bareValueRe_`. */
let inlineValueRe: RegExp | undefined;
function inlineValueRe_(): RegExp {
  if (inlineValueRe === undefined) {
    inlineValueRe = new RegExp(`^${valueToken_()}`, "i");
  }
  return inlineValueRe;
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
export function inlineValue(line: string): AdversarialVerdictStatus | undefined {
  const prefix = inlinePrefix_().exec(line);
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

/** The status value a heading's value line states: one value at the start of the
 *  line, on a line that could itself be a signature — column 0, outside any fence
 *  — or undefined. Trailing text after the value is tolerated exactly as the inline
 *  form tolerates it (see `bareValueRe_`): a reviewer that writes its reason after
 *  the value signed a verdict, it just did not write only one word.
 *
 *  The value line is judged, not just the token line (#2322): the heading form
 *  used to ask only whether `### VERDICT` sat at column 0, so
 *  `### VERDICT\n    APPROVED` signed. An indented, bulleted, quoted or tabled
 *  value line is a reviewer SHOWING a verdict the same way an indented inline
 *  marker is, and a heading is no defence: the token line's column says nothing
 *  about the line beneath it. Both halves of the judgement come from the same
 *  per-line rules the inline form obeys, so the two forms cannot disagree about
 *  what a quotation looks like.
 *
 *  The fence test is `FENCE_RE` rather than the caller's walk, because the caller's
 *  walk is what decided about the token line: a value line that IS the ``` opener is
 *  a `fence` to that walk rather than an `inside` line, yet no signature can begin on
 *  a delimiter — and the value the reviewer meant, if it follows the opener, sits
 *  inside the block and is refused there. */
export function headingValueLine(line: string): AdversarialVerdictStatus | undefined {
  if (structuralLine(line) || FENCE_RE.test(line)) return undefined;
  const bare = bareValueRe_().exec(line.trim());
  const candidate = bare?.[1];
  if (candidate === undefined) return undefined;
  return VERDICT_STATUSES.find((s) => s.toLowerCase() === candidate.toLowerCase());
}

/** Does this line carry the token inside marker syntax (inline form) or is it
 *  the heading form? What makes a line a member of a menu run. A list item is not
 *  a marker line at all — it is a bullet that happens to quote one — so it neither
 *  signs nor joins a run. */
export function isTokenLine(line: string): boolean {
  return inlinePrefix_().test(line) || headingRe_().test(line);
}

/** Is this line structure rather than a signature — a block quote, a table row,
 *  any leading whitespace, a list marker, or a bullet followed by a TAB? The one
 *  place `QUOTED_OR_TABLE_RE` is consulted, so the token line and a heading's
 *  value line cannot be judged by different rules. */
export function structuralLine(line: string): boolean {
  return QUOTED_OR_TABLE_RE.test(line);
}
