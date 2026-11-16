/**
 * lean/spec-for — the ONE way a step reads its contract.
 *
 * Nine steps re-parsed the issue body themselves, which was fine while the body
 * was the only source and stopped being fine the moment `derive` put a second one
 * on the record: a step still calling `parsePiSpec(body)` would decline a run
 * whose contract the run already held, at the step where a decline is expensive.
 * Every caller asks this module instead, and one rule decides for all of them: the
 * body's block wins whenever it parses; the persisted `derivedSpec` stands in ONLY
 * for the `no pi-spec v1 block` reason, so every other failure returns unchanged
 * and a malformed block stays its author's fault; with neither, the parse failure
 * comes back verbatim. A resume reuses the contract it derived — nothing here
 * re-derives.
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
 * `"derived"` exactly when the record carries a derived spec — read off the record
 * rather than a closure, so a resumed run still says where its contract came from
 * and a `require` run can never print `spec: derived` on its PR.
 */
export function specSource(run: Pick<LeanRun, "derivedSpec">): SpecSource {
  return run.derivedSpec === undefined ? "issue" : "derived";
}
