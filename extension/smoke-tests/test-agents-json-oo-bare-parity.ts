#!/usr/bin/env bun
/**
 * oo / bare parity for the developer and ops bash permission maps (#1084).
 *
 * Once the prompts stop typing the `oo` prefix (#1083), agents run bare
 * commands. In strict and headless mode the oo rewrite hook is inert, so a
 * bare command resolves against agents.json alone and falls to `"*": "ask"`
 * (a hard deny in headless mode) unless a bare row grants it.
 *
 * Rule enforced here: for every `oo <cmd>…` row in the command families
 * below, the bare `<cmd>…` must resolve to the same verdict under
 * matchBashSubcommand (longest pattern wins). Equality is by verdict, not by
 * key, so an existing broader bare row satisfies the rule.
 *
 * Exempt, by decision (#1084):
 *   - gh / glab forge rows: permanently out of parity, so the #912 merge
 *     gate's surface is unchanged. Bare gh/glab must stay `ask`.
 *   - oo's own subcommands (oo recall, oo help, oo patterns, oo learn, …):
 *     they have no bare counterpart.
 *   - command families outside FAMILIES (docker, uv, npx, jest, ruff, the
 *     ImageMagick and bats rows, …): out of scope for this ticket.
 *
 * Also asserts that ops' bare test-runner deny rows still deny, so the
 * parity rows cannot shadow them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { matchBashSubcommand } from "../src/bash-command-parser.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FAMILIES = ["git", "cargo", "bun", "npm", "pnpm", "yarn", "pytest", "go"];
const ROLES = ["developer", "ops"] as const;

const agentsPath = path.resolve(import.meta.dirname, "..", "..", "agents.json");
const agents = JSON.parse(readFileSync(agentsPath, "utf8")) as {
  agent: Record<string, { permission: { bash: Record<string, string> } }>;
};

/** A concrete command that the bare pattern should match (wildcard → "x"). */
function sampleFor(pattern: string): string {
  if (pattern.endsWith(" *")) return `${pattern.slice(0, -2)} x`;
  if (pattern.endsWith("*")) return pattern.slice(0, -1);
  return pattern;
}

for (const role of ROLES) {
  const bash = agents.agent[role]?.permission.bash ?? {};
  for (const [key, verdict] of Object.entries(bash)) {
    if (!key.startsWith("oo ")) continue;
    const bare = key.slice(3);
    if (bare.startsWith("gh ") || bare.startsWith("glab ")) continue;
    if (!FAMILIES.includes(bare.split(/[ *]/)[0] ?? "")) continue;
    const sample = sampleFor(bare);
    const got = matchBashSubcommand(sample, bash);
    assert(
      got === verdict,
      `${role}: "${key}" is ${verdict}; bare "${bare}" resolves ${got} on "${sample}"`,
    );
  }
}

const ops = agents.agent.ops?.permission.bash ?? {};
for (const cmd of [
  "cargo test",
  "cargo clippy",
  "bun test",
  "npm test",
  "pytest",
  "pnpm test",
  "yarn test",
  "go test",
]) {
  assert(matchBashSubcommand(cmd, ops) === "deny", `ops: bare "${cmd}" stays deny`);
}

for (const role of ROLES) {
  const bash = agents.agent[role]?.permission.bash ?? {};
  assert(matchBashSubcommand("gh pr merge 1", bash) === "ask", `${role}: bare gh pr merge stays ask`);
  assert(matchBashSubcommand("glab mr merge 1", bash) === "ask", `${role}: bare glab mr merge stays ask`);
}

console.log(exit === 0 ? "\nAll oo/bare parity checks passed." : "\nFAILED");
process.exit(exit);
