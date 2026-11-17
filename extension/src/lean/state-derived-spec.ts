/**
 * lean/state-derived-spec — the derived contract, and the rules for trusting one
 * that came off disk.
 *
 * The same document is read in two places, the run record and `ready`'s own step
 * outcome, and both reads are of untrusted bytes, so both go through
 * {@link derivedSpecProblem}: one rule, one implementation, no way for the readers
 * to drift. The judgement is `spec.ts`'s own reader applied to the contract's own
 * rendering plus the readiness rules `ready` applied before persisting; a spec that
 * would not survive that round trip is one the run never validated, and it is
 * refused at load like any other corruption rather than executed by the steps that
 * would each read it differently.
 */

import { type PiSpec, parsePiSpec, readiness, renderPiSpec } from "./spec.ts";

/** The persisted derivation: the spec, the model that drafted it, and the epoch ms
 * it was derived at. The spec is already validated, so a later step reads exactly
 * what `ready` accepted. */
export interface DerivedSpec {
  spec: PiSpec;
  model: string;
  at: number;
}

/** The least a renderer needs to read a contract: the run record, or just the one
 * field the accessor consults. Renderers that thread a contract source declare this
 * rather than restate it. */
export type ContractSource = { derivedSpec?: DerivedSpec };

/** A candidate derived spec, or `undefined` with the reason it is not one. The
 * result is canonicalised — `parsePiSpec`'s own object, not the caller's — so a field
 * order or an omitted optional in the file cannot leak into what the steps execute.
 * Every refusal quotes the RENDERED block: an operator told a contract was wrong
 * without being shown it cannot tell a bad derivation from a broken validator. */
export function derivedSpecProblem(value: unknown): string | undefined {
  const quoted = (reason: string): string =>
    `${reason}\n\n${renderPiSpecSafe((value as { spec: PiSpec }).spec) ?? ""}`;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "derivedSpec must be an object";
  const d = value as Record<string, unknown>;
  if (typeof d.model !== "string") return "derivedSpec.model must be a string";
  if (typeof d.at !== "number" || !Number.isFinite(d.at))
    return "derivedSpec.at must be a finite number";
  const spec = d.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec))
    return "derivedSpec.spec must be an object";
  const rendered = renderPiSpecSafe(spec as PiSpec);
  if (rendered === undefined) return "derivedSpec.spec is not a renderable pi-spec";
  const back = parsePiSpec(rendered);
  if (!back.ok) return quoted(`derivedSpec.spec does not parse: ${back.reason}`);
  if (JSON.stringify(back.spec) !== JSON.stringify(spec))
    return quoted("derivedSpec.spec does not round-trip through its own rendering");
  const unready = readiness(back.spec);
  if (unready.length > 0) return quoted(`derivedSpec.spec is not ready: ${unready.join("; ")}`);
  // Two rules the ENGINE adds to the contract's own, stated here because a persisted
  // derived contract is the only document nine steps execute that no author signed:
  // every criterion is a `test`, and there is no `scope`. The mapper
  // (`pi-spec-map.ts`) makes both true by construction, so the engine cannot produce
  // either shape — which is exactly why a record that carries one is corruption or a
  // hand edit rather than a derivation. A `command` row would license `verify` to
  // execute a string no human wrote; a `scope` would name paths no gate enforces.
  for (const c of back.spec.criteria)
    if (c.verify !== "test")
      return `derivedSpec.spec criterion ${c.id} verifies by "${c.verify}" — a derived contract is tests only`;
  if (back.spec.scope !== undefined)
    return "derivedSpec.spec declares a scope — a derived contract has none";
  return undefined;
}

/** The validated form: {@link derivedSpecProblem}'s judgement, applied. */
export function assertDerivedSpec(value: unknown): DerivedSpec {
  const problem = derivedSpecProblem(value);
  if (problem !== undefined) throw new Error(problem);
  const d = value as { spec: PiSpec; model: string; at: number };
  // Re-read through the contract's parser so the result is the reader's canonical
  // shape rather than the file's; the problem check has proved this parse succeeds.
  const canonical = parsePiSpec(renderPiSpec(d.spec));
  if (!canonical.ok) throw new Error(derivedSpecProblem(value) ?? "derivedSpec is unusable");
  return { spec: canonical.spec, model: d.model, at: d.at };
}

/** `renderPiSpec` on a value that may not be one: undefined rather than a throw. */
function renderPiSpecSafe(spec: PiSpec): string | undefined {
  try {
    return renderPiSpec(spec);
  } catch {
    return undefined;
  }
}
