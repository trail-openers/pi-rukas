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
import { allowsReadOnlyChain, firstWordAllowed, splitReadOnlyChain } from "./pm-bash-chain.ts";
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
    // A loose row (`cat*`) must not admit `cat=1 touch x` or `catchsegv`.
    if (verdict === "allow" && firstWordAllowed(command, pmBash)) return;
    // matchBashSubcommand returns null for any operator outside quotes. A
    // chain whose every part is an allowlisted read passes here, and only
    // here — other roles keep the refusal (#1352, pm-bash-chain.ts).
    if (verdict === null && allowsReadOnlyChain(command, pmBash)) return;
    trace(`pm-bash-guard: BLOCKED PM bash (mode-independent) — ${command}`);
    const split = verdict === null ? splitReadOnlyChain(command) : undefined;
    const unterminated = split?.ok === false && split.reason === "unterminated-quote";
    return { block: true, reason: pmBashRefusal(verdict, unterminated) };
  });
}

/**
 * Why a PM bash call was refused. `null` from the matcher means the command
 * carries a shell operator outside quotes. A chain of allowlisted reads joined
 * by `&&`, `||`, `;` or `|` was already accepted (pm-bash-chain.ts), so a null
 * that reaches here has a part that is not an allowlisted read, or a construct
 * no chain may carry (`$(…)`, backticks, `$VAR`, a redirect other than to
 * /dev/null, `xargs`/`tee`). The old text called that an "injection chain",
 * which sent a PM looking for an attack in `git status && git log` (#1233).
 * An unterminated quote gets its own text: the command does not parse at all,
 * usually because of an apostrophe inside a single-quoted argument (#1352).
 */
export function pmBashRefusal(verdict: string | null, unterminatedQuote = false): string {
  if (unterminatedQuote) {
    return "Refused: this command has an unterminated quote, so it does not parse as shell — usually an apostrophe inside a single-quoted argument. Write the apostrophe as '\\'' (close the quote, escaped quote, reopen) or use double quotes, then run it again.";
  }
  if (verdict === null) {
    return "Refused: PM bash accepts one allowlisted command, or a chain of allowlisted reads joined by `&&`, `||`, `;` or `|` (redirects only to /dev/null or `2>&1`). This one has a part that is not on the allowlist (e.g. `cd`), or carries `$(…)`, backticks, `$VAR`, another redirect, or `xargs`/`tee`. Run each part as its own bash call — for another directory use `git -C <dir> …` rather than `cd <dir> && …` — and dispatch anything that mutates to a specialist (dispatch_specialist: ops for git and forge-CLI (gh/glab) mutations, developer for code).";
  }
  return "Refused: this command is not on the PM bash allowlist (agents.json). PM may run only its allowlisted read-only commands directly. Dispatch implementation and git/mutation work to specialists instead (dispatch_specialist to ops for git and forge-CLI (gh/glab) mutations, developer for code).";
}
