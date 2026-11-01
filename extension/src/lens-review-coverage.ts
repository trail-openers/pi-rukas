/**
 * lens-review-coverage — the round's coverage DENOMINATOR: the pure, model-free
 * bookkeeping behind "which files was this review supposed to examine, and does
 * its evidence speak about them?".
 *
 * `lensProducedEvidence` (lens-review-incomplete.ts) asks a different question
 * and stays asking it: "did anything come back?". A lens that stalled in
 * orientation and emitted nothing is caught there. A lens that answered
 * completely — a finding, or the closing summary the prompt requires — while
 * never mentioning one of the files the diff changed is caught by nothing,
 * because the review had no record of what it was supposed to look at. Two
 * dispatches showed the cost (a child at 20 M tokens over 111 turns before its
 * first edit; a lens child at 20.1 M tokens over 132 turns on a two-file
 * smoke-test delta), and neither was detected by the harness.
 *
 * So this module answers the other question, from recorded data only. Three
 * steps, no model call, no configuration:
 *
 *   1. `selectedFiles` — the round's expected set, from the diff the review
 *      itself resolved, through the SAME parser the advisory split judges
 *      findings with (`changedLineRanges`, review-diff.ts). One definition of
 *      "a file this change touches", so the denominator and the blocking split
 *      cannot disagree about the change set.
 *   2. `accountedFiles` — a selected file is ACCOUNTED FOR when some lens
 *      reported a finding that cites it, or wrote the closing summary the
 *      prompt requires and that summary names it. Both are things the child
 *      already had to produce; nothing new is asked of it.
 *   3. `unaccountedFiles` — expected minus accounted: a deterministic
 *      subtraction, and the only judgement it makes is whether a recorded string
 *      mentions a recorded path.
 *
 * The two kinds of claim are NOT interchangeable, and the POSITIVE coverage
 * claim reads only the strong one. A `summary` claim is a substring test over
 * prose the model wrote, so a lens that merely QUOTED a path — "Reviewed
 * `src/a.ts` and `src/b.ts`, all good" — accounts for files it may never have
 * opened. Acceptable for a DISCLOSURE (naming a gap costs nothing); a lie as a
 * WARRANTY ("every file in this round's denominator was named"), which is why
 * `hasFindingClaimedFile` exists and why the ✓ line demands it.
 *
 * What an unaccounted file DOES is decided by the caller (lens-review.ts), and
 * goes through the existing `REVIEW_INCOMPLETE` verdict — the state for "this
 * pass did not review the diff", which `lensPassed` (review-ledger.ts) already
 * refuses to record as passed and `applyLensVerdict` (work-driver-lens-verdicts.ts)
 * already parks on. No new verdict, severity, or ledger field beyond the summary
 * list that names the lanes.
 *
 * Fail-open, deliberately, and only in the direction of not inventing a
 * denominator it cannot defend: when the expected set was never computed (a
 * caller-pasted diff the review never read from git, or a diff with no readable
 * file section), `accountedFiles` returns undefined and the round is judged
 * exactly as before. That is the #1143 rule for a discount — a discount is
 * never granted on evidence that could not be read, and neither is a penalty.
 * The rule that a review which read nothing is never an approval (#384) is a
 * different rule and is untouched here: it belongs to the diff resolver, which
 * blocks on such a diff before any lens runs.
 */

import { changedLineRanges } from "./review-diff.ts";

/** A file is accounted for by a finding citing it, or by the closing summary
 * naming it. One value for both, so the operator reads how sure the witness is
 * rather than having to infer it from which section of the report it appeared in. */
export type FileAccountability = "finding" | "summary";

/**
 * The files a unified diff changes, in the same repo-relative spelling
 * `changedLineRanges` returns. A `+++ /dev/null` side contributes nothing, so a
 * deleted file is not an item a reviewer can be asked to name.
 *
 * A diff that yields no file section is returned as an EMPTY set, never as a
 * failure: a round that could not read its diff at all is blocked upstream
 * (#384), so nothing here may read emptiness as approval, and the absence of a
 * denominator is spelled by `undefined` from `accountedFiles` rather than by an
 * empty list a caller might mistake for "covered nothing".
 */
