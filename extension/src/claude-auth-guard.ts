/**
 * claude-auth-guard — the mode-independent `tool_call` hook that refuses
 * `claude auth logout` / `claude auth login` in a spawned child.
 *
 * `claude auth logout` deletes the credential file the CLI authenticates with.
 * Nothing in this harness can put it back: the flow is interactive, so every
 * later child spawn — and the parent's own CLI calls — fail on authentication
 * until a human sits at a terminal and re-logs in. A command that destroys
 * state no agent can restore belongs in the same place as the destructive-git
 * and merge guards: `registerModeIndependentGuards`, ahead of every trust and
 * sandbox bypass, since those two modes are the defaults and a guard placed
 * after them would, in practice, never run.
 *
 * Universal rather than role-scoped: unlike the push ban (a role duty @ops
 * still holds), there is no role for whom destroying the session's credential
 * is part of the job. The predicate lives in `claude-auth-command.ts` and is
 * Pi-free; this file only binds it to the hook.
 *
 * ## The refusal never quotes the command
 *
 * The reason goes back to the model, which repeats it, and the trace line goes
 * to stderr, which the transcript mirrors unredacted. Whatever the agent typed
 * next to the verb — a token pasted on the command line, a private host —
 * would be reproduced in both. So the refusal names the verb it recognised and
 * the remedy, never the text it matched, exactly as `public-hygiene-no-leak.ts`
 * requires of the hygiene guard.
 *
 * ## Operator escape hatch
 *
 * `PI_ENSEMBLE_ALLOW_CLAUDE_AUTH=1` registers no hook at all — the shape every
 * other mode-independent guard uses, so the session is inert rather than
 * re-checking the env per call. The variable is the operator's to set in their
 * own shell; a harness-set value would be the bypass itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runsClaudeAuth } from "./claude-auth-command.ts";
import { traceWarn } from "./trace.ts";

/** What the agent can run instead: the read-only form of the same subcommand. */
const REMEDY = "claude auth status";

/** Operator-only opt-out (see the module header for why it is not harness-set). */
function claudeAuthAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_CLAUDE_AUTH === "1";
}

/**
 * Refuse the CLI's auth login/logout inside a child.
 *
 * Call from `registerModeIndependentGuards`, BEFORE the sandbox short-circuit
 * and the trust-mode bypass, or in practice it never runs.
 */
export function registerClaudeAuthGuard(pi: ExtensionAPI): void {
  if (claudeAuthAllowed()) return;
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown })?.command;
    if (typeof command !== "string" || !runsClaudeAuth(command)) return;
    // traceWarn, not trace: a refusal changes what the child runs, and an
    // operator debugging it has no reason to know to enable PI_ENSEMBLE_DEBUG.
    // The verb label only — never the command text.
    traceWarn("claude-auth-guard: BLOCKED claude auth login/logout");
    return {
      block: true,
      reason: `Refused: \`claude auth logout\` / \`claude auth login\` delete and replace the CLI's stored credential. There is no undo and no non-interactive recovery — every later command that authenticates as you fails until a human re-logs in at a terminal, so a subagent cannot repair what it broke mid-run. To check the session, run \`${REMEDY}\` (read-only). If this command is genuinely required, the operator sets PI_ENSEMBLE_ALLOW_CLAUDE_AUTH=1 in their own shell before launching the session; an agent that sets it itself has not obtained anything.`,
    };
  });
}
