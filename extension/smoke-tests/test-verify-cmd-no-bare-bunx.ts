#!/usr/bin/env bun
/**
 * #1118: `bun x` dispatches through the one bun binary always on PATH; `bunx`
 * is a second entry provisioning may not create, and two cycles parked on it.
 * Two scanned lists, because the same alias appears in two different roles:
 *
 *   1. `COMMAND_FILES` — the driver's command-tier files (`kind: "command"`
 *      in HEADLESS_FILES, derived rather than hand-listed). Every line the
 *      driver may execute.
 *   2. `PROSE_FILES` (#1414) — driver code and operator docs that PRESCRIBE
 *      a command. A `bunx` here is what a later reader copies, and for the
 *      cap-checkpoint it was also the operator-facing lie: the checkpoint
 *      ran one literal and the handoff named another.
 *
 * `EXEMPT_FILES` names where `bunx` stays legal and is deliberately NOT
 * scanned: `bash-command-parser.ts` / `review-accept-arms.ts` match
 * user-typed commands (where the alias is legitimate), `review-accept-guard.ts`
 * documents those arms, `ci.yml` runs on GitHub runners that always have it,
 * and smoke-test fixtures carry it as test DATA.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FILES, type HostFile } from "../src/headless/inputs.ts";
import { CHECKPOINT_TYPECHECK_CMD } from "../src/work-driver-cap-checkpoint.ts";
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const BARE_BUNX = /\bbunx\b/;

/**
 * #1414 — the checkpoint's typecheck command, spelled once in src and
 * repeated as prose in three files that cannot import it (one is a type-only
 * module; the others are docs). Pinned to the constant AND to itself here so
 * a rewrite of any one site fails the gate rather than quietly restoring the
 * bug's operator-facing lie.
 */
const CHECKPOINT_CMD = "bun x tsc --noEmit";

/** Where the checkpoint command is spelled, and what each site must say. */
const PROSE_FILES: readonly string[] = [
  "extension/src/work-driver-cap-checkpoint.ts",
  "extension/src/work-driver-caped-state.ts",
  "extension/src/workflow-state-cap.ts",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/configuration.md",
  ".pi/worktree-setup",
];

/**
 * Named exemptions — files carrying `bunx` deliberately, never scanned.
 * Asserted below: if one of these ever loses its token the exemption is
 * dead config hiding a typo, and the list has drifted from reality.
 */
const EXEMPT_FILES: readonly string[] = [
  "extension/src/bash-command-parser.ts",
  "extension/src/review-accept-guard.ts",
  "extension/src/review-accept-arms.ts",
  ".github/workflows/ci.yml",
  "extension/smoke-tests/fixtures/agents-md/rich-manifest-no-codestyle-agents-md.md",
  "extension/smoke-tests/fixtures/issues/341.json",
  "extension/smoke-tests/fixtures/explore-replies/984.txt",
];

/** Each scanned prose file, with the substring (beyond the constant) that
 * states the checkpoint's command for a human reader. */
type ProseEntry = readonly [path: string, commandMention: string];

/**
 * Each entry: [file, [substring that must appear]]. Substrings are checked
 * RAW (no token substitution) so a site cannot satisfy the gate by naming a
 * constant instead of the command the operator reads.
 *
 * The three src sites spell the command only inside
 * `CHECKPOINT_TYPECHECK_CMD`, so their mention is that constant's name (the
 * executed literal and the exported value are pinned separately, below).
 * The doc sites carry the command itself, so their mention is the command.
 */
