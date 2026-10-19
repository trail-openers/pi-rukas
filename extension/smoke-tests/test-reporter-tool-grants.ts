#!/usr/bin/env bun
/**
 * Every companion reporter tool is ALLOWED for the role that dispatches it.
 *
 * The reporters (`report_workstream`, `report_finding`, `report_policy`, ...) are
 * schema-validated tools registered into a child by a companion extension. In
 * headless mode (`pi-rukas-headless`, `pi -p`) the subagent guard resolves every
 * child tool call against agents.json, and a tool with no rule resolves to `ask`,
 * which headless hard-denies ("subagent ask → no broker socket — headless deny").
 * Interactive and trust mode skip the guard, so a missing grant passes every
 * local and live test and fails every unattended cycle: the epic #1642
 * measurement parked 5 of 5 cycles at plan this way (`report_workstream`
 * refused). This test resolves each reporter for its dispatch role exactly the
 * way the headless guard does, and fails when a new reporter ships without one.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveToolPermission } from "../src/permission-guard.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) exitCode = 1;
}

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.resolve(here, "..", "src");
const agents = JSON.parse(readFileSync(path.resolve(here, "..", "..", "agents.json"), "utf8"))
  .agent as Record<string, { permission?: Record<string, string | Record<string, string>> }>;

/**
 * The role each reporter's child is dispatched under. Lens children run as
 * code-review-specialist; every other reporter child is an explore dispatch
 * (plan, policy judge, plan investigation, research angles, facts).
 */
const DISPATCH_ROLE: Record<string, string> = {
  report_finding: "code-review-specialist",
  report_workstream: "explore",
  report_policy: "explore",
  report_plan_item: "explore",
  report_research_claim: "explore",
  report_facts: "explore",
};

// Every reporter registered under src/ (`name: "report_..."` in a registerTool call).
const registered = new Set<string>();
for (const file of readdirSync(src)) {
  if (!file.endsWith(".ts")) continue;
  for (const m of readFileSync(path.join(src, file), "utf8").matchAll(
    /name: "(report_[a-z_]+)"/g,
  )) {
    if (m[1]) registered.add(m[1]);
  }
}

assert(
  registered.size >= 6,
  `the scan finds the reporter registrations (found ${registered.size})`,
);
for (const tool of registered) {
  const role = DISPATCH_ROLE[tool];
  assert(role !== undefined, `${tool} has a declared dispatch role in this test`);
  if (role === undefined) continue;
  const verdict = resolveToolPermission(tool, role, {}, {}, agents);
  assert(
    verdict === "allow",
    `${tool} resolves to allow for ${role} (got ${verdict}; ask is a headless deny)`,
  );
}

// The gate can fail: an ungranted reporter resolves to ask, which headless denies.
assert(
  resolveToolPermission("report_not_a_real_tool", "explore", {}, {}, agents) === "ask",
  "control: an ungranted tool resolves to ask, so a missing grant is caught",
);

process.exit(exitCode);
