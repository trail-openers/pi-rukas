#!/usr/bin/env bun
/**
 * A tool PM cannot call without a prompt is a tool PM does not have.
 *
 * `agents.json` sets `"*": "ask"` for project-manager and then allowlists every
 * dispatch tool by name. Registering a new tool therefore does NOT make it
 * usable: it falls through to `ask`, so every call interrupts the user — and in
 * headless `pi -p`, novel calls are hard-denied outright.
 *
 * That is exactly what happened to `start_work_driver` and
 * `load_workflow_doctrine`. They were registered, described, named in the
 * sticky preamble, and documented in AGENTS.md and the README — and PM would
 * still have been stopped at the permission layer on first use. The tools were
 * built to end an incident where PM hand-rolled the driver because it had
 * nothing to call; shipping them behind a prompt would have half-reproduced it.
 *
 * So the rule is mechanical: every tool this extension registers is resolved in
 * PM's permission map, or listed below with the reason it is not.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const AGENTS = path.resolve(import.meta.dirname, "..", "..", "agents.json");

/**
 * Tools deliberately NOT granted to project-manager, each with the reason.
 * Empty today; an entry here is a decision, not an oversight.
 */
const NOT_FOR_PM: Record<string, string> = {
  // Companion extensions loaded INTO a child process
  // (`pi --no-extensions --extension <path>`), never into the main session.
  // The parent reads the child's `tool_use` blocks afterward; PM never sees
  // these and must not be granted them.
  report_finding: "lens-reporter.ts — registered inside each lens-review child",
  report_policy: "policy-reporter.ts — registered inside the merge-policy judge child",
};

// Every `pi.registerTool({ name: "…" })` in the extension.
const registered = new Set<string>();
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(path.join(SRC, f), "utf8");
  for (const m of text.matchAll(/registerTool\(\{\s*\n?\s*name:\s*"([^"]+)"/g)) {
    registered.add(m[1] as string);
  }
}

assert(
  registered.size >= 9,
  `found ${registered.size} registered tools: ${[...registered].sort().join(", ")}`,
);

const agents = JSON.parse(readFileSync(AGENTS, "utf8")) as {
  agent: Record<string, { permission: Record<string, unknown> }>;
};
const perm = agents.agent["project-manager"]?.permission ?? {};

// The premise. If this ever becomes "allow", the rest of this file is moot —
// and the assertion below will say so rather than passing silently.
assert(
  perm["*"] === "ask",
  `canary: PM's default is "${perm["*"]}" — an unlisted tool does NOT fall through to allow`,
);

{
  const ungranted = [...registered]
    .filter((t) => !(t in NOT_FOR_PM))
    .filter((t) => perm[t] !== "allow");
  assert(
    ungranted.length === 0,
    `every registered tool is allowed for PM${
      ungranted.length
        ? ` — would prompt on use: ${ungranted.join(", ")} (add to agents.json, or to NOT_FOR_PM with a reason)`
        : ""
    }`,
  );
}

{
  // The two this file was written for.
  assert(perm.start_work_driver === "allow", "start_work_driver is granted");
  assert(perm.load_workflow_doctrine === "allow", "load_workflow_doctrine is granted");
  assert(
    registered.has("start_work_driver") && registered.has("load_workflow_doctrine"),
    "...and both are actually registered, so the grants are not stale",
  );
}

{
  // The allowlist must not rot the other way: a grant for a tool that no longer
  // exists is dead config that hides a typo in a real one.
  const known = new Set([...registered, ...Object.keys(NOT_FOR_PM)]);
  const orphans = Object.keys(perm).filter(
    (k) =>
      (k.startsWith("dispatch_") || k.endsWith("_loop") || k === "check_review_cap") &&
      !known.has(k),
  );
  assert(
    orphans.length === 0,
    `no grant names a tool that is not registered${orphans.length ? ` — stale: ${orphans.join(", ")}` : ""}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
