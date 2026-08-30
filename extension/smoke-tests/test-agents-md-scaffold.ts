#!/usr/bin/env bun
/**
 * scaffold — the --scaffold post-pass for create/update.
 *
 * Tests the full scaffold feature:
 *
 *   1. create --scaffold (no-file): managed sections + 5 boilerplate OUTSIDE
 *      markers + operator-choices section (when answers provided)
 *   2. create --scaffold dryRun: plan.newBytes includes boilerplate, writeFile NOT called
 *   3. update --scaffold (has-markers): boilerplate inserted after environment
 *   4. Idempotency: second --scaffold → writeFile stub throws for managed
 *      sections; byte-equality on boilerplate spans
 *   5. Key load-bearing test: check on a freshly scaffolded file exits 0 with
 *      ZERO findings
 *   6. Wrap + scaffold: brownfield no-markers gets wrap + scaffold-append
 *   7. Wrap stays scaffold-free: the wrap path emits no boilerplate when
 *      scaffold is not set
 *   8. Operator choices: answers produce the operator-choices section + [asked:operator]
 *      ledger rows; unanswered → section not created
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsMdFs,
  checkAgent,
  createAgent,
  fileState,
  updateAgent,
} from "../src/agents-md/agents-md.ts";
import { EXIT_CLEAN, EXIT_FINDINGS } from "../src/agents-md/check.ts";
import { parseMarkers, presentIds } from "../src/agents-md/markers.ts";
import { parseLedger, renderLedger } from "../src/agents-md/ledger.ts";
import {
  type OperatorAnswers,
  computeScaffold,
  renderOperatorChoices,
  operatorChoicesLedgerRows,
  runScaffoldPostPass,
  runWrapScaffold,
} from "../src/agents-md/scaffold.ts";
import { commandsBody, environmentBody, gatesBody } from "../src/agents-md/renderer.ts";
import { WrapError, wrapBytes, wrapLedgerRows } from "../src/agents-md/wrap.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-scaffold-"));
const AGENTS = path.join(tmp, "AGENTS.md");
const FIXED_DATE = "2026-01-01";

// Build a minimal fixture so detectFacts finds facts → managed sections render.
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
    today: () => FIXED_DATE,
    ...overrides,
  };
}

// ===================================================== 1. create --scaffold (no-file)

{
  const fs = mkFs();
  const res = createAgent(tmp, AGENTS, fs, { scaffold: true });
  const content = fs.readFile(AGENTS);
  assert(res.exitCode === 0, "create --scaffold: exit 0");
  assert(res.plan?.wouldWrite === true, "create --scaffold: wouldWrite is true");
  assert(res.plan?.scaffoldedIds !== undefined, "create --scaffold: scaffoldedIds present");
  assert(
    res.plan?.scaffoldedIds.length === 5,
    `create --scaffold: 5 scaffolded ids (got ${res.plan?.scaffoldedIds.length})`,
  );
  // Boilerplate is OUTSIDE markers.
  assert(
    content.includes("# Minimalist Engineering"),
    "create --scaffold: minimalist-engineering section present",
  );
  assert(content.includes("# Git Workflow"), "create --scaffold: git-workflow section present");
  assert(
    content.includes("# Documentation Policy"),
    "create --scaffold: documentation-policy section present",
  );
  assert(
    content.includes("# Issue-Driven Development"),
    "create --scaffold: issue-driven-development section present",
  );
  assert(
    content.includes("# Code Review Doctrine"),
    "create --scaffold: code-review-doctrine section present",
  );
  // Managed sections are inside markers.
  const ids = presentIds(content);
  assert(
    ids.includes("quality-gates") && ids.includes("commands") && ids.includes("environment"),
    "create --scaffold: managed sections inside markers",
  );
  // Operator-choices NOT created (no answers).
  assert(
    !content.includes("## Operator choices"),
    "create --scaffold: no operator-choices without answers",
  );
}

// ===================================================== 2. create --scaffold with answers

{
  rmSync(AGENTS);
  const answers: OperatorAnswers = {
    coverageThreshold: "80%+",
    reviewBlockingSeverity: "MEDIUM",
    mergeAuthority: "squash-merge when gates pass",
    projectConstraints: "no breaking changes to public API",
  };
  const fs = mkFs();
  const res = createAgent(tmp, AGENTS, fs, { scaffold: true, answers });
  const content = fs.readFile(AGENTS);
  assert(res.exitCode === 0, "create --scaffold with answers: exit 0");
  assert(
    content.includes("## Operator choices"),
    "scaffold with answers: operator-choices section present",
  );
  assert(content.includes("80%+"), "scaffold with answers: coverage threshold recorded");
  assert(content.includes("MEDIUM"), "scaffold with answers: review-blocking severity recorded");
  // Ledger has [asked:operator] rows.
  const ledgerBody = content.slice(
    content.indexOf("<!-- pi-ensemble:agents-md:begin decision-ledger"),
    content.indexOf("<!-- pi-ensemble:agents-md:end decision-ledger"),
  );
  assert(
    parseLedger(ledgerBody).some((r) => r.provenance === "asked"),
    "scaffold with answers: [asked:operator] ledger rows present",
  );
}

// ===================================================== 3. create --scaffold dryRun

{
  rmSync(AGENTS);
  let wrote = false;
  const fs = mkFs({ writeFile: () => (wrote = true) });
  const res = createAgent(tmp, AGENTS, fs, { scaffold: true }, true);
  assert(res.exitCode === 0, "create --scaffold dryRun: exit 0");
  assert(res.plan?.wouldWrite === true, "create --scaffold dryRun: wouldWrite is true");
  assert(wrote === false, "create --scaffold dryRun: writeFile NOT called");
  assert(
    res.plan?.newBytes.includes("# Minimalist Engineering"),
    "scaffold dryRun: newBytes include boilerplate",
  );
  assert(res.plan?.scaffoldedIds?.length === 5, "scaffold dryRun: scaffoldedIds computed in plan");
}

// ===================================================== 4. update --scaffold (has-markers)

{
  rmSync(AGENTS, { force: true });
  // Start with a plain create (no scaffold).
  const fs = mkFs();
  createAgent(tmp, AGENTS, fs);
  // Now update with scaffold.
  const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.exitCode === 0, "update --scaffold: exit 0");
  assert(res.plan?.wouldWrite === true, "update --scaffold: wouldWrite is true");
  assert(res.plan?.scaffoldedIds !== undefined, "update --scaffold: scaffoldedIds present");
  const content = fs.readFile(AGENTS);
  assert(content.includes("# Minimalist Engineering"), "update --scaffold: boilerplate present");
  // Boilerplate is AFTER the environment section (which is inside markers).
  const envEnd = content.indexOf("<!-- pi-ensemble:agents-md:end environment -->");
  const minimalStart = content.indexOf("# Minimalist Engineering");
  assert(minimalStart > envEnd, "update --scaffold: boilerplate inserted after environment");
}

// ===================================================== 5. Idempotency: second scaffold → no-op

{
  rmSync(AGENTS);
  let writeCount = 0;
  const fs = mkFs({
    writeFile: (p, b) => {
      writeFileSync(p, b);
      writeCount++;
    },
  });
  // First scaffold — writes.
  const res1 = createAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res1.plan?.wouldWrite === true, "scaffold #1: wouldWrite is true");
  assert(writeCount === 1, "scaffold #1: wrote once");
  // Second scaffold — no-op.
  const res2 = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res2.plan?.wouldWrite === false, "scaffold #2: wouldWrite is false (idempotent)");
  assert(writeCount === 1, "scaffold #2: writeFile NOT entered again");
}

// ===================================================== 6. Key load-bearing test: check on scaffolded file → exit 0

{
  rmSync(AGENTS, { force: true });
  const fs = mkFs();
  const res = createAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.exitCode === 0, "scaffold create: exit 0");
  // Run check: should be clean — no findings.
  const checkRes = checkAgent(tmp, AGENTS, {}, fs);
  assert(
    checkRes.check?.code === EXIT_CLEAN,
    `check on scaffolded file: exit 0 (got ${checkRes.check?.code})`,
  );
  assert(
    checkRes.check?.findings.length === 0,
    `check on scaffolded file: zero findings (got ${checkRes.check?.findings.length})`,
  );
}

// ===================================================== 7. wrap + scaffold

{
  // Brownfield file: no markers.
  writeFileSync(AGENTS, "# My Project\n\n## Overview\n\nJust a project.\n");
  const facts = {
    manifest: "package.json",
    commands: [{ name: "test", command: "bun run test", kind: "test", runner: "bun" }],
    ciWorkflows: [],
  };
  const bodies = [
    { id: "quality-gates", body: "Run these before pushing.\n\n- **test** — `bun run test`" },
    { id: "commands", body: "| kind | command |\n| --- | --- |\n| test | `bun run test` |" },
    { id: "environment", body: "- Manifest: `package.json`\n- Package manager: `bun`" },
  ];
  const ledger = wrapLedgerRows(FIXED_DATE, []);

  // Wrap without scaffold — works fine.
  const wrapped = wrapBytes(
    "# My Project\n\nThis is a simple project.\n",
    facts as any,
    bodies,
    ledger,
  );
  assert(wrapped.bytes.includes("My Project"), "wrap without scaffold: preamble preserved");

  // Wrap with scaffold — refusal condition lifted (machine=0, appended=0, but scaffoldBodies > 0).
  const scaffoldBodies = [
    { id: "minimalist-engineering", body: "# Minimalist Engineering\n\n## Simple code" },
  ];
  const wrappedNoScaffold = wrapBytes(
    "# My Project\n\nThis is a simple project.\n",
    facts as any,
    [], // no derivable bodies
    ledger,
    scaffoldBodies, // present → refusal lifted
  );
  const scaffoldResult = computeScaffold(new Set(), { scaffold: true });
  const wrappedWithScaffold = runWrapScaffold(
    wrappedNoScaffold.bytes,
    scaffoldResult,
    [], // no append IDs (no derivable bodies)
  );
  assert(
    wrappedWithScaffold.bytes.includes("# Minimalist Engineering"),
    "wrap with scaffold: boilerplate appended",
  );
  assert(
    wrappedWithScaffold.bytes.includes("This is a simple project"),
    "wrap with scaffold: original preamble preserved",
  );

  // Wrap with no scaffold AND no machine AND no append → still refuses.
  try {
    wrapBytes("# F\n\n## X\n\nprose", facts as any, [], ledger);
    assert(false, "wrap without scaffold: should have thrown");
  } catch (e) {
    assert(e instanceof WrapError, "wrap without scaffold: throws WrapError");
    assert(
      /refusing to wrap/.test((e as Error).message),
      "wrap without scaffold: refusal message present",
    );
  }
}

// ===================================================== 8. operator-choices rendering

{
  const answers: OperatorAnswers = {
    coverageThreshold: "90%+",
    reviewBlockingSeverity: "HIGH",
  };
  const body = renderOperatorChoices(answers);
  assert(body.includes("90%+"), "renderOperatorChoices: coverage threshold included");
  assert(body.includes("HIGH"), "renderOperatorChoices: review severity included");
  assert(body.includes("mergeAuthority") === false, "renderOperatorChoices: omitted fields absent");
  // Ledger rows for the answers.
  const rows = operatorChoicesLedgerRows(answers, FIXED_DATE);
  assert(rows.length === 2, "operatorChoicesLedgerRows: 2 rows (only answered fields)");
  assert(rows[0]?.provenance === "asked", "operator ledger: provenance is asked");
}

// ===================================================== 9. computeScaffold: skip already-present

{
  const existing = new Set(["minimalist-engineering", "git-workflow"]);
  const result = computeScaffold(existing, { scaffold: true });
  assert(result.sections.length === 3, "computeScaffold: 3 sections (skipped 2 existing)");
  assert(
    !result.sections.some((s) => s.id === "minimalist-engineering"),
    "computeScaffold: existing ids skipped",
  );
}

// ===================================================== 10. runScaffoldPostPass: after param inserts after environment

{
  const text =
    "# T\n<!-- pi-ensemble:agents-md:begin quality-gates v1 -->\n- test\n<!-- pi-ensemble:agents-md:end quality-gates -->\n<!-- pi-ensemble:agents-md:begin environment v1 -->\n- env\n<!-- pi-ensemble:agents-md:end environment -->\n<!-- pi-ensemble:agents-md:begin decision-ledger v1 -->\n| key | value | provenance |\n| --- | --- | --- |\n| k | v | [auto:2026-01-01] |\n<!-- pi-ensemble:agents-md:end decision-ledger -->\n";
  const scaffoldResult = {
    sections: [{ id: "minimalist-engineering", body: "# Minimalist Engineering\n\nSimple code." }],
    operatorChoicesBody: undefined,
    ledgerRows: [],
  };
  const post = runScaffoldPostPass(text, scaffoldResult, true);
  assert(post.bytes.includes("# Minimalist Engineering"), "post-pass: boilerplate present");
  // The boilerplate should be inserted after the environment end marker.
  const envEndIdx = post.bytes.indexOf("<!-- pi-ensemble:agents-md:end environment -->");
  const minimalIdx = post.bytes.indexOf("# Minimalist Engineering");
  assert(minimalIdx > envEndIdx, "post-pass: boilerplate after environment section");
  // Existing bytes after environment are preserved.
  const decisionLedgerStart = post.bytes.indexOf(
    "<!-- pi-ensemble:agents-md:begin decision-ledger v1 -->",
  );
  assert(decisionLedgerStart > envEndIdx, "post-pass: decision-ledger still after environment");
  // wouldWrite: false when no new sections.
  const emptyResult = { sections: [], operatorChoicesBody: undefined, ledgerRows: [] };
  const postEmpty = runScaffoldPostPass(text, emptyResult, true);
  assert(postEmpty.bytes === text, "post-pass empty: bytes unchanged");
}

// ===================================================== 11. idempotency: update --scaffold when already scaffolded

{
  rmSync(AGENTS);
  const fs = mkFs({
    writeFile: () => {
      throw new Error("writeFile should not be called on idempotent scaffold");
    },
  });
  // First create with scaffold.
  createAgent(tmp, AGENTS, { ...mkFs() }, { scaffold: true });
  // Second update with scaffold — should be no-op.
  const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.plan?.wouldWrite === false, "idempotent scaffold update: wouldWrite is false");
}

// ===================================================== 12. wrap stays scaffold-free: no scaffold param = no boilerplate

{
  writeFileSync(
    AGENTS,
    "# T\n\n## Commands\n\n| kind | command |\n| --- | --- |\n| test | `bun test` |\n",
  );
  const facts = {
    manifest: "package.json",
    commands: [{ name: "test", command: "bun run test", kind: "test", runner: "bun" }],
    ciWorkflows: [],
  };
  const bodies = [
    { id: "quality-gates", body: "Run these before pushing.\n\n- **test** — `bun run test`" },
    { id: "commands", body: "| kind | command |\n| --- | --- |\n| test | `bun run test` |" },
    { id: "environment", body: "- Manifest: `package.json`" },
  ];
  const ledger = wrapLedgerRows(FIXED_DATE, []);
  const wrapped = wrapBytes(
    "# My Project\n\nThis project has no sections.\n",
    facts as any,
    bodies,
    ledger,
    undefined, // no scaffoldBodies
  );
  assert(
    !wrapped.bytes.includes("# Minimalist Engineering"),
    "wrap without scaffold: no boilerplate",
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll scaffold checks passed." : "\nFAILED");
process.exit(exit);
