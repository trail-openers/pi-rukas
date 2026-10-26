/**
 * work-driver-verify-record — #1667: what the develop verify command gate ran,
 * and how each run failed, as the corrective-round decision reads it.
 *
 * Lives in the verify layer so the gate fills it without importing the decision
 * (work-driver-corrective-decide.ts imports this file, never the reverse). The
 * record is a discriminated union, so "the command never ran" stays distinct
 * from "it ran and nothing failed": the decision declines a round on "not-run".
 * It also holds the reading of verify output that the gate and the decision share.
 */

import { redactThenBound } from "./text-flatten.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  isNonAssertionLine,
} from "./work-driver-consolidation-classify.ts";
import { detailLooksCredential } from "./work-driver-verify-credential-screen.ts";
import { harnessInnerLine, isHarnessWrapper } from "./work-driver-verify-failures.ts";
import {
  HEADER_DETAIL_MAX,
  HEADER_DETAIL_WITHHELD,
  harvestHeaderDetails,
} from "./work-driver-verify-header-detail.ts";
import { splitLines } from "./work-driver-verify-support.ts";
import { harvestConsolidatedTallies } from "./work-driver-verify-tally.ts";
import { looksLikeMissingDeps } from "./worktree-provision.ts";

/** One verify run the gate actually made. */
export interface RanVerifyRecord {
  status: "ran";
  /** The verify command the gate ran. */
  command: string;
  /**
   * The failures the verify command block appended, in order. A subset of the
   * gate's failures: the scope and protected-path failures come before the block
   * and are not verify output, which is what this list tells apart.
   */
  failures: string[];
  /** One entry per worktree whose own verify run failed: its cwd and failure text. */
  perWorktree: Array<{ cwd: string; text: string }>;
  /** The consolidated run's raw failure stream, when that run failed. */
  consolidatedRaw?: string;
}

export type VerifyCommandRecord = { status: "not-run" } | RanVerifyRecord;

/**
 * How long one extracted assertion line may be on its way out. The table's own
 * scan window is 8 KiB, so an evidence line longer than this is a serialized
 * payload rather than an assertion, and the handoff does not need it whole.
 */
export const ASSERTION_LINE_MAX = 500;

/** The out-parameter the gate fills in place. Starts as "not-run". */
export interface VerifyRecordSlot {
  current: VerifyCommandRecord;
}

export function newVerifyRecordSlot(): VerifyRecordSlot {
  return { current: { status: "not-run" } };
}

/**
 * Every line of `text` a developer can act on: the lines the extractor accepts
 * as an assertion (a `✗` line, a compiler or linter error). Uncapped — the
 * dependency check must read every line, not the bounded subset given out.
 *
 * The #1841 `FAIL`-header DETAIL lines are NOT in this list — see
 * {@link failureEvidence} for the two channels and the lines a developer is
 * actually given.
 *
 * #1762 round 3 — two rules the wrapper's inner lines used to skip:
 *
 *   - **The #807 non-assertion / secret guard applies to every line offered,
 *     inner or not.** `extractSpecificAssertion` refuses a line that
 *     `isNonAssertionLine` rejects (a marker, an echoed `$ ` command, a
 *     credential-shaped line), but it only ever judges the SINGLE-LINE stream a
 *     wrapper carries — a multi-line inner stream yields `undefined` there and
 *     this reader unwrapped it itself, so a secret printed inside a wrapper
 *     reached the corrective-round prompt, the handoff and the forge comment
 *     unmasked. Same predicate, same text, both loops.
 *   - **`splitLines`, not `split("\n")`.** The harness flattens a multi-line
 *     gate stream into one line with `\n`, but a gate that printed `\r` line
 *     breaks leaves `\r` behind here, and an unsplit `\r` makes the trimmed
 *     line differ from what the extractor and the classifier both saw.
 *
 *   - **The tally harvest is an OPTION on this reader, not a second reader.**
 *     {@link AssertionLinesOptions}'s `harvestTallies` is what separates the two
 *     routes; everything else — dedupe, redact, rank — is one pipeline. See
 *     {@link consolidatedAssertionLines}. The harvest defaults OFF
 *     because a per-worktree record's text is `formatExecError`'s wrapper, and when
 *     the tail fits the window that wrapper KEEPS its newlines and indentation — so
 *     an unconditional harvest here read the tally block out of a per-worktree
 *     stream, joined the harness's own sentence into a SECOND evidence line
 *     (`verify command … failed in <cwd>: test.sh: failed checks (2), not run (0): lint,
 *     test/b_test.sh`) and spent a `CORRECTIVE_MAX_LINES` slot on harness prose.
 *
 *   - **The harvest reads the READER'S VIEW, never the raw text.** The
 *     `harvestTallies` option feeds {@link harvestConsolidatedTallies} the stream
 *     THIS function just walked — every wrapper line replaced by what
 *     {@link harnessInnerLine} reports behind it — not `text`. A wrapper line that
 *     carried a tally block (`… failed in <cwd>: test.sh: failed checks (2)` above
 *     two indented names) is itself the tally line the harvest anchors on, so
 *     harvesting the raw text joined the harness's own sentence into the evidence
 *     line and spent a `CORRECTIVE_MAX_LINES` slot on it (#1810's adversarial
 *     reproduction). The unwrap is the same one the per-line walk above applies, so
 *     harvest and reader can no longer disagree about what a line IS.
 *
 *   - **What comes back is REDACTED.** These lines are the evidence of a park:
 *     they reach the corrective-round prompt, the handoff and the forge comment.
 *     A failing assertion routinely ECHOES the value it compared, so every line is
 *     passed through the same redact-then-bound the commit-pr evidence reader
 *     ({@link namedFailureLines}) uses — one ordering rule for every stored verify
 *     line, so a bound cannot be applied in one reader and forgotten in another.
 */
