/**
 * test-child-guards-helpers.ts — the fake-pi harness shared by the two
 * child-guards test files (#926): `test-child-guards-extension.ts` (structural
 * canaries) and `test-child-guards-loaded-hooks.ts` (the loaded hook set).
 *
 * One fake pi so the two files cannot drift about what "loaded into a child"
 * means: the same `on`/`registerTool`/`registerCommand` surface, and `dispatch`
 * returns the FIRST `{ block: true }`, mirroring how Pi applies tool_call hooks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

export interface FakePi {
  on: (name: string, fn: Handler) => void;
  registeredTools: string[];
  registeredCommands: string[];
}

export function makeFakePi(): FakePi & { handlers: Record<string, Handler[]> } {
  const handlers: Record<string, Handler[]> = {};
  const fake: FakePi & { handlers: Record<string, Handler[]> } = {
    handlers,
    on(name, fn) {
      const list = handlers[name];
      if (list) list.push(fn);
      else handlers[name] = [fn];
    },
    registeredTools: [],
    registeredCommands: [],
  };
  (
    fake as unknown as Record<string, unknown> as { registerTool: (t: { name: string }) => void }
  ).registerTool = (t) => fake.registeredTools.push(t.name);
  (
    fake as unknown as Record<string, unknown> as { registerCommand: (c: { name: string }) => void }
  ).registerCommand = (c) => fake.registeredCommands.push(c.name);
  return fake;
}

export async function dispatch(
  fake: { handlers: Record<string, Handler[]> },
  toolName: string,
  command: string,
): Promise<unknown> {
  const event = { toolName, input: { command } };
  const results = await Promise.all((fake.handlers.tool_call ?? []).map((h) => h(event, {})));
  // A refusal is the FIRST { block: true } — the hook that answers first wins,
  // mirroring how Pi applies tool_call hooks.
  return results.find((r) => (r as { block?: boolean })?.block === true);
}

export type FakePiApi = ReturnType<typeof makeFakePi> & ExtensionAPI;
