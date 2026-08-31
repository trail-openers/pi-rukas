/**
 * issue-creation-guard — the mode-independent `tool_call` hook that refuses
 * agent-driven GitHub issue creation.
 *
 * The incident: PM filed three non-trivial issues inline in one session
 * (#591, #592, #594) — no adversarial gap gate, no user confirmation, no
 * structured spec body for /work to consume. The existing "triviality test"
 * in PM doctrine is self-judged with no oracle, and trust mode (the default
 * on an interactive host) makes agents.json deny rules decorative.
 *
 * The fix follows two precedents: `start_work_driver` (a compiled tool
 * replacing a prose workflow) and `registerDestructiveGitGuard` (a
 * mode-independent tool_call hook registered BEFORE the trust-mode bypass).
 * The companion driver is plan-driver.ts / the start_plan_driver tool; this
 * file is the "no other door" half.
 *
 * Mode-independence is load-bearing. The guard registers ahead of:
 *   - the sandbox-mode short-circuit (container default),
 *   - the trust-mode short-circuit (interactive-host default),
 *   - the per-role verdict resolution (project/global overlays layer ON TOP
 *     of agents.json, so a deny in agents.json alone is a soft fence that a
 *     `.pi/permissions.json` override can reopen — the hook cannot be).
 * Neither the container fence, the operator's trust, nor any config override
 * can reopen the door. Only the operator typing `gh issue create` in their
 * own terminal, or the compiled plan driver's child-process exec (which does
 * not pass through this hook — exempt by construction, exactly like the work
 * driver's mechanized `gh pr create`), can create a ticket.
 *
 * Fires for ALL roles (PM, explore, ops, developer, adversarial-developer,
 * code-review-specialist) in ALL modes (trust, strict, headless, sandbox).
 * A subagent that discovers a missing ticket must REPORT it to PM, not open
 * the door itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createsGitHubIssue } from "./bash-command-parser.ts";
import { trace } from "./trace.ts";

/** Opt-out for an operator who genuinely wants to file tickets by hand. */
function directIssueCreateAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE === "1";
}

export function registerIssueCreationGuard(pi: ExtensionAPI): void {
  if (directIssueCreateAllowed()) {
    trace(
      "issue-creation-guard: PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE=1 — direct issue creation permitted",
    );
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    const creating = createsGitHubIssue(command);
    if (!creating) return;
    trace(`issue-creation-guard: BLOCKED issue creation (mode-independent) — ${creating}`);
    return {
      block: true,
      reason: `Issue creation is gated. Use the start_plan_driver tool (or the /plan flow) instead of running \`${creating}\` directly — it runs the adversarial gap gate, the user-confirmation seam, and files via the driver's own exec path, which is exempt from this hook by construction. \`gh issue edit\` on an existing issue stays open.`,
    };
  });
}