/**
 * Options distinguishing the two routes into this reader. `harvestTallies` is the
 * route difference: the consolidated route holds the
 * gate's raw stream and so can read a script's tally block; every other route holds
 * harness prose and must not. Dedupe, redaction and ranking are shared — a second
 * reader that copies them is a reader that forgets one of them (the #1808 round found
 * exactly that). The #1841 `FAIL`-header detail harvest is NOT a route difference:
 * it runs on both, and its lines come back on the separate channel
 * {@link failureEvidence}'s `details` carries.
 */
export interface AssertionLinesOptions {
  /** Harvest indented tally name blocks and append them as joined lines. */
  harvestTallies?: boolean;
}

/**
 * The shared tail BOTH channels of this reader run through (#1841 round 2): the
 * #807 non-assertion/secret veto, then redact-then-bound, then dedupe. One
 * function, because the two channels used to spell the same three steps twice and
 * the detail channel's copy had NO credential screen of its own — so a credential
 * printed INDENTED under a `FAIL` header reached the developer prompt while the
 * same line unindented was refused.
 *
 * `veto` is the channel's own extra refusal: the assertion channel's is
 * "the shared table does not recognise this line as naming a check, or the
 * credential screen refuses it", the detail channel's is
 * `detailLooksCredential` (an unprefixed base64 PEM body, a bare
 * `Authorization: Basic …` or an `ssh-rsa AAAA…` blob survives the keyword-anchored
 * `isNonAssertionLine`, so a channel that keeps whole lines of prose has to ask the
 * opaque-run arm too). Both channels ask the credential screen (#1841 round 4, c):
 * "could this line still be credential material" is one question and the two
 * channels used to answer it differently, which is the #1841 round 2 defect mirrored
 * onto the unindented route. Both channels keep the non-assertion veto — a marker or
 * an echoed `$ ` command is not evidence on either route.
 *
 * `out` is the channel's list and `seen` the dedupe set SHARED across both, so the
 * same redacted text cannot be given twice as a header detail and an assertion.
 */
function guardedPush(
  out: string[],
  seen: Set<string>,
  line: string,
  veto: (line: string) => boolean,
): void {
  if (line.length === 0) return;
  if (isNonAssertionLine(line)) return;
  if (veto(line)) return;
  const redacted = redactThenBound(line, ASSERTION_LINE_MAX).text;
  if (redacted.length === 0 || seen.has(redacted)) return;
  seen.add(redacted);
  out.push(redacted);
}

/**
 * The assertion channel's veto: a line the shared table does not accept as an
 * assertion, or one the credential screen refuses. The screen is not redundant with
 * `isNonAssertionLine`, which anchors on a keyword and so never sees an unprefixed
 * base64 blob — the very shape this channel is asked about, because an unindented
 * credential in a gate's output is as publishable as an indented one (#1841
 * round 4, c).
 */
function notAnAssertion(line: string): boolean {
  return extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION || detailLooksCredential(line);
}

interface AssertionLinesView {
  /** The lines that NAME a failing check, in stream order, deduped and redacted. */
  lines: string[];
  /**
   * The indented detail lines of any `FAIL` header, same bounds, dedupe and
   * redaction, and screened for credentials. The developer's DIAGNOSIS — given in
   * the prompt, NEVER stored as evidence: {@link failureEvidence}'s `assertions`
   * is the one public reader for what a round may be stored from.
   */
  details: string[];
}

