#!/usr/bin/env bun
/**
 * agent-override — the #659 B1 agentOverride/refresh seam.
 *
 * A no-manifest fixture (a hand-built has-markers file with NO detected
 * manifest) is updated with an agentOverride carrying facts + codeStyleBullets.
 * The 3 fact sections are built from the override via the existing
 * gatesBody/commandsBody/environmentBody, the code-style pair is inserted
 * after the environment section, and the ledger rows are stamped
 * [detected:agent,today]. A second identical update (no agentOverride, no
 * refresh, LATER date) is byte-identical and upserts ZERO omit:* rows.
 *
 * Refresh semantics: refresh: true + agentOverride DIRECTLY REPLACES the
 * [detected:agent] rows for sections whose existing ledger row is
 * [detected:agent,...] — bypassing mergeAutoRows. A differing body bumps the
 * date; an identical body (post trailing-newline normalisation) is a no-op
 * (date unchanged). A rich-manifest fixture's [auto,...] rows are NEVER
 * touched by refresh.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsMdFs,
  createAgent,
  updateAgent,
} from "../src/agents-md/agents-md.ts";
import { parseLedger } from "../src/agents-md/ledger.ts";
import { gatesBody } from "../src/agents-md/renderer.ts";
import { sidecarPath } from "../src/agents-md/sidecar.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkFs(today: string): AgentsMdFs {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, b) => writeFileSync(p, b),
    stat: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    today: () => today,
  };
}

// ===================================================== 1. agentOverride: first-time population + code-style insertion

{
  const noManifestDir = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-nomanifest-"));
  const noManifestAgents = path.join(noManifestDir, "AGENTS.md");

  // Hand-built has-markers file: 3 fact sections with non-empty bodies, a
  // decision-ledger with a single auto row. NO manifest on disk, so
  // detectFacts would derive no commands / no manifest → the sections would
  // be omitted without an agentOverride.
  const seedFile = [
    "# T",
    "<!-- pi-rukas:agents-md:begin quality-gates v1 -->",
    "- **gate** — `some command`",
    "<!-- pi-rukas:agents-md:end quality-gates -->",
    "<!-- pi-rukas:agents-md:begin commands v1 -->",
    "| kind | command |",
    "| --- | --- |",
    "| test | `some command` |",
    "<!-- pi-rukas:agents-md:end commands -->",
    "<!-- pi-rukas:agents-md:begin environment v1 -->",
    "- CI: no `.github/workflows/` detected",
    "<!-- pi-rukas:agents-md:end environment -->",
    "<!-- pi-rukas:agents-md:begin decision-ledger v1 -->",
    "| key | value | provenance |",
    "| --- | --- | --- |",
    "| k | v | [auto:2026-01-01] |",
    "<!-- pi-rukas:agents-md:end decision-ledger -->",
    "",
  ].join("\n");
  writeFileSync(noManifestAgents, seedFile);

  // Facts that produce bodies for ALL 3 fact sections: a manifest (for
  // environment) and non-empty commands (for quality-gates + commands). This
  // is the shape B2 will produce — a real agent dispatch that found a manifest
  // and its commands.
  const overrideFacts = {
    manifest: "package.json",
    packageManager: "bun",
    commands: [
      { name: "bun test", command: "bun test", kind: "test" as const, runner: "bun" },
    ],
    ciWorkflows: [],
    notes: [],
  };

  // Call 1: seed with agentOverride (facts + codeStyleBullets).
  const fs1 = mkFs("2026-01-01");
  const r1 = updateAgent(noManifestDir, noManifestAgents, fs1, {
    agentOverride: {
      facts: overrideFacts,
      codeStyleBullets: ["Use bun for all JS/TS work", "Run the full test suite before push"],
    },
  });
  const after1 = fs1.readFile(noManifestAgents);
  assert(r1.exitCode === 0, "agentOverride #1: exit 0");
  assert(r1.plan?.wouldWrite === true, "agentOverride #1: wouldWrite is true");
  // The 3 fact sections are built from the override facts (not detectFacts).
  assert(
    after1.includes("- **bun test** — `bun test`"),
    "agentOverride #1: quality-gates built from override facts",
  );
  assert(
    after1.includes("| test | `bun test` |"),
    "agentOverride #1: commands built from override facts",
  );
  // Code-style pair is inserted (first-time) after the environment section.
  assert(
    after1.includes("<!-- pi-rukas:agents-md:begin code-style v1 -->"),
    "agentOverride #1: code-style pair inserted",
  );
  const envEndIdx = after1.indexOf("<!-- pi-rukas:agents-md:end environment -->");
  const csBeginIdx = after1.indexOf("<!-- pi-rukas:agents-md:begin code-style v1 -->");
  assert(csBeginIdx > envEndIdx, "agentOverride #1: code-style inserted after environment");
  assert(
    after1.includes("- Use bun for all JS/TS work"),
    "agentOverride #1: code-style bullets rendered",
  );
  // Ledger rows are [detected:agent,today] for the 3 fact sections.
  // Post-#680 M1: the ledger is in the sidecar, not the in-file span.
  const sPath1 = sidecarPath(noManifestDir);
  const parsedLedger1 = parseLedger(fs1.readFile(sPath1));
  const detectedIds = parsedLedger1.filter((r) => r.provenance === "detected").map((r) => r.key);
  // All 3 fact sections have bodies (manifest + non-empty commands) → all 3
  // get [detected:agent] rows. This is the shape the churn-loop acceptance
  // criterion assumes: "the ledger already carries [detected:agent,<date>]
  // rows for the 3 fact sections (seeded there by a prior call with
  // agentOverride)".
  assert(
    detectedIds.includes("quality-gates") &&
      detectedIds.includes("commands") &&
      detectedIds.includes("environment"),
    "agentOverride #1: all 3 fact sections have [detected:agent] rows",
  );
  assert(
    !parsedLedger1.some((r) => r.key.startsWith("omit:")),
    "agentOverride #1: NO omit:* rows (all 3 sections have bodies)",
  );

  // Call 2: routine update (no agentOverride, no refresh), LATER date.
  // Must be byte-identical and upsert ZERO omit:* rows (the churn-loop fix).
  const fs2 = mkFs("2026-09-09");
  const r2 = updateAgent(noManifestDir, noManifestAgents, fs2);
  const after2 = fs2.readFile(noManifestAgents);
  assert(r2.exitCode === 0, "agentOverride #2 (routine): exit 0");
  assert(
    r2.plan?.wouldWrite === false,
    "agentOverride #2 (routine): wouldWrite is false (already current)",
  );
  assert(
    Buffer.from(after2, "utf8").equals(Buffer.from(after1, "utf8")),
    "agentOverride #2 (routine): byte-identical across date rollover (no churn)",
  );
  assert(
    r2.plan?.omitted.length === 0,
    "agentOverride #2 (routine): ZERO omitted (no omit:* rows upserted)",
  );
  const sPath2 = sidecarPath(noManifestDir);
  const parsedLedger2 = parseLedger(fs2.readFile(sPath2));
  assert(
    parsedLedger2.every(
      (r) =>
        r.key !== "omit:quality-gates" &&
        r.key !== "omit:commands" &&
        r.key !== "omit:environment",
    ),
    "agentOverride #2 (routine): NO omit:* rows for the 3 fact sections in the ledger",
  );
  // The detected rows keep their original dates (no churn).
  const qgRow = parsedLedger2.find((r) => r.key === "quality-gates");
  assert(qgRow?.date === "2026-01-01", "agentOverride #2 (routine): detected row date unchanged");

  rmSync(noManifestDir, { recursive: true, force: true });
}

// ===================================================== 2. refresh semantics

{
  // A hand-built has-markers file whose ledger carries [auto,...] rows for
  // the 3 fact sections (the rich-manifest shape). Refresh must NOT touch
  // these rows — provenance is checked BEFORE acting.
  const richDir = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-rich-"));
  const richAgents = path.join(richDir, "AGENTS.md");

  const richSeed = [
    "# T",
    "<!-- pi-rukas:agents-md:begin quality-gates v1 -->",
    "- **bun test** — `bun test`",
    "<!-- pi-rukas:agents-md:end quality-gates -->",
    "<!-- pi-rukas:agents-md:begin commands v1 -->",
    "| kind | command |",
    "| --- | --- |",
    "| test | `bun test` |",
    "<!-- pi-rukas:agents-md:end commands -->",
    "<!-- pi-rukas:agents-md:begin environment v1 -->",
    "- Manifest: `package.json`",
    "<!-- pi-rukas:agents-md:end environment -->",
    "<!-- pi-rukas:agents-md:begin decision-ledger v1 -->",
    "| key | value | provenance |",
    "| --- | --- | --- |",
    "| quality-gates | bun test | [auto:2026-01-01] |",
    "| commands | bun test | [auto:2026-01-01] |",
    "| environment | package.json | [auto:2026-01-01] |",
    "<!-- pi-rukas:agents-md:end decision-ledger -->",
    "",
  ].join("\n");
  writeFileSync(richAgents, richSeed);

  // Verify the seed: [auto,...] rows for the 3 fact sections.
  const seeded = readFileSync(richAgents, "utf8");
  // Post-#680 M1: the seed file has an in-file decision-ledger span (legacy
  // markdown format). The update path migrates it to the sidecar. We need to
  // check the sidecar after the update, not the in-file span.
  // For the SEED verification (before any update), we use the legacy parser.
  const { parseLegacyMarkdownLedger } = await import("../src/agents-md/ledger.ts");
  const seededLedgerSpan = (await import("../src/agents-md/markers.ts")).sectionContentWithEnd(seeded, "decision-ledger") ?? "";
  const seededParsed = parseLegacyMarkdownLedger(seededLedgerSpan);
  const autoFactRows = seededParsed.filter(
    (r) =>
      ["quality-gates", "commands", "environment"].includes(r.key) && r.provenance === "auto",
  );
  assert(
    autoFactRows.length === 3,
    `rich fixture seeded with [auto,...] rows for the 3 fact sections (got ${autoFactRows.length})`,
  );

  // Refresh with a DIFFERING agentOverride: the [auto] rows are NOT touched
  // (refresh only acts on [detected:agent] rows). The fact sections are
  // re-derived from the override facts, but the ledger rows stay [auto].
  const differingFacts = {
    manifest: "package.json",
    packageManager: "bun",
    commands: [
      { name: "cargo test", command: "cargo test", kind: "test" as const, runner: "cargo" },
    ],
    ciWorkflows: [],
    notes: [],
  };
  const fsRefresh = mkFs("2026-06-01");
  const rRefresh = updateAgent(richDir, richAgents, fsRefresh, {
    agentOverride: { facts: differingFacts },
    refresh: true,
  });
  const afterRefresh = fsRefresh.readFile(richAgents);
  assert(rRefresh.exitCode === 0, "refresh (rich): exit 0");
  // The [auto] rows are NEVER touched by refresh — provenance checked BEFORE
  // acting. The fact sections are re-derived from the override, but the
  // ledger rows for the 3 fact sections stay [auto] (not [detected:agent]).
  const sPathRefresh = sidecarPath(richDir);
  const afterRefreshParsed = parseLedger(fsRefresh.readFile(sPathRefresh));
  const factRowsAfter = afterRefreshParsed.filter((r) =>
    ["quality-gates", "commands", "environment"].includes(r.key),
  );
  assert(
    factRowsAfter.every((r) => r.provenance === "auto"),
    "refresh (rich): [auto] rows are NEVER touched by refresh (provenance checked before acting)",
  );

  rmSync(richDir, { recursive: true, force: true });
}

// ===================================================== 3. refresh no-op / churn (detected rows)

{
  const noManifestDir2 = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-nomanifest2-"));
  const noManifestAgents2 = path.join(noManifestDir2, "AGENTS.md");

  // Seed with a [detected:agent] row for quality-gates. The body must match
  // what gatesBody(sameFacts) produces exactly (post trailing-newline
  // normalisation) for the no-op case to hold.
  const sameFacts = {
    manifest: undefined,
    commands: [{ name: "a", command: "a cmd", kind: "test" as const, runner: "a" }],
    ciWorkflows: [],
    notes: [],
  };
  const qgResult = gatesBody(sameFacts);
  const expectedQgBody = typeof qgResult === "string" ? qgResult : "";
  const seedDetected = [
    "# T",
    "<!-- pi-rukas:agents-md:begin quality-gates v1 -->",
    expectedQgBody,
    "<!-- pi-rukas:agents-md:end quality-gates -->",
    "<!-- pi-rukas:agents-md:begin decision-ledger v1 -->",
    "| key | value | provenance |",
    "| --- | --- | --- |",
    "| quality-gates | agent | [detected:agent,2026-01-01] |",
    "<!-- pi-rukas:agents-md:end decision-ledger -->",
    "",
  ].join("\n");
  writeFileSync(noManifestAgents2, seedDetected);

  // Refresh with the SAME body (post normalisation) → the quality-gates row's
  // date is unchanged (no churn).
  const fsSame = mkFs("2026-06-01");
  const rSame = updateAgent(noManifestDir2, noManifestAgents2, fsSame, {
    agentOverride: { facts: sameFacts },
    refresh: true,
  });
  const afterSame = fsSame.readFile(noManifestAgents2);
  assert(rSame.exitCode === 0, "refresh no-op: exit 0");
  const sPathSame = sidecarPath(noManifestDir2);
  const sameParsed = parseLedger(fsSame.readFile(sPathSame));
  const qgSame = sameParsed.find((r) => r.key === "quality-gates");
  assert(qgSame?.date === "2026-01-01", "refresh no-op: quality-gates date unchanged (no churn)");
  assert(qgSame?.provenance === "detected", "refresh no-op: quality-gates provenance still detected");

  // Refresh with a DIFFERENT body → section replaced, date bumped to today.
  const diffFacts = {
    manifest: undefined,
    commands: [{ name: "b", command: "b cmd", kind: "test" as const, runner: "b" }],
    ciWorkflows: [],
    notes: [],
  };
  const fsDiff = mkFs("2026-07-01");
  const rDiff = updateAgent(noManifestDir2, noManifestAgents2, fsDiff, {
    agentOverride: { facts: diffFacts },
    refresh: true,
  });
  const afterDiff = fsDiff.readFile(noManifestAgents2);
  assert(rDiff.exitCode === 0, "refresh diff: exit 0");
  assert(rDiff.plan?.wouldWrite === true, "refresh diff: wouldWrite is true (body changed)");
  assert(afterDiff.includes("- **b** — `b cmd`"), "refresh diff: section body replaced");
  const sPathDiff = sidecarPath(noManifestDir2);
  const diffParsed = parseLedger(fsDiff.readFile(sPathDiff));
  const qgDiff = diffParsed.find((r) => r.key === "quality-gates");
  assert(qgDiff?.date === "2026-07-01", "refresh diff: date bumped to today");

  rmSync(noManifestDir2, { recursive: true, force: true });
}

console.log(exit === 0 ? "\nAll agent-override checks passed." : "\nFAILED");
process.exit(exit);
