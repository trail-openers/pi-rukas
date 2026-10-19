/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses a
 * destructive vipune write inside a spawned child (#1666).
 *
 * `vipune update <id> -t "…"` replaces a row's content in place (see
 * bash-pattern-wildcard.ts for the measurement). The allowlist cannot express
 * "status yes, content no", and the verdict layer is not consulted by trust-mode
 * children, so before this hook a trust-mode /work child could rewrite a memory
 * row that the harness judges it against. The refusal therefore lives in the
 * shared mode-independent block (subagent-guard-guards.ts), which both child
 * entry points register ahead of every trust bypass.
 *
 * Each `&&` / `||` / `;` / `|` / newline segment is checked, so a chained
 * `true && vipune update …` is refused the same as a bare one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDestructiveMemoryWrite } from "./bash-pattern-wildcard.ts";
import { trace } from "./trace.ts";

const SEGMENT_SPLIT = /\s*(?:&&|\|\||[;|\n])\s*/;

export function registerMemoryWriteGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    if (!command.split(SEGMENT_SPLIT).some(isDestructiveMemoryWrite)) return;
    trace("memory-write-guard: BLOCKED destructive vipune update (replaces a memory row's text)");
    return {
      block: true,
      reason:
        "Refused: `vipune update … -t` replaces an existing memory row's text in place, with no lineage and no undo, so anything that cited that memory now cites different text. To correct a memory, store the corrected statement with `vipune add '<statement>' --supersedes <id>`, which keeps the original row.",
    };
  });
}
