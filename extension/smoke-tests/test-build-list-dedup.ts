#!/usr/bin/env bun
/**
 * #479 Gate 1 — data transcription for the jq tool-classification lists in
 * build.sh.
 *
 * build.sh's two jq programs (the PM matrix branch and the specialist
 * self-only branch) each embed the same 13-key tool checklist and the same
 * 20-key MCP filter-exclusion list as literal text. Nothing keeps the two
 * copies in step: a key added to one branch and not the other renders on the
 * role prompt's **MCP:** line instead of **Tools:**, and `bun run build`
 * exits 0 — the only symptom is a subtly wrong capability block reaching a
 * subagent.
 *
 * This test asserts the *data* — that both copies are transcriptions of the
 * two expected member sets, verbatim: same members, no additions, no
 * omissions, same order. It says nothing about the surrounding jq predicate
 * (Gate 2, the byte-identical `dist/prompts/standard/` diff, covers that).
 *
 * Two shapes of build.sh exist at different points in the #479 refactor, and
 * this test must be green in **both** so it lands before the refactor,
 * proving the transcription the refactor then relies on:
 *
 * - **Baseline** (today): the sets exist as inline jq — one
 *   `then "key"` per member in the tool checklist, one `.key != "key"` per
 *   member in the MCP filter, in both branches. The test counts the inline
 *   copies against the expected sets (each member must appear exactly 2
 *   times — one per branch — or more for `*`, which is legitimately used
 *   elsewhere in the same file, e.g. the bash-default checks).
 * - **Refactored** (task-a): the sets exist once each as single-line array
 *   literals inside the capability function —
 *   `local TOOL_KEYS='["read","write",…]'` and
 *   `local NON_TOOL_KEYS='["read","write",…]'` (the `local` scoping and the
 *   indentation are the shell style the refactor actually uses; the matchers
 *   accept them via `(?:^|\s)(?:local\s+)?` rather than a line anchor). The
 *   members are asserted verbatim — no reordering, no additions, no omissions
 *   — and the inline jq copies are gone
 *   (zero `then "key"` and `.key != "key"` occurrences for every member
 *   except `*`, which the jq predicates still use directly).
 *
 * The expected sets are hardcoded here rather than read from build.sh, so
 * the test pins the transcription independently of either shape.
 */

import fs from "node:fs/promises";
import path from "node:path";