export function selectedFiles(diff: string): Set<string> {
  return new Set(changedLineRanges(diff).keys());
}

/**
 * The diff the round may be measured against: the one the review resolved
 * itself. A caller-pasted string is refused — it is not evidence of what the PR
 * changed (it omits, truncates and contradicts), which is the same reason the
 * advisory split will not judge blocking findings against one
 * (lens-review-advisory.ts). The shape check lives here, on the branch that
 * decides whether a denominator exists at all, so no caller has to remember it.
 */
export function coverageDiffOf(
  resolved: { kind: string; diffSource?: string; diff?: string } | undefined,
): string | undefined {
  if (!resolved || resolved.kind !== "ok" || resolved.diffSource !== "computed") return undefined;
  const diff = resolved.diff;
  return diff && diff.trim() !== "" ? diff : undefined;
}

/**
 * The round's expected set, or `undefined` when the round has no defensible
 * one. This is the whole question the caller asks, in one call and one type:
 * there is no half-built argument a caller can assemble wrongly (a diff
 * mistyped for a set spreads into characters, and a denominator built from
 * that would report every file as covered by a letter).
 */
export function expectedFilesOf(
  resolved: { kind: string; diffSource?: string; diff?: string } | undefined,
): Set<string> | undefined {
  const diff = coverageDiffOf(resolved);
  if (diff === undefined) return undefined;
  const files = selectedFiles(diff);
  return files.size > 0 ? files : undefined;
}

/** What `accountedFiles` reads off a lens row: the paths it reported and the
 * prose it closed with. Structural so a caller's own row shape satisfies it. */
export interface CoverageEvidence {
  findings: readonly { path: string }[];
  summary?: string;
}

/**
 * Which of `expected` this round's evidence accounts for.
 *
 * `expected` is the round's denominator — the caller passes what
 * `expectedFilesOf` computed, and nothing else: an implementation cannot let a
 * caller pick its own denominator, or the denominator stops being a gate.
 * `undefined` is returned only when that set is empty — "there is nothing to
 * check", which the caller must read as "judge the round as before", never as
 * "nothing was covered". Otherwise the returned Map is over `expected` and
 * holds only the accounted-for files, so the caller's unaccounted set is a
 * subtraction.
 */
export function accountedFiles(
  lensResults: readonly CoverageEvidence[],
  expected: ReadonlySet<string>,
): Map<string, FileAccountability> | undefined {
  if (expected.size === 0) return undefined;
  const wanted = expected;
  const out = new Map<string, FileAccountability>();
  const claim = (file: string, how: FileAccountability): void => {
    if (!wanted.has(file)) return;
    // A finding is stronger evidence than prose: never demote to `summary`.
    if (out.get(file) === "finding") return;
    out.set(file, how);
  };
  for (const r of lensResults) {
    for (const f of r.findings) {
      const path = norm(f.path);
      if (path) claim(path, "finding");
    }
    const summary = r.summary?.trim();
    if (!summary) continue;
    // Anchored, not a bare substring. The whole denominator is a handful of
    // paths and the diff is IN the lens's prompt, so a summary that recites the
    // prompt — "Reviewed `src/a.ts` and `src/b.ts`, all good", or one big code
    // fence — used to account for every file in the set without any evidence a
    // lens opened one. Requiring the path to appear as a token (bounded by
    // non-path characters) still accepts every natural way of citing a file —
    // `src/a.ts`, `a.ts`, `` `src/a.ts` ``, "(src/a.ts)", a bullet — and stops
    // the path merely being embedded inside a quoted blob of diff or prompt
    // text. The weaker guarantee for the DISCLOSURE is that a path nobody even
    // typed stays unaccounted; the POSITIVE claim additionally demands a
    // `finding`-class claim (`hasFindingClaimedFile`).
    for (const file of wanted) {
      if (out.get(file) === "finding") continue;
      if (mentionsPath(summary, file)) claim(file, "summary");
    }
  }
  return out;
}

