#!/usr/bin/env bun
/**
 * scaffold — the --scaffold post-pass for create/update.
 * Post-#681 M2: heading-delimited sections (no HTML comment markers).
 * 12 test blocks covering: create/dryRun/update/idempotency/check/wrap/
 * operator-choices/insert-after-environment/no-scaffold/bare-create.
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
import { parseLedger, renderLedger, type LedgerRow } from "../src/agents-md/ledger.ts";
import { presentManagedIds } from "../src/agents-md/section-detect.ts";
import { commandsBody, environmentBody, gatesBody } from "../src/agents-md/renderer.ts";
import {
  type OperatorAnswers,
  computeScaffold,
  operatorChoicesLedgerRows,
  renderOperatorChoices,
  runScaffoldPostPass,
  runWrapScaffold,
} from "../src/agents-md/scaffold.ts";
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
const BOILERPLATE_IDS = ["minimalist-engineering", "git-workflow", "documentation-policy", "issue-driven-development", "code-review-doctrine", "context7-protocol", "testing-standards"];

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
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    today: () => FIXED_DATE,
    ...overrides,
  };
}

/**
 * Seed the heading-based file shape the integrated create path produces
 * (fact sections as h2, bodies from the SAME fixtures detectFacts would
 * derive, plus a populated sidecar), so update-path tests exercise the
 * heading pipeline end to end. Fact-section rendering belongs to the
 * wrap-render workstream.
 */
function seedHeadingFile(root: string, agentsPath: string, fs: AgentsMdFs, extra?: LedgerRow[]): void {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  const facts = {
    manifest: "package.json",
    packageManager: "bun",
    language: "typescript",
    ciWorkflows: ["ci.yml"],
    commands: [{ name: "vitest", command: "vitest", kind: "test" as const, runner: "bun" }],
  };
  const qg = gatesBody(facts as any);
  const cmd = commandsBody(facts as any);
  const env = environmentBody(facts as any);
  const parts: string[] = ["# AGENTS.md", ""];
  if (typeof qg === "string") parts.push("## Quality Gates", "", qg, "");
  if (typeof cmd === "string") parts.push("## Commands", "", cmd, "");
  if (typeof env === "string") parts.push("## Environment", "", env);
  const body = parts.join("\n");
  writeFileSync(agentsPath, body.endsWith("\n") ? body : `${body}\n`);
  const rows: LedgerRow[] = [
    { key: "quality-gates", value: "vitest", provenance: "auto", date: FIXED_DATE },
    { key: "commands", value: "vitest", provenance: "auto", date: FIXED_DATE },
    { key: "environment", value: "package.json, bun, typescript", provenance: "auto", date: FIXED_DATE },
    ...(extra ?? []),
  ];
  fs.mkdir?.(path.join(root, ".pi"));
  writeFileSync(path.join(root, ".pi", "agents-md-state.json"), renderLedger(rows));
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
    res.plan?.scaffoldedIds.length === 7,
    `create --scaffold: 7 scaffolded ids (got ${res.plan?.scaffoldedIds.length})`,
  );
  assert(content.includes("≥80%"), "create --scaffold: unanswered coverage renders the ≥80% default");
  assert((content.match(/≥80%/g) ?? []).length === 1, "create --scaffold: the ≥80% default is stated exactly once");
  const ids = presentManagedIds(content);
  for (const id of BOILERPLATE_IDS) assert(ids.includes(id), `create --scaffold: ${id} is a heading-delimited section`);
  // The pure-prose guarantee for M2-owned output: the SCAFFOLD post-pass
  // (this workstream) emits zero HTML comment markers. The fact sections are
  // the wrap-render workstream's output (still marker-wrapped in this
  // integration branch), so the zero-`<!--` assertion is scoped to the
  // scaffold section span.
  const scaffoldSectionBytes = content.slice(content.indexOf("# Minimalist Engineering"));
  assert(!scaffoldSectionBytes.includes("<!--"), "create --scaffold: zero `<!--` bytes in scaffold output (pure prose)");

  assert(!content.includes("## Operator choices"), "create --scaffold: no operator-choices without answers");
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
  assert(presentManagedIds(content).includes("operator-choices"), "scaffold with answers: operator-choices is a heading-delimited section");
  assert(content.includes("80%+"), "scaffold with answers: coverage threshold recorded");
  // Mutual exclusion: the threshold is stated in Testing Standards, and
  // operator-choices must NOT duplicate it (no coverage bullet there).
  const opChoicesIdx = content.indexOf("## Operator choices");
  const testingIdx = content.indexOf("# Testing Standards");
  const nextSection = content.indexOf("# ", testingIdx + 1);
  const testingBody =
    nextSection > testingIdx ? content.slice(testingIdx, nextSection) : content.slice(testingIdx);
  assert(
    testingBody.includes("80%+"),
    "scaffold with answers: Testing Standards carries the answered threshold",
  );
  const opChoicesBody = opChoicesIdx >= 0 ? content.slice(opChoicesIdx, testingIdx) : "";
  assert(
    !opChoicesBody.includes("Coverage threshold"),
    "scaffold with answers: operator-choices omits the coverage bullet",
  );
  // Post-#680 M1: the decision-ledger is in the sidecar, not the in-file span.
  // The threshold should be stated exactly once in the rendered file (no
  // in-file ledger section to exclude).
  assert(
    (content.match(/80%\+/g) ?? []).length === 1,
    "scaffold with answers: the threshold is stated exactly once in the managed + boilerplate text",
  );
  assert(content.includes("MEDIUM"), "scaffold with answers: review-blocking severity recorded");
  // Ledger has [asked:operator] rows in the sidecar.
  const sPath = `${tmp}/.pi/agents-md-state.json`;
  const sRows = parseLedger(fs.readFile(sPath));
  assert(
    sRows.some((r) => r.provenance === "asked"),
    "scaffold with answers: [asked:operator] sidecar rows present",
  );
  // Pure prose: the operator-choices + boilerplate scaffold span is a
  // heading, not a marker pair.
  const scaffoldSlice = content.slice(opChoicesIdx);
  assert(!scaffoldSlice.includes("<!--"), "scaffold with answers: zero `<!--` bytes in scaffold output (pure prose)");
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
  assert(res.plan?.scaffoldedIds?.length === 7, "scaffold dryRun: scaffoldedIds computed in plan");
}

