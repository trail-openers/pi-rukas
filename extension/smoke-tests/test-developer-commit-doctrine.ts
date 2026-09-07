#!/usr/bin/env bun
/**
 * Doctrine canary: the developer is allowed to commit in their worktree
 * (#621 — resolves the three-way contradiction introduced by #453).
 *
 * Pre-#621, `agents-base/developer.md` CRITICAL-tagged `git commit` as
 * denied (system-prompt layer), while the develop dispatch prompt
 * (`work-driver-prompts-early.ts:349`) and the develop-verify gate
 * (`work-driver-verify-develop.ts`) both required committed work ahead of
 * baseSha. The contradiction caused 100% develop-step failure on the
 * Qwen3.8-27B-INT4 runs (7/7 cycles). This canary pins the fix against
 * drift:
 *
 *   (a) the built `developer.md` does NOT contain git-commit-denied
 *       language (`git commit` / `git add` appearing on a line with a
 *       "denied" / "will be denied" / "DO NOT attempt" marker);
 *   (b) the built `developer.md` DOES instruct the developer to commit
 *       in the worktree with explicit `git add` and `git commit`
 *       commands;
 *   (c) `inlineDevelopPrompt` output contains explicit `git add` and
 *       `git commit` commands AND "Do NOT push";
 *   (d) the verify error message does not contain the phantom
 *       "driver-required message format" (the AC3 fix);
 *   (e) `work-driver-cap-checkpoint.ts` source does not contain
 *       "forbidden to commit" (the AC4 fix — the stale header comment
 *       that claimed developers were forbidden to commit).
 *
 * Non-vacuity: if any of the source files being asserted against is
 * missing, the test fails rather than passing vacuously.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Locate the built developer.md — the source of truth for what the
 * developer subagent actually reads at runtime. `bun run build` produces
 * this from `agents-base/developer.md` + the manifest. The build output
 * lives at `dist/prompts/standard/developer.md` relative to the repo root.
 *
 * If the built file doesn't exist yet (fresh clone before build), fall
 * back to the source `agents-base/developer.md` — the canary's purpose
 * is to catch DOCTRINE drift, and the source is what the build reads
 * from. The build step itself is a separate concern (run as part of the
 * pre-push gate).
 */
const BUILT_DEV = path.join(ROOT, "dist", "prompts", "standard", "developer.md");
const SOURCE_DEV = path.join(ROOT, "agents-base", "developer.md");
const DEV_DOC = existsSync(BUILT_DEV) ? BUILT_DEV : SOURCE_DEV;
const DEV_REL = path.relative(ROOT, DEV_DOC);

if (!existsSync(DEV_DOC)) {
  console.error(
    `✗ canary cannot proceed: neither ${DEV_REL} nor agents-base/developer.md exists — run 'bun run build' first`,
  );
  process.exit(1);
}

// Non-vacuity: the source files we assert against must exist.
const EARLY = path.join(ROOT, "extension", "src", "work-driver-prompts-early.ts");
const LATE = path.join(ROOT, "extension", "src", "work-driver-prompts-late.ts");
const VERIFY = path.join(ROOT, "extension", "src", "work-driver-verify-develop.ts");
const CAP_CHECKPOINT = path.join(ROOT, "extension", "src", "work-driver-cap-checkpoint.ts");

for (const [label, p] of [
  ["built/source developer.md", DEV_DOC],
  ["work-driver-prompts-early.ts", EARLY],
  ["work-driver-prompts-late.ts", LATE],
  ["work-driver-verify-develop.ts", VERIFY],
  ["work-driver-cap-checkpoint.ts", CAP_CHECKPOINT],
] as const) {
  assert(existsSync(p), `non-vacuity: ${label} exists at ${p}`);
}

const devDoc = readFileSync(DEV_DOC, "utf8");

// ------------------------------------------------ (a) no commit-denied language

/**
 * A "denied" marker on the same line as `git commit` / `git add` is the
 * shape of the pre-#621 prohibition. `git push` is still denied — those
 * lines are EXPECTED and allowed; only the commit/add forms are not.
 */
const DENIED_MARKERS =
  /will be denied|DO NOT attempt|Do NOT attempt|forbidden to commit|denied by design|structurally denied/i;

