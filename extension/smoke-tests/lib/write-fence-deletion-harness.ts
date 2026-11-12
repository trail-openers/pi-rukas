/**
 * Shared harness for the two #2200 child-deletion test files: the assertion tally,
 * a minimal `ExtensionAPI` double the deletion hook can register against, and the
 * fixture destructuring both files need. `exit` is a live binding — a file reads it
 * when it prints its verdict, so a failure in either file is a non-zero exit.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  firstDeletionOutside,
  registerDeletionGuard,
  type DeletionRoots,
} from "../../src/write-fence-deletion.ts";

export let exit = 0;

export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

export type Handler = (event: unknown, ctx: unknown) => unknown;
export type FakePi = ExtensionAPI & { handlers: Record<string, Handler[]> };

export function fakePi(): FakePi {
  const handlers: Record<string, Handler[]> = {};
  return {
    handlers,
    on(name: string, fn: Handler) {
      handlers[name] = [...(handlers[name] ?? []), fn];
    },
  } as unknown as FakePi;
}

/** Run `command` past every hook `pi` registered; the first refusal wins. */
export async function toolCall(pi: FakePi, command: string) {
  const results = await Promise.all(
    (pi.handlers.tool_call ?? []).map((h) =>
      h({ type: "tool_call", toolName: "bash", input: { command } }, {}),
    ),
  );
  return results.find((r) => r !== undefined) as { block: true; reason: string } | undefined;
}

/** Register a deletion hook whose roots come from exactly this env, in the child's cwd. */
export function registerDeletionGuardWith(env: Record<string, string>, cwd: string) {
  const pi = fakePi();
  registerDeletionGuard(pi, { env, cwd });
  return pi;
}

/** Every refusal the child logged into its scratch dir. */
export function loggedRefusals(scratch: string): Array<{ tool: string; path: string }> {
  const out: Array<{ tool: string; path: string }> = [];
  for (const f of readdirSync(scratch)) {
    if (!f.startsWith("write-fence-")) continue;
    for (const line of readFileSync(path.join(scratch, f), "utf8").split("\n")) {
      if (line.trim() !== "") out.push(JSON.parse(line) as { tool: string; path: string });
    }
  }
  return out;
}

/** The refusal reason the rule gives this command against `roots`, or undefined when it runs. */
export function refused(command: string, roots: DeletionRoots): string | undefined {
  return firstDeletionOutside(command, roots)?.reason;
}
