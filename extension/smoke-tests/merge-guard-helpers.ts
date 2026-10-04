#!/usr/bin/env bun
/**
 * Shared helpers for the merge-guard decision-matrix tests (test-merge-guard.ts
 * and test-merge-guard-round-cap.ts). Both files drive the REAL registerMergeGuard
 * hook through `opts.execFn`; this module holds the common ledger setup,
 * the fake-pi hook factory, and the `hookDecision` runner so the two files
 * share one implementation (the 500-line gate: the round-cap matrix is a
 * sibling file, and the shared harness lives here rather than being
 * duplicated).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { type LedgerEntry, ledgerPathFor, latestEntry } from "../src/review-ledger.ts";
import { adversarialPassed, lensPassed } from "../src/review-ledger.ts";

// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the decision matrix runs offline, without a real remote.
process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;
let LEDGER_TMP_DIR: string | undefined;

export async function setupLedgerPath() {
  LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(LEDGER_TMP_DIR, "review-ledger.json");
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  LEDGER_FILE = p;
}

export function teardownLedger() {
  if (LEDGER_TMP_DIR) {
    try {
      rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error(`⚠ could not remove the ledger temp dir: ${(err as Error).message}`);
    }
  }
}

export let exit = 0;
export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

export { ledgerPathFor, latestEntry, adversarialPassed, lensPassed };
export type { LedgerEntry, MergeTarget };

export const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "janni",
  labels: [],
};

export const GOOD_ENTRIES: LedgerEntry[] = [
  { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
];

/** Save/restore the shared ledger around a row so the matrix is side-effect-free. */
export async function withLedger(entries: LedgerEntry[], fn: () => Promise<unknown>) {
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
    writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
  } catch (err) {
    throw new Error(`cannot write test ledger at ${file}: ${(err as Error).message}`);
  }
  const done = () => {
    try {
      if (saved === null) {
        if (existsSync(file)) unlinkSync(file);
      } else {
        writeFileSync(file, saved, "utf8");
      }
    } catch (err) {
      console.error(`⚠ could not restore the ledger at ${file}: ${(err as Error).message}`);
    }
  };
  try {
    return await fn();
  } finally {
    done();
  }
}

/** Register the real guard on a fake pi and drive it through `opts.execFn`. */
export async function makeHook(env: {
  target: MergeTarget;
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
  failFetch?: boolean;
  failGh?: boolean;
  ledgerCommonDir?: string;
  remote?: string;
  ghComments?: string;
}): Promise<(event: unknown, ctx: unknown) => Promise<unknown>> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const t = env.target;
  const ghView = {
    stdout: JSON.stringify({
      headRefName: t.headBranch,
      headRefOid: t.headOid,
      baseRefName: t.baseBranch,
      author: { login: t.author },
      labels: t.labels.map((n) => ({ name: n })),
    }),
  };
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    env.calls.push(cmd);
    if (cmd.includes("gh pr view")) {
      if (cmd.includes("--json number")) {
        return { stdout: JSON.stringify({ number: t.prNumber }) };
      }
      if (env.failGh) throw new Error("gh: not found");
      if (cmd.includes("--json comments")) {
        if (env.ghComments === undefined) {
          throw new Error("gh: comments not stubbed");
        }
        return { stdout: env.ghComments };
      }
      return ghView;
    }
    if (cmd.includes("git fetch")) {
      if (env.failFetch) throw new Error("unable to connect");
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      if (env.remote === "origin") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.upstream.url")) {
      if (env.remote === "upstream") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.")) {
      return { stdout: "" };
    }
    if (cmd.includes("git remote")) {
      return { stdout: env.remote + "\n" };
    }
    if (cmd.includes(`rev-parse ${env.remote}/`)) return { stdout: env.fetchedHead };
    if (cmd.includes("patch-id")) return { stdout: `${env.currentPatchId} 0000` };
    if (cmd.includes("git-common-dir")) {
      return { stdout: env.ledgerCommonDir ?? "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  };
  registerMergeGuard(fakePi, { execFn });
  if (!handler) throw new Error("the merge guard did not register a tool_call handler");
  return handler;
}

export async function hookDecision(
  command: string,
  entries: LedgerEntry[],
  opts: {
    target?: MergeTarget;
    patchId?: string;
    fetchedHead?: string;
    failGh?: boolean;
    failFetch?: boolean;
    ledgerCommonDir?: string;
    remote?: string;
    ghComments?: string;
  } = {},
) {
  const env = {
    target: opts.target ?? TARGET,
    currentPatchId: opts.patchId ?? "p1",
    fetchedHead: opts.fetchedHead ?? "abc123",
    failGh: opts.failGh,
    failFetch: opts.failFetch,
    ledgerCommonDir: opts.ledgerCommonDir ?? (LEDGER_FILE ? path.dirname(LEDGER_FILE) : ""),
    calls: [] as string[],
    remote: opts.remote ?? "origin",
    ghComments: opts.ghComments,
  };
  const handler = await makeHook(env);
  const r = await withLedger(entries, () =>
    handler({ toolName: "bash", input: { command } }, undefined as never),
  );
  return {
    block: r?.block === true,
    reason: (r as { reason?: string } | undefined)?.reason,
    calls: env.calls,
  };
}