const CHECKPOINT_PROSE: readonly ProseEntry[] = [
  // The jsdoc above typecheckWorktree.
  ["extension/src/work-driver-cap-checkpoint.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // The handoff bullet both renderers print.
  ["extension/src/work-driver-caped-state.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // The record type's own doc comment (type-only module — it names the
  // constant by reference rather than spelling the command, so it cannot
  // drift from what the driver runs).
  ["extension/src/workflow-state-cap.ts", "CHECKPOINT_TYPECHECK_CMD"],
  // Operator-facing docs: no constant is in scope, so they spell it out.
  ["AGENTS.md", "bun x tsc --noEmit"],
  ["CONTRIBUTING.md", "bun x tsc --noEmit"],
  ["docs/configuration.md", "bun x tsc --noEmit"],
  [".pi/worktree-setup", "bun x tsc --noEmit"],
];

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

// --------------------------- #1414: the prose list (driver code + operator docs)

/**
 * Failures for one prose file: the bare alias on any line (comments
 * included, same rule as the tiers — a doc that mentions `bunx` in prose is
 * the one a later reader copies), plus the checkpoint-command substrings.
 */
function checkProse(rel: string, text: string): string[] {
  const fails: string[] = [];
  for (const line of text.split("\n")) {
    if (BARE_BUNX.test(line))
      fails.push(
        `${rel} uses bare \`bunx\` — \`bun x\` uses the binary that is always there: ${line.trim().slice(0, 120)}`,
      );
  }
  for (const [file, mention] of CHECKPOINT_PROSE) {
    if (file !== rel) continue;
    if (!text.includes(mention))
      fails.push(
        `${rel} does not name the checkpoint command — expected \`${mention}\` (the checkpoint runs \`${CHECKPOINT_CMD}\`)`,
      );
  }
  return fails;
}

// The scope lists themselves: a dropped entry would report a clean repo over
// files it never read, and a dead exemption hides a typo in a live one.
if (PROSE_FILES.length < 7)
  report([`prose scope [${PROSE_FILES.join(", ")}] must cover the 3 src files + 4 doc sites`]);
for (const [file] of CHECKPOINT_PROSE) {
  if (!PROSE_FILES.includes(file))
    report([`${file} must be in PROSE_FILES — its prose is pinned but not bunx-scanned`]);
}
for (const rel of EXEMPT_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch {
    report([`exempt file ${rel} is NOT readable — the exemption names a path that is gone`]);
    continue;
  }
  if (!BARE_BUNX.test(text))
    report([`exempt file ${rel} no longer carries \`bunx\` — dead exemption; drop it or fix the file`]);
}

for (const rel of PROSE_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : String(err);
    report([`${rel} is NOT readable (${code})`]);
    continue;
  }
  report(checkProse(rel, text));
}

// The executed literal, the exported constant and the prose must be ONE
// string. Reading the source rather than trusting the constant is what makes
// this a drift gate: a rewrite of the call site alone is caught.
{
  const src = readFileSync(
    path.join(REPO_ROOT, "extension/src/work-driver-cap-checkpoint.ts"),
    "utf8",
  );
  if (!src.includes(`CHECKPOINT_TYPECHECK_CMD = "${CHECKPOINT_CMD}"`))
    report([`exported CHECKPOINT_TYPECHECK_CMD is not \`${CHECKPOINT_CMD}\``]);
  if (!src.includes(`run(CHECKPOINT_TYPECHECK_CMD,`))
    report([
      `typecheckWorktree no longer executes CHECKPOINT_TYPECHECK_CMD — the literal may have drifted from the prose`,
    ]);
  // Canaries for THIS half of the gate, in both directions: a planted bad
  // literal is caught, and the fixed form is not.
  const planted = src.replace(`"${CHECKPOINT_CMD}"`, '"bunx tsc --no-emit"');
  if (planted.includes(`CHECKPOINT_TYPECHECK_CMD = "${CHECKPOINT_CMD}"`))
    report(["GATE-BROKEN: a planted bad checkpoint literal was NOT caught"]);
  else console.log("✓ canary planted bad checkpoint literal: caught");
  if (checkProse("extension/src/sentinel.ts", `const c = "${CHECKPOINT_CMD}";`).length !== 0)
    report(["GATE-BROKEN: the fixed checkpoint form was flagged as bad"]);
  else console.log("✓ canary fixed checkpoint form: not flagged");
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
