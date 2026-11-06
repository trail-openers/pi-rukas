#!/usr/bin/env bun
/**
 * #2031 AC1 — both reviewer ROLE PROMPTS tell the reviewer that a probe needing
 * hostile or alternate config points HOME, GIT_CONFIG_GLOBAL and XDG_CONFIG_HOME
 * at a mktemp directory, and that a reviewer never writes under $HOME or outside
 * its review tree. #2051 AC1 adds the other half of the same rule: the probes go
 * in ONE directory the reviewer made for the run, that directory stays under
 * 50 MB in total, and the reviewer deletes it before reporting — the temp-dir
 * leak this rule exists to stop is a lens that filled the host's temp quota and
 * took the next child down with it.
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
  // #2051 AC1 — the size and cleanup half of the rule, asserted as three separate
  // obligations: each one the module must state, and each one a rule a reviewer
  // can ignore while still honouring the mktemp/HOME sentences above.
  if (!/one (mktemp -d|directory)[^.]*(for|in) (this|the) run/i.test(prompt))
    missing.push("one directory for the run");
  if (!/under 50 MB/i.test(prompt)) missing.push("under 50 MB");
  if (!/delete[s]? (the|it|your|all)[^.]*before (you |it )?report/i.test(prompt))
    missing.push("delete the directory before reporting");
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
  // The size and cleanup sentences are reviewer-only too: a developer's own
  // scratch under the temp dir is the work, not a probe leak.
  assert(
    !/under 50 MB/i.test(prompt),
    `${role}: built prompt does not carry the reviewer-only 50 MB probe bound`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
