/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses a
 * destructive vipune write inside a spawned child (#1666).
 *
 * `vipune update <id> -t "…"` replaces a row's content in place, with no lineage
 * and no undo (the id survives, so anything that cited the row now cites
 * different text). The allowlist cannot express "status yes, content no", and
 * the verdict layer is not consulted by trust-mode children, so before this hook
 * a trust-mode /work child could rewrite a memory row that the harness judges it
 * against. The refusal therefore lives in the shared mode-independent block
 * (subagent-guard-guards.ts), which both child entry points register ahead of
 * every trust bypass.
 *
 * The predicate itself is Pi-free and lives in bash-destructive-write.ts, where
 * the allowlist matcher reads it too. This file only binds it to the hook.
 *
 * A guardrail against accidental rewrites, not a security boundary: a determined
 * command can still reach the vipune binary some other way.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { destructiveWriteVerb } from "./bash-destructive-write.ts";
import { trace } from "./trace.ts";

/** The command string of a bash tool call; anything that is not a string reads as empty. */
export function bashCommandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function registerMemoryWriteGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const verb = destructiveWriteVerb(bashCommandOf(event.input));
    if (verb === undefined) return;
    trace(`memory-write-guard: BLOCKED destructive vipune write (${verb})`);
    return {
      block: true,
      reason:
        "Refused: `vipune update … -t` replaces a memory row's text in place, `vipune delete` removes a row, and `vipune prune` demotes candidates in bulk; none has a confirmation or an undo, and anything that cited the row now cites different text or nothing. To correct a memory, store the corrected statement with `vipune add '<statement>' --supersedes <id>`, which keeps the original row.",
    };
  });
}
