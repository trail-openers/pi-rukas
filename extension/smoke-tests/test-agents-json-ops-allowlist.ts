#!/usr/bin/env bun
/**
 * Keep the ops bash permission map explicit at the GitHub boundary.
 *
 * A broad `gh api*` grant can authorize arbitrary API mutations, while
 * omitting the common PR mutations makes the allowlist unusable for routine
 * release work. The default must remain ask so new commands require review.
 * This is an offline assertion over the checked-in permission configuration.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const agentsPath = path.resolve(import.meta.dirname, "..", "..", "agents.json");
const agents = JSON.parse(readFileSync(agentsPath, "utf8")) as {
  agent?: {
    ops?: {
      permission?: {
        bash?: Record<string, unknown>;
      };
    };
  };
};
const bash = agents.agent?.ops?.permission?.bash ?? {};

assert(!("gh api*" in bash), "ops has no blanket gh api* grant");
assert(bash["gh pr close*"] === "allow", "ops explicitly allows gh pr close*");
assert(bash["gh pr merge*"] === "allow", "ops explicitly allows gh pr merge*");
assert(bash["*"] === "ask", `ops bash default is ${JSON.stringify(bash["*"])}`);

console.log(exit === 0 ? "\nAll ops allowlist checks passed." : "\nFAILED");
process.exit(exit);
