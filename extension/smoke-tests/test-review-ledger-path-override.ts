#!/usr/bin/env bun
/**
 * #955 — the PI_ENSEMBLE_REVIEW_LEDGER_FILE override for `ledgerPathFor`.
 *
 * The override is what lets the merge-guard decision-matrix tests point the
 * ledger at a private temp file instead of the real per-clone ledger under
 * the git common dir (which concurrent test runs across worktrees would race
 * on and clobber). This pins the override's contract:
 *
 *   - when the env is set (an absolute path), `ledgerPathFor` returns it
 *     verbatim and makes NO git exec calls (the short-circuit).
 *   - when the env is unset, the existing git-based behaviour is preserved
 *     (the git exec IS made).
 */

import path from "node:path";
import { ledgerPathFor } from "../src/review-ledger.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CWD = import.meta.dirname;
const OVERRIDE = path.join("/tmp", "pi-ledger-override", "review-ledger.json");
const prevOverride = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;

// ---------------------------------------------------------------- override set
{
  const calls: string[] = [];
  const execFn = async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "/some/git/common/dir\n" };
  };
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = OVERRIDE;
  try {
    const p = await ledgerPathFor(execFn, CWD);
    assert(p === OVERRIDE, "override set → ledgerPathFor returns the env value verbatim");
    assert(calls.length === 0, "override set → no git exec calls are made (short-circuit)");
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

// --------------------------------------------------------------- override unset
{
  // Ensure the env is unset for this case regardless of the prior state.
  if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  if (process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE !== undefined) {
    delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  }
  const calls: string[] = [];
  const execFn = async (cmd: string) => {
    calls.push(cmd);
    return { stdout: "/some/git/common/dir\n" };
  };
  try {
    const p = await ledgerPathFor(execFn, CWD);
    assert(
      p === path.join("/some/git/common/dir", "review-ledger.json"),
      "unset → git-based behaviour preserved",
    );
    assert(
      calls.length === 1 && calls[0] === "git rev-parse --git-common-dir",
      "unset → the git rev-parse exec is made",
    );
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = prevOverride;
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
