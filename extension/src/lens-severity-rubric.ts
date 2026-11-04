/**
 * lens-severity-rubric — what a severity label has to be worth.
 *
 * Two halves, both harness-side, because the lens skills cannot police
 * themselves: four of the six ladders (simplicity, type-safety, architecture,
 * security) define HIGH by an adjective — "significant", "could lead to",
 * "impedes maintenance" — which a model can satisfy for almost any finding it
 * bothers to report. In one six-lens pass over a 7-file offline-script PR, 49
 * of 56 findings were labelled HIGH and about two were real: 17 simplicity, 13
 * type-safety, 9 security, 8 architecture. error-handling and performance were
 * calibrated (they anchor HIGH to a demonstrated failure), and the blocking bar
 * is moving to HIGH, so an inflated label is now a fix order.
 *
 *   - `SEVERITY_RUBRIC` is the floor on the EVIDENCE a HIGH requires, printed in
 *     the lens prompt beside the `report_finding` field list, where a reworded
 *     SKILL.md cannot edit it out of the child's context;
 *   - `capTestPathFindings` is the executed half, applied ONCE on the merge path
 *     (lens-review.ts) where every lens's findings are deduped and before the
 *     round is recorded, so the findings-store row — and any row a later round
 *     carries from it — holds the capped severity.
 *
 * The cap is the one class where there is no judgment to make: a finding about
 * test-only code is not a merge blocker under the rubric, and the prompt alone
 * did not hold (test-only deltas were the loudest source of inflated HIGHs in
 * the pass that motivated this).
 */

import type { Finding } from "./lens-review-types.ts";
import { isLensTestPath } from "./lens-test-path.ts";

/**
 * The severity rubric every lens is handed. One rubric for six lenses because
 * the ladders do not agree with each other.
 *
 * The floor is on evidence, not on categories: a category of code is never
 * itself high, and harm stated only as "impedes understanding" is a
 * maintainability opinion, not a failure.
 */
export const SEVERITY_RUBRIC = `## How to choose a severity

Severity is a claim about harm. The level you pick must be backed by harm you can state.

**CRITICAL or HIGH requires at least ONE of these four conditions, stated in the finding:**
  (a) a concrete, reachable failure on a realistic input — name the input and what goes wrong;
  (b) data loss or corruption;
  (c) a security exposure an attacker can actually reach — name the path to it;
  (d) a requirement stated in the issue that this diff violates.
If you cannot state one of those for THIS finding, it is not HIGH.

**A finding that meets one of (a)-(d) keeps that severity wherever the code lives** — a
reachable failure, lost data or a reachable exposure in a test file is still one.

**Cap at MEDIUM or LOW — these are nits however you label them, and they are what the cap
enforces on test paths:**
  - style, naming and typing nits (missing annotations, an untyped value, a category of code
    rather than a failure you can name);
  - duplication and dead code;
  - findings about test-only code that meet none of (a)-(d);
  - performance claims not measured on a demonstrated hot path;
  - harm stated only as "impedes understanding" or "makes maintenance harder".

This rubric OVERRIDES your lens skill wherever the two conflict, including any
severity ladder that assigns HIGH to a category of code or to maintainability
alone. Where your skill calls a class of finding HIGH and this rubric caps it,
report the severity the reachable impact of your finding actually warrants.`;

/**
 * Deterministic cap: a HIGH finding whose cited path is test code comes down to
 * MEDIUM. CRITICAL passes through — the harness does not downgrade a finding the
 * lens called critical, which is the same call the rubric reserves for the
 * reviewer — and a finding already at or below the cap is returned unchanged so
 * the provenance marker never lies about a row the cap did not move.
 *
 * Returns the SAME object when nothing moves: the marker is only ever set by
 * this pass, so `severityCapped` means "this row's severity was lowered here".
 */
export function capTestPathFinding<T extends Finding>(finding: T): T {
  if (finding.severity !== "HIGH") return finding;
  if (!isLensTestPath(finding.path)) return finding;
  return { ...finding, severity: "MEDIUM", severityCapped: "test-path" };
}

/**
 * The merge-path pass. ONE call, after `dedupeFindings` and before the round is
 * recorded against the findings memory, so the verdict, the severity counts, the
 * stored rows and any row a later round carries all read the capped severity.
 *
 * A no-op on an untouched list: a list whose every row passes through returns
 * the input array, so the pass costs nothing on the ordinary round and cannot
 * perturb the order `dedupeFindings` established.
 */
export function capTestPathFindings(findings: readonly Finding[]): Finding[] {
  if (findings.every((f) => capTestPathFinding(f) === f)) return [...findings];
  return findings.map((f) => capTestPathFinding(f));
}
