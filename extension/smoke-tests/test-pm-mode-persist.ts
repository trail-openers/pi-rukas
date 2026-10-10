#!/usr/bin/env bun
/**
 * Project manager mode must come back when a session is reopened.
 *
 * The mode lives in memory. A session reopened by a new process (pi --session)
 * would otherwise run with edit and write available and no preamble. The mode
 * is recorded as a custom session entry the first time a run starts in it, and
 * restored from that entry on session_start.
 */

import { armPmMode, isPmModeActive, resetPmMode } from "../src/pm-mode.ts";
import { PM_MODE_ENTRY, registerPmModePersistence } from "../src/pm-mode-persist.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function harness() {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub of the extension API
  const handlers: Record<string, (event: unknown, ctx: any) => void> = {};
  const appended: { type: string; data: unknown }[] = [];
  let restored = 0;
  const pi = {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    on(name: string, fn: (event: unknown, ctx: any) => void) {
      handlers[name] = fn;
    },
    appendEntry(type: string, data?: unknown) {
      appended.push({ type, data });
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
  registerPmModePersistence(pi, () => {
    restored++;
  });
  // biome-ignore lint/suspicious/noExplicitAny: a context is whatever the case passes
  const start = (ctx: any) => handlers.session_start?.({}, ctx);
  const branch = (entries: unknown[]) => ({ sessionManager: { getBranch: () => entries } });
  const run = () => handlers.agent_start?.({}, {});
  return { appended, start, branch, run, restored: () => restored };
}

{
  resetPmMode();
  const h = harness();
  h.start(h.branch([]));
  h.run();
  assert(h.appended.length === 0, "outside PM mode nothing is recorded");
  armPmMode();
  h.run();
  h.run();
  assert(h.appended.length === 1, "the mode is recorded once, on the first run in it");
  assert(h.appended[0]?.type === PM_MODE_ENTRY, "the entry has the pi-rukas type");
}

{
  resetPmMode();
  const h = harness();
  h.start(h.branch([{ type: "message" }, { type: "custom", customType: PM_MODE_ENTRY }]));
  assert(isPmModeActive(), "a reopened session with the entry is in PM mode again");
  assert(h.restored() === 1, "the caller is told, so it can strip the tools");
  h.run();
  assert(h.appended.length === 0, "the entry is not written a second time");
}

{
  resetPmMode();
  const h = harness();
  h.start(h.branch([{ type: "custom", customType: "something-else" }]));
  assert(!isPmModeActive(), "another extension's entry does not arm the mode");
  assert(h.restored() === 0, "and nothing is stripped");
}

{
  resetPmMode();
  const h = harness();
  h.start({});
  assert(!isPmModeActive(), "a context without a session manager changes nothing");
}

resetPmMode();
process.exit(exit);
