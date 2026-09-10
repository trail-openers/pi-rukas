#!/usr/bin/env bun
/**
 * scaffold quality — the SINGLE size-discipline (density) gate for the
 * scaffolded AGENTS.md.
 *
 * Distinct from, and additional to, test-agents-md-size.ts (the 32 KiB hard
 * safety cap, untouched). This test states the quality ceiling ONCE:
 *
 *   (a) a realistic full-featured rendered AGENTS.md — the 4 managed sections
 *       + all 7 scaffold sections + a decision-ledger with several rows —
 *       totals ≤ 550 lines;
 *   (b) each of the 2 new section bodies (Context7 Protocol, Testing
 *       Standards) is individually ≤ 20 lines (the per-section density check
 *       is the real gate; the document total is secondary).
 *
 * The constraint is stated in this one test only — do not duplicate it
 * elsewhere.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentsMdFs } from "../src/agents-md/agents-md.ts";
import { createAgent } from "../src/agents-md/agents-md.ts";
import {
  SCAFFOLD_BODIES,
  SCAFFOLD_HEADING_MAP,
  computeScaffold,
  testingStandardsBody,
} from "../src/agents-md/scaffold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "pi-ens-agentsmd-quality-"));
const AGENTS = path.join(tmp, "AGENTS.md");
const FIXED_DATE = "2026-01-01";

// Build a realistic fixture so detectFacts yields all 4 managed sections.
mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
mkdirSync(path.join(tmp, "src"), { recursive: true });
writeFileSync(
  path.join(tmp, "package.json"),
  JSON.stringify(
    {
      name: "fixture",
      scripts: {
        test: "vitest",
        lint: "biome lint",
        build: "bun run build",
        typecheck: "bunx tsc --noEmit",
      },
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

const fs: AgentsMdFs = {
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
};

// ------------------------------------------------- (a) full-featured total ≤ 550

{
  const res = createAgent(tmp, AGENTS, fs);
  assert(res.exitCode === 0, "full-featured create: exit 0");
  const content = fs.readFile(AGENTS);
  // Post-#680 M1: the decision-ledger is in the sidecar, not the in-file span.
  // The sidecar was written by createAgent. The density test only cares about
  // the line count of the rendered file (the sidecar doesn't affect that).
  const lines = content.split("\n").length;
  console.log(`  full-featured rendered file = ${lines} lines`);
  assert(lines <= 550, `full-featured AGENTS.md total ≤ 550 lines (got ${lines})`);
  // The sidecar should exist and be non-empty.
  const sPath = `${tmp}/.pi/agents-md-state.json`;
  assert(fs.stat(sPath), "full-featured: sidecar exists after create");
  assert(fs.readFile(sPath).length > 0, "full-featured: sidecar is non-empty");

  // All 7 scaffold sections present.
  for (const heading of [
    "# Minimalist Engineering",
    "# Git Workflow",
    "# Documentation Policy",
    "# Issue-Driven Development",
    "# Code Review Doctrine",
    "# Context7 Protocol",
    "# Testing Standards",
  ]) {
    assert(content.includes(heading), `full-featured: ${heading} present`);
  }
}

// ------------------------- (b) per-section density: Context7 + Testing Standards ≤ 20

{
  // Context7 body from the static registration site.
  const ctxBody = SCAFFOLD_BODIES.find((s) => s.id === "context7-protocol")?.body;
  assert(ctxBody !== undefined, "Context7 body is registered in SCAFFOLD_BODIES");
  const ctxLines = ctxBody ? ctxBody.split("\n").length : Number.POSITIVE_INFINITY;
  console.log(`  Context7 Protocol body = ${ctxLines} lines`);
  assert(ctxLines <= 20, `Context7 Protocol body ≤ 20 lines (got ${ctxLines})`);

  // Testing Standards body — answer-aware, assert the budget for both
  // renderings (answered and the ≥80% default).
  for (const variant of [testingStandardsBody(), testingStandardsBody("90%+")]) {
    const lines = variant.split("\n").length;
    console.log(`  Testing Standards body = ${lines} lines`);
    assert(lines <= 20, `Testing Standards body ≤ 20 lines (got ${lines})`);
  }
}

// ------------------- (b) computeScaffold unit: answer-aware body + skip semantics

{
  const existing = new Set(["minimalist-engineering", "git-workflow"]);
  const result = computeScaffold(existing, { scaffold: true });
  assert(
    result.sections.length === 5,
    `computeScaffold: 5 sections (7 − 2 existing, got ${result.sections.length})`,
  );
  assert(
    !result.sections.some((s) => s.id === "minimalist-engineering"),
    "computeScaffold: existing ids skipped",
  );
  // The answer-aware body: unanswered → the opinionated default.
  assert(
    (result.sections.find((s) => s.id === "testing-standards")?.body ?? "").includes("≥80%"),
    "computeScaffold: unanswered Testing Standards renders the ≥80% default",
  );

  // Answered: the operator's value renders in Testing Standards, and the
  // operator-choices body suppresses its coverage bullet (mutual exclusion).
  const answered = computeScaffold(new Set(), {
    scaffold: true,
    answers: { coverageThreshold: "60%" },
  });
  const answeredBody = answered.sections.find((s) => s.id === "testing-standards")?.body ?? "";
  assert(
    answeredBody.includes("60%"),
    "computeScaffold: answered threshold renders in Testing Standards",
  );
  assert(
    answered.operatorChoicesBody !== undefined,
    "computeScaffold: operator-choices body present when answered",
  );
  assert(
    !answered.operatorChoicesBody.includes("Coverage threshold"),
    "computeScaffold: operator-choices omits the coverage bullet when answered",
  );

  // Skip is idempotent for the dynamic body too: already present → skipped,
  // and the coverage bullet stays suppressed so the value is never duplicated.
  const alreadyPresent = computeScaffold(new Set(["testing-standards"]), {
    scaffold: true,
    answers: { coverageThreshold: "60%" },
  });
  assert(
    !alreadyPresent.sections.some((s) => s.id === "testing-standards"),
    "computeScaffold: already-present Testing Standards is skipped (not re-rendered)",
  );
  assert(
    alreadyPresent.operatorChoicesBody !== undefined &&
      !alreadyPresent.operatorChoicesBody.includes("Coverage threshold"),
    "computeScaffold: coverage bullet suppressed even when the section was skipped",
  );
}

// ------------------- (c) heading map + body-heading consistency (idempotency guard)

{
  // SCAFFOLD_HEADING_MAP is the single source update-agent.ts's
  // detectExistingBoilerplate reads; a missing entry means a brownfield file
  // carrying that heading gets it duplicated on every update. (End-to-end
  // no-op behaviour is exercised by test-agents-md-idempotency.ts's
  // "update with scaffold: true" block, whose throwing writeFile stub fails
  // on any re-insertion.)
  assert(
    SCAFFOLD_HEADING_MAP.get("Context7 Protocol") === "context7-protocol",
    "SCAFFOLD_HEADING_MAP: Context7 Protocol → context7-protocol",
  );
  assert(
    SCAFFOLD_HEADING_MAP.get("Testing Standards") === "testing-standards",
    "SCAFFOLD_HEADING_MAP: Testing Standards → testing-standards",
  );
  // The body headings must match the map keys verbatim (case-sensitive),
  // which is what the heading regex in detectExistingBoilerplate relies on.
  for (const { id, body } of SCAFFOLD_BODIES) {
    const name = [...SCAFFOLD_HEADING_MAP.entries()].find(([, v]) => v === id)?.[0];
    assert(
      name !== undefined && body.startsWith(`# ${name}`),
      `body heading matches SCAFFOLD_HEADING_MAP key for ${id}`,
    );
  }
  const tsName = [...SCAFFOLD_HEADING_MAP.entries()].find(
    ([, v]) => v === "testing-standards",
  )?.[0];
  assert(
    tsName !== undefined &&
      testingStandardsBody().startsWith(`# ${tsName}`) &&
      testingStandardsBody("90%+").startsWith(`# ${tsName}`),
    "Testing Standards body heading matches the map key in both renderings",
  );
}

// ------------------- (d) reworded greenfield-interview doctrine (grep-assertion)

{
  // pi-prompts/*.md bodies are read at runtime with no build step, so the
  // source file IS the artifact under test.
  const promptSrc = readFileSync(
    path.join(__dirname, "..", "..", "pi-prompts", "agents-md.md"),
    "utf8",
  );
  const lines = promptSrc.split("\n");
  const coverageLine = lines.find((l) => l.includes("**Coverage threshold**"));
  assert(
    coverageLine !== undefined,
    "interview doctrine: the coverage question exists in the greenfield interview",
  );
  assert(
    (coverageLine ?? "").includes("≥80% opinionated default"),
    "interview doctrine: the coverage question is carved out (renders the ≥80% default, not 'omit')",
  );
  assert(
    !promptSrc.includes("Unanswered → section not created, no invented defaults"),
    "interview doctrine: the old blanket rule is gone (it would contradict the carve-out)",
  );
  const protocolLine = lines.find((l) =>
    l.includes("Unanswered → the Testing Standards section renders the ≥80% opinionated default"),
  );
  assert(
    protocolLine !== undefined,
    "interview doctrine: the carve-out protocol line is present verbatim",
  );
  assert(
    protocolLine !== undefined &&
      protocolLine.includes("the other 3 interview questions keep the omit-on-unanswered rule"),
    "interview doctrine: the carve-out keeps omit-on-unanswered for the other 3 questions",
  );
  // The other 3 questions still keep the omit-on-unanswered default.
  const others = lines.filter((l) =>
    [
      "**Review-blocking severity**",
      "**Merge authority**",
      "**Project-specific constraints**",
    ].some((q) => l.includes(q)),
  );
  assert(
    others.length === 3 && others.every((l) => l.includes("(default: omit)")),
    "interview doctrine: the other 3 questions retain (default: omit)",
  );
}

rmSync(tmp, { recursive: true, force: true });

console.log(exit === 0 ? "\nAll scaffold-quality checks passed." : "\nFAILED");
process.exit(exit);
