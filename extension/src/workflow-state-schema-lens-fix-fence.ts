/**
 * workflow-state-schema-lens-fix-fence — #1852: the plan-time fence the lens-fix
 * round is judged against, persisted so the adversarial step's gate reads the
 * SAME value the fixer's prompt printed.
 *
 * The lens-fix step dispatches the fixer and returns; the fix is committed and
 * pushed later, from the adversarial step, after the gate approves. So the fence
 * the fixer was told about has to survive that hand-off, and the gate must not
 * rebuild it from a second reading of the tree — a fence re-derived after the
 * fact is a fence that can disagree with the one the fixer read (the #1846
 * prompt==gate contract, applied to the lens fix).
 *
 * This record is a *plan-time* snapshot: it holds only what was known before the
 * dispatch. The three values only the running round knows (`passChanged`,
 * `helperDirs`, `admittingSlots`) are filled in by `gateFenceView` at the gate,
 * which is the same permitted asymmetry the adversarial fix pass has.
 *
 * `fence` is the `FixPassFence` object itself, which is why this fragment cannot
 * import that type: `work-driver-fix-pass-admission.ts` imports the plan-fence
 * grammar, and a schema module that imported it would put a value import back
 * into the workflow-state cycle the #1362 split exists to keep out. The shape is
 * therefore spelled here, field for field, and `test-lens-fix-prompt-fence.ts`
 * asserts the two stay structurally identical, so a field added to one and not
 * the other fails the gate rather than silently widening a fence.
 */

/** The fence view the lens-fix prompt printed and the gate reads. */
export interface LensFixFenceSnapshot {
  /** Which round's lens-fix dispatch this fence bounds. */
  round: number;
  /**
   * The workstream whose `pipelineState.worktrees` entry IS the lens tree
   * (PM decision #1852-8) — the id the revert's recorded-tree gate is keyed on.
   */
  workstreamId: string;
  /**
   * The lens tree's HEAD read BEFORE the fixer was dispatched, and the value
   * the fence's delta is measured from: `committedChanges(roundTip..head)` plus
   * the tree's uncommitted and untracked changes. A full 40-hex SHA or the
   * record is refused by the gate.
   */
  roundTip: string;
  /** The ONE fence value: the prompt rendered it, the gate reads it. */
  fence: {
    id: string;
    admits: string[];
    declared: string[];
    helperDirs: string[];
    passChanged: string[];
    outOfScope: string[];
    ceiling: number;
    ceilingBasis: string;
    admittingSlots: number;
  };
  /** The fence workstream's declared paths, kept for the revert request. */
  declared: string[];
  /** The finding-named widening, kept for the same reason. */
  named: string[];
  /** Provenance set: tracked at the cycle base ∪ committed by the cycle. */
  candidates: string[];
  /** The lens findings JSON the fence's `named` widening was read from. */
  findings: string;
  /**
   * The tree the fence was built from, recorded so the gate reads the same tree
   * the prompt described instead of resolving one again by a separate lookup.
   */
  worktree: string;
}
