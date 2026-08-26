#!/usr/bin/env bun
/**
 * size — the rendered maximal fixture must fit under the 32 KiB Codex cap.
 *
 * The design starts with a SMALL curated section set (quality-gates, commands,
 * environment, decision-ledger) precisely because the 32 KiB cap argues for
 * fewer, denser sections than agentsgen's 11. This test renders the maximal
 * case — every section present, a realistic command list, and a populated
 * ledger — and asserts the bytes stay under 32 KiB, with headroom.
 */

import type { Command, detectFacts } from "../src/agents-md/detect.ts";
import type { LedgerRow } from "../src/agents-md/ledger.ts";
import { renderAgent } from "../src/agents-md/renderer.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CAP = 32 * 1024; // Codex's 32 KiB cap

// A maximal-but-realistic DetectedFacts: every section emitted, many commands.
const facts: ReturnType<typeof detectFacts> = {
  manifest: "package.json",
  runner: "bun",
  packageManager: "bun",
  language: "typescript",
  ciWorkflows: ["ci.yml", "release.yml", "image.yml"],
  notes: [],
  commands: [
    "test",
    "lint",
    "check",
    "format",
    "typecheck",
    "build",
    "test:unit",
    "test:integration",
    "lint:ci",
    "build:release",
    "dev",
    "start",
    "stop",
    "migrate",
    "seed",
    "backup",
    "restore",
    "deploy:staging",
    "deploy:prod",
    "clean",
    "audit",
  ].map((name, i): Command => ({ name, command: `bun run ${name}`, kind: "test", runner: "bun" })),
};

// A populated ledger: auto rows plus several operator rows.
const ledger: LedgerRow[] = [
  {
    key: "omit:environment",
    value: "no recognised manifest was detected",
    provenance: "auto",
    date: "2026-01-01",
  },
  { key: "deploy-target", value: "prod-eu", provenance: "asked", date: "2026-01-02" },
  { key: "merge-strategy", value: "squash", provenance: "asked", date: "2026-01-03" },
  { key: "ci-provider", value: "github-actions", provenance: "auto", date: "2026-01-04" },
].map((r) => ({ ...r }));

const rendered = renderAgent({
  facts,
  ledger,
  preamble: "# AGENTS.md\n\n<!-- pi-ensemble:agents-md:managed -->\n",
  version: 1,
});

const bytes = Buffer.byteLength(rendered, "utf8");
console.log(`  rendered maximal fixture = ${bytes} bytes`);
assert(bytes < CAP, `maximal rendered fixture is under the 32 KiB cap (${bytes} < ${CAP})`);
// Headroom: even a generous 50% over today's size must still fit, so a few more
// commands or ledger rows don't push it over in silence.
assert(bytes < CAP * 0.5, `...with headroom (${bytes} < ${CAP * 0.5} = half the cap)`);

console.log(exit === 0 ? "\nAll size checks passed." : "\nFAILED");
process.exit(exit);
