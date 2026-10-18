#!/usr/bin/env bun
/**
 * Headless S6 (#1021) — `pi-rukas-headless research` drives the real
 * /research pipeline with stub dispatch, git, fetch, vipune and memory (no
 * model call, no network) and maps its result to the exit code and JSON:
 *
 *   verified findings  → 0, status "completed", artifact under <repo>/outputs/
 *   gaps only          → 0, "abstained": true, artifact still written
 *   no usable claims   → 30, the halt reason
 *   deep, entailment dispatch failed → 0, "entailment": "unavailable"
 *   unknown tier       → 40, error.code "unknown-tier", nothing dispatched
 *   every tier name    → accepted
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runResearchVerb } from "../src/headless/research.ts";
import { setResearchDispatch } from "../src/research-driver.ts";
import { RESEARCH_TIERS } from "../src/research-types.ts";
import type { ExecFn } from "../src/worktree.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();

let mode: "findings" | "gaps-only" | "empty" = "findings";
let dispatches = 0;
const claim = (kind: string, text: string, source: string, sourceKind: string) => ({
  name: "report_research_claim",
  arguments: { kind, text, source, sourceKind, confidence: "high", staleness: "stable" },
});
setResearchDispatch(((_pi: unknown, _spec: unknown, opts?: { label?: string }) => {
  dispatches++;
  if (opts?.label === "research-entailment") {
    return Promise.resolve({
      role: "explore",
      ok: false,
      text: "",
      toolUses: [],
      ms: 1,
      exitCode: 1,
    });
  }
  const toolUses =
    mode === "empty"
      ? [{ name: "report_research_claim", arguments: { kind: "finding", text: "" } }]
      : mode === "gaps-only"
        ? [claim("gap", "could not answer", "none", "none")]
        : [claim("finding", "the scoring is RRF", "https://a/live", "url")];
  return Promise.resolve({
    role: "explore",
    ok: true,
    text: "angle summary",
    toolUses,
    ms: 1,
    exitCode: 0,
  });
}) as never);

const execFn: ExecFn = async (cmd) => {
  if (cmd.startsWith("git rev-parse")) return { stdout: "feedbeef12345\n" };
  throw new Error(`unexpected: ${cmd}`);
};
const deps = {
  execFn,
  fetchFn: (async () => ({ status: 200 })) as never,
  vipuneSearchFn: (async () => ({ kind: "hits", hits: [] })) as never,
  memoryWriteFn: (async () => ({ outcome: "written" as const, id: "m1" })) as never,
};
const research = (argv: readonly string[], ctx: Parameters<typeof runResearchVerb>[1]) =>
  runResearchVerb(argv, ctx, deps);

async function freshRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "headless-research-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
  return tmp;
}
const repos: string[] = [];

{
  const repo = await freshRepo();
  repos.push(repo);
  mode = "findings";
  const r = await runVerb(
    "research",
    ["how rrf scoring works", "--tier", "quick", "--json"],
    repo,
    research,
  );
  assert(r.violations.length === 0, `findings: output contract (${r.violations.join("; ")})`);
  assert(r.code === 0, `findings exits 0 (got ${r.code})`);
  assert(r.doc.status === "completed" && r.doc.abstained === false, "findings: completed");
  const artifact = String(r.doc.artifactPath);
  assert(
    artifact.startsWith(path.join(repo, "outputs") + path.sep),
    `artifact under outputs/ (${artifact})`,
  );
  assert(
    await fs.stat(artifact).then(
      () => true,
      () => false,
    ),
    "findings: the artifact exists",
  );
}

{
  const repo = await freshRepo();
  repos.push(repo);
  mode = "gaps-only";
  const r = await runVerb(
    "research",
    ["an unanswerable question", "--tier", "quick"],
    repo,
    research,
  );
  assert(r.violations.length === 0, `abstained: output contract (${r.violations.join("; ")})`);
  assert(r.code === 0, `abstention exits 0 (got ${r.code})`);
  assert(r.doc.abstained === true && r.doc.status === "abstained", "abstention: abstained true");
  assert(typeof r.doc.artifactPath === "string", "abstention: the artifact is still written");
}

{
  const repo = await freshRepo();
  repos.push(repo);
  mode = "empty";
  const r = await runVerb("research", ["t", "--tier", "quick"], repo, research);
  assert(r.violations.length === 0, `halt: output contract (${r.violations.join("; ")})`);
  assert(r.code === 30, `a halted run exits 30 (got ${r.code})`);
  assert((r.doc.halt as { reason?: string })?.reason === "no-structured-claims", "halt: reason");
}

{
  const repo = await freshRepo();
  repos.push(repo);
  mode = "findings";
  const r = await runVerb("research", ["how rrf scoring works", "--tier", "deep"], repo, research);
  assert(r.violations.length === 0, `deep: output contract (${r.violations.join("; ")})`);
  assert(r.code === 0, `deep with entailment unavailable exits 0 (got ${r.code})`);
  assert(
    r.doc.entailment === "unavailable",
    `deep: entailment unavailable (got ${r.doc.entailment})`,
  );
}

{
  dispatches = 0;
  const r = await runVerb("research", ["t", "--tier", "bogus"], process.cwd(), research);
  assert(r.code === 40, `unknown tier exits 40 (got ${r.code})`);
  assert((r.doc.error as { code?: string })?.code === "unknown-tier", "unknown tier: error.code");
  assert(dispatches === 0, "unknown tier: nothing dispatched");
  const none = await runVerb("research", [], process.cwd(), research);
  assert(none.code === 40, "no topic → 40");
}

for (const tier of RESEARCH_TIERS) {
  const repo = await freshRepo();
  repos.push(repo);
  mode = "findings";
  const r = await runVerb("research", ["tier check", "--tier", tier], repo, research);
  assert(r.code === 0 && r.doc.tier === tier, `tier "${tier}" accepted (exit ${r.code})`);
}

setResearchDispatch(null);
for (const d of repos) await fs.rm(d, { recursive: true, force: true });
process.exit(state.exit);
