/**
 * broadcast-kill-guard — the mode-independent `tool_call` hook that refuses a bash
 * command signalling every process of the operator's uid (#2381).
 *
 * A child runs as the operator's own uid with an unfenced bash, so `kill -TERM -1`,
 * `pkill -u <user>` or an interpreter's `os.killpg(1, …)` reaches the kernel from any
 * child in any mode — and `killpg(1)` IS `kill(-1)` on Linux. Three review children
 * probing a target project's group kill with `1` as a stand-in pid each terminated the
 * operator's terminal server, the user manager, every sibling agent and the /work
 * driver that dispatched them. No agent task needs a uid-wide signal, so the refusal
 * lives in the shared mode-independent block (subagent-guard-guards.ts), which both
 * child entry points and the parent register ahead of every trust bypass.
 *
 * The predicate itself is Pi-free and lives in bash-broadcast-kill.ts. This file only
 * binds it to the hook. A guardrail against a child's own bad judgement, not a
 * security boundary: a kill assembled at run time, or a script run by path, is outside
 * it — the complete fence is a PID namespace or the sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { broadcastKillVerdictOf } from "./bash-broadcast-kill.ts";
import { bashCommandOf } from "./memory-write-guard.ts";
import { traceWarn } from "./trace.ts";

/** Why the call is refused. Names the rule and the spellings, never the command text. */
export const BROADCAST_KILL_REASON =
  "Refused: this command signals every process of your uid — `kill … -1`, `pkill -u` / `killall -u`, `killall5`, `kill(-1, …)`, `killpg(1, …)` — or a process group the guard cannot read. On Linux `killpg(1)` is `kill(-1)`: it terminates the operator's terminal session, the user manager, every sibling agent on the host and the driver that dispatched you. Signal only pids and process groups you started yourself, by literal number; a stand-in pid for a probe is never 0, 1 or -1.";

export function registerBroadcastKillGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const verdict = broadcastKillVerdictOf(bashCommandOf(event.input));
    if (verdict === undefined) return;
    // traceWarn, not trace: a refusal changes what the child runs. The label only —
    // never the command text, which is untrusted and may hold secrets.
    traceWarn(`broadcast-kill-guard: BLOCKED a uid-wide signal (${verdict.kind}: ${verdict.via})`);
    return { block: true, reason: BROADCAST_KILL_REASON };
  });
}
