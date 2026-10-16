#!/usr/bin/env bun
/**
 * Keep the ops bash permission map explicit at the GitHub boundary.
 *
 * A broad `oo gh api*` grant can authorize arbitrary API mutations, while
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

assert(!("oo gh api*" in bash), "ops has no blanket oo gh api* grant");
assert(bash["oo gh pr close*"] === "allow", "ops explicitly allows oo gh pr close*");
// Merges are granted in the plain form the merge guard accepts. The `oo`-wrapped
// forms are refused by the guard (wrappers are not read), so they must NOT be
// granted: see docs/troubleshooting.md, "Which commands the guard checks (#962)".
assert(bash["gh pr merge*"] === "allow", "ops explicitly allows gh pr merge*");
assert(!("oo gh pr merge*" in bash), "ops has no oo-wrapped gh pr merge* grant");
assert(!("oo glab mr merge*" in bash), "ops has no oo-wrapped glab mr merge* grant");
assert(bash["*"] === "ask", `ops bash default is ${JSON.stringify(bash["*"])}`);

console.log(exit === 0 ? "\nAll ops allowlist checks passed." : "\nFAILED");
process.exit(exit);
