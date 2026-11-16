/**
 * lean/spec-for — the ONE way a step reads its contract.
 *
 * Nine steps re-read the issue body and parsed it for themselves. That was fine
 * while the body was the only place a spec could come from, and it stopped being
 * fine the moment `derive` intake mode put a second source on the record: a step
 * that kept calling `parsePiSpec(body)` would go on declining a run whose
 * contract the run already held, at the exact step where a decline is expensive
 * (tests frozen, code built, PR open).
 *
 * So every caller asks this module, and one rule decides for all of them:
 *
 *   - the body's own block wins whenever it parses — an issue that carries a
 *     contract is running on the contract its author wrote, whatever else the
 *     record holds;
 *   - the persisted `derivedSpec` is used ONLY for the one reason
 *     `"no pi-spec v1 block"`, because that is the only shape `derive` mode
 *     derived for; every other parse failure returns today's failure unchanged
 *     so each caller keeps its own existing error arm (a malformed block is the
 *     author's fault and must still read as one);
 *   - with neither, the parse result is handed back verbatim — including the
 *     reason, which is what `decline` posts.
 *
 * A resumed run therefore reuses the spec it derived: nothing here re-derives,
 * and a run cannot pay for a second draft or read a contract that changed under
 * it mid-flight.
 */

import { type ParseResult, type PiSpec, parsePiSpec } from "./spec.ts";
import type { LeanRun } from "./state.ts";

/** Where the contract this run is executing came from. */
export type SpecSource = "issue" | "derived";

/** What a caller gets: the spec and its provenance, or the parse failure. */
export type SpecFor =
  | { ok: true; spec: PiSpec; source: SpecSource }
  | { ok: false; reason: string };

/** The one parse reason `derive` mode stands in for. Every other reason is the author's. */
const NO_BLOCK = "no pi-spec v1 block";

/**
 * The body's block, or the run's derived one. Never a third thing, and never a
 * fresh model call.
 */
export function specFor(body: string, run: LeanRun | Pick<LeanRun, "derivedSpec">): SpecFor {
  const parsed = parsePiSpec(body);
  if (parsed.ok) return { ok: true, spec: parsed.spec, source: "issue" };
  const held = run.derivedSpec;
  if (parsed.reason === NO_BLOCK && held !== undefined)
    return { ok: true, spec: held.spec, source: "derived" };
  return { ok: false, reason: parsed.reason };
}

/**
 * A step's read that cannot fail on a derived run: the spec, or the failure
 * text the caller already knows how to report. `specFor` is the judgement and
 * this is its two-line use, written once so nine callers do not each invent a
 * different way of unwrapping the same union.
 */
export function specOrThrow(
  body: string,
  run: LeanRun | Pick<LeanRun, "derivedSpec">,
  prefix: string,
): { spec: PiSpec; source: SpecSource } {
  const read = specFor(body, run);
  if (!read.ok) throw new Error(`${prefix}${read.reason}`);
  return { spec: read.spec, source: read.source };
}

/**
 * `specSource` is `"derived"` exactly when the record carries a derived spec.
 *
 * Read off the record rather than a closure, so a resumed run — which never ran
 * the derivation — still says where its contract came from, and a `require`-mode
 * run can never print `spec: derived` on its PR.
 */
export function specSource(run: Pick<LeanRun, "derivedSpec">): SpecSource {
  return run.derivedSpec === undefined ? "issue" : "derived";
}
