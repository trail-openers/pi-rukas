#!/usr/bin/env bun
/**
 * Headless S6 (#1021) — `pi-rukas-headless agents-md` maps the agents-md
 * verb's own code to the process exit code (0 → 0, 1 → 10, 2 → 40,
 * 3 → 10 gated) and prints only JSON on stdout.
 *
 * The check cases spawn the real CLI entry (`bun src/headless/cli.ts`) in a
 * scratch repo, so the asserted code is what the process actually exits with:
 *
 *   clean AGENTS.md      → 0,  status "clean", findings []
 *   stale path           → 10, status "findings", the stale-path finding
 *   missing AGENTS.md    → 40, status "refused", error
 *   unknown verb / flag  → 40, error.code "bad-arguments"
 *
 * In process: an update reports `wouldWrite`, and agentsMdExit maps 3 to a
 * gated 10 (no deterministic check produces 3 today).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderLedger } from "../src/agents-md/ledger.ts";
import { agentsMdExit } from "../src/headless/agents-md.ts";
import { validateNdjsonLine } from "../src/headless/ndjson.ts";
import { makeAssert, runVerb } from "./headless-verb-harness.ts";

const { assert, state } = makeAssert();
const CLI = path.join(import.meta.dirname, "..", "src", "headless", "cli.ts");

function scratchRepo(agentsMd: string | undefined): string {
  const root = mkdtempSync(path.join(tmpdir(), "headless-agents-md-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  if (agentsMd !== undefined) writeFileSync(path.join(root, "AGENTS.md"), agentsMd);
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "agents-md-state.json"),
    renderLedger([{ key: "k", value: "v", provenance: "auto", date: "2026-01-01" }]),
  );
  return root;
}

/** Spawn the real entry; returns the exit code, the stdout document and the stderr lines. */
function spawnCli(cwd: string, args: string[]) {
  const r = spawnSync("bun", [CLI, "agents-md", ...args], { cwd, encoding: "utf8" });
  const docs = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
  const bad = lines.filter((l) => {
    try {
      return validateNdjsonLine(JSON.parse(l)).length > 0;
    } catch {
      return true;
    }
  });
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(docs[0] ?? "");
  } catch {}
  return { code: r.status, docs: docs.length, doc, lines: lines.length, bad };
}

const gate = ["# T", "", "## Quality Gates", ""];
const roots: string[] = [];

{
  const root = scratchRepo([...gate, "- **g** — `bun run test`"].join("\n"));
  roots.push(root);
  const r = spawnCli(root, ["check", "--json"]);
  assert(r.code === 0, `clean check exits 0 (got ${r.code})`);
  assert(r.docs === 1 && r.doc.status === "clean", "clean: one JSON document, status clean");
  assert(r.doc.verb === "check" && r.doc.subcommand === "agents-md", "clean: verb and subcommand");
  assert(
    Array.isArray(r.doc.findings) && (r.doc.findings as unknown[]).length === 0,
    "clean: no findings",
  );
  assert(r.lines > 0 && r.bad.length === 0, `clean: NDJSON on stderr (${r.bad.join(" | ")})`);
}

{
  const root = scratchRepo([...gate, "- see `gone-file.ts` for details"].join("\n"));
  roots.push(root);
  const r = spawnCli(root, ["check"]);
  assert(r.code === 10, `findings check exits 10 (got ${r.code})`);
  const findings = r.doc.findings as { kind: string; message: string }[];
  assert(
    r.doc.status === "findings" && findings.some((f) => f.kind === "stale-path"),
    "findings: status and the stale-path finding",
  );
  assert(r.lines > 0 && r.bad.length === 0, "findings: NDJSON on stderr");
}

{
  const root = scratchRepo(undefined);
  roots.push(root);
  const r = spawnCli(root, ["check"]);
  assert(r.code === 40, `missing AGENTS.md exits 40 (got ${r.code})`);
  assert(
    r.doc.status === "refused" &&
      typeof (r.doc.error as { message?: string })?.message === "string",
    "refused: error carried",
  );
  assert(r.lines > 0 && r.bad.length === 0, "refused: NDJSON on stderr");
}

{
  const root = scratchRepo(undefined);
  roots.push(root);
  for (const args of [["frobnicate"], ["check", "--merge"], []]) {
    const r = spawnCli(root, args);
    assert(
      r.code === 40 && (r.doc.error as { code?: string })?.code === "bad-arguments",
      `bad arguments [${args.join(" ")}] → 40 bad-arguments (got ${r.code})`,
    );
  }
}

{
  const root = scratchRepo([...gate, "- **g** — `bun run test`"].join("\n"));
  roots.push(root);
  const r = await runVerb("agents-md", ["update", root], root);
  assert(r.violations.length === 0, `update: output contract (${r.violations.join("; ")})`);
  assert(typeof r.doc.wouldWrite === "boolean", "update: wouldWrite reported");
  assert(r.doc.verb === "update", "update: verb");
}

{
  const g = agentsMdExit(3);
  assert(g.exitCode === 10 && g.status === "gated", "gated on a human (3) → 10, status gated");
  assert(agentsMdExit(2).exitCode === 40 && agentsMdExit(1).exitCode === 10, "2 → 40, 1 → 10");
}

for (const d of roots) rmSync(d, { recursive: true, force: true });
process.exit(state.exit);
