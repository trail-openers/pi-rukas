#!/usr/bin/env bun
/**
 * Smoke test for per-role tool-gating (PR #238 — Option A).
 *
 * Asserts on the CHILD ARGV built by `buildChildArgs`:
 *  - read-only roles (explore, adversarial-developer, code-review-specialist)
 *    produce argv containing `--exclude-tools` with write/edit/multiedit
 *  - executor roles (developer, ops) produce NO `--exclude-tools` entry
 *  - project-manager (rarely spawned) produces NO `--exclude-tools` entry
 *
 * Also retains the direct map assertions for role-tools.ts itself.
 */

import { buildChildArgs } from "../src/spawn.ts";
import { type ResolvedModelChoice } from "../src/models.ts";
import { excludeToolListFor, excludeToolsFor } from "../src/role-tools.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Helper to find the value after --exclude-tools in argv.
function excludeToolsValueFromArgs(args: string[]): string | undefined {
  const idx = args.indexOf("--exclude-tools");
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// Shared test fixtures.
const TEST_PROMPT = "/tmp/pi-ensemble-test-prompt.md";
const TEST_TRANSCRIPT = "/tmp/pi-ensemble-test-transcript.json";
const TEST_MODEL: ResolvedModelChoice = { provider: undefined, model: undefined, source: "default" };

// ============================================================
// CHILD ARGV ASSERTIONS — the fix for #339
// These prove the flag reaches the spawned child's argv.
// ============================================================

// 1. Read-only roles: --exclude-tools is present with correct value.
{
  for (const role of ["explore", "adversarial-developer", "code-review-specialist"]) {
    const args = buildChildArgs(role, TEST_PROMPT, TEST_TRANSCRIPT, TEST_MODEL, false);
    const value = excludeToolsValueFromArgs(args);
    assert(
      value === "write,edit,multiedit",
      `${role}: --exclude-tools write,edit,multiedit in child argv (got: ${value})`,
    );
  }
}

// 2. Executor roles: --exclude-tools is ABSENT.
{
  for (const role of ["developer", "ops"]) {
    const args = buildChildArgs(role, TEST_PROMPT, TEST_TRANSCRIPT, TEST_MODEL, false);
    const value = excludeToolsValueFromArgs(args);
    assert(
      value === undefined,
      `${role}: no --exclude-tools in child argv (developer/ops legitimately need write/edit)`,
    );
  }
}

// 3. project-manager (rarely a subagent): no --exclude-tools.
{
  const args = buildChildArgs("project-manager", TEST_PROMPT, TEST_TRANSCRIPT, TEST_MODEL, false);
  const value = excludeToolsValueFromArgs(args);
  assert(
    value === undefined,
    "project-manager: no --exclude-tools in child argv (parent-process gating is separate concern)",
  );
}

// 4. Unknown role: no --exclude-tools (err open, not closed).
{
  const args = buildChildArgs(
    "future-role-that-does-not-exist",
    TEST_PROMPT,
    TEST_TRANSCRIPT,
    TEST_MODEL,
    false,
  );
  const value = excludeToolsValueFromArgs(args);
  assert(value === undefined, "unknown role: no --exclude-tools in child argv (errs open)");
}

// 5. Basic arg structure: --mode rpc and --no-extensions are present.
{
  const args = buildChildArgs("developer", TEST_PROMPT, TEST_TRANSCRIPT, TEST_MODEL, false);
  assert(args.includes("--mode"), "child argv contains --mode");
  assert(args[args.indexOf("--mode") + 1] === "rpc", "child argv --mode value is rpc");
  assert(args.includes("--no-extensions"), "child argv contains --no-extensions");
}

// 6. extraArgs are appended.
{
  const args = buildChildArgs(
    "developer",
    TEST_PROMPT,
    TEST_TRANSCRIPT,
    TEST_MODEL,
    false,
    ["--extra-flag", "value"],
  );
  assert(args.includes("--extra-flag"), "child argv includes extraArgs");
  assert(args[args.indexOf("--extra-flag") + 1] === "value", "extraArgs value is correct");
}

// ============================================================
// DIRECT MAP ASSERTIONS (role-tools.ts)
// Retained for completeness — verifies the source of truth.
// ============================================================

// 7. Read-only roles get write/edit/multiedit excluded.
{
  for (const role of ["explore", "adversarial-developer", "code-review-specialist"]) {
    const list = excludeToolListFor(role);
    assert(list.includes("write"), `${role}: write excluded`);
    assert(list.includes("edit"), `${role}: edit excluded`);
    assert(list.includes("multiedit"), `${role}: multiedit excluded`);
    const csv = excludeToolsFor(role);
    assert(csv === "write,edit,multiedit", `${role}: CSV shape correct (got: ${csv})`);
  }
}

// 8. Executor roles (developer, ops) have NO exclusions.
{
  for (const role of ["developer", "ops"]) {
    const list = excludeToolListFor(role);
    assert(
      list.length === 0,
      `${role}: empty exclude list (developer/ops legitimately need write/edit)`,
    );
    const csv = excludeToolsFor(role);
    assert(csv === undefined, `${role}: excludeToolsFor returns undefined (spawn.ts skips the flag)`);
  }
}

// 9. project-manager (rarely a subagent) has NO exclusions.
{
  const list = excludeToolListFor("project-manager");
  assert(
    list.length === 0,
    "project-manager: empty exclude list (parent-process gating is separate concern)",
  );
  const csv = excludeToolsFor("project-manager");
  assert(csv === undefined, "project-manager: excludeToolsFor returns undefined");
}

// 10. Unknown role: err open.
{
  const list = excludeToolListFor("future-role-that-does-not-exist");
  assert(list.length === 0, "unknown role: empty exclude list");
  const csv = excludeToolsFor("future-role-that-does-not-exist");
  assert(csv === undefined, "unknown role: excludeToolsFor returns undefined (errs open)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);