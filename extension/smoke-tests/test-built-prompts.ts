#!/usr/bin/env bun
/**
 * Structural assembly gate for the role prompts.
 *
 * This checks presence only: it cannot determine whether a doctrine sentence
 * accurately describes runtime behaviour. That remains a human review
 * judgement, so this test must not be read as semantic prompt verification.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANIFESTS = path.join(ROOT, "manifests");
const PROMPTS = path.join(ROOT, "dist", "prompts", "standard");
const BUILD = path.join(ROOT, "build.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Build the same output this gate inspects. No Pi child or network is used.
execFileSync("bash", [BUILD], {
  cwd: ROOT,
  env: {
    ...process.env,
    PI_ENSEMBLE_BASE: ROOT,
    PROMPTS_DIR: path.join(ROOT, "dist", "prompts"),
  },
  stdio: "ignore",
});

for (const manifestName of readdirSync(MANIFESTS).filter((name) => name.endsWith(".manifest"))) {
  const role = manifestName.replace(/\.manifest$/, "");
  const manifestPath = path.join(MANIFESTS, manifestName);
  const promptPath = path.join(PROMPTS, `${role}.md`);
  const prompt = readFileSync(promptPath, "utf8");
  const promptLines = new Set(prompt.split("\n"));

  for (const line of readFileSync(manifestPath, "utf8").split("\n")) {
    const modulePath = line.trim();
    if (!modulePath || modulePath.startsWith("#")) continue;

    const module = readFileSync(path.join(ROOT, modulePath), "utf8");
    // bash-final-reminders intentionally starts at H2, so the first ATX
    // heading is used rather than requiring every module to invent an H1.
    const heading = module.match(/^#{1,6} .+$/m)?.[0];
    assert(heading !== undefined, `${role}: ${modulePath} has a markdown heading`);
    if (heading !== undefined) {
      assert(
        promptLines.has(heading),
        `${role}: assembled prompt contains ${modulePath}'s first heading (${heading})`,
      );
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
