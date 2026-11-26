/**
 * lean/full-tier-operand-switch — the ONE reader of the lever deciding how wide the full-tier skip looks;
 * the rule it gates lives in `lean/verify-suite-command.ts`. On, the roster's report pair at its tail may
 * also stand for one operand naming a directory of the tree; off compares the head run's argv word for word,
 * with a glued report word and its path taken back. Only `"0"` takes it off, read at CALL time.
 */
export const leanFullTierOperandEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_FULL_TIER_OPERAND !== "0";
