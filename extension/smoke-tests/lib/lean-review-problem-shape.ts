/**
 * lib/lean-review-problem-shape — the review section's payload constants, restated.
 *
 * `lean-review-problem-golden.ts` freezes the review section's own shape and must
 * not read a cap or a marker back from `lean/review-criteria.ts`: a golden that did
 * could not catch that module changing them. They are restated here rather than
 * imported, so the golden judges the renderer against a copy the renderer cannot
 * move.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

/** The cap each of the section's two payloads is bounded at — restated, not read
 * from the module under change. */
export const GOLDEN_PAYLOAD_CAP = 20_000;

/** What each payload's fence says when IT clipped. Two markers and never one: a
 * seat weighing a cut statement against a cut list has to be able to tell which
 * half of its contract it lost. Built by concatenation so this file's own prose,
 * which names them, is not matched by anything that looks for them. */
export const GOLDEN_PROBLEM_MARKER = ["…(problem", "truncated)"].join(" ");

/** The character a fence is built from, as a string: counted with `split` rather
 * than a regex, where an escape for it reads as the literal's own terminator. */
export const FENCE_CHAR = "\u0060";
