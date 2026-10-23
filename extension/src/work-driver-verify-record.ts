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

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "./work-driver-consolidation-classify.ts";
import {
  classifyFailureLine,
  harnessInnerLine,
  isHarnessWrapper,
} from "./work-driver-verify-failures.ts";
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
 */
export function assertionLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (line: string): void => {
    if (line.length === 0 || seen.has(line)) return;
    if (extractSpecificAssertion(line) === NO_SPECIFIC_ASSERTION) return;
    seen.add(line);
    out.push(line);
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // The wrapper is not by itself an assertion candidate —
    // `extractSpecificAssertion` refuses it, and this reader must agree with
    // it — but the gate's own lines sit inside it as `\n`-separated text, and
    // each of those is offered below.
    if (!isHarnessWrapper(line)) push(line);
    const inner = harnessInnerLine(line);
    if (inner === undefined) continue;
    for (const raw2 of inner.split("\n")) push(raw2.trim());
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