export function assertionLines(text: string, opts: AssertionLinesOptions = {}): string[] {
  return assertionLinesView(text, opts).lines;
}

/**
 * The ONE walker of a verify failure text. {@link assertionLines} and
 * {@link failureEvidence} are the thin readers of this, so the two channels cannot
 * be assembled by a copy that forgets the wrapper cut, the dedupe set or the
 * redaction — the #1762/#1808 defect family.
 */
function assertionLinesView(text: string, opts: AssertionLinesOptions): AssertionLinesView {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (line: string): void => guardedPush(out, seen, line, notAnAssertion);
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // The wrapper is not by itself an assertion candidate —
    // `extractSpecificAssertion` refuses it, and this reader must agree with
    // it — but the gate's own lines sit inside it as line-separated text, and
    // each of those is offered below.
    //
    // #1762 - the walk is POSITION-PRESERVING. The outer pass walks
    // `splitLines(text)` and pushes each non-wrapper line in place; a wrapper's
    // inner stream then gets its OWN `splitLines` walk immediately after it, every
    // line judged on its own and keeping its position in the stream. Inner lines
    // are never rejoined with the wrapper sentence and never re-anchored to it:
    // re-joining would put a gate line inside harness prose, which is the #798
    // defect through this door. Only the `formatExecError` wrapper is covered -
    // the smoke-tier wrapper is a different sentence, out of scope here.
    if (!isHarnessWrapper(line)) push(line);
    const inner = harnessInnerLine(line);
    if (inner === undefined) continue;
    for (const raw2 of splitLines(inner)) push(raw2.trim());
  }
  // The tally harvest is gathered HERE so it goes through the same `push` as every
  // other line: same dedupe (`seen`), same redact-then-bound, same `✗` preference.
  //
  // The reader's own view of the stream, not `text`: a wrapper line is replaced
  // by what sits behind it (empty when the wrapper carries no gate stream), so
  // the harness sentence can never be the tally the harvest anchors its join on —
  // nor the header a detail block is measured against (#1810).
  const view = splitLines(text)
    .map((l) => (isHarnessWrapper(l) ? (harnessInnerLine(l) ?? "") : l))
    .join("\n");
  // #1841 — a `FAIL  <description>` header names WHICH check went red; the lines
  // indented beneath it say what to change, and on their own they name nothing, so
  // the per-line walk above drops them. They are the developer's diagnosis and must
  // reach the corrective prompt, so they are gathered here rather than left to the
  // table. Harvested on BOTH routes (unlike the tally harvest below, which stays
  // consolidated-only) and always on this unwrapped view, so a header inside a
  // harness wrapper is measured against the gate's own text and no detail line can
  // ever open with the harness sentence (#1810's guard, which is why the harvest is
  // never handed `text`).
  //
  // They do NOT go through `push`: that gate is
  // `extractSpecificAssertion(...) !== NO_SPECIFIC_ASSERTION`, whose rule is that
  // only a line the shared table recognises as NAMING a check may be an assertion,
  // and a detail line is prose — it names nothing on its own, which is the whole
  // reason it needs a reader. Its place is beside the header, which is what earns the
  // round, so this channel stays out of `lines` and {@link failureEvidence}'s
  // `given` is what joins header and details into the lines a developer is given.
  // They run
  // through the SAME shared tail as every assertion ({@link guardedPush}: the #807
  // non-assertion/secret veto, the same redact-then-bound every other stored verify
  // line goes through, the same dedupe set), with the credential screen
  // (`detailLooksCredential`) as this channel's extra veto: an unprefixed base64
  // PEM body, a bare `Authorization: Basic …` or an `ssh-rsa AAAA…` blob survives
  // the keyword-anchored `isNonAssertionLine`, and this channel is the one place a
  // gate's indented prose is kept whole (#1841 round 2).
  const details: string[] = [];
  for (const detail of harvestHeaderDetails(view)) {
    guardedPush(details, seen, detail, detailLooksCredential);
  }
  if (opts.harvestTallies === true) {
    for (const joined of harvestConsolidatedTallies(view)) push(joined);
  }
  // A `✗` line is the assertion the operator named; when there is one, the
  // generic error lines around it are noise, not a second diagnosis. The withheld
  // marker is NOT noise: it is the disclosure that a detail block was cut short, so
  // it travels beside a `✗` line instead of being dropped with the diagnosis prose
  // (#1841 round 4, d) — an operator reading a park should still learn that the gate
  // printed something the screen refused.
  const marked = out.filter((l) => l.startsWith("\u2717"));
  const withheld = details.filter((l) => l === HEADER_DETAIL_WITHHELD);
  return {
    lines: marked.length > 0 ? marked : out,
    details: marked.length > 0 ? withheld : details,
  };
}