const commitDeniedLines = devDoc
  .split("\n")
  .filter((line) => {
    if (!/(git commit|git add)/.test(line)) return false;
    if (DENIED_MARKERS.test(line)) return true;
    // "❌" bullet items also count as a denial marker.
    if (/❌.*git (commit|add)/.test(line)) return true;
    return false;
  });

assert(
  commitDeniedLines.length === 0,
  commitDeniedLines.length === 0
    ? "built developer.md: no git-commit-denied language (commit/add lines with denial markers)"
    : `built developer.md: ${commitDeniedLines.length} git-commit-denied line(s) found: ${commitDeniedLines
        .map((l) => l.trim().slice(0, 100))
        .join(" | ")}`,
);

// `git push` denial is EXPECTED and must still be present (the prohibition
// only lifts for commit/add, not push).
const pushDeniedLines = devDoc.split("\n").filter((line) => {
  if (!/git push/.test(line)) return false;
  return /denied|DO NOT|Do not|❌|@ops/.test(line);
});
assert(
  pushDeniedLines.length > 0,
  "built developer.md: git push denial is still present (the prohibition only lifts for commit/add, not push)",
);

// ------------------------------------------------ (b) explicit commit instructions

// The built developer.md must instruct the developer to commit in the
// worktree with explicit git commands. This is the positive counterpart
// to (a): removing the denial isn't enough — the developer needs to know
// to commit (smaller models under long context drift off the instruction
// if it's only implied).
assert(
  devDoc.includes("git add -A") && /git commit/.test(devDoc),
  "built developer.md: instructs the developer to commit (explicit `git add -A` + `git commit` commands present)",
);
assert(
  /worktree/i.test(devDoc) && /commit.*worktree|worktree.*commit/i.test(devDoc),
  "built developer.md: commit instruction is scoped to the worktree (not a blanket instruction)",
);

// ------------------------------------------------ (c) inlineDevelopPrompt explicit commands

const ws = {
  id: "default",
  scope: "Add the retry ceiling check to the startup path",
  paths: ["extension/src/retry-config-check.ts"],
  outOfScope: ["extension/src/spawn.ts"],
};

const developPrompt = inlineDevelopPrompt([621], "/tmp/scratch", ws, undefined, undefined, undefined);
assert(
  developPrompt.includes("git add -A"),
  "inlineDevelopPrompt: contains explicit `git add -A` command (AC2)",
);
assert(
  /git commit -m/.test(developPrompt),
  "inlineDevelopPrompt: contains explicit `git commit -m` command (AC2)",
);
assert(
  /Do NOT push/i.test(developPrompt),
  "inlineDevelopPrompt: still contains 'Do NOT push' (push is still @ops's job)",
);
assert(
  /REJECT|reject/i.test(developPrompt) && /uncommitted/i.test(developPrompt),
  "inlineDevelopPrompt: states uncommitted-only work WILL BE REJECTED by the verify gate (AC2)",
);

// ------------------------------------------------ (d) verify error message

const verifySrc = readFileSync(VERIFY, "utf8");
assert(
  !verifySrc.includes("driver-required message format"),
  "work-driver-verify-develop.ts: no longer references the phantom 'driver-required message format' (AC3)",
);
assert(
  verifySrc.includes("git add -A && git commit"),
  "work-driver-verify-develop.ts: error message is actionable — names the exact `git add -A && git commit` fix (AC3)",
);

// ------------------------------------------------ (e) cap-checkpoint.ts stale comment

const capSrc = readFileSync(CAP_CHECKPOINT, "utf8");
assert(
  !capSrc.includes("forbidden to commit"),
  "work-driver-cap-checkpoint.ts: stale 'forbidden to commit' header comment is removed (AC4)",
);
assert(
  !capSrc.includes("Do NOT"),
  "work-driver-cap-checkpoint.ts: no 'Do NOT commit' language remains in the header comment",
);

// ------------------------------------------------ late prompts: AC5

const lateSrc = readFileSync(LATE, "utf8");
assert(
  !lateSrc.includes("left changes UNCOMMITTED per Step 4 doctrine"),
  "work-driver-prompts-late.ts: stale 'left changes UNCOMMITTED per Step 4 doctrine' is removed (AC5)",
);
assert(
  !lateSrc.includes("Verify each worktree has uncommitted work"),
  "work-driver-prompts-late.ts: stale 'Verify each worktree has uncommitted work' is removed (AC5)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
