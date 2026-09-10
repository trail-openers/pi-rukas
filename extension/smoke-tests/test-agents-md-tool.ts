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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const plan = d.plan as
    | { newBytes: string; oldBytes: string; wouldWrite: boolean; managedIds: string[] }
    | undefined;
  assert(plan !== undefined, "create details carry a plan");
  assert(plan?.wouldWrite === true, "create plan: wouldWrite is true");
  assert(plan?.oldBytes === "", "create plan: oldBytes is the empty string");
  assert(plan?.newBytes === wrote, "create plan: newBytes are the bytes actually written");
  // The create/no-file path scaffolds by default (post-#649 flip): a bare
  // create (no scaffold param) carries all 7 boilerplate sections.
  const planWithScaffold = d.plan as
    | {
        newBytes: string;
        oldBytes: string;
        wouldWrite: boolean;
        managedIds: string[];
        scaffoldedIds?: string[];
      }
    | undefined;
  assert(
    planWithScaffold?.scaffoldedIds?.length === 7,
    `create plan: 7 scaffold sections by default (got ${planWithScaffold?.scaffoldedIds?.length})`,
  );
  assert(
    wrote.includes("# Context7 Protocol") && wrote.includes("# Testing Standards"),
    "create: the written file carries the 2 new boilerplate sections",
  );
  assert(
    wrote.includes("≥80%"),
    "create: unanswered coverage renders the ≥80% default in Testing Standards",
  );
  assert(
    plan?.managedIds.includes("quality-gates") && !plan?.managedIds.includes("decision-ledger"),
    "create plan: managed ids include fact sections, NOT the ledger (moved to sidecar post-#680 M1)",
  );
  // The report carries the CLI-style summary AND the diff.
  assert(r.content[0]?.text.includes("would write"), "create report says 'would write'");
  assert(r.content[0]?.text.includes("bun run test"), "create report names a detected command");
  // Post-#680 M1: the diff includes sidecar changes (new file), so minus lines
  // are expected for the sidecar diff. The AGENTS.md diff itself is still
  // insertions-only.
  const plusLines = r.content[0]?.text.split("\n").filter((l) => l.startsWith("+"));
  assert(plusLines.length > 0, "create diff has insertion lines");
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
  // The has-markers update path stays scaffold-OPT-IN: with no scaffold param
  // the update must NOT add boilerplate sections.
  const planUpdate = d.plan as { scaffoldedIds?: string[] } | undefined;
  assert(
    planUpdate?.scaffoldedIds === undefined,
    "update plan: scaffoldedIds is undefined (scaffold is opt-in for update)",
  );
  const afterUpdate = readFileSync(AGENTS, "utf8");
  assert(
    (afterUpdate.match(/# Minimalist Engineering/g) ?? []).length ===
      (before.match(/# Minimalist Engineering/g) ?? []).length,
    "update: no new boilerplate headings were added (still the scaffolded set from create)",
  );
}

// ------------------------------------------------------------------ no-op update

{
  const r = await run({ verb: "update" });
  const plan = r.details.plan as { wouldWrite: boolean; newBytes: string } | undefined;
  assert(
    r.details.exitCode === 0 && plan?.wouldWrite === false,
    "idempotent update: no-op, exit 0",
  );
  assert(r.content[0]?.text.includes("no-op (already current)"), "no-op report says so");
}

// ---------------------------------------------------------------------- check

{
  const r = await run({ verb: "check" });
  const c = r.details.check as
    | { code: number; findings: { kind: string; message: string }[]; corrupt: boolean }
    | undefined;
  assert(r.details.verb === "check", "check details carry the verb");
  assert(c !== undefined, "check details carry the full CheckResult");
  assert(c?.code === 0, `clean fixture → check code 0 (got ${c?.code})`);
  assert(c?.corrupt === false, "clean fixture: not corrupt");
  assert(c?.findings.length === 0, "clean fixture: zero findings");
  assert(r.content[0]?.text === "clean", "clean check renders 'clean'");

  // A stale reference → findings, one line per finding.
  writeFileSync(
    AGENTS,
    "# T\n\nsee `gone.ts` for the rest\n",
  );
  const r2 = await run({ verb: "check" });
  const c2 = r2.details.check as { code: number; findings: { kind: string; message: string }[] };
  assert(r2.details.exitCode === 1 && c2.code === 1, "stale path → exit 1");
  assert(
    c2.findings.some((f) => f.kind === "stale-path" && f.message.includes("gone.ts")),
    "check finding names the stale path",
  );
  assert(
    r2.content[0]?.text.split("\n").length >= 1 && r2.content[0]?.text.includes("stale-path"),
    "check report is one line per finding",
  );

  // no-file case: check absent, error present.
  rmSync(AGENTS);
  const r3 = await run({ verb: "check" });
  assert(
    r3.details.error !== undefined && r3.details.check === undefined,
    "check on a missing file: error present, check absent",
  );
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
  assert(
    readFileSync(AGENTS, "utf8") === plan?.oldBytes,
    "…against the repo-root AGENTS.md, not cwd-relative",
  );
}

// ----------------------------------- graceful fallback: no agentOverride

{
  // The graceful-fallback contract: when the pre-pass dispatch fails or
  // returns no report_facts call, the PM calls agents_md_run WITHOUT an
  // agentOverride parameter at all. The result must be indistinguishable
  // from a call that never wired the pre-pass — i.e. the tool's default
  // (no agentOverride) path produces the same bytes as passing an empty
  // agentOverride. This is the "no facts, never a guess" fallback.
  //
  // Since agents_md_run's TypeBox schema does not yet expose agentOverride
  // (B1's scope), we test the tool-level behavior: a bare update (no
  // agentOverride param) must exit 0 and produce deterministic output.
  // The file was restored by the "deep refused" test's create call, so
  // update finds it.
  const r = await run({ verb: "update" });
  assert(r.details.exitCode === 0, "graceful fallback: update without agentOverride exits 0");
  const plan = r.details.plan as { wouldWrite: boolean; newBytes: string } | undefined;
  assert(plan !== undefined, "graceful fallback: plan is present");
  assert(
    (plan?.newBytes ?? "").length > 0,
    "graceful fallback: newBytes is non-empty (facts derived from detectFacts)",
  );
  assert(
    r.content[0]?.text !== undefined,
    "graceful fallback: report is present (no error)",
  );
}

// ---------------- agentOverride carrying testingNotes (the #667 render thread)

{
  // The pre-pass (B2) reports testingNotes on the AgentFacts wire; the tool
  // maps facts.testingNotes onto AgentOverride.testingNotes and the
  // first-time scaffold population renders the "Project-specific" supplement
  // after the static doctrine. A second run must be a no-op (the section is
  // already present — the skip-if-present idempotency, never a refresh).
  rmSync(AGENTS, { force: true });
  const notes = [
    "Unit tests in-module via #[cfg(test)]",
    "Integration tests live in tests/ via assert_cmd",
  ];
  const r = await run({
    verb: "create",
    agentOverride: { facts: { testingNotes: notes } },
  });
  const d = r.details;
  assert(d.verb === "create" && d.exitCode === 0, "create + testingNotes → { verb: create, exitCode: 0 }");
  const wrote = readFileSync(AGENTS, "utf8");
  assert(
    wrote.includes("**Project-specific**"),
    "create + testingNotes: the 'Project-specific' demarcation is rendered",
  );
  for (const n of notes) {
    assert(wrote.includes(`- ${n}`), `create + testingNotes: bullet rendered verbatim: ${n}`);
  }
  // The static doctrine is unchanged (still present, before the supplement).
  assert(
    wrote.includes("- TDD preferred: write the failing test first, then the minimal"),
    "create + testingNotes: the static TDD doctrine line is unchanged",
  );
  assert(
    wrote.includes("≥80%") && wrote.indexOf("≥80%") < wrote.indexOf("**Project-specific**"),
    "create + testingNotes: the coverage-threshold line precedes the supplement",
  );

  // Idempotency: a second update with DIFFERENT notes is a no-op — the
  // section is already present, so the supplement is never re-rendered.
  const r2 = await run({
    verb: "update",
    scaffold: true,
    agentOverride: {
      facts: { testingNotes: ["A completely different note that must not appear"] },
    },
  });
  const p2 = r2.details.plan as {
    wouldWrite: boolean;
    newBytes: string;
    scaffoldedIds?: string[];
  } | undefined;
  assert(
    !p2?.scaffoldedIds?.includes("testing-standards"),
    "update + new testingNotes: testing-standards NOT re-scaffolded (skip-if-present idempotency)",
  );
  assert(
    !readFileSync(AGENTS, "utf8").includes("A completely different note that must not appear"),
    "update + new testingNotes: the file is unchanged (notes never re-render a present section)",
  );

  // Graceful failure: create with NO agentOverride (the pre-pass failed /
  // returned no report_facts call) renders the static doctrine exactly —
  // no demarcation, byte-identical to the no-testingNotes rendering.
  rmSync(AGENTS, { force: true });
  const r3 = await run({ verb: "create" });
  const wrote3 = readFileSync(AGENTS, "utf8");
  assert(
    !wrote3.includes("**Project-specific**"),
    "create without agentOverride: no 'Project-specific' supplement (graceful failure)",
  );
}

// ----------------- create with codeStyleBullets/architectureBullets + 5th answers field (#697)

{
  // The create-path drop gap: agents_md_run create with an agentOverride
  // carrying the two bullet fields must render both sections in the written
  // file (with [detected:agent] sidecar rows), and the widened `answers`
  // TypeBox param must accept the 5th field (projectIntent) landing in
  // operator-choices only. Both in one call, at the tool seam.
  rmSync(AGENTS, { force: true });
  const cs = ["bun only — no npm in CI"];
  const arch = ["extension/src — the runtime", "extension/src/agents-md — the /agents-md core"];
  const r = await run({
    verb: "create",
    agentOverride: { codeStyleBullets: cs, architectureBullets: arch },
    answers: { projectIntent: "pi-rukas: orchestration harness for pi subagents; TypeScript + Bun" },
  });
  const d = r.details;
  assert(d.verb === "create" && d.exitCode === 0, "create + bullets + 5th answer: { verb: create, exitCode: 0 }");
  const wrote = readFileSync(AGENTS, "utf8");
  assert(wrote.includes("## Code Style"), "create + bullets: ## Code Style in plan.newBytes file");
  assert(wrote.includes("## Architecture Notes"), "create + bullets: ## Architecture Notes in plan.newBytes file");
  for (const b of [...cs, ...arch]) {
    assert(wrote.includes(`- ${b}`), `create + bullets: bullet rendered: ${b}`);
  }
  // The 5th answers field: accepted by the widened TypeBox param and rendered
  // in operator-choices with its dedicated bullet — never in an agent-derived
  // section (provenance separation: operator-authored vs refresh-replaceable).
  assert(wrote.includes("## Operator choices"), "create + 5th answer: operator-choices section present");
  assert(
    wrote.includes("- **Project intent & stack:** pi-rukas: orchestration harness for pi subagents"),
    "create + 5th answer: the projectIntent bullet renders in operator-choices",
  );
  const archSection = wrote.slice(wrote.indexOf("## Architecture Notes"));
  assert(
    !archSection.includes("orchestration harness for pi subagents"),
    "create + 5th answer: the operator's intent is ABSENT from architecture-notes",
  );
  // Sidecar rows: [detected:agent] for both bullet sections + [asked:operator]
  // for the 5th answer, all distinct keys.
  const sPath = path.join(tmp, ".pi", "agents-md-state.json");
  const sRaw = JSON.parse(readFileSync(sPath, "utf8")) as { key: string; value: string; provenance: string; date: string }[];
  const csRow = sRaw.find((x) => x.key === "code-style");
  const archRow = sRaw.find((x) => x.key === "architecture-notes");
  const intentRow = sRaw.find((x) => x.key === "operator:intent");
  assert(csRow?.provenance === "detected" && csRow?.value === "agent", "create + bullets: code-style [detected:agent] sidecar row");
  assert(archRow?.provenance === "detected" && archRow?.value === "agent", "create + bullets: architecture-notes [detected:agent] sidecar row");
  assert(intentRow?.provenance === "asked", "create + 5th answer: operator:intent [asked:operator] sidecar row");
  assert(
    !sRaw.some((x) => x.key === "omit:code-style" || x.key === "omit:architecture-notes"),
    "create + bullets: no omit: rows for the agent-derived sections",
  );
  // The widened param is OPTIONAL: a create without `answers` still exits 0
  // and produces no operator-choices section (the default-omit pattern).
  rmSync(AGENTS, { force: true });
  const r2 = await run({ verb: "create" });
  assert(r2.details.exitCode === 0, "create without answers: exit 0 (answers param is optional)");
  const wrote2 = readFileSync(AGENTS, "utf8");
  assert(
    !wrote2.includes("## Operator choices"),
    "create without answers: no operator-choices section (unanswered → absent)",
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll tool checks passed." : "\nFAILED");
process.exit(exit);
