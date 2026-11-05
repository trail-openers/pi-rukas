/**
 * review-findings-reproduction — the one reader of a stored row's claimed
 * reproduction (#2040), and the rule that decides when it is unreadable.
 *
 * A `reproduction` is FILE CONTENT: `rowProblem` in review-findings-file.ts
 * refuses a row whose claim is not exactly two strings, and the cap
 * (`capUnprovenHighFinding`, lens-unproven-high.ts) treats a row with no
 * evidence as unproven. Those two rules have to agree on what "no evidence"
 * means, or a hand-edited or corrupted field can read as a claim the harness
 * should honour — which is the direction that would let a forged HIGH keep its
 * blocking power. One module states it once, for the validator and the cap
 * alike.
 */

/** The two fields a reproduction is allowed to carry, and their only type. */
interface ReproductionShape {
  command?: unknown;
  observed?: unknown;
}

/**
 * The longest claim the harness will read, per field. Both are untrusted child
 * text: `command` is compared against the child's calls and `observed` is a gate
 * no renderer prints, but the pair is PERSISTED on the findings row, so an
 * unbounded field is a lens writing megabytes into the store through one call.
 * Comfortably above any command a lens spells (the longest gate line in this
 * repo is a few hundred characters) and far below anything worth storing.
 */
export const REPRODUCTION_COMMAND_MAX = 4096;
export const REPRODUCTION_OBSERVED_MAX = 16384;

/**
 * Why a stored `reproduction` is unreadable, or undefined when it is exactly
 * what the schema says: an object with two strings. Emptiness is NOT refused
 * here — emptiness is a claim that named nothing, and it is the CAP that decides
 * what counts as evidence, so there is one rule about it rather than two. An
 * over-bound field IS refused here: the cap reads the claim through this same
 * reader, so a dropped claim caps the row rather than being compared at length.
 */
export function reproductionProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "is not an object";
  const r = v as ReproductionShape;
  if (typeof r.command !== "string") return "has no string command";
  if (typeof r.observed !== "string") return "has no string observed";
  if (r.command.length > REPRODUCTION_COMMAND_MAX) return "carries an over-long command";
  if (r.observed.length > REPRODUCTION_OBSERVED_MAX) return "carries an over-long observed";
  return undefined;
}

/**
 * The reproduction, read back off untrusted content: the same shape check as
 * `reproductionProblem`, narrowed to the type, so the extractor and the cap
 * share one definition of a well-formed claim instead of each keeping its own.
 */
export function readReproduction(v: unknown): { command: string; observed: string } | undefined {
  return reproductionProblem(v) === undefined
    ? (v as { command: string; observed: string })
    : undefined;
}
