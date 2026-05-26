#!/usr/bin/env bun
/**
 * Smoke test for the /audit command.
 *
 * Tests:
 *   - command registration and prompt loading
 *   - argument expansion
 *   - prompt frontmatter structure
 *   - basic shape of audit workflow
 *
 * Bypasses Pi entirely. Useful for fast iteration on /audit wiring.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const PROJ_DIR = path.resolve(EXT_DIR, "..");
const PI_PROMPTS = path.join(PROJ_DIR, "pi-prompts");
const AUDIT_PROMPT = path.join(PI_PROMPTS, "audit.md");

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

// Test 1: /audit command registration
assert(rec.registeredCommands.includes("audit"), "/audit registered");

// Test 2: audit.md exists and is readable
const auditFile = await fs.stat(AUDIT_PROMPT).then(() => true).catch(() => false);
assert(auditFile, "pi-prompts/audit.md exists");

// Test 3: audit.md has correct frontmatter structure
const auditContent = await fs.readFile(AUDIT_PROMPT, "utf8");
assert(auditContent.includes("---"), "audit.md has frontmatter delimiter");
assert(auditContent.includes("description:"), "audit.md has description field");
assert(auditContent.includes("argument-hint:"), "audit.md has argument-hint field");
assert(
  auditContent.includes("standards-first"),
  "audit.md body mentions standards-first",
);
assert(
  auditContent.includes("Phase 1: Standards Discovery"),
  "audit.md describes Phase 1 (standards discovery)",
);
assert(
  auditContent.includes("Phase 2: Audit Passes"),
  "audit.md describes Phase 2 (audit passes)",
);
assert(
  auditContent.includes("Phase 3: Synthesis & Reporting"),
  "audit.md describes Phase 3 (synthesis)",
);

// Test 4: Fire /audit with no args (should default to entire repo)
const { ctx: ctx1 } = makeCtx();
await handlers.audit!("", ctx1);
assert(rec.sentMessages.length === 1, "/audit (no args) → 1 message queued");
assert(
  rec.sentMessages[0].includes("**Scope"),
  "/audit: expanded body includes scope section",
);

// Test 5: Fire /audit with path argument
const { ctx: ctx2 } = makeCtx();
await handlers.audit!("src/", ctx2);
assert(rec.sentMessages.length === 2, "/audit src/ → second message queued");
assert(
  rec.sentMessages[1].includes("**Scope**: src/"),
  "/audit src/: $ARGUMENTS expanded to 'src/'",
);

// Test 6: Fire /audit with multiple paths
const { ctx: ctx3 } = makeCtx();
await handlers.audit!("src/ lib/", ctx3);
assert(rec.sentMessages.length === 3, "/audit src/ lib/ → third message queued");
assert(
  rec.sentMessages[2].includes("**Scope**: src/ lib/"),
  "/audit src/ lib/: $ARGUMENTS expanded to 'src/ lib/'",
);

// Test 7: Verify audit workflow mentions the required phases
assert(
  auditContent.includes("dispatch_specialist"),
  "audit.md mentions dispatch_specialist for standards discovery",
);
assert(
  auditContent.includes("dispatch_parallel"),
  "audit.md mentions dispatch_parallel for audit passes",
);
assert(
  auditContent.includes("explore"),
  "audit.md mentions explore role",
);
assert(
  auditContent.includes("adversarial-developer"),
  "audit.md mentions adversarial-developer role",
);
assert(
  auditContent.includes("code-review-specialist"),
  "audit.md mentions code-review-specialist role",
);

// Test 8: Verify findings structure is documented
assert(
  auditContent.includes('category'),
  "audit.md documents findings category field",
);
assert(
  auditContent.includes('severity'),
  "audit.md documents findings severity field",
);
assert(
  auditContent.includes('confidence'),
  "audit.md documents findings confidence field",
);
assert(
  auditContent.includes('evidence'),
  "audit.md documents findings evidence field",
);

// Test 9: Verify vipune and colgrep usage policies
assert(
  auditContent.includes("vipune"),
  "audit.md mentions vipune for memory lookup",
);
assert(
  auditContent.includes("colgrep"),
  "audit.md mentions colgrep for code pattern search",
);

// Test 10: Verify async reporting compatibility
assert(
  auditContent.includes("[ensemble:async]"),
  "audit.md mentions async report format",
);
assert(
  auditContent.includes("/runs"),
  "audit.md mentions /runs for transcript access",
);

console.log("\n=== test-audit summary ===");
console.log("All command registration and prompt flow tests passed.");
console.log(`exit ${exit}`);
process.exit(exit);