/**
 * Does at least one file in `expected` carry a `finding`-class claim — a
 * `report_finding` call that cited it, from a lens row OR from a deterministic
 * extra finding (the `CLAIM_SCAN` witness)?
 *
 * The one place a `summary` claim must not be trusted alone. A closing summary
 * is free prose the child wrote after the fact and `accountedFiles` accepts
 * `summary.includes(file)`, so a lane that recites the diff's file list
 * accounts for every file in it without reading one. Findings are structured
 * tool calls the child had to make; a path in one is a claim about code the
 * lens located. Requiring one such claim per round is the difference between
 * "no file was left unmentioned" and "the review showed its work on at least
 * one file it was supposed to read".
 *
 * DISCLOSURE-LEVEL by design, like everything else at the file level: the
 * caller blocks nothing on it — it gates only the POSITIVE claim.
 */
export function hasFindingClaimedFile(
  lensResults: readonly CoverageEvidence[],
  expected: ReadonlySet<string>,
): boolean {
  if (expected.size === 0) return false;
  for (const r of lensResults) {
    for (const f of r.findings) {
      const path = norm(f.path);
      if (path !== "" && expected.has(path)) return true;
    }
  }
  return false;
}

/** The files the round was supposed to examine minus the ones its evidence
 * accounts for. Sorted HERE, not at the call site: an unsorted denominator's
 * report moves between runs, and a report whose order moves cannot be diffed
 * or compared across rounds. */
export function unaccountedFiles(
  expected: ReadonlySet<string>,
  accounted: ReadonlyMap<string, FileAccountability>,
): string[] {
  return Array.from(expected)
    .filter((f) => !accounted.has(f))
    .sort();
}

// The characters a real path is built from, negated: the LEFT flank. `+` sits
// INSIDE the path set on purpose — a re-emitted diff line glues `+` or `+++`
// straight onto the path (`"…\n+src/a.ts"`, `"…\n+++src/a.ts"`), and only
// because those are path characters does this flank refuse them.
const NOT_PATH: PathCharClass = "[^A-Za-z0-9_./+-]";
// What may stand AFTER a cited path and still be a citation: anything that is
// not a line break. Deliberately NOT the same set as the left flank — see the
// doc comment for why reusing it would reject every natural citation.
const NOT_LINE_BREAK = String.raw`[^\r\n]`;
// One sentence terminator: `.` `,` `;` `:` `!` `?`, or the markdown bullet `-`.
// `.` and `-` are ALSO path characters, which is exactly why the right flank
// needs this arm: with `NOT_LINE_BREAK` alone a path followed by prose already
// passes, but the ANCHORED terminator arm is what lets a path that ENDS a line
// account — and anchoring it to `\r?\n`/`$` is what stops `src/b.ts` from
// matching at the dot inside `src/b.ts.spec`.
const TERMINATOR = String.raw`[!?,.;:\-]`;
// A path character: interpolated into the right flank's negative lookahead, so
// this constant IS the single definition of what refuses to close a citation —
// `src/b.ts.spec` and `src/b.tsx` are not `src/b.ts`/`src/a.ts` named. It is
// the mirror of the left flank's `NOT_PATH`, deliberately a SEPARATE class (the
// right flank then reads `NOT_LINE_BREAK` on purpose). `-` last, in
// `String.raw`, so it stays a literal.
// The invariant the comment above promises is COMPILER-MAINTAINED, not
// comment-maintained. Chosen form: an explicit string-literal type on each
// constant. `String.raw` returns `string` and would widen the annotation away,
// so each constant is the literal itself (the classes contain no escape
// sequences, so `String.raw` and a plain literal are byte-identical here) and
// the annotation is then a real check: change a character in either class and
// `tsc` fails on that line instead of leaving the comment to assert an equality
// nobody verifies. The class CHARACTERS are unchanged, and dropping `String.raw`
// here changes nothing: neither class contains `$` or a backslash, so the tag
// was a no-op and the two forms are byte-identical (verified).
type PathCharClass = "[A-Za-z0-9_./+-]" | "[^A-Za-z0-9_./+-]";
const PATH_CHAR: PathCharClass = "[A-Za-z0-9_./+-]";

