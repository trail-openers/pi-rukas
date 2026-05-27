#!/usr/bin/env bun
/**
 * Smoke test for the /audit command.
 *
 * Covers:
 *   - command registration and message wiring
 *   - prompt frontmatter keys
 *   - policy link presence
 *   - compact contract guidance in the runtime prompt
 *   - a few load-bearing shape checks in the non-runtime examples doc
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJ_DIR = path.resolve(__dirname, "..", "..");
const AUDIT_PROMPT = path.join(PROJ_DIR, "pi-prompts", "audit.md");
const AUDIT_EXAMPLES = path.join(PROJ_DIR, "docs", "audit-contract-examples.md");

type PiRecord = {
  sentMessages: string[];
  registeredCommands: string[];
};

type RegisterCommand = Pick<ExtensionAPI, "registerCommand">["registerCommand"];
type RegisteredCommand = Parameters<RegisterCommand>[1];
type CommandHandler = RegisteredCommand["handler"];

function makePi() {
  const rec: PiRecord = {
    sentMessages: [],
    registeredCommands: [],
  };
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name, def) => {
      rec.registeredCommands.push(name);
      handlers[name] = def.handler;
    },
    on: () => undefined,
    sendUserMessage: (msg) => {
      rec.sentMessages.push(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  } satisfies Pick<ExtensionAPI, "registerTool" | "registerCommand" | "on" | "sendUserMessage">;
  return { pi, rec };
}

function makeCtx(): Parameters<CommandHandler>[1] {
  const ctx = {
    isIdle: () => true,
    cwd: process.cwd(),
    ui: {
      notify: () => undefined,
    },
  } satisfies Parameters<CommandHandler>[1];
  return ctx;
}

class AssertionError extends Error {}
let exit = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (condition) return;
  exit = 1;
  throw new AssertionError(message);
}

function parseJsonBlock(section: string, label: string): unknown {
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert(match !== null, `${label} contains a JSON code block`);
  return JSON.parse(match[1]);
}

function getSection(content: string, heading: string) {
  const start = content.indexOf(heading);
  assert(start !== -1, `${heading} section exists`);
  const section = content.slice(start);
  const next = section.slice(heading.length).search(/\n##\s/);
  return next === -1 ? section : section.slice(0, heading.length + next);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is an object`);
}

function assertString(value: unknown, label: string) {
  assert(typeof value === "string", `${label} is a string`);
}

function assertNumber(value: unknown, label: string) {
  assert(typeof value === "number", `${label} is a number`);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  assert(Array.isArray(value), `${label} is an array`);
}

const handlers: Record<string, CommandHandler> = {};
const { pi, rec } = makePi();

await extensionEntry(pi);

try {
  assert(rec.registeredCommands.includes("audit"), "/audit registered");

  const auditContent = await fs.readFile(AUDIT_PROMPT, "utf8");
  const frontmatter = auditContent.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter !== null, "audit.md has frontmatter");
  assert(frontmatter?.[1].includes("description:"), "audit.md frontmatter includes description");
  assert(frontmatter?.[1].includes("argument-hint:"), "audit.md frontmatter includes argument-hint");
  assert(auditContent.includes("../docs/audit-vipune-policy.md"), "audit.md references vipune policy");
  assert(auditContent.includes("../docs/audit-colgrep-policy.md"), "audit.md references colgrep policy");
  assert(auditContent.includes("../docs/audit-contract-examples.md"), "audit.md references contract examples doc");
  assert(!auditContent.includes("```json"), "runtime prompt no longer contains inline JSON examples");

  const discoverySection = getSection(auditContent, "## Standards Discovery Output Shape");
  assert(discoverySection.includes("discovery_mode"), "discovery section mentions discovery_mode");
  assert(discoverySection.includes("quality_gates"), "discovery section mentions quality_gates");
  assert(discoverySection.includes("../docs/audit-contract-examples.md"), "discovery section points to examples doc");

  const mergedSection = getSection(auditContent, "## Merged Audit Report Shape");
  assert(mergedSection.includes("summary"), "merged section mentions summary");
  assert(mergedSection.includes("findings"), "merged section mentions findings");

  const partialSection = getSection(auditContent, "## Partial-Failure Graceful Degradation Shape");
  assert(partialSection.includes("pass_failures"), "partial section mentions pass_failures");
  assert(partialSection.includes("findings"), "partial section mentions findings");

  await handlers.audit!("", makeCtx());
  const sentAfterDefault = rec.sentMessages.length;
  assert(sentAfterDefault === 1, "/audit emits one message for default scope");

  await handlers.audit!("src/", makeCtx());
  const sentAfterSinglePath = rec.sentMessages.length;
  assert(sentAfterSinglePath === 2, "/audit emits a second message for one path");
  assert(rec.sentMessages[1].includes("src/"), "/audit forwards a single path argument");

  await handlers.audit!("src/ lib/", makeCtx());
  const sentAfterMultiplePaths = rec.sentMessages.length;
  assert(sentAfterMultiplePaths === 3, "/audit emits a third message for multiple paths");
  assert(rec.sentMessages[2].includes("src/ lib/"), "/audit forwards multiple path arguments");

  const examplesContent = await fs.readFile(AUDIT_EXAMPLES, "utf8");
  assert(examplesContent.includes("## Standards Discovery Output Shape"), "examples doc includes discovery example");
  assert(examplesContent.includes("## Merged Audit Report Shape"), "examples doc includes merged example");
  assert(examplesContent.includes("## Partial-Failure Graceful Degradation Shape"), "examples doc includes partial example");

  const discovery = parseJsonBlock(getSection(examplesContent, "## Standards Discovery Output Shape"), "standards discovery example");
  assertObject(discovery, "standards discovery example");
  assertString(discovery.discovery_mode, "standards discovery example.discovery_mode");
  assertArray(discovery.limitations, "standards discovery example.limitations");
  const discoveryStandards = discovery.standards;
  assertObject(discoveryStandards, "standards discovery example.standards");
  const discoveryDocumented = discoveryStandards.documented;
  assertArray(discoveryDocumented, "standards discovery example.standards.documented");
  const discoveryDocumentedFirst = discoveryDocumented[0];
  assertObject(discoveryDocumentedFirst, "standards discovery example.standards.documented[0]");
  assertString(discoveryDocumentedFirst.source, "standards discovery example.standards.documented[0].source");
  assertString(discoveryDocumentedFirst.summary, "standards discovery example.standards.documented[0].summary");
  assertString(discoveryDocumentedFirst.evidence, "standards discovery example.standards.documented[0].evidence");

  const merged = parseJsonBlock(getSection(examplesContent, "## Merged Audit Report Shape"), "merged audit example");
  assertObject(merged, "merged audit example");
  assertString(merged.discovery_mode, "merged audit example.discovery_mode");
  const mergedSummary = merged.summary;
  assertObject(mergedSummary, "merged audit example.summary");
  assertNumber(mergedSummary.passes_completed, "merged audit example.summary.passes_completed");
  const mergedFindings = merged.findings;
  assertArray(mergedFindings, "merged audit example.findings");
  const mergedFirstFinding = mergedFindings[0];
  assertObject(mergedFirstFinding, "merged audit example.findings[0]");
  assertString(mergedFirstFinding.category, "merged audit example.findings[0].category");
  assertString(mergedFirstFinding.severity, "merged audit example.findings[0].severity");
  assertString(mergedFirstFinding.evidence, "merged audit example.findings[0].evidence");

  const partial = parseJsonBlock(getSection(examplesContent, "## Partial-Failure Graceful Degradation Shape"), "partial failure example");
  assertObject(partial, "partial failure example");
  assertString(partial.discovery_mode, "partial failure example.discovery_mode");
  const partialSummary = partial.summary;
  assertObject(partialSummary, "partial failure example.summary");
  assertNumber(partialSummary.total_passes, "partial failure example.summary.total_passes");
  const partialFailures = partial.pass_failures;
  assertArray(partialFailures, "partial failure example.pass_failures");
  const partialFirstFailure = partialFailures[0];
  assertObject(partialFirstFailure, "partial failure example.pass_failures[0]");
  assertString(partialFirstFailure.pass, "partial failure example.pass_failures[0].pass");
  assertString(partialFirstFailure.error, "partial failure example.pass_failures[0].error");
} catch (error) {
  exit = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  console.log("\n=== test-audit summary ===");
  console.log(exit === 0 ? "All audit smoke tests passed." : "Audit smoke tests failed.");
  console.log(`exit ${exit}`);
  process.exit(exit);
}
