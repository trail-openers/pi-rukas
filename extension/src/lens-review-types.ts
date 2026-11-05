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
  /**
   * #2040 — the evidence a HIGH claims to stand on: a command the lens child
   * actually ran, and the output it saw. A claim, not a fact: the harness
   * checks the `command` against the SAME child's recorded tool calls
   * (`capUnprovenHighFinding`, lens-severity-rubric.ts) and caps the row when
   * it does not match. `observed` is a gate, never content — no renderer
   * prints it, so untrusted child text cannot reach a prompt or a post.
   */
  reproduction?: FindingReproduction;
}

/** What a HIGH must name to keep its severity (see `RawFinding.reproduction`). */
export interface FindingReproduction {
  command: string;
  observed: string;
}

/**
 * Where a finding came from. Not every finding comes from a lens: `CLAIM_SCAN`
 * is deterministic and model-free (see `claim-scan.ts`). Labelling its output
 * as a lens's would be a false attribution in the operator's summary — the
 * exact defect class this scan exists to catch.
 */
export type FindingSource = LensName | "CLAIM_SCAN";

/**
 * Which deterministic cap moved a row. `"test-path"` — a HIGH citing test code;
 * `"unproven"` (#2040) — a HIGH whose claimed reproduction the harness could
 * not match against that lens child's own recorded tool calls.
 */
export type SeverityCap = "test-path" | "unproven";

/** True for the harness's own closed set of cap markers. One predicate for the
 * renderers and the file validator: a marker is printed or stored only when this
 * says so, so no surface can echo free text into the `(capped: …)` slot. */
export function isSeverityCap(v: unknown): v is SeverityCap {
  return v === "test-path" || v === "unproven";
}

export interface Finding extends RawFinding {
  severity: Severity;
  lens: FindingSource;
  /**
   * Set ONLY by a deterministic severity cap on a row whose HIGH it lowered to
   * MEDIUM — `"test-path"` for `capTestPathFinding`, `"unproven"` for
   * `capUnprovenHighFinding` (both in lens-severity-rubric.ts). It is the
   * harness's own provenance, not the lens's claim: a row that arrived at
   * MEDIUM from the lens carries nothing, so an operator reading a capped row
   * can tell "the lens called this medium" from "the harness overrode the
   * lens", and neither can be confused for the other in the disclosure.
   */
  severityCapped?: SeverityCap;
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
  /**
   * The no-line marker the STORED row carried (#1469). A file-level claim is
   * still one when it comes back, and the renderer's `:?` depends on the row
   * saying so — a carried row that lost it renders as a claim about code it
   * never cites. Required so the store's carry site cannot forget it silently;
   * `undefined` is the honest value for a row that cited a line.
   */
  noLine?: boolean;
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
   * #1652 — the results this child's session recorded for its calls, keyed by
   * `toolCallId`, carried alongside `toolUses` for the same reason (#2040):
   * `toolUses` is what the child ASKED for and `toolResults` is what Pi
   * accepted, so a matcher that reads only the calls counts refusals as runs.
   * Absent when the replay carried none, which the cap reads as "no ledger", not
   * as "everything failed".
   */
  toolResults?: DispatchResult["toolResults"];
  /**
   * #534 — the child's tokens/cost. Previously discarded (the per-lens
   * `result.usage` was dropped here); carried so the driver can fold the
   * six-lens pass's spend into the cycle total at the emission point.
   */
  usage?: DispatchUsage;
  /**
   * #1847 — how the lens got its skill. The PARENT read `<skillDir>/SKILL.md`
   * before the spawn and put the body in the child's prompt, so the driver
   * records the fact itself (`skill delivered inline (<skill name>)`) instead
   * of asking the child to self-report a read it was never asked to perform.
   * Absent on a row that never spawned — a blocked lens carries its
   * `parseError` (`skill not installed:` / `skill not readable:`) as the
   * evidence of what stopped it.
   */
  skillDelivered?: string;
  /**
   * #2040 — what this child's session recorded it as having asked for, kept on
   * the row so the parent can check a HIGH's claimed reproduction against the
   * child that made it (`capUnprovenHighFinding`, lens-severity-rubric.ts).
   * Per-child rather than round-wide by design: a command one lens ran is not
   * evidence for a finding another lens reported. Absent on a row that never
   * spawned, which is the same reading as an empty list — nothing was run.
   */
  toolUses?: unknown[];
}