// #1841 round 3 (b) — the detail channel has NO reader of its own any more. The
// only caller that ever wanted the details alone was the shape suite, and it asks
// `harvestHeaderDetails` in the module that produces them; an export nothing in
// production called was a second surface for the same channel to drift on. The two
// readers that ARE asked are {@link failureEvidence} and the thin wrappers below.

/**
 * The two channels of one verify failure text, read ONCE (#1841 round 3, c).
 *
 * `decideCorrectiveRound` used to ask two readers over the same stream —
 * `assertionLines` for its gate and dependency check, a second reader for what the
 * developer is given — which walked, deduped and redacted the text twice and let
 * the two answers drift. One call returns both, and each caller says which channel
 * it is on.
 */
export interface FailureEvidence {
  /** The lines that NAME a failing check. The gate, the dependency check, and the
   * text the fence is admitted from. */
  assertions: string[];
  /** The `FAIL`-header details beside them. Prompt-only (#1841 round 2, b). */
  details: string[];
  /** Assertions then details — the lines a corrective developer is GIVEN. */
  given: string[];
}

/**
 * Read one failure text ONCE and return both channels. {@link assertionLines} and
 * {@link consolidatedAssertionLines} are the other thin readers of it; every caller
 * that needs both channels asks this one.
 */
export function failureEvidence(text: string, opts: AssertionLinesOptions = {}): FailureEvidence {
  const view = assertionLinesView(text, opts);
  return {
    assertions: view.lines,
    details: view.details,
    given: [...view.lines, ...view.details],
  };
}

/**
 * The evidence lines of a CONSOLIDATED verify run: {@link assertionLines} with
 * `harvestTallies` on — one joined line per tally block (`test.sh: failed checks
 * (2)` with the names indented beneath it) appended AFTER the assertions, so an
 * assertion the gate printed outranks a tally and the joined tally costs ONE
 * `CORRECTIVE_MAX_LINES` slot and is cut at `CORRECTIVE_LINE_MAX` like any other
 * evidence line. Names are never emitted on their own. The #1841 `FAIL`-header
 * detail harvest runs on BOTH routes, so it is not part of what this option adds.
 *
 * A one-line wrapper over the SAME reader, kept under this name because
 * `work-driver-corrective-decide.ts` and the shape suite call it. It exists so the
 * caller that knows it holds a RAW consolidated stream says so, rather than the
 * reader guessing from text that looks like a stream. The guess is what was wrong:
 * `formatExecError` keeps the tail's newlines and indentation whenever the tail
 * fits its window, so a per-worktree record can carry an indented tally block, and
 * a harvest inside {@link assertionLines} emitted a second line opening with the
 * wrapper sentence from harness prose.
 */
export function consolidatedAssertionLines(raw: string): string[] {
  return assertionLines(raw, { harvestTallies: true });
}

/**
 * #1667 — the deps hint the per-worktree verify appends. Suppressed whenever
 * assertion lines were extracted: the hint then names a cause the output does
 * not support. The exception is a dependency signature ON an extracted line —
 * that line is the diagnosis, and the hint stays with it.
 */
export function depsHintApplies(output: string): boolean {
  const lines = assertionLines(output);
  return lines.length === 0 ? looksLikeMissingDeps(output) : lines.some(looksLikeMissingDeps);
}

/**
 * #826 — the three-state per-worktree assertion for the flake-retry gate.
 * The RAW extracted assertion (a specific `✗`/error line found in the
 * failure text) or `null` when nothing assertion-shaped could be extracted
 * (honest absence, the NO_SPECIFIC_ASSERTION sentinel is NOT a known
 * assertion). Known-and-mismatching suppresses the re-run (the #821 defect);
 * unknown ALLOWS it (the pre-#826 behaviour for that case): absence on the
 * per-worktree side is not evidence the consolidated failure is an
 * independent defect.
 */
export function gatePerAssertion(failureText: string | undefined): string | null {
  if (failureText === undefined) return null;
  const extracted = extractSpecificAssertion(failureText);
  return extracted === NO_SPECIFIC_ASSERTION ? null : extracted;
}
