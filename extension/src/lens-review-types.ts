import type { Severity } from "./lens-review-format.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

/**
 * lens-review-types — the shared per-lens result shape (#1000: moved out of
 * lens-review.ts so that file stays under the 500-line limit while keeping
 * its origin/main jsdoc comments verbatim).
 *
 * `LensName` is deliberately re-exported alongside: `Finding` below is
 * typed with it, and the consumers of this module name the lens string
 * here. `LensReview` re-exports the whole set from lens-review.ts, so no
 * consumer import path changes.
 */

export type LensName = string; // deliberately unbounded — the roster is data-driven from SKILL.md frontmatter (#873)

export interface RawFinding {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
  suggestion?: string;
}

/**
 * Where a finding came from. Not every finding comes from a lens: `CLAIM_SCAN`
 * is deterministic and model-free (see `claim-scan.ts`). Labelling its output
 * as a lens's would be a false attribution in the operator's summary — the
 * exact defect class this scan exists to catch.
 */
export type FindingSource = LensName | "CLAIM_SCAN";

export interface Finding extends RawFinding {
  severity: Severity;
  lens: FindingSource;
}

/**
 * A row an earlier round recorded and this round did not resolve: still open,
 * its cited code unchanged. It is a distinct type, not a flag on `Finding`, so a
 * lens's own output can never carry the marker. Only the findings store builds
 * one (review-findings-round.ts); renderers list these under `carriedHeading`,
 * apart from this round's own findings.
 */
export interface CarriedFinding extends Finding {
  carried: true;
}

/** True when `f` is a row carried from an earlier round (see `CarriedFinding`). */
export function isCarried(f: Finding): f is CarriedFinding {
  return (f as Partial<CarriedFinding>).carried === true;
}

/**
 * The one heading every renderer uses for carried rows (summary, advisory and
 * residual comment), so the three surfaces name them the same way.
 */
export function carriedHeading(count: number, detail: string): string {
  return `Carried from earlier rounds (${count}) \u2014 ${detail}`;
}

export interface LensRunResult {
  lens: LensName;
  ok: boolean;
  ms: number;
  /**
   * #456 — wall-clock when this lens's dispatch began. Persisted via
   * `dispatch-completed.lensTimings`; sequential startMs across a pass are
   * the fingerprint of spawn-semaphore queueing (cap 1), distinct from a
   * slow-by-contamination pass.
   */
  startMs: number;
  findings: Finding[];
  model?: string;
  transcriptPath?: string;
  /** #543 — the dispatch-cap kill cause when the lens child was cap-killed
   * (loop detector / token budget). A cap-killed lens is NOT retried: an
   * SIGTERM'd looped child is a non-zero exit, and without this guard the
   * retry below would undo the kill up to MAX_LENS_ATTEMPTS times. */
  killCause?: DispatchResult["killCause"];
  /** #543 — the F1 streak evidence at a loop kill, threaded so the
   * driver's capEvidence write has the tool + count to render. */
  loopEvidence?: { tool: string; count: number };
  /** #543 — the F6 budget + used tokens at a token-budget kill, threaded
   * for the same reason. */
  tokenBudget?: { budget: number; used: number };
  /** Set when the child failed to spawn or returned non-zero. */
  parseError?: string;
  /** Number of spawn attempts made for this lens (1 = no retries; up to
   * MAX_LENS_ATTEMPTS on transient failures). #3. */
  attempts: number;
  /** True when ALL attempts failed — the lens contributes no findings and
   * the overall verdict is REVIEW_INCOMPLETE. #3. */
  blocked: boolean;
  /**
   * The child's closing prose. The lens prompt asks for it explicitly, and it
   * is the only evidence that a lens which reported no findings actually
   * looked — see `lensProducedEvidence`.
   */
  summary?: string;
  /**
   * #534 — the child's tokens/cost. Previously discarded (the per-lens
   * `result.usage` was dropped here); carried so the driver can fold the
   * six-lens pass's spend into the cycle total at the emission point.
   */
  usage?: DispatchUsage;
}
