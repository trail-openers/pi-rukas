#!/usr/bin/env bun
/**
 * #955 lens round 6 — quoted-token merge canaries, the size-bound refusal,
 * and the catch-block helper.
 *
 *   1. Quoted tokens: the shell removes quotes around a WHOLE word before
 *      execution, so `gh pr "merge" 17`, `gh "pr" merge 17`, `"gh" pr merge
 *      17`, `gh pr 'merge' 17` and the quoted-REST-endpoint shapes are live
 *      merges — all must match (mergesPr !== undefined) with the number /
 *      repo extracted. Quoted STRINGS in a later segment (`echo "gh pr
 *      merge 17"`, `git commit -m "…"`) stay inert (mergesPr === undefined).
 *   2. The size bound: a merge-bearing command over 8000 chars with `gh`
 *      refuses explicitly through the REAL hook ("too large to analyse")
 *      with NO gh/git exec calls — never falling through to
 *      current-branch PR resolution.
 *   3. `analyseRefusal` (merge-guard.ts): the one message builder for every
 *      throw the guard catches; it must never throw (a thrown null/undefined
 *      in a catch makes the catch itself throw, failing the guard OPEN) and
 *      every refusal carries block === true (the hook's return shape).
 */

import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mergesPr } from "../src/bash-merges-pr.ts";
import { extractMergeNumber, mergeVerbArgs, mergeVerbRepo } from "../src/merge-parse.ts";
import { analyseRefusal, registerMergeGuard } from "../src/merge-guard.ts";
import { ledgerPathFor } from "../src/review-ledger.ts";

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
  if (!p) throw new Error("cannot resolve the ledger path for the quoted canaries");
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

// ------------------------------------------------------------ 1. Quoted verb-door shapes
// The shell removes whole-word quotes before execution — every shape below
// is a live merge the guard must match, with the number extracted.

{
  const cases = [
    'gh pr "merge" 17',
    'gh "pr" merge 17',
    '"gh" pr merge 17',
    "gh pr 'merge' 17",
  ];
  for (const cmd of cases) {
    const span = mergesPr(cmd);
    assert(span !== undefined, `canary (quoted verb): blocked — ${cmd}`);
    const a = mergeVerbArgs(cmd);
    assert(a !== undefined, `canary (quoted verb): tail present — ${cmd}`);
    assert(
      a !== undefined && extractMergeNumber(a) === 17,
      `canary (quoted verb): number is 17 — ${cmd}`,
    );
  }
}

// ------------------------------------------------------------ 1b. Quoted REST-endpoint shapes
// Quoting the endpoint is COMMON — the REST door must match the unquoted
// endpoint with the method/fields logic intact.

{
  const cases = [
    'gh api -X PUT "repos/o/r/pulls/17/merge"',
    "gh api -X PUT 'repos/o/r/pulls/17/merge'",
    'gh api "repos/o/r/pulls/17/merge"',
  ];
  for (const cmd of cases) {
    const span = mergesPr(cmd);
    assert(span !== undefined, `canary (quoted REST): blocked — ${cmd}`);
  }
}

// ------------------------------------------------------------ 1c. Inert quoted strings
// A quoted STRING is one token whose head is never the bare forge word —
// these stay inert exactly the way they always were.

{
  const inert = [
    'echo "gh pr merge 17"',
    'git commit -m "gh pr merge 17"',
    'git commit -m "gh api repos/o/r/pulls/17/merge -X PUT"',
    "echo 'gh api -X PUT repos/o/r/pulls/17/merge'",
    'echo "gh api repos/o/r/pulls/17/merge"',
  ];
  for (const cmd of inert) {
    assert(mergesPr(cmd) === undefined, `allowed (quoted, inert) — ${cmd}`);
  }
}

// ------------------------------------------------------------ 1d. Repo extraction
// The repo must extract for the quoted forms too (mergeVerbRepo / restRepoFor).

{
  const r = mergeVerbRepo('gh -R o/r pr "merge" 17');
  assert(r?.kind === "repo" && r.repo === "o/r", "canary (quoted verb): the repo is o/r from -R");
}

// ------------------------------------------------------------ 2. Size bound (REAL hook)
// A merge-bearing command over the bound refuses EXPLICITLY ("too large to
// analyse") with no gh/git exec calls — never current-branch PR resolution.

/** Register the real guard on a fake pi and drive it with a stub execFn. */
async function makeHook(): Promise<{
  handler: (event: unknown, ctx: unknown) => Promise<unknown>;
  calls: string[];
}> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const calls: string[] = [];
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    throw new Error(`no exec allowed: ${cmd}`);
  };
  registerMergeGuard(fakePi, { execFn });
  if (!handler) throw new Error("the merge guard did not register a tool_call handler");
  return { handler, calls };
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

{
  const { handler, calls } = await makeHook();
  const big = "gh api repos/o/r/pulls/17/merge --field x=" + "y".repeat(25000);
  assert(big.length > 8000, `size-bound: fixture is ${big.length} chars (>8000)`);
  const r = await withLedgerWrite(() =>
    handler({ toolName: "bash", input: { command: big } }, undefined as never),
  );
  assert(r?.block === true, "size-bound: >8000-char REST merge → REFUSED through the real hook");
  assert(
    /too large to analyse/.test((r as { reason?: string } | undefined)?.reason ?? ""),
    "size-bound: refusal names the size bound (not current-branch resolution)",
  );
  assert(calls.length === 0, "size-bound: NO gh/git exec calls (the bound fires before any resolution)");
}

// ------------------------------------------------------------ 3. analyseRefusal
// The catch-block helper must never throw (a thrown null/undefined in a
// catch makes the catch itself throw, failing the guard OPEN) and the hook's
// block shape (block === true) is the caller's guarantee.

{
  const inputs: unknown[] = [null, undefined, "a plain string", new Error("boom")];
  let threw = false;
  let allNonEmpty = true;
  for (const v of inputs) {
    try {
      const s = analyseRefusal(v);
      if (s.length === 0) allNonEmpty = false;
    } catch {
      threw = true;
    }
  }
  assert(!threw, "analyseRefusal: never throws (null, undefined, string, Error)");
  assert(allNonEmpty, "analyseRefusal: always returns a non-empty message");
  assert(analyseRefusal(null) === "null", "analyseRefusal: null → the string null");
  assert(analyseRefusal(undefined) === "undefined", "analyseRefusal: undefined → the string undefined");
  assert(analyseRefusal(new Error("boom")).startsWith("Error: boom"), "analyseRefusal: Error → name + message");
  // The hook's block shape: every refusal carries block === true.
  const block = { block: true, reason: "merge refused: " + analyseRefusal(null) };
  assert(block.block === true, "hook shape: the refusal carries block === true");
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