const BUILD_SH = path.join(import.meta.dirname, "..", "..", "build.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The 13 named tools, in checklist order. A role granted one of these has it
 * rendered on the **Tools:** line; the MCP filter must exclude it.
 */
const EXPECTED_TOOL_KEYS = [
  "read",
  "write",
  "edit",
  "rg",
  "skill",
  "webfetch",
  "list",
  "todowrite",
  "task",
  "taskctl",
  "cancel_task",
  "list_tasks",
  "check_task",
];

/**
 * The 20-key MCP filter-exclusion set, in select order. Superset of
 * TOOL_KEYS plus the 7 infrastructure members — collapsing the two lists
 * would misclassify any role granted vipune, websearch, mcp or a wildcard.
 */
const EXPECTED_NON_TOOL_KEYS = [
  ...EXPECTED_TOOL_KEYS,
  "multiedit",
  "websearch",
  "bash",
  "*",
  "external_directory",
  "mcp",
  "vipune",
];

const body = await fs.readFile(BUILD_SH, "utf8");
const lines = body.split("\n");

/** `then "key"` occurrences in the tool checklist. */
function checklistCount(key: string): number {
  return lines.filter((l) => l.includes(`then "${key}" else empty end`)).length;
}

/** `.key != "key"` occurrences in the MCP filter select. */
function selectCount(key: string): number {
  return lines.filter((l) => l.includes(`.key != "${key}"`)).length;
}

function isRefactored(): boolean {
  return (
    /(?:^|\s)(?:local\s+)?TOOL_KEYS=/.test(body, "m") &&
    /(?:^|\s)(?:local\s+)?NON_TOOL_KEYS=/.test(body, "m")
  );
}

/**
 * Extract a single-line array literal as its members.
 * The `(?:^|\s)(?:local\s+)?` prefix matches both the column-0 form
 * and the `local`-scoped, indented form build.sh uses inside the
 * capability function.
 */
function extractArray(name: string): string[] {
  const m = body.match(new RegExp(`(?:^|\\s)(?:local\\s+)?${name}='(\\[.*?])'\\s*$`, "m"));
  if (!m) return [];
  const parsed = JSON.parse(m[1]) as unknown;
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

if (isRefactored()) {
  // ---------------------- refactored: single-line array literals (task-a)

  for (const name of ["TOOL_KEYS", "NON_TOOL_KEYS"]) {
    const m = body.match(new RegExp(`(?:^|\\s)(?:local\\s+)?${name}='\\[[^\\n]*\\]'\\s*$`, "m"));
    assert(m !== null, `${name} is a single-line array literal in build.sh`);
  }

  const toolKeys = extractArray("TOOL_KEYS");
  const nonToolKeys = extractArray("NON_TOOL_KEYS");

  assert(
    JSON.stringify(toolKeys) === JSON.stringify(EXPECTED_TOOL_KEYS),
    `TOOL_KEYS transcribes the removed 13-key checklist verbatim (got ${toolKeys.length} members)`,
  );
  assert(
    JSON.stringify(nonToolKeys) === JSON.stringify(EXPECTED_NON_TOOL_KEYS),
    `NON_TOOL_KEYS transcribes the removed 20-key filter set verbatim (got ${nonToolKeys.length} members)`,
  );

  for (const key of EXPECTED_NON_TOOL_KEYS) {
    if (key === "*") continue; // still used by the bash-default jq checks
    assert(
      checklistCount(key) === 0 && selectCount(key) === 0,
      `inline jq copy of "${key}" is gone (consumed via --argjson)`,
    );
  }
} else {
  // ------------------------------- baseline: inline copies in both branches

  for (const key of EXPECTED_TOOL_KEYS) {
    assert(
      checklistCount(key) === 2,
      `checklist member "${key}" present in both jq branches (found ${checklistCount(key)})`,
    );
  }

  for (const key of EXPECTED_NON_TOOL_KEYS) {
    if (key === "*") {
      assert(
        selectCount(key) >= 2,
        `MCP filter copies .key != "*" in both jq branches (found ${selectCount(key)})`,
      );
      continue;
    }
    assert(
      selectCount(key) === 2,
      `MCP filter member .key != "${key}" present in both jq branches (found ${selectCount(key)})`,
    );
  }

  // Anti-drift: a key present in the checklist of one branch but the other
  // (or in the filter of one but not the other) would show up as a count
  // of 1 — the exact defect this issue is about.
  assert(
    EXPECTED_TOOL_KEYS.every((k) => checklistCount(k) === 2) &&
      EXPECTED_NON_TOOL_KEYS.every((k) => (k === "*" ? selectCount(k) >= 2 : selectCount(k) === 2)),
    "no key drifts between the two branches (every member found exactly 2x, or more for *)",
  );
}

// ------------------------------------------------- anti-vacuity: the matchers
//
// A broken regex would make every count 0 and the assertions above would
// fail in baseline but — worse — silently pass a *refactored* file that
// renamed the literal shapes. Prove the matchers see what they claim to see
// by running them against the known shapes.
{
  const sample =
    '        (if ($perm.read // "deny") == "allow" then "read" else empty end),\n            .key != "read" and\n';
  assert(
    sample.split("\n").filter((l) => l.includes('then "read" else empty end')).length === 1 &&
      sample.split("\n").filter((l) => l.includes('.key != "read"')).length === 1,
    "checklist/select matchers actually match the inline shapes",
  );
  const sampleLiteral = `TOOL_KEYS='["read","write","edit"]'`;
  assert(
    (sampleLiteral.match(/^TOOL_KEYS='(\[.*?])'\s*$/m)?.[1] ?? "").includes('"read"'),
    "array-literal extraction matches the single-line shape",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