/**
 * Does `summary` NAME `file` as a path, rather than merely CONTAIN its
 * characters? See the call site: the denominator is a handful of paths and the
 * diff is IN the lens's own prompt, so an unanchored `includes` cannot tell a
 * citation apart from a recital.
 *
 * THE TWO FLANKS ARE NOT THE SAME TEST, and each carries its own load — do not
 * "simplify" them into one shared set:
 *
 *   LEFT  — `(^|NOT_PATH)`: start of the summary, or a non-path character —
 *           and a newline IS one, so a path opening at a line start is admitted
 *           by `NOT_PATH`, not by a dedicated alternative. This half alone is
 *           the recital guard: `--- a/x`, `+++ b/x`, `+++ "b/x"` and a
 *           re-emitted `"…\n+src/a.ts"` are refused here, because `-` and `+`
 *           ARE path characters and so cannot be consumed by `NOT_PATH`.
 *           `load("src/a.ts")` and `src/b.ts@default` are NOT refused by this
 *           flank at all, and not for the reason the deleted copy gave: `"` and
 *           `@` sit outside the path set, so `NOT_PATH` consumes either, but
 *           `(^|NOT_PATH)` never requires the consumed character to be the one
 *           IMMEDIATELY before the path — the match simply reopens the path at
 *           its next occurrence. Measured against the shipped regex,
 *           `load("src/a.ts")`, `src/b.ts@default`, a bare `<src/a.ts>` and
 *           `See load("src/a.ts") here` are ALL admitted.
 *           HONESTY NOTE, stated for the record: the `^` arm is what admits
 *           them — at index 0 there is no character for `NOT_PATH` to consume,
 *           and away from index 0 the arm is satisfied anywhere earlier in the
 *           string, so it cannot function as a quote/at-sign fence. The deleted
 *           copy of this block asserted all six forms were refused "HERE" and
 *           claimed BOTH flanks read the SAME `NOT_PATH` constant, which the
 *           right flank contradicts outright (it reads `NOT_LINE_BREAK`); that
 *           copy was hoisted above the `const` declarations, where TypeScript
 *           attaches a doc comment to nothing, which is how it survived
 *           unchallenged next to a block saying the opposite.
 *           `test-lens-coverage-denominator.ts` pins the `^`-arm witness.
 *   RIGHT — `NOT_LINE_BREAK(?!PATH_CHAR)`, or one `TERMINATOR` and then the end
 *           of the line or summary. Reusing the left flank's `NOT_PATH` here
 *           would reject every natural citation whose path runs into prose or a
 *           full stop ("Read src/a.ts and …", "Reviewed src/a.ts."). What makes
 *           the loose right flank safe is the negative lookahead plus the line
 *           anchor: a citation may be followed by prose, but NOT by more path
 *           characters, so `src/b.ts.spec` and `src/b.tsx` stay unaccounted
 *           rather than accounting for a shorter file — and the two are refused
 *           by DIFFERENT arms: `src/b.tsx` by the lookahead alone (`x` is a
 *           `PATH_CHAR` and no terminator precedes it), while `src/b.ts.spec` is
 *           refused only because the `TERMINATOR?(?:\r?\n|$)` arm cannot close
 *           on it either — the `.` is a legal terminator, but the arm then
 *           demands the end of line or summary and `spec` is neither. So the
 *           right flank is the lookahead OR the anchored terminator, not the
 *           lookahead alone.
 *
 * No `m` flag: `$` is the end of the WHOLE summary and `\r?\n` is the explicit
 * line end. Adding `m` would make every recited header line an end and
 * re-admit `+++ b/src/a.ts`.
 */
function mentionsPath(summary: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|${NOT_PATH})${escaped}(?:(?!${PATH_CHAR})${NOT_LINE_BREAK}|${TERMINATOR}?(?:\\r?\\n|$))`,
  );
  return re.test(summary);
}

function norm(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}
