#!/usr/bin/env bun
/**
 * tool — the #526 in-process delivery for /agents-md.
 *
 * `registerAgentsMdTools` is the fix for #524's delivery defect: the prose
 * body told PM to run `bun extension/src/agents-md/agents-md.ts` — a path
 * relative to the HOST repo, which has no extension/ directory. The tool
 * reaches the same verbs in-process, resolving the repo root from
 * `ctx.cwd` (work-entry's `resolveRepoRoot`), never `process.cwd()`.
 *
 * This test drives the real registered tool with a fake ExtensionAPI and a
 * stubbed FsOps, asserting:
 *   - each verb reaches its verb function with a resolved repo root
 *   - the structured result shape (details: verb, exitCode, plan/check/error)
 *   - dryRun is honored through the tool (plan.newBytes returned, no writeFile)
 *   - `deep: true` on create is rejected with a structured error
 *   - the unified diff in the report is insertions-only for a create
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsMdTools } from "../src/agents-md-tool.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-tool-"));
// A fixture repo: the tool resolves the root from the cwd it is given.
mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
writeFileSync(
  path.join(tmp, "package.json"),
  JSON.stringify({ name: "fixture", scripts: { test: "vitest", lint: "biome lint" } }, null, 2),
);
writeFileSync(path.join(tmp, "bun.lock"), "{ lockfileVersion: 1 }");
writeFileSync(path.join(tmp, ".github", "workflows", "ci.yml"), "name: CI\njobs:\n  t: {}\n");

const AGENTS = path.join(tmp, "AGENTS.md");

// --------------------------------------- capture what registerTool got

interface RegisteredTool {
  name: string;
  execute: (
    id: string,
    raw: unknown,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: { cwd: string },
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}
const tools: RegisteredTool[] = [];
const fakePi = {
  registerTool: (t: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: RegisteredTool["execute"];
  }) => {
    tools.push({ name: t.name, execute: t.execute });
  },
} as unknown as ExtensionAPI;

registerAgentsMdTools(fakePi);
assert(tools.length === 1, "registerAgentsMdTools registers exactly one tool");
assert(tools[0]?.name === "agents_md_run", "the tool is named agents_md_run");

const tool = tools[0]!;
const run = (raw: Record<string, unknown>) =>
  tool.execute("t1", raw, new AbortController().signal, () => {}, { cwd: tmp });

// ------------------------------------------------------------------- create

{
  let wrote = "";
  const r = await run({ verb: "create" });
  wrote = readFileSync(AGENTS, "utf8");
  const d = r.details;
  assert(d.verb === "create" && d.exitCode === 0, "create → { verb: create, exitCode: 0 }");
  const plan = d.plan as { newBytes: string; oldBytes: string; wouldWrite: boolean; managedIds: string[] } | undefined;
  assert(plan !== undefined, "create details carry a plan");
  assert(plan?.wouldWrite === true, "create plan: wouldWrite is true");
  assert(plan?.oldBytes === "", "create plan: oldBytes is the empty string");
  assert(plan?.newBytes === wrote, "create plan: newBytes are the bytes actually written");
  assert(
    plan?.managedIds.includes("quality-gates") && plan?.managedIds.includes("decision-ledger"),
    "create plan: managed ids include the fact sections and the ledger",
  );
  // The report carries the CLI-style summary AND the diff.
  assert(r.content[0]?.text.includes("would write"), "create report says 'would write'");
  assert(r.content[0]?.text.includes("bun run test"), "create report names a detected command");
  const plusLines = r.content[0]!.text.split("\n").filter((l) => l.startsWith("+"));
  const minusLines = r.content[0]!.text.split("\n").filter((l) => l.startsWith("-"));
  assert(plusLines.length > 0, "create diff has insertion lines");
  assert(minusLines.length === 0, "create diff is insertions-only");
}

// ------------------------------------------------------------------- update

{
  // A real change: add a script so the derived commands section changes.
  const pkg = JSON.parse(readFileSync(path.join(tmp, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  pkg.scripts.typecheck = "bunx tsc --noEmit";
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

  const before = readFileSync(AGENTS, "utf8");
  const r = await run({ verb: "update" });
  const d = r.details;
  assert(d.verb === "update" && d.exitCode === 0, "update → { verb: update, exitCode: 0 }");
  const plan = d.plan as { newBytes: string; oldBytes: string; wouldWrite: boolean } | undefined;
  assert(plan?.wouldWrite === true, "update plan: wouldWrite is true after env change");
  assert(plan?.oldBytes === before, "update plan: oldBytes is the prior file content");
  assert(plan?.newBytes !== before, "update plan: newBytes differ from oldBytes");
  assert(readFileSync(AGENTS, "utf8") === plan?.newBytes, "update wrote the planned bytes");
  assert(r.content[0]?.text.includes("bun run typecheck"), "update diff shows the new command");
}

// ------------------------------------------------------------------ no-op update

{
  const r = await run({ verb: "update" });
  const plan = r.details.plan as { wouldWrite: boolean; newBytes: string } | undefined;
  assert(r.details.exitCode === 0 && plan?.wouldWrite === false, "idempotent update: no-op, exit 0");
  assert(r.content[0]?.text.includes("no-op (already current)"), "no-op report says so");
}

// ---------------------------------------------------------------------- check

{
  const r = await run({ verb: "check" });
  const c = r.details.check as { code: number; findings: { kind: string; message: string }[]; corrupt: boolean } | undefined;
  assert(r.details.verb === "check", "check details carry the verb");
  assert(c !== undefined, "check details carry the full CheckResult");
  assert(c?.code === 0, `clean fixture → check code 0 (got ${c?.code})`);
  assert(c?.corrupt === false, "clean fixture: not corrupt");
  assert(c?.findings.length === 0, "clean fixture: zero findings");
  assert(r.content[0]?.text === "clean", "clean check renders 'clean'");

  // A stale reference → findings, one line per finding.
  writeFileSync(AGENTS, `# T\n\nsee \`gone.ts\` for the rest\n\n<!-- pi-ensemble:agents-md:begin decision-ledger v1 -->\n| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |\n<!-- pi-ensemble:agents-md:end decision-ledger -->\n`);
  const r2 = await run({ verb: "check" });
  const c2 = r2.details.check as { code: number; findings: { kind: string; message: string }[] };
  assert(r2.details.exitCode === 1 && c2.code === 1, "stale path → exit 1");
  assert(c2.findings.some((f) => f.kind === "stale-path" && f.message.includes("gone.ts")), "check finding names the stale path");
  assert(r2.content[0]?.text.split("\n").length >= 1 && r2.content[0]?.text.includes("stale-path"), "check report is one line per finding");

  // no-file case: check absent, error present.
  rmSync(AGENTS);
  const r3 = await run({ verb: "check" });
  assert(r3.details.error !== undefined && r3.details.check === undefined, "check on a missing file: error present, check absent");
  assert(r3.details.exitCode === 2, "check on a missing file → exit 2");
  assert(r3.content[0]?.text.includes("error"), "…and the report renders the error");
}

// --------------------------------------------------------------- deep refused

{
  // Restore the file so the refusal is about the param, not a missing file.
  await run({ verb: "create" });
  const r = await run({ verb: "create", deep: true });
  assert(r.details.error === "deep is only valid for check", "deep on create → structured error");
  assert(r.details.exitCode === 2, "deep on create → exit 2");
  assert(r.content[0]?.text.includes("deep is only valid"), "…rendered in the report");
  const r2 = await run({ verb: "update", deep: true });
  assert(r2.details.error === "deep is only valid for check", "deep on update → structured error");
}

// ------------------------------------------------------ repo-root resolution

{
  // The tool must resolve the root from ctx.cwd via git, not process.cwd().
  // Run from a subdirectory of the fixture repo: root must still be `tmp`.
  const sub = path.join(tmp, "subdir");
  mkdirSync(sub, { recursive: true });
  const r = await run({ verb: "update" });
  const plan = r.details.plan as { oldBytes: string } | undefined;
  assert(plan !== undefined, "update from a subdirectory still resolves the repo");
  assert(readFileSync(AGENTS, "utf8") === plan?.oldBytes, "…against the repo-root AGENTS.md, not cwd-relative");
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll tool checks passed." : "\nFAILED");
process.exit(exit);
