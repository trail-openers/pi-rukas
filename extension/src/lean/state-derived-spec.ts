/**
 * lean/state-derived-spec — the derived contract, and the rules for trusting one
 * that came off disk.
 *
 * The same document is read in two places: on the run record (`ready` wrote it)
 * and on `ready`'s own step outcome (the durable verdict that produced it). Both
 * reads are of untrusted bytes, so both go through {@link assertDerivedSpec} —
 * one rule, one implementation, no chance for the two readers to diverge on what
 * a valid contract is.
 *
 * The judgement is not a shape check restated from `spec.ts`; it is the contract's
 * OWN reader applied to the contract's OWN rendering, plus the readiness rules
 * `ready` applied before persisting. A record whose spec would not survive that
 * round trip is a document the run never validated, and it is refused at load —
 * the same place every other form of corruption is refused — rather than executed
 * by nine steps that would each read it differently.
 */

import { type PiSpec, parsePiSpec, readiness, renderPiSpec } from "./spec.ts";

/**
 * The persisted derivation: the spec, the model that drafted it, and the epoch
 * ms at which the run derived it. The spec is the parsed-and-validated contract,
 * so what a later step reads is exactly what `ready` accepted.
 */
export interface DerivedSpec {
  spec: PiSpec;
  model: string;
  at: number;
}

/**
 * Validate a candidate derived spec, returning the canonicalised form the run
 * should hold — or `undefined` with the reason.
 *
 * The canonicalisation matters as much as the check: what comes back is
 * `parsePiSpec`'s own object, not the caller's, so a field order or an omitted
 * optional in the file cannot leak into what the steps execute.
 */
export function derivedSpecProblem(value: unknown): string | undefined {
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
  if (!back.ok) return `derivedSpec.spec does not parse: ${back.reason}`;
  if (JSON.stringify(back.spec) !== JSON.stringify(spec))
    return "derivedSpec.spec does not round-trip through its own rendering";
  const unready = readiness(back.spec);
  if (unready.length > 0) return `derivedSpec.spec is not ready: ${unready.join("; ")}`;
  return undefined;
}

/** The validated form: {@link derivedSpecProblem}'s judgement, applied. */
export function assertDerivedSpec(value: unknown): DerivedSpec {
  const problem = derivedSpecProblem(value);
  if (problem !== undefined) throw new Error(problem);
  const d = value as { spec: PiSpec; model: string; at: number };
  // Re-read through the contract's parser so the returned object is the reader's
  // canonical shape rather than the file's — `derivedSpecProblem` has already
  // proved this parse succeeds.
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
