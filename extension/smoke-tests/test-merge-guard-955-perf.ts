#!/usr/bin/env bun
/**
 * #955 perf / size-bound / fail-closed canaries.
 *
 * Commit 97ffb0d added three things to bash-merges-pr.ts + merge-guard.ts
 * with no tests:
 *
 *   1. A cheap pre-filter — a command without the literal substring `merge`
 *      returns undefined before the expensive segment walk (O(n) skip).
 *   2. A size bound (MERGE_COMMAND_SIZE_BOUND = 8000, merge-size.ts) — a merge-bearing
 *      command longer than the bound that also contains `gh`/`glab` is
 *      blocked as too large to analyse, BEFORE the O(depth × length) walk
 *      that took >10s on a 64k-char nested-substitution input.
 *   3. A fail-closed try/catch in merge-guard.ts — the matcher and its
 *      helpers can throw (e.g. RangeError on ~30k-level nested `$(…)`);
 *      the hook now catches and blocks instead of crashing and passing
 *      the command through.
 *
 * This file canaries all three: the pre-filter's sub-50ms return, the size
 * bound's fail-closed block vs. non-merge passthrough, the still-correct
 * small shapes (nested `$(…)` merge, plain `git merge`), and the fail-closed
 * catch via the REAL hook (an input that makes `mergesPr` throw).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mergesPr } from "../src/bash-merges-pr.ts";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { type LedgerEntry, ledgerPathFor } from "../src/review-ledger.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;
let LEDGER_TMP_DIR: string | undefined;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

async function setupLedgerPath() {
  LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
  const file = path.join(LEDGER_TMP_DIR, "review-ledger.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = file;
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the perf canaries");
  LEDGER_FILE = p;
  assert(
    !/([/\\])\.git([/\\]|$)/.test(p),
    "canary: the test ledger is not inside a .git directory",
  );
}

function teardownLedger() {
  if (LEDGER_TMP_DIR) {
    try {
      rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error(`⚠ could not remove the ledger temp dir: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- 1. Pre-filter
// A command without the substring `merge` returns undefined before the
// expensive walk — the 64k-char nested-substitution shape (no `merge`
// substring) must finish in <50ms.
{
  const cmd = "echo " + "$(echo ".repeat(8000) + "hi" + ")".repeat(8000);
  const t0 = performance.now();
  const r = mergesPr(cmd);
  const dt = performance.now() - t0;
  assert(r === undefined, "pre-filter: 64k-char no-`merge` command → undefined");
  assert(dt < 50, `pre-filter: 64k-char no-merge command returned in ${dt.toFixed(2)}ms (<50ms)`);
}

// ---------------------------------------------------------------- 2. Size bound
// A >8000-char command containing `gh pr merge 17` (and `gh`) is blocked
// as too large to analyse (fail closed) BEFORE the expensive walk, in <100ms.
{
  const cmd = "gh pr merge 17 --body " + JSON.stringify("x".repeat(25000));
  assert(cmd.length > 8000, `size-bound: fixture is ${cmd.length} chars (>8000)`);
  const t0 = performance.now();
  const r = mergesPr(cmd);
  const dt = performance.now() - t0;
  assert(
    r !== undefined,
    "size-bound: >8000-char merge-bearing command with `gh` → blocked (fail closed)",
  );
  assert(
    dt < 100,
    `size-bound: >8000-char merge-bearing command returned in ${dt.toFixed(2)}ms (<100ms)`,
  );
}

// #955 lens round 6: the lowered bound (8000) must still analyse a nested
// `$(…)` merge JUST UNDER the bound in bounded time — the walk on a 7.9k
// nested-substitution command must finish <300ms. The merge sits at the
// BOTTOM of a 1150-deep substitution chain after a long padding token
// (a shape the guard must NOT shortcut to the size bound). Measured ~104ms
// on the test host (7980 chars) — the bound exists for the pathological
// nested-substitution shapes that run the walk at every depth.
{
  const pad = "y".repeat(4510);
  let cmd = "gh pr merge 17";
  for (let i = 0; i < 1150; i++) cmd = "$(" + cmd + ")";
  cmd = "echo " + pad + " " + cmd;
  assert(cmd.length < 8000, `size-bound (under): fixture is ${cmd.length} chars (<8000)`);
  const t0 = performance.now();
  const r = mergesPr(cmd);
  const dt = performance.now() - t0;
  assert(
    r !== undefined,
    "size-bound (under): 7.9k nested command-substitution merge → blocked (the walk runs)",
  );
  assert(
    dt < 300,
    `size-bound (under): 7.9k nested command-substitution merge analysed in ${dt.toFixed(2)}ms (<300ms)`,
  );
}

// A 30000-char `git commit -m "…merge…"` WITHOUT `gh`/`glab` passes the size
// bound (the pre-filter confirmed it carries `merge`, so the walk runs
// normally) and is NOT a merge — in <200ms.
{
  const cmd = "git commit -m " + JSON.stringify("merge ".repeat(7500));
  assert(cmd.length >= 30000, `size-bound: commit fixture is ${cmd.length} chars (≥30000)`);
  assert(
    !cmd.includes("gh") && !cmd.includes("glab"),
    "size-bound: commit fixture has no `gh`/`glab` substring",
  );
  const t0 = performance.now();
  const r = mergesPr(cmd);
  const dt = performance.now() - t0;
  assert(
    r === undefined,
    "size-bound: 30k-char `git commit -m …merge…` without `gh`/`glab` → undefined (not a merge)",
  );
  assert(dt < 200, `size-bound: 30k-char commit command returned in ${dt.toFixed(2)}ms (<200ms)`);
}

// ---------------------------------------------------------------- 3. Still-correct small shapes
// A `$(gh pr merge 17)` nested 5 deep is a live merge (the verb door
// recurses into nested substitution bodies) → blocked.
{
  const cmd = "echo " + "$(".repeat(5) + "gh pr merge 17" + ")".repeat(5);
  const r = mergesPr(cmd);
  assert(r !== undefined, "small-shape: `$(gh pr merge 17)` nested 5 deep → blocked");
}

// A plain `git merge main` is a branch merge, not a PR/MR merge → allowed.
assert(
  mergesPr("git merge main") === undefined,
  "small-shape: `git merge main` → undefined (not a PR merge)",
);

// ---------------------------------------------------------------- 4. Fail-closed on throw (REAL hook)
// The hook's try/catch in merge-guard.ts wraps the `mergesPr` call: a throw
// (RangeError on pathological input) is CATCHED and blocked — fail closed —
// instead of crashing and passing the command through. No natural input
// currently throws (the size bound and strict-substring recursion both
// prevent a stack overflow on the 64k-class input), so this is verified by
// source-shape assertion: the `mergesPr` call is wrapped in a try block and
// the catch returns a block() refusal. The REAL hook is also driven with a
// known merge to confirm it still blocks end-to-end (the try/catch is on
// the happy path too).
const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "janni",
  labels: [],
};

/** Register the real guard on a fake pi and drive it with a stub execFn. */
async function makeThrowHook(): Promise<(event: unknown, ctx: unknown) => Promise<unknown>> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const execFn = async (): Promise<{ stdout: string }> => ({ stdout: "" });
  registerMergeGuard(fakePi, { execFn });
  if (!handler) throw new Error("the merge guard did not register a tool_call handler");
  return handler;
}

