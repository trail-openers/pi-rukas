#!/usr/bin/env bun
/**
 * scaffold survival — hand-edit survival of heading-delimited sections.
 *
 * The update splice loop (update-agent.ts) only rewrites sections whose id
 * is in its `updates` Map (fact-section ids quality-gates/commands/environment/
 * code-style), so a boilerplate or operator-choices section hand-edited by
 * the operator survives a routine (non-scaffold) update byte-for-byte even
 * though it sits INSIDE a heading-delimited managed section. Proven via
 * `managedSectionBody` byte-equality, not `wouldWrite` (which collapses to
 * `scaffoldAdded` on a scaffold:true call and reflects nothing about the
 * fact-section bytes).
 * The forcing update runs WITHOUT `scaffold: true` so the write path
 * actually runs.
 *
 * Post-#681 M2: sections are heading-delimited (no HTML comment markers);
 * the hand-edit is performed directly on the file bytes (replacing the
 * section body between its heading and the next heading of level ≤ its own).
 *
 * Split out from test-agents-md-scaffold.ts (the 500-line hard limit,
 * AGENTS.md §12) along the seam "existing scaffold behavior tests" vs
 * "hand-edit survival of managed sections" (#664).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsMdFs,
  createAgent,
  updateAgent,
} from "../src/agents-md/agents-md.ts";
import {
  managedSectionBody,
  presentManagedIds,
  spliceManagedSection as spliceSectionBody,
} from "../src/agents-md/section-detect.ts";
import { type OperatorAnswers } from "../src/agents-md/scaffold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-scaffold-survival-"));
const AGENTS = path.join(tmp, "AGENTS.md");

// Build a minimal fixture so detectFacts finds facts → managed sections render
// (mirrors test-agents-md-scaffold.ts).
mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
mkdirSync(path.join(tmp, "src"), { recursive: true });
writeFileSync(
  path.join(tmp, "package.json"),
  JSON.stringify(
    {
      name: "fixture",
      scripts: { test: "vitest", lint: "biome lint", build: "bun run build" },
      devDependencies: { typescript: "^5.4.0" },
    },
    null,
    2,
  ),
);
writeFileSync(path.join(tmp, "bun.lock"), "{ lockfileVersion: 1 }");
writeFileSync(
  path.join(tmp, ".github", "workflows", "ci.yml"),
  "name: CI\njobs:\n  test:\n    steps: []\n",
);
writeFileSync(path.join(tmp, "src", "index.ts"), "export const x = 1;\n");

function mkFs(overrides?: Partial<AgentsMdFs>): AgentsMdFs {
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
    today: () => "2026-01-01",
    ...overrides,
  };
}

// ===================================================== 1. boilerplate section

{
  const fs = mkFs();
  createAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(presentManagedIds(fs.readFile(AGENTS)).includes("minimalist-engineering"), "scaffold: minimalist-engineering is a heading-delimited section");
  const edited = spliceSectionBody(
    fs.readFile(AGENTS),
    "minimalist-engineering",
    "Hand-edited by operator.\n",
  );
  writeFileSync(AGENTS, edited);
  rmSync(path.join(tmp, ".github", "workflows", "ci.yml"));
  const res = updateAgent(tmp, AGENTS, fs, {});
  assert(res.exitCode === 0, "hand-edit (boilerplate): the forcing update exits 0");
  assert(res.plan?.wouldWrite === true, "hand-edit (boilerplate): the forcing update genuinely wrote (ci.yml deletion is a real change)");
  const boilerplateBody = managedSectionBody(fs.readFile(AGENTS), "minimalist-engineering");
  assert(
    boilerplateBody === "\nHand-edited by operator.\n",
    `hand-edit (boilerplate): the hand-edited section survives byte-for-byte (got ${JSON.stringify(boilerplateBody)})`,
  );
}

// ===================================================== 2. operator-choices section

{
  rmSync(AGENTS, { force: true });
  writeFileSync(
    path.join(tmp, ".github", "workflows", "ci.yml"),
    "name: CI\njobs:\n  test:\n    steps: []\n",
  );
  const answers: OperatorAnswers = { coverageThreshold: "85%+", reviewBlockingSeverity: "HIGH" };
  const fs = mkFs();
  createAgent(tmp, AGENTS, fs, { scaffold: true, answers });
  assert(presentManagedIds(fs.readFile(AGENTS)).includes("operator-choices"), "scaffold + answers: operator-choices is a heading-delimited section");
  const edited = spliceSectionBody(
    fs.readFile(AGENTS),
    "operator-choices",
    "- **Review-blocking severity:** CRITICALED\n",
  );
  writeFileSync(AGENTS, edited);
  rmSync(path.join(tmp, ".github", "workflows", "ci.yml"));
  const res = updateAgent(tmp, AGENTS, fs, {});
  assert(res.exitCode === 0, "hand-edit (operator-choices): the forcing update exits 0");
  assert(res.plan?.wouldWrite === true, "hand-edit (operator-choices): the forcing update genuinely wrote");
  const opBody = managedSectionBody(fs.readFile(AGENTS), "operator-choices");
  assert(
    opBody === "\n- **Review-blocking severity:** CRITICALED\n",
    `hand-edit (operator-choices): the hand-edited section survives byte-for-byte (got ${JSON.stringify(opBody)})`,
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll scaffold survival checks passed." : "\nFAILED");
process.exit(exit);
