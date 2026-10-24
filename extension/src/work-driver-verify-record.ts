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
import {
  classifyFailureLine,
  harnessInnerLine,
  isHarnessWrapper,
} from "./work-driver-verify-failures.ts";
import { splitLines } from "./work-driver-verify-support.ts";
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
const ASSERTION_LINE_MAX = 500;

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
 *   - **What comes back is REDACTED.** These lines are the evidence of a park:
 *     they reach the corrective-round prompt, the handoff and the forge comment.
 *     A failing assertion routinely ECHOES the value it compared, so every line is
 *     passed through the same redact-then-bound the commit-pr evidence reader
 *     ({@link namedFailureLines}) uses — one ordering rule for every stored verify
 *     line, so a bound cannot be applied in one reader and forgotten in another.
 */
export function assertionLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (line: string): void => {
    if (line.length === 0) return;
    if (extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION) return;
    // An UNWRAPPED inner line never passes through `extractSpecificAssertion`'s
    // own guard, because the extractor refuses a multi-line stream and this
    // function unwraps it. The guard is applied here so both routes answer the
    // same way for the same text.
    if (isNonAssertionLine(line)) return;
    const redacted = redactThenBound(line, ASSERTION_LINE_MAX).text;
    if (redacted.length === 0 || seen.has(redacted)) return;
    seen.add(redacted);
    out.push(redacted);
  };
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // The wrapper is not by itself an assertion candidate —
    // `extractSpecificAssertion` refuses it, and this reader must agree with
    // it — but the gate's own lines sit inside it as line-separated text, and
    // each of those is offered below.
    if (!isHarnessWrapper(line)) push(line);
    const inner = harnessInnerLine(line);
    if (inner === undefined) continue;
    for (const raw2 of splitLines(inner)) push(raw2.trim());
  }
  // A `✗` line is the assertion the operator named; when there is one, the
  // generic error lines around it are noise, not a second diagnosis.
  const marked = out.filter((l) => l.startsWith("\u2717"));
  return marked.length > 0 ? marked : out;
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
