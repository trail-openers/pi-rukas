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
 * local and live test and fails only unattended cycles. This test resolves each
 * reporter for its dispatch role the way the headless guard does.
 *
 * DISPATCH_ROLE must change with the dispatch site: a reporter moved to another
 * role needs its grant moved too. Its keys must equal the registered set, so a
 * reporter added (or removed) without updating this map fails here.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToolPermission } from "../src/permission-guard.ts";

let exitCode = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) exitCode = 1;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "src");
// agents.json's `agent` map is the shape resolveToolPermission reads; a drift in
// that shape makes every grant below resolve to ask and fail loudly.
const agents = JSON.parse(readFileSync(path.resolve(here, "..", "..", "agents.json"), "utf8"))
  .agent as Record<string, { permission?: Record<string, string | Record<string, string>> }>;

/**
 * The role each reporter's child is dispatched under. Lens children run as
 * code-review-specialist; every other reporter child is an explore dispatch
 * (plan, policy judge, plan investigation, research angles, facts).
 */
const DISPATCH_ROLE: Partial<Record<string, string>> = {
  report_finding: "code-review-specialist",
  report_workstream: "explore",
  report_policy: "explore",
  report_plan_item: "explore",
  report_research_claim: "explore",
  report_facts: "explore",
};

// Every reporter registered anywhere under src/ (`name: "report_..."`, any quote style).
const registered = new Set<string>();
for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
  if (!file.endsWith(".ts")) continue;
  const text = readFileSync(path.join(src, file), "utf8");
  for (const m of text.matchAll(/name:\s*["'`](report_[a-z_]+)["'`]/g)) {
    if (m[1]) registered.add(m[1]);
  }
}

const declared = Object.keys(DISPATCH_ROLE).sort();
assert(
  JSON.stringify([...registered].sort()) === JSON.stringify(declared),
  `the registered reporters equal the declared map (registered: ${[...registered].sort().join(", ")})`,
);
for (const tool of declared) {
  const role = DISPATCH_ROLE[tool];
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
