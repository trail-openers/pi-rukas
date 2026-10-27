/**
 * workflow-state-events-lens-fix-fence — #1852: the lens-fix step's own record
 * that THIS round's fence could not be built, and why.
 *
 * Split from `workflow-state-schema-lens-fix-fence.ts` for the AGENTS.md §12
 * 500-line gate. The snapshot type stays with the schema it describes; this is
 * the event half, and it is the file the event's own status rendering and the
 * validator read.
 *
 * Why an event rather than a trace: the adversarial gate has to tell two
 * absent-fence states apart, and only one of them is a failure to refuse. A
 * state file written before #1852 (or a step that never ran) has no fence
 * because none was ever required — standing down is right there. A round whose
 * step TRIED to build the fence and could not has a fence that went missing, and
 * landing that round unchecked is exactly the pre-#1852 hole. The trace cannot
 * answer that question after a resume; an event can, and it is the same answer
 * on the first pass and on the second.
 *
 * It is recorded and never acts as a verdict: the gate's refusal is the cap-hit,
 * and this is the evidence that makes the gate know what silence means.
 */
export type LensFixFenceUnavailableEvent = {
  kind: "lens-fix-fence-unavailable";
  at: number;
  /** The lens review round whose fence was not built. */
  round: number;
  /** The tree the step tried to measure. */
  worktree: string;
  /** Why the build failed, in the planner's own words (never a fallback). */
  reason: string;
};
