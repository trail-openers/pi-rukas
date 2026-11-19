/**
 * lib/forge-read-collector — the fake `ExtensionAPI` the #2382 `forge_read`
 * owner tests load a child entry point into.
 *
 * Shape-only, like `test-forge-read-off-child-text.ts`: the entry points call
 * `pi.registerTool({ name, execute, … })` and `pi.on(...)`, so this collects
 * exactly those and leaves the rest of Pi's surface unnamed (this project's
 * smoke-tests config pins `"types": ["node"]` and has never resolved the Pi
 * packages). One collector, one counting rule, so the shipped run and the
 * duplicate-tool mutant cannot disagree about what "how many `forge_read`s
 * landed" means.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CollectedTool {
  name: string;
  execute: (id: string, raw: unknown) => Promise<unknown>;
}

export function makeForgeCollector(): {
  pi: ExtensionAPI;
  tools: CollectedTool[];
  handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>>;
} {
  const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const tools: CollectedTool[] = [];
  const pi = {
    on: (name: string, fn: (e: unknown, c: unknown) => unknown) => {
      const list = handlers[name] ?? [];
      list.push(fn);
      handlers[name] = list;
    },
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => undefined,
    registerTool: (t: CollectedTool) => {
      tools.push({ name: t.name, execute: t.execute });
    },
    registerCommand: () => undefined,
    registerProvider: () => undefined,
    registerFlag: () => undefined,
  };
  return { pi: pi as unknown as ExtensionAPI, tools, handlers };
}

/** How many tools in `tools` carry the name `forge_read`. */
export const forgeNames = (tools: Array<{ name: string }>): number =>
  tools.filter((t) => t.name === "forge_read").length;
