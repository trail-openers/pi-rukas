/**
 * lean/state-outcome-spec-fields — the two fields of the derived contract in an outcome record.
 *
 * Both belong to the one save that writes the contract, so both are judged and rebuilt here: the
 * block canonicalises through the contract's own reader and takes the run's base sha beside it, or
 * drops the pair together. Split from `state-outcome.ts` so the record's owner table and the rest
 * of its fields stay one screen; the shape rules stay the record's. The base sha is taken only as
 * a full oid, the same shape `state.ts` holds the run's own to, so a truncated one is dropped
 * rather than reaching a reader.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { type DerivedSpec, canonicalDerivedSpec } from "./state-derived-spec.ts";

/** The rebuilt `derivedSpec`/`baseSha` pair, or nothing when the record carried no contract. */
export function derivedSpecOutcomeFields(oc: Record<string, unknown>): {
  derivedSpec?: DerivedSpec;
  baseSha?: string;
} {
  const derived = canonicalDerivedSpec(oc.derivedSpec);
  if (derived === undefined) return {};
  return typeof oc.baseSha === "string" && isFullCommitSha(oc.baseSha)
    ? { derivedSpec: derived, baseSha: oc.baseSha }
    : { derivedSpec: derived };
}