// ===================================================== 4. update --scaffold (heading-delimited file)

{
  rmSync(AGENTS, { force: true });
  // Seed the heading-based file shape (fact sections as h2) the integrated
  // create path produces, then update with scaffold.
  const fs = mkFs();
  seedHeadingFile(tmp, AGENTS, fs);
  const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.exitCode === 0, "update --scaffold: exit 0");
  assert(res.plan?.wouldWrite === true, "update --scaffold: wouldWrite is true");
  assert(res.plan?.scaffoldedIds !== undefined, "update --scaffold: scaffoldedIds present");
  assert(
    res.plan?.scaffoldedIds.length === 7,
    `update --scaffold: 7 scaffolded ids (got ${res.plan?.scaffoldedIds.length})`,
  );
  const content = fs.readFile(AGENTS);
  assert(content.includes("# Minimalist Engineering"), "update --scaffold: boilerplate present");
  // Boilerplate is AFTER the environment section (heading-delimited).
  const envHeading = content.indexOf("## Environment");
  const minimalStart = content.indexOf("# Minimalist Engineering");
  assert(
    envHeading >= 0 && minimalStart > envHeading,
    "update --scaffold: boilerplate inserted after environment section",
  );
  // ...and each boilerplate section is heading-delimited (heading present),
  // not bare text appended outside any managed span.
  for (const id of BOILERPLATE_IDS) assert(presentManagedIds(content).includes(id), `update --scaffold: ${id} is a heading-delimited section`);
}

// ===================================================== 5. Idempotency: second scaffold → no-op

{
  rmSync(AGENTS, { force: true });
  const fs = mkFs();
  // First scaffold: seed heading facts, then update --scaffold (inserts 7).
  seedHeadingFile(tmp, AGENTS, fs);
  const res1 = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res1.plan?.wouldWrite === true, "scaffold #1: wouldWrite is true");
  // Second scaffold — no-op: heading detection finds every boilerplate
  // section, so computeScaffold adds nothing and the sidecar is unchanged.
  const res2 = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res2.plan?.wouldWrite === false, "scaffold #2: wouldWrite is false (idempotent)");
}

