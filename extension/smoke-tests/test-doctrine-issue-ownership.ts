#!/usr/bin/env bun
/**
 * Doctrine canary: issue creation is compiled, and the doctrine says so.
 *
 * #528 gated issue creation on spec quality and routed it through a single
 * owner (PM). #598 made that gate structural: creation is compiled into the
 * `start_plan_driver` tool, `pi-prompts/plan.md` is deleted, and direct
 * `gh issue create` is structurally denied for every role in every mode. The
 * canary pins the doctrine against drift: the verb `gh issue create` must
 * appear only in the allowlisted files (project-manager.md, and the
 * PM-only command block in github-issues.md), and only as a negation or a
 * fenced command line — never as a positive prose prescription outside them.
 *
 * AGENTS.md is deliberately NOT scanned: it is host-project-specific (auto-loaded
 * by Pi when cwd is inside the repo), not part of the composed role prompt. See
 * the MUST_BE_ABSENT note below for the negation exception in ops.md.
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
 * project-manager.md names the verb inside the structural-denial doctrine
 * ("Direct `gh issue create` is structurally denied…"); github-issues.md
 * keeps the same shape in its creation section.
 */
const ALLOWLIST = [
  "agents-base/project-manager.md",
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

// Non-vacuity: the known allowlisted sites must still be found, and plan.md
// (deleted in #598) must be gone — if it reappears, the prose body is
// back and the compiled-driver replacement is half-reproduced.
assert(hits.length > 0, `scan found ${hits.length} occurrence(s) of "gh issue create"`);
assert(
  hits.some((h) => h.file === "agents-base/project-manager.md"),
  "non-vacuity: project-manager.md still names the verb (in the denial doctrine)",
);
assert(
  !hits.some((h) => h.file === "pi-prompts/plan.md"),
  "canary: pi-prompts/plan.md is deleted — the 473-line prose body is replaced by start_plan_driver",
);

// Every hit outside the allowlist must be a negation or fenced-code line
// (ops.md's refusal rule quotes the verb inside "Never run ..."). #598's
// structural denial adds a third allowed shape: the verb quoted inside a
// backticked phrase ("`gh issue create` is structurally denied").
const NEGATION = /(do not|never|must not|❌|do NOT|Do not|denied|denies|refused|refuses|gated)/i;
function isAllowedLine(line: string): boolean {
  return (
    NEGATION.test(line) ||
    line.includes("`gh issue create`") ||
    line.trimStart().startsWith("gh ") ||
    line.trimStart().startsWith("`")
  );
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
  const lines = content.split("\n").filter((l) => l.includes("gh issue create"));
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
