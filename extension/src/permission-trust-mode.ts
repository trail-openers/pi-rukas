/**
 * Trust-mode readers — the one question the permission layer asks the
 * environment: is there a boundary worth enforcing here?
 *
 * Split out of permission-guard.ts to keep that module under the 500-line
 * cap (AGENTS.md §12), following the same seam as #171's bash-command-parser
 * and permission-decision-cache splits. Both guards consult these, and spawn
 * .ts asks the parent's verdict before deciding what to forward into a child.
 *
 * The three states, and why two of them short-circuit everything:
 *   1. Sandbox (PI_ENSEMBLE_SANDBOX_MODE=1) — the container fence IS the trust
 *      boundary; per-call prompts are theatre inside a disposable container.
 *   2. Interactive host (hasUI=true, no strict opt-in) — the parent runs as
 *      the user's own UID with the user's own credentials, so per-call prompts
 *      give zero meaningful protection while emitting ~30 prompts/minute and
 *      training users to rubber-stamp. Honest answer: trust the agent or
 *      don't run it.
 *   3. Headless (no UI) — STAYS strict. No human present to consent, so `ask`
 *      verdicts hard-deny; CI/cron contexts are genuinely adversarial.
 *
 * Because 1 and 2 are the DEFAULTS in their environments, any refusal that has
 * to hold anyway is a mode-independent `tool_call` hook registered before those
 * short-circuits — the set in subagent-guard-guards.ts, which #1437's
 * memory-write-guard.ts joined.
 *
 * Opt-in escape hatch: PI_ENSEMBLE_STRICT_PERMISSIONS=1 restores the legacy
 * ask-flow for users who actively want it back in interactive host mode.
 */

/**
 * Does this process resolve to trust mode — i.e. should per-call gating be
 * skipped? `hasUI` is Pi's `ctx.hasUI`.
 */
export function isInTrustMode(hasUI: boolean): boolean {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_TRUST_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_STRICT_PERMISSIONS === "1") return false;
  return hasUI;
}

/**
 * The parent's trust-mode status, for spawn.ts. `parentHasUI` is the parent
 * session's `ctx.hasUI`, captured at session_start; when it is missing (a very
 * early spawn) assume strict to fail safe — the subagent then uses the broker
 * fallback, which is the correct behaviour.
 */
export function parentTrustMode(parentHasUI: boolean | undefined): boolean {
  if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") return true;
  if (process.env.PI_ENSEMBLE_STRICT_PERMISSIONS === "1") return false;
  return parentHasUI === true;
}
