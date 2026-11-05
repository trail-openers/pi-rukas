#!/usr/bin/env bun
/**
 * #2031 AC1 — both reviewer ROLE PROMPTS tell the reviewer that a probe needing
 * hostile or alternate config points HOME, GIT_CONFIG_GLOBAL and XDG_CONFIG_HOME
 * at a mktemp directory, and that a reviewer never writes under $HOME or outside
 * its review tree.
 *
 * Asserted against the BUILT prompt (`dist/prompts/standard/<role>.md`, rebuilt
 * here through build.sh, the same way test-built-prompts.ts inspects it), so the
 * gate proves the sentence reaches the model rather than sitting in a source
 * file that no manifest assembles. The two other roles that hold bash and drive
 * reviewer-adjacent work (developer, ops) are the negative control: the rule is
 * reviewer-only, so it must not land in the shared trailer.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const SELF = "test-AC1-reviewer-probe-hygiene-prompt.ts";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROMPTS = path.join(ROOT, "dist", "prompts", "standard");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    // The digest anchors on the `✗` lines; the file names itself so the parent
    // can attribute the red.
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

execFileSync("bash", [path.join(ROOT, "build.sh")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PI_ENSEMBLE_BASE: ROOT,
    PROMPTS_DIR: path.join(ROOT, "dist", "prompts"),
  },
  stdio: "ignore",
});

/** The three levers a hostile-config probe has to redirect, all at once. */
const LEVERS = ["HOME", "GIT_CONFIG_GLOBAL", "XDG_CONFIG_HOME"];

function hasRule(prompt: string): { missing: string[] } {
  const missing: string[] = [];
  if (!/mktemp/i.test(prompt)) missing.push("mktemp");
  for (const lever of LEVERS) if (!prompt.includes(lever)) missing.push(lever);
  if (!/never write under \$HOME/i.test(prompt)) missing.push("never write under $HOME");
  if (!/outside (its|the|your) review tree/i.test(prompt)) missing.push("outside its review tree");
  return { missing };
}

for (const role of ["code-review-specialist", "adversarial-developer"]) {
  const prompt = readFileSync(path.join(PROMPTS, `${role}.md`), "utf8");
  const { missing } = hasRule(prompt);
  assert(
    missing.length === 0,
    `${role}: built prompt states the probe-hygiene rule — missing [${missing.join(", ")}]`,
  );
}

for (const role of ["developer", "ops"]) {
  const prompt = readFileSync(path.join(PROMPTS, `${role}.md`), "utf8");
  assert(
    !/never write under \$HOME/i.test(prompt),
    `${role}: built prompt does not carry the reviewer-only probe-hygiene rule`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
