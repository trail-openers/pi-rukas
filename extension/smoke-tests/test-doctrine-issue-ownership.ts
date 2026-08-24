#!/usr/bin/env bun
/**
 * Doctrine canary: `gh issue create` is PM-only.
 *
 * Issue #528 gates issue creation on spec quality and routes it through a
 * single owner (PM). The canary pins that doctrine against future drift:
 * the verb `gh issue create` must appear only in the allowlisted files
 * (project-manager.md, plan.md, and the PM-only command block in
 * github-issues.md), and must not appear as a positive prose prescription
 * in the files that task-b (ops.md) and task-c (github-issues.md) gate.
 *
 * AGENTS.md is deliberately NOT scanned: it is host-project-specific (auto-loaded
 * by Pi when cwd is inside the repo), not part of the composed role prompt, and its
 * issue-creation reference at L478 ("PM surfaces related work via `gh issue create`")
 * was role-scoped by this PR (#528). See the MUST_BE_ABSENT note below for the
 * negation exception in ops.md.
 *
 * Non-vacuity: if the grep pattern rots to zero matches the test fails
 * rather than passing silently.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Files where `gh issue create` is legitimately present (data, not logic).
 * github-issues.md carries the real PM-only command in its creation section
 * (that section is explicitly "PM only"; composed into both PM and developer
 * prompts, the role split above keeps specialists from acting on it).
 */
const ALLOWLIST = [
  "agents-base/project-manager.md",
  "pi-prompts/plan.md",
  "modules/workflows/github-issues.md",
];

/**
 * Files where `gh issue create` must be absent as a positive prose
 * prescription. ops.md's refusal rule legitimately quotes the verb inside a
 * negation ("Never run `gh issue create`"), and github-issues.md carries the
 * real PM-only command inside a fenced code block. Any other occurrence is
 * drift and fails the canary.
 */
const MUST_BE_ABSENT = [
  "agents-base/ops.md",
  "agents-base/developer.md",
  "modules/workflows/github-issues.md",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, "agents-base")),
  ...walk(path.join(ROOT, "modules")),
  ...walk(path.join(ROOT, "pi-prompts")),
];

// Collect all lines containing "gh issue create"
const hits: { file: string; n: number }[] = [];
for (const f of files) {
  let content: string;
  try {
    content = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const rel = path.relative(ROOT, f);
  content.split("\n").forEach((text, i) => {
    if (text.includes("gh issue create")) hits.push({ file: rel, n: i + 1 });
  });
}

// Non-vacuity: the two known allowlisted sites must still be found
assert(hits.length > 0, `scan found ${hits.length} occurrence(s) of "gh issue create"`);
assert(
  hits.some((h) => h.file === "agents-base/project-manager.md"),
  "non-vacuity: project-manager.md still contains the verb",
);
assert(
  hits.some((h) => h.file === "pi-prompts/plan.md"),
  "non-vacuity: plan.md still contains the verb",
);

// Every hit outside the allowlist must be a negation or fenced-code line
// (ops.md's refusal rule quotes the verb inside "Never run ...").
const NEGATION = /(do not|never|must not|❌|do NOT|Do not)/i;
function isAllowedLine(line: string): boolean {
  return NEGATION.test(line) || line.trimStart().startsWith("gh ") || line.trimStart().startsWith("`");
}
const violations = hits
  .filter((h) => !ALLOWLIST.includes(h.file))
  .filter((h) => {
    const line = readFileSync(path.join(ROOT, h.file), "utf8").split("\n")[h.n - 1] ?? "";
    return !isAllowedLine(line);
  });
assert(
  violations.length === 0,
  violations.length
    ? `gh issue create found outside allowlist: ${violations.map((v) => `${v.file}:${v.n}`).join(", ")}`
    : "all hits are within the allowlist or are negations/fenced code",
);

// Absence of positive prose prescriptions in negation files (negation-aware).
// A line is allowed if it carries a negation word OR is a fenced-code
// command line (starts with `gh `), e.g. the PM-only command block.
for (const f of MUST_BE_ABSENT) {
  const content = readFileSync(path.join(ROOT, f), "utf8");
  const lines = content
    .split("\n")
    .filter((l) => l.includes("gh issue create"));
  const positive = lines.filter((l) => !isAllowedLine(l));
  assert(
    positive.length === 0,
    positive.length === 0
      ? `no positive "gh issue create" prescription in ${f}`
      : `un-negated "gh issue create" in ${f}: ${positive.map((l) => l.trim().slice(0, 80)).join(" | ")}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