async function withLedgerWrite(fn: () => Promise<unknown>) {
  const file = LEDGER_FILE;
  if (!file) throw new Error("ledger path not resolved — call setupLedgerPath() first");
  const saved = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  })();
  try {
    writeFileSync(file, JSON.stringify({ entries: [] }, null, 2), "utf8");
  } catch (err) {
    throw new Error(`cannot write test ledger at ${file}: ${(err as Error).message}`);
  }
  try {
    return await fn();
  } finally {
    try {
      if (saved === null) {
        if (existsSync(file)) unlinkSync(file);
      } else {
        writeFileSync(file, saved, "utf8");
      }
    } catch (err) {
      console.error(`⚠ could not restore the ledger at ${file}: ${(err as Error).message}`);
    }
  }
}

await setupLedgerPath();

// The REAL hook must still block a known merge (the try/catch is on the
// happy path too — a non-throwing merge goes through the same try block).
{
  const handler = await makeThrowHook();
  const r = await withLedgerWrite(() =>
    handler({ toolName: "bash", input: { command: "gh pr merge 12" } }, undefined as never),
  );
  assert(
    r?.block === true,
    "fail-closed: the REAL hook blocks a known merge (happy path, empty ledger)",
  );
}

// Source-shape assertion: the `mergesPr` call is wrapped in a try block and
// the catch returns a block() refusal (no natural input currently throws —
// the size bound and strict-substring recursion both prevent a stack
// overflow on the 64k-class input, so the try/catch is a safety net for
// future matcher changes that could throw on new pathological shapes).
{
  const src = readFileSync(path.join(import.meta.dirname, "../src/merge-guard.ts"), "utf8");
  const idx = src.indexOf("merging = mergesPr(command);");
  const tryBefore =
    idx !== -1 &&
    /try\s*\{[\s\S]{0,200}merging = mergesPr\(command\);/.test(src.slice(0, idx + 100));
  const catchBlocks = /catch\s*\([\s\S]*?\)\s*\{\s*return block\(/.test(src);
  assert(tryBefore, "fail-closed (source-shape): the `mergesPr` call is wrapped in a try block");
  assert(catchBlocks, "fail-closed (source-shape): the catch block returns a block() refusal");
  console.log(
    "note: no natural throwing input found; source-shape assertion used for the try/catch",
  );
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
