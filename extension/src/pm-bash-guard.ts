/**
 * pm-bash-guard — the mode-independent `tool_call` hook that enforces PM's
 * bash allowlist in every mode (trust, strict, headless, sandbox).
 *
 * Research 2026-08-31: PM ran `gh pr create`, `gh pr checks --watch`,
 * `git commit` directly instead of dispatching to ops. Root cause: in trust
 * mode (the default on an interactive host) the agents.json allowlist is
 * decorative — the hook short-circuits before any verdict resolution, and
 * the model improvises around the sticky preamble.
 *
 * The fix mirrors issue-creation-guard.ts 1:1: a mode-independent `tool_call`
 * hook registered in registerPermissionGuard ahead of the sandbox short-circuit,
 * the subagent branch, and the trust-mode early return in the main handler —
 * so it fires in ALL modes (trust, strict, headless, sandbox), which is what
 * makes the allowlist an actual boundary instead of a decorative one. Anything the PM's agents.json bash block allows passes silently
 * (strict-mode ask becomes redundant but cheaper, and every refusal now
 * carries an actionable reason naming the correct route); everything else is
 * blocked with a refusal that tells PM to dispatch.
 *
 * PM-only by construction: the hook fires only while `isPmModeActive()` is
 * true. That flag is armed by the parent's workflow commands (the `/work`
 * family and `start_work_driver`) and is never set in a subagent process
 * (children never run a workflow command and inherit no parent module state),
 * so subagents are unaffected without an explicit role check.
 *
 * Mode-independence is load-bearing: like the issue-creation guard, the hook
 * sits BEFORE every bypass, so neither the container fence, the operator's
 * trust, nor a config overlay can reopen a door the allowlist closes.
 *
 * Fail-closed by construction: the allowlist is read from agents.json at
 * hook time via loadAgentsJson, and an unreadable/unparsable agents.json
 * yields `{}` — a PM bash block with zero patterns means EVERY command is
 * blocked, so a load failure arms the guard, never disarms it. The runtime
 * allowlist is the agents.json block itself (single source of truth; no
 * second copy that could drift).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchBashSubcommand } from "./bash-command-parser.ts";
import { loadAgentsJson } from "./permission-config.ts";
import { isPmModeActive } from "./pm-mode.ts";
import { trace } from "./trace.js";

/** Opt-out for an operator who deliberately wants the legacy ask flow. */
function pmBashGuardDisabled(): boolean {
  return process.env.PI_ENSEMBLE_PM_BASH_GUARD === "0";
}

export function registerPmBashGuard(pi: ExtensionAPI): void {
  if (pmBashGuardDisabled()) {
    trace("pm-bash-guard: PI_ENSEMBLE_PM_BASH_GUARD=0 — PM bash allowlist guard disabled");
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // PM-only: this hook never fires for subagent processes (isPmModeActive
    // is parent-session state and never set in children).
    if (!isPmModeActive()) return;
    const command = (event.input as { command?: string })?.command ?? "";
    if (command.trim() === "") return;
    const pmBash = (loadAgentsJson()["project-manager"]?.permission?.bash ?? {}) as Record<
      string,
      string
    >;
    const verdict = matchBashSubcommand(command, pmBash);
    // matchBashSubcommand returns null for injection vectors OUTSIDE quoted
    // segments — those can never auto-match an allowlist row, so they block
    // here exactly as they block under strict-mode headless resolution.
    if (verdict === "allow") return;
    trace(`pm-bash-guard: BLOCKED PM bash (mode-independent) — ${command}`);
    return {
      block: true,
      reason:
        'PM may only run bash commands on its agents.json allowlist (or none matched — including injection chains like "&&", "|", ";" and backticks). This command is not on the list. Dispatch implementation and git/mutation work to specialists instead (dispatch_specialist to ops for git/gh mutations, developer for code); only allowlisted read-only commands may run directly.',
    };
  });
}
