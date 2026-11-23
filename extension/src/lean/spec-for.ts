/**
 * lean/spec-for — the ONE way a step reads its contract.
 *
 * A step calling `parsePiSpec(body)` itself would decline a run whose contract
 * `derive` already put on the record, at the step where a decline is expensive.
 * Every caller asks this module instead, and one rule decides for all of them: the
 * body's block wins whenever it parses; the persisted `derivedSpec` stands in ONLY
 * for the `no pi-spec v1 block` reason, so every other failure returns unchanged
 * and a malformed block stays its author's fault — including a body truncated INSIDE
 * the fence, which parses as "no block" but is the author's defect all the same and
 * is reported as one. With neither, the parse failure comes back verbatim. A resume
 * reuses the contract it derived — nothing here re-derives.
 */

import { NO_BLOCK_RULE, type PiSpec, parsePiSpec, unterminatedFenceLine } from "./spec.ts";
import type { ContractSource } from "./state-derived-spec.ts";

/** Where the contract this run is executing came from. */
export type SpecSource = "issue" | "derived";

/** What a caller gets: the spec and its provenance, or the parse failure. */
export type SpecFor =
  | { ok: true; spec: PiSpec; source: SpecSource }
  | { ok: false; reason: string };

/** The reason a body cut off inside a fence is reported, in every mode. */
const UNTERMINATED = "pi-spec v1 block is not valid JSON: the fence it sits in was never closed";

/** The body's block, or the run's derived one. Never a third thing, and never a
 * fresh model call. */
export function specFor(body: string, run: ContractSource): SpecFor {
  const parsed = parsePiSpec(body);
  if (parsed.ok) return { ok: true, spec: parsed.spec, source: "issue" };
  const held = run.derivedSpec;
  if (parsed.reason !== NO_BLOCK_RULE || held === undefined)
    return { ok: false, reason: parsed.reason };
  // "No block" has two causes and only one is the record's to cover for: a body that
  // never carried a contract, and a body TRUNCATED inside one. `fencedBlocks` refuses
  // to call an unclosed fence a block, so the second reads as the first and the
  // accessor would hand every step a machine-written contract over the author's
  // clipped one. The line test is `parsePiSpec`'s own predicate, so both modes name
  // the author's defect in the author's words.
  if (unterminatedFenceLine(body) !== undefined) return { ok: false, reason: UNTERMINATED };
  return { ok: true, spec: held.spec, source: "derived" };
}

/** `"derived"` exactly when the record carries a derived spec — read off the record,
 * not a closure, so a resumed run still says where its contract came from and a
 * `require` run can never print `spec: derived` on its PR. */
export function specSource(run: ContractSource): SpecSource {
  return run.derivedSpec === undefined ? "issue" : "derived";
}

/**
 * The issue re-read for a step, and its contract: an unread body or an unusable spec
 * is infrastructure, thrown as `fail(message)`. The body is the SAME fetch the spec
 * was parsed from, kept for the child's brief — never a second one (`lean/issue-prose.ts`).
 */
export async function rereadSpec(
  fetchBody: () => Promise<string>,
  run: ContractSource,
  fail: (message: string) => Error,
): Promise<{ spec: PiSpec; body: string }> {
  let body: string;
  try {
    body = await fetchBody();
  } catch (err) {
    throw fail(`could not read the issue: ${(err as Error).message}`);
  }
  const read = specFor(body, run);
  if (!read.ok) throw fail(`the issue's spec is unusable: ${read.reason}`);
  return { spec: read.spec, body };
}
