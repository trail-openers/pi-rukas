/**
 * lean/roster-base-setup-switch — the ONE reader of the lever that provisions the roster's base
 * checkout like the run's own worktree, `.pi/worktree-setup` included (`verify-roster.ts`). Off,
 * the base tree gets symlinked dependencies only. Only the literal `"0"` turns it off, read at CALL time.
 */

/** Whether the roster's base checkout runs the project's `.pi/worktree-setup`. */
export function leanRosterBaseSetupEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_ROSTER_BASE_SETUP !== "0";
}
