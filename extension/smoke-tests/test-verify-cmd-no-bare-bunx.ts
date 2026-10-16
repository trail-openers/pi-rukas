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

/**
 * Failures for one tier's text.
 *
 * `optional` is NOT a parameter here: whatever the driver does when a tier is
 * absent, a tier file that EXISTS must still carry a command. An empty
 * optional tier is a broken gate, not "no gate" — the ENOENT skip below is
 * the only place optionality applies.
 *
 * The bunx scan reads every line including comments on purpose: a tier that
 * mentions `bunx` in prose is the one a later editor copies from.
 */
function checkTier(rel: string, text: string): string[] {
  const fails: string[] = [];
  for (const line of text.split("\n")) {
    if (BARE_BUNX.test(line))
      fails.push(
        `${rel} uses bare \`bunx\` — \`bun x\` uses the binary that is always there: ${line.trim().slice(0, 120)}`,
      );
  }
  if (readFirstConfigLine(text) === undefined)
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

// The `optionalTier` split is derived from `whenAbsent`, so a rewording of
// that prose silently reclassifies the develop gate. Pinned explicitly.
const REQUIRED = COMMAND_FILES.filter((f) => !optionalTier(f)).map((f) => f.path);
if (!REQUIRED.includes(".pi/verify-cmd"))
  report([
    `.pi/verify-cmd must classify as required — got required tier(s) [${REQUIRED.join(", ")}]`,
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
  report(checkTier(f.path, text));
}

// Fixture canaries: a gate never observed to fail is worthless (AGENTS.md §1).
// Counts are exact, not ">=1" — a canary that over-reports hides a rule that
// fires where it should not.
const CANARIES: Array<[string, string, number]> = [
  ["bare bunx", "# c\nbunx tsc --noEmit", 1],
  ["clean bun x", "cd extension && bun x tsc --noEmit", 0],
  ["comment-only tier", "# comment only\n\n   \n", 1],
  ["empty optional tier", "", 1],
  ["bunx in a comment is flagged", "# was: bunx tsc\nbun x tsc --noEmit", 1],
];
for (const [label, text, expected] of CANARIES) {
  const n = checkTier(".pi/verify-cmd", text).length;
  if (n === expected) console.log(`✓ canary ${label}: ${n} failure(s)`);
  else report([`GATE-BROKEN: canary ${label} expected ${expected} failures, got ${n}`]);
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