// ===================================================== 6. Key load-bearing test: check on scaffolded file → exit 0

{
  rmSync(AGENTS, { force: true });
  const fs = mkFs();
  seedHeadingFile(tmp, AGENTS, fs);
  const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.exitCode === 0, "scaffold update: exit 0");
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
  // Brownfield file: no managed headings.
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

// ===================================================== 9. runScaffoldPostPass: after param inserts after environment

{
  // A heading-delimited file (post-M2 shape): fact sections as h2, then
  // boilerplate to be inserted after environment.
  const text = [
    "# T",
    "",
    "## Quality Gates",
    "",
    "- test",
    "",
    "## Environment",
    "",
    "- env",
    "",
    "## Project notes",
    "",
    "operator prose",
  ].join("\n");
  const scaffoldResult = {
    sections: [{ id: "minimalist-engineering", body: "# Minimalist Engineering\n\nSimple code." }],
    operatorChoicesBody: undefined,
    ledgerRows: [],
  };
  const post = runScaffoldPostPass(text, scaffoldResult, true);
  assert(post.bytes.includes("# Minimalist Engineering"), "post-pass: boilerplate present");
  const envIdx = post.bytes.indexOf("## Environment");
  const minimalIdx = post.bytes.indexOf("# Minimalist Engineering");
  const notesIdx = post.bytes.indexOf("## Project notes");
  assert(
    minimalIdx > envIdx && minimalIdx < notesIdx,
    "post-pass: boilerplate after environment, before next h2",
  );
  assert(post.bytes.includes("## Project notes"), "post-pass: next h2 preserved");
  assert(post.bytes.includes("operator prose"), "post-pass: following prose preserved");
  const emptyResult = { sections: [], operatorChoicesBody: undefined, ledgerRows: [] };
  const postEmpty = runScaffoldPostPass(text, emptyResult, true);
  assert(postEmpty.bytes === text, "post-pass empty: bytes unchanged");
}

// ===================================================== 10. idempotency: update --scaffold when already scaffolded

{
  rmSync(AGENTS, { force: true });
  const fs = mkFs({ writeFile: () => { throw new Error("writeFile on idempotent scaffold"); } });
  const baseFs = mkFs();
  seedHeadingFile(tmp, AGENTS, baseFs);
  const seed = updateAgent(tmp, AGENTS, baseFs, { scaffold: true });
  assert(seed.exitCode === 0, "seed scaffold: exit 0");
  const res = updateAgent(tmp, AGENTS, fs, { scaffold: true });
  assert(res.plan?.wouldWrite === false, "idempotent scaffold update: wouldWrite is false");
}

// ===================================================== 11. wrap stays scaffold-free: no scaffold param = no boilerplate

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

// ===================================================== 12. bare create default: scaffold ON, 7 sections

{
  rmSync(AGENTS, { force: true });
  const fs = mkFs();
  const res = createAgent(tmp, AGENTS, fs);
  const content = fs.readFile(AGENTS);
  assert(res.exitCode === 0, "bare create: exit 0");
  assert(res.plan?.wouldWrite === true, "bare create: wouldWrite is true");
  assert(
    res.plan?.scaffoldedIds?.length === 7,
    `bare create: scaffold defaults ON — 7 scaffolded ids (got ${res.plan?.scaffoldedIds?.length})`,
  );
  assert(content.includes("# Context7 Protocol"), "bare create: Context7 Protocol present");
  assert(content.includes("# Testing Standards"), "bare create: Testing Standards present");
  assert(content.includes("≥80%"), "bare create: unanswered coverage renders the ≥80% default");
  rmSync(AGENTS);
  const resOff = createAgent(tmp, AGENTS, fs, { scaffold: false });
  const contentOff = fs.readFile(AGENTS);
  assert(resOff.plan?.scaffoldedIds === undefined, "scaffold: false: no scaffoldedIds");
  assert(
    !contentOff.includes("# Minimalist Engineering") && !contentOff.includes("# Testing Standards"),
    "scaffold: false: no boilerplate sections",
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log(exit === 0 ? "\nAll scaffold checks passed." : "\nFAILED");
process.exit(exit);
