#!/usr/bin/env bun
/**
 * AGENTS.md is a rules file, so the file itself has to stay a rules file.
 *
 * Two constraints, both cheap and both violable by an ordinary PR that pastes
 * an incident write-up into doctrine:
 *
 *   1. A byte ceiling. The file is auto-loaded into every agent's context for
 *      this repo, so its size is a per-dispatch cost, and the ceiling makes
 *      that cost a stated number rather than a preference.
 *   2. No issue-number references. `#123` in a rule is incident history: the
 *      reasoning is carried by the sentence, the number is a pointer into git,
 *      and a pointer that outlives its issue is noise in everybody's prompt.
 *      Linkage belongs in the PR body (`Closes #N`), not in the doctrine.
 *
 * Both are asserted in both directions: the real file is clean, and synthetic
 * fixtures carrying each violation are caught by the same exported checker.
 * A gate never observed to fail is worthless.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export const BYTE_CEILING = 28_000;

/** An issue reference: `#` immediately followed by digits. */
const ISSUE_REF_RE = /#\d+/;

/** Every violation in a document, as human-readable lines. Empty means clean. */
export function agentsMdStaticFindings(text: string, ceiling = BYTE_CEILING): string[] {
  const findings: string[] = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > ceiling) findings.push(`over the byte ceiling (${bytes} > ${ceiling})`);
  const numbered = text.split("\n").filter((line) => ISSUE_REF_RE.test(line));
  if (numbered.length > 0) {
    findings.push(`issue references on ${numbered.length} line(s): ${numbered[0]?.trim().slice(0, 60)}`);
  }
  return findings;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const file = path.join(ROOT, "AGENTS.md");

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`\nFATAL: ${file} unreadable — the static-rules gate cannot run.`);
  process.exit(1);
}

const bytes = Buffer.byteLength(text, "utf8");
assert(bytes <= BYTE_CEILING, `AGENTS.md fits the byte ceiling (${bytes} <= ${BYTE_CEILING})`);
assert(
  !ISSUE_REF_RE.test(text),
  "AGENTS.md carries no issue reference — history lives in git, not in doctrine",
);
assert(
  agentsMdStaticFindings(text).length === 0,
  `the checker agrees the real file is clean (got ${JSON.stringify(agentsMdStaticFindings(text))})`,
);

// ------------------------------------------------------------- the canaries

const OVERSIZED = `# Agent Guidelines\n\n${"x".repeat(BYTE_CEILING + 1)}\n`;
assert(
  agentsMdStaticFindings(OVERSIZED).some((f) => f.startsWith("over the byte ceiling")),
  `canary: an oversized document IS caught (${OVERSIZED.length + 1} chars)`,
);
assert(
  agentsMdStaticFindings(`## 1. Gates\n\nA gate checks executed evidence (#123).\n`).some((f) =>
    f.startsWith("issue references"),
  ),
  "canary: a synthetic `#123` in a rule line IS caught",
);
assert(
  agentsMdStaticFindings("# Title\n\nA rule with a hash in prose: `#tag` is a label.\n").length === 0,
  "canary: a clean document under the ceiling is not flagged (no vacuous pass)",
);

console.log(exit === 0 ? "\nAll AGENTS.md static-rules checks passed." : "\nFAILED");
process.exit(exit);
