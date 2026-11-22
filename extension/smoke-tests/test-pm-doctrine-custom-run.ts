#!/usr/bin/env bun
/**
 * `before_agent_start` is a union on `messageType` since Pi 1.2.0: "user"
 * runs carry the operator's prompt, "custom" runs start from another
 * extension's `pi.sendMessage(..., { triggerTurn: true })` while idle. PM
 * doctrine — the sticky preamble and the backlog reminder — is for operator
 * prompt turns only, so a custom run must pass through untouched: injected
 * PM prose would misdirect a run that has nothing to do with orchestrating.
 *
 * The pre-1.2.0 event shape (no `messageType` field) must keep receiving the
 * preamble — the gate is inert on older Pi, which is the shipped behaviour
 * the union never changed.
 *
 * The custom-run path must also not consume the full-doctrine one-shot: a
 * custom run arriving before the first user turn cannot leave the PM
 * permanently un-doctrined.
 */

import { registerCommands } from "../src/commands.ts";
import { armPmMode, resetPmMode, takeDoctrinePending } from "../src/pm-mode.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface FakeCtx {
  cwd: string | undefined;
  ui: { notify: (msg: string, kind?: string) => void };
}

type Hook = (
  event: {
    type?: string;
    messageType?: string;
    prompt?: string;
    message?: unknown;
    systemPrompt?: string;
    systemPromptOptions?: unknown;
  },
  ctx: FakeCtx,
) => Promise<{ systemPrompt: string } | undefined>;

const hooks: Hook[] = [];
const pi = {
  registerTool: () => undefined,
  registerCommand: () => undefined,
  on: (event: string, handler: Hook) => {
    if (event === "before_agent_start") hooks.push(handler);
    return () => undefined;
  },
  sendUserMessage: () => undefined,
  sendMessage: () => undefined,
  getCommands: () => [],
  getAllTools: () => [],
  setActiveTools: () => undefined,
};

// Only the command/doctrine registration — the full extension entry would
// also arm process-wide watchers this test has no use for.
// biome-ignore lint/suspicious/noExplicitAny: mock pi is narrower than ExtensionAPI
registerCommands(pi as any);
assert(hooks.length === 1, "exactly one before_agent_start hook — the only PM seam");
const hook = hooks[0] as Hook;

const BASE = "PI_BASE_PROMPT";
const ctx: FakeCtx = { cwd: undefined, ui: { notify: () => undefined } };

function armSession(): void {
  resetPmMode();
  armPmMode();
  takeDoctrinePending();
}

const USER_EVENT = {
  type: "before_agent_start",
  messageType: "user",
  prompt: "x",
  systemPrompt: BASE,
  systemPromptOptions: {},
};
const CUSTOM_EVENT = {
  type: "before_agent_start",
  messageType: "custom",
  message: { role: "custom", content: [{ type: "text", text: "from another extension" }] },
  systemPrompt: BASE,
  systemPromptOptions: {},
};
// The pre-1.2.0 shape: no `messageType` field at all.
const LEGACY_EVENT = {
  type: "before_agent_start",
  prompt: "x",
  systemPrompt: BASE,
  systemPromptOptions: {},
};

// 1. user run while PM mode is armed → the preamble lands.
armSession();
const userOut = await hook(USER_EVENT, ctx);
assert(
  typeof userOut?.systemPrompt === "string" && userOut.systemPrompt.startsWith(`${BASE}\n\n`),
  'messageType "user": the sticky preamble is appended',
);

// 2. custom run while PM mode is armed → nothing is injected.
armSession();
const customOut = await hook(CUSTOM_EVENT, ctx);
assert(customOut === undefined, 'messageType "custom": the hook returns nothing — prompt untouched');

// 3. legacy shape (no messageType) → treated as a user run; the gate is
//    inert below Pi 1.2.0.
armSession();
const legacyOut = await hook(LEGACY_EVENT, ctx);
assert(
  typeof legacyOut?.systemPrompt === "string" && legacyOut.systemPrompt.startsWith(`${BASE}\n\n`),
  "absent messageType (Pi < 1.2.0 shape): still receives the preamble — gate is inert",
);

// 4. a custom run must not consume the full-doctrine one-shot: a custom run
//    arriving before the first user turn leaves doctrine pending.
resetPmMode();
armPmMode(); // doctrine pending, not yet spent
await hook(CUSTOM_EVENT, ctx);
assert(takeDoctrinePending() === true, "a custom run does not spend the full-doctrine one-shot");

// 5. PM mode unarmed → no injection on either shape (the pre-existing
//    boundary, asserted beside the new one so the two gates stay honest).
resetPmMode();
const offUser = await hook(USER_EVENT, ctx);
const offCustom = await hook(CUSTOM_EVENT, ctx);
assert(offUser === undefined && offCustom === undefined, "PM mode unarmed: both shapes pass through");

process.exit(exit);
