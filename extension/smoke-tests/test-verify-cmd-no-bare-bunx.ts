#!/usr/bin/env bun
/**
 * #1118: `bun x` dispatches through the one bun binary always on PATH; `bunx`
 * is a second entry provisioning may not create, and two cycles parked on it.
 * In scope: the driver's command-tier files — `HEADLESS_FILES` where
 * `kind: "command"`, derived rather than hand-listed. Out of scope and in
 * #1414: driver code, docs, `.pi/worktree-setup`, `ci.yml` — `bunx` stays
 * legal there.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FILES, type HostFile } from "../src/headless/inputs.ts";
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BARE_BUNX = /\bbunx\b/;

const COMMAND_FILES: readonly HostFile[] = HEADLESS_FILES.filter((f) => f.kind === "command");

/** A tier whose absence the driver treats as "no gate" rather than a missing file. */
function optionalTier(f: HostFile): boolean {
  return f.kind === "command" && !f.whenAbsent.includes("derive");
}

/** Failures for one tier's text. `optional` = the driver treats it as "no gate". */
function checkTier(rel: string, text: string, optional: boolean): string[] {
  const fails: string[] = [];
  for (const line of text.split("\n")) {
    if (BARE_BUNX.test(line))
      fails.push(
        `${rel} uses bare \`bunx\` — \`bun x\` uses the binary that is always there: ${line.trim().slice(0, 120)}`,
      );
  }
  if (!optional && readFirstConfigLine(text) === undefined)
    fails.push(`${rel} has no command line — the driver would fall back to derivation`);
  return fails;
}

let exit = 0;
function report(fails: string[]) {
  for (const f of fails) {
    console.error(`✗ ${f}`);
    exit = 1;
  }
}

// The gate's own scope: a filter bug or a dropped entry would report a clean
// repo over tiers it never read.
if (COMMAND_FILES.length === 0 || !COMMAND_FILES.some((f) => f.path === ".pi/verify-cmd"))
  report([
    `derived scope [${COMMAND_FILES.map((f) => f.path).join(", ")}] must be non-empty and hold .pi/verify-cmd`,
  ]);

for (const f of COMMAND_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, f.path), "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    // Data, not a hard-coded name: `whenAbsent` is what the driver does.
    if (code === "ENOENT" && optionalTier(f)) {
      console.log(`· ${f.path} absent — ${f.whenAbsent}`);
      continue;
    }
    report([`${f.path} is NOT readable (${code})`]);
    continue;
  }
  report(checkTier(f.path, text, optionalTier(f)));
}

// One fixture canary: a gate never observed to fail is worthless (AGENTS.md §1).
const CANARIES: Array<[string, string, boolean, number]> = [
  [".pi/verify-cmd", "# c\nbunx tsc --noEmit", false, 1],
  [".pi/verify-cmd", "cd extension && bun x tsc --noEmit", false, 0],
  [".pi/verify-cmd", "# comment only\n\n   \n", false, 1],
];
for (const [rel, text, optional, expected] of CANARIES) {
  const n = checkTier(rel, text, optional).length;
  const ok = expected === 0 ? n === 0 : n >= expected;
  if (ok) console.log(`✓ canary ${rel}: ${n} failure(s)`);
  else
    report([
      `GATE-BROKEN: canary ${rel} expected ${expected === 0 ? "0" : "≥1"} failures, got ${n}`,
    ]);
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
