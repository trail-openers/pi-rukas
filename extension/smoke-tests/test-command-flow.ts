#!/usr/bin/env bun
/**
 * Smoke test for the slash-command → before_agent_start → PM-doctrine flow.
 *
 * Mocks the Pi ExtensionAPI/ExtensionCommandContext shapes my code touches,
 * runs the extension's default export, fires each slash command, and asserts:
 *   - command handler loads the right prompt body
 *   - pi.sendUserMessage receives the expanded body
 *   - before_agent_start hook appends the PM doctrine when armed
 *   - one-shot semantics: a second turn (without re-firing /command) does NOT
 *     get the doctrine
 *
 * Bypasses Pi entirely. Useful for fast iteration on extension wiring.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const PROJ_DIR = path.resolve(EXT_DIR, "..");
const PI_PROMPTS = path.join(PROJ_DIR, "pi-prompts");
const PM_PROMPT = path.join(PROJ_DIR, "dist", "prompts", "standard", "project-manager.md");

interface Recorded {
  sentMessages: string[];
  notifies: Array<{ msg: string; kind?: string }>;
  registeredTools: string[];
  registeredCommands: string[];
  beforeAgentStartHandlers: Array<(event: unknown) => Promise<unknown>>;
}

function makePi() {
  const rec: Recorded = {
    sentMessages: [],
    notifies: [],
    registeredTools: [],
    registeredCommands: [],
    beforeAgentStartHandlers: [],
  };
  const pi = {
    registerTool: (def: { name: string }) => rec.registeredTools.push(def.name),
    registerCommand: (name: string, _def: unknown) => rec.registeredCommands.push(name),
    on: (event: string, handler: (e: unknown) => Promise<unknown>) => {
      if (event === "before_agent_start") rec.beforeAgentStartHandlers.push(handler);
    },
    sendUserMessage: (msg: string) => rec.sentMessages.push(msg),
    sendMessage: (_msg: string) => undefined,
    getCommands: () => [],
  };
  return { pi, rec };
}

function makeCtx() {
  const notifies: Array<{ msg: string; kind?: string }> = [];
  const ctx = {
    isIdle: () => true,
    cwd: process.cwd(),
    ui: {
      notify: (msg: string, kind?: string) => notifies.push({ msg, kind }),
    },
  };
  return { ctx, notifies };
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Capture handlers as they register — registerCommand stores name only above,
// so we re-wire here to keep references to the actual handler fns.
const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
const { pi, rec } = makePi();
pi.registerCommand = (name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) => {
  rec.registeredCommands.push(name);
  handlers[name] = def.handler;
};

// biome-ignore lint/suspicious/noExplicitAny: mock pi has narrower type than real ExtensionAPI
await extensionEntry(pi as any);

assert(rec.registeredCommands.includes("start"), "/start registered");
assert(rec.registeredCommands.includes("research"), "/research registered");
assert(rec.registeredCommands.includes("plan"), "/plan registered");
assert(rec.registeredCommands.includes("work"), "/work registered");
assert(rec.registeredCommands.includes("review"), "/review registered");
assert(rec.registeredCommands.includes("audit"), "/audit registered");
assert(rec.registeredCommands.includes("do"), "/do registered (PR7 — free-form work counterpart to /work)");
assert(rec.registeredCommands.includes("ensemble-debug"), "/ensemble-debug registered");
assert(rec.registeredCommands.includes("runs"), "/runs registered");

// PR7 — pi-prompts/do.md exists and uses the expected placeholders +
// toolkit mentions. /do is PM-driven; its body is loaded from disk on
// every invocation (no compiled driver code path).
{
  const doBody = await fs.readFile(path.join(PI_PROMPTS, "do.md"), "utf8");
  assert(doBody.length > 500, "pi-prompts/do.md exists and is non-trivial");
  assert(
    doBody.includes("$ARGUMENTS"),
    "pi-prompts/do.md uses $ARGUMENTS (consumed by expandArgs in commands.ts)",
  );
  assert(
    doBody.includes("dispatch_specialist"),
    "pi-prompts/do.md mentions dispatch_specialist (PM orchestration toolkit)",
  );
  assert(
    doBody.includes("adversarial_loop"),
    "pi-prompts/do.md mentions adversarial_loop (non-negotiable commit gate)",
  );
}
assert(rec.registeredTools.includes("dispatch_specialist"), "dispatch_specialist tool registered");
assert(rec.registeredTools.includes("dispatch_parallel"), "dispatch_parallel tool registered");
assert(rec.registeredTools.includes("adversarial_loop"), "adversarial_loop tool registered");
assert(rec.registeredTools.includes("dispatch_lens_review"), "dispatch_lens_review tool registered");
assert(rec.beforeAgentStartHandlers.length === 1, "exactly one before_agent_start hook");

// Verify pi-prompts files exist
for (const name of ["start", "research", "plan", "work", "review", "do"]) {
  const file = path.join(PI_PROMPTS, `${name}.md`);
  const exists = await fs.stat(file).then(() => true).catch(() => false);
  assert(exists, `pi-prompts/${name}.md exists`);
}
const pmExists = await fs.stat(PM_PROMPT).then(() => true).catch(() => false);
assert(pmExists, "PM doctrine prompt built (dist/prompts/standard/project-manager.md)");

// Fire /start with no args
const { ctx: ctx1 } = makeCtx();
await handlers.start!("", ctx1);
assert(rec.sentMessages.length === 1, "/start → 1 message queued");
const startBody = await fs.readFile(path.join(PI_PROMPTS, "start.md"), "utf8");
assert(
  rec.sentMessages[0] === startBody,
  "/start: queued message equals start.md body (no $ARGUMENTS in start.md, so no expansion)",
);

// Fire /work 42 — under PI_ENSEMBLE_WORK_DRIVER=0 this exercises the
// legacy PM-driven path: handler reads pi-prompts/work.md and sends it.
// (PR1 of workflow-graph compilation introduced the driver-based path; the
// legacy path stays available as a fallback.)
const prevFlag = process.env.PI_ENSEMBLE_WORK_DRIVER;
process.env.PI_ENSEMBLE_WORK_DRIVER = "0";
try {
  const { ctx: ctx2 } = makeCtx();
  await handlers.work!("42", ctx2);
  assert(rec.sentMessages.length === 2, "/work 42 (legacy flag=0) → second message queued");
  assert(
    rec.sentMessages[1].includes("**Issue**: 42"),
    "/work 42 (legacy flag=0): $ARGUMENTS expanded to '42' in workflow body",
  );
} finally {
  if (prevFlag === undefined) delete process.env.PI_ENSEMBLE_WORK_DRIVER;
  else process.env.PI_ENSEMBLE_WORK_DRIVER = prevFlag;
}

// Fire /review #456 (with arg expansion)
const { ctx: ctxR } = makeCtx();
await handlers.review!("#456", ctxR);
assert(rec.sentMessages.length === 3, "/review #456 → third message queued");
assert(
  rec.sentMessages[2].includes("**Scope**: #456"),
  "/review #456: $ARGUMENTS expanded to '#456' in workflow body",
);

// /work under PI_ENSEMBLE_WORK_DRIVER=1 (default) should NOT send a user
// message — it spins up the driver via notify() instead. We can't actually
// run the driver here (it would spawn real Pi children) but we can verify:
//  - no new sendUserMessage is queued (count stays at 3),
//  - a notify of kind "info" fires naming the work-state path.
{
  const prevFlag = process.env.PI_ENSEMBLE_WORK_DRIVER;
  delete process.env.PI_ENSEMBLE_WORK_DRIVER; // default = ON
  try {
    const { ctx: ctxW, notifies: notifW } = makeCtx();
    await handlers.work!("789", ctxW);
    assert(
      rec.sentMessages.length === 3,
      "/work 789 (driver default-ON): does NOT call sendUserMessage",
    );
    assert(
      notifW.some((n) => n.kind === "info" && /work-state\/789\.json/.test(n.msg)),
      "/work 789 (driver default-ON): info notify names the work-state file path",
    );
  } finally {
    if (prevFlag === undefined) delete process.env.PI_ENSEMBLE_WORK_DRIVER;
    else process.env.PI_ENSEMBLE_WORK_DRIVER = prevFlag;
  }
}

// /work without an issue number under driver mode should reject cleanly
// (warning notify, no sendUserMessage).
{
  const prevFlag = process.env.PI_ENSEMBLE_WORK_DRIVER;
  delete process.env.PI_ENSEMBLE_WORK_DRIVER;
  try {
    const { ctx: ctxWE, notifies: notifWE } = makeCtx();
    await handlers.work!("", ctxWE);
    assert(
      rec.sentMessages.length === 3,
      "/work (driver default-ON, no args): does NOT send a message",
    );
    assert(
      notifWE.some((n) => n.kind === "warning" && /issue number/.test(n.msg)),
      "/work (driver default-ON, no args): warning notify mentions missing issue number",
    );
  } finally {
    if (prevFlag === undefined) delete process.env.PI_ENSEMBLE_WORK_DRIVER;
    else process.env.PI_ENSEMBLE_WORK_DRIVER = prevFlag;
  }
}

// Fire before_agent_start with doctrine armed (set by the most recent /work call)
const hook = rec.beforeAgentStartHandlers[0]!;
const result1 = (await hook({ systemPrompt: "PI_BASE_PROMPT" })) as
  | { systemPrompt: string }
  | undefined;
assert(result1 !== undefined, "before_agent_start returns a result when armed");
assert(
  (result1?.systemPrompt ?? "").startsWith("PI_BASE_PROMPT\n\n"),
  "before_agent_start: appends to existing systemPrompt (does not replace)",
);
const pmBody = await fs.readFile(PM_PROMPT, "utf8");
assert(
  (result1?.systemPrompt ?? "").includes(pmBody.slice(0, 200)),
  "before_agent_start: PM doctrine body is included",
);

// Second call without re-firing /command: PM mode is sticky for the
// remainder of the session, so the sticky preamble must still be appended
// (closes the "PM forgets the doctrine on turn 2+" bug). The FULL doctrine
// is one-shot though — only the short preamble appears on turn 2.
const result2 = await hook({ systemPrompt: "PI_BASE_PROMPT" });
assert(
  result2?.systemPrompt !== undefined && result2.systemPrompt.includes("PM mode — orchestration only"),
  "before_agent_start: sticky preamble appended on turn 2 (PM mode active)",
);
assert(
  !(result2?.systemPrompt ?? "").includes(pmBody.slice(0, 200)),
  "before_agent_start: FULL doctrine NOT re-injected on turn 2 (cost-bounded one-shot)",
);

// Fire /start when busy — should refuse and not arm
const { ctx: ctx3, notifies: notif3 } = makeCtx();
ctx3.isIdle = () => false;
await handlers.start!("", ctx3);
assert(
  rec.sentMessages.length === 3,
  "/start while busy: no new message queued (still 3 from earlier)",
);
assert(
  notif3.some((n) => n.kind === "warning"),
  "/start while busy: user is notified",
);
// Even when /start is refused, PM mode stays active from the earlier successful
// /start so the sticky preamble is still appended. The state didn't regress.
const result3 = await hook({ systemPrompt: "PI_BASE_PROMPT" });
assert(
  result3?.systemPrompt !== undefined && result3.systemPrompt.includes("PM mode — orchestration only"),
  "/start while busy: PM mode sticky preamble still active from earlier /start",
);

// PR7 — Fire /do <description>. PM-driven, no driver path; same shape
// as /research / /plan. Placed at the end so the earlier hardcoded
// sentMessages.length === N assertions don't shift.
{
  const { ctx: ctxDo } = makeCtx();
  const before = rec.sentMessages.length;
  await handlers.do!("fix the typo in README.md", ctxDo);
  assert(
    rec.sentMessages.length === before + 1,
    "/do <description> → 1 message queued (PM-driven, no driver detour)",
  );
  assert(
    rec.sentMessages[before].includes("**Request**: fix the typo in README.md"),
    "/do: $ARGUMENTS expanded into the **Request** field of do.md",
  );
}

console.log("\n=== test-command-flow summary ===");
console.log(`registered: ${rec.registeredCommands.length} commands, ${rec.registeredTools.length} tools`);
console.log(`exit ${exit}`);
process.exit(exit);
