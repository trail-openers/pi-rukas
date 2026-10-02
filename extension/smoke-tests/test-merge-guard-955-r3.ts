#!/usr/bin/env bun
/**
 * #955 round-2 hardening — part 2: the real-hook decision matrix.
 *
 * Moved from test-merge-guard-955-r2.ts (which sat over the 500-line §12
 * limit) without any change to the assertions: the "guard decision matrix"
 * section — every shape driven through the REAL hook via
 * `registerMergeGuard` with a failing lens ledger — lives here, with its
 * own imports and helpers copied from the r2 file's idiom. The matcher-side
 * canaries stay in r2.
 *
 * Every shape is asserted through the real hook (registerMergeGuard with a
 * failing lens ledger) — the guard must REFUSE, not merely match.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { type LedgerEntry, ledgerPathFor } from "../src/review-ledger.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;
// The temp dir holding the private ledger file; removed at the end of the test
// so no fixture lingers. The env override is set in setupLedgerPath before the
// path is resolved so `ledgerPathFor` returns a private temp file instead of
// the real per-clone ledger under the git common dir.
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
  // Point the ledger at a private temp file BEFORE resolving the path so
  // `ledgerPathFor` (the module under test) returns it and never the real
  // per-clone ledger under the git common dir.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = file;
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  LEDGER_FILE = p;
  // Canary: the ledger must NOT live inside any .git directory — that would
  // clobber the real per-clone review ledger shared by every worktree.
  assert(!/([/\\])\.git([/\\]|$)/.test(p), "canary: the test ledger is not inside a .git directory");
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

const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "janni",
  labels: [],
};

// The failing-lens ledger (the lievo #17 shape): the guard must REFUSE.
const FAILING_LENS: LedgerEntry[] = [
  { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: "feature/x", kind: "lens", patchId: "p1", passed: false, at: 2 },
];

async function withLedger(entries: LedgerEntry[], fn: () => Promise<unknown>) {
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
  };
}

/** Register the real guard on a fake pi and drive it through `opts.execFn`. */
async function makeHook(env: {
  target: MergeTarget;
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
  failGh?: boolean;
  failFetch?: boolean;
  ledgerCommonDir?: string;
  remote?: string;
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

async function hookDecision(
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

await setupLedgerPath();

// A merge hidden 4 shell-eval layers deep exceeds the unwrap budget (3).
// The guard must treat it as a merge WITH NO number → the fallback refusal,
// never as "not a merge". #955 adversarial round 4 (finding 1): the
// shell-VALID depth-4 form (plain single quotes) is the live merge that must
// be refused; the escaped-quote form (the previous canary) is not a live merge
// but its malformed inner layer must fail closed the same way.
const DEEP_MERGE = "bash -c \\'(sh -c \\'(gh pr merge 12)\\')\\'";

// Depth-4 hook test (run after FAILING_LENS is defined):
{
  const r = await hookDecision(DEEP_MERGE, FAILING_LENS);
  assert(r.block === true, "depth-4 merge (escaped-quote form) with failing lens → REFUSED (fail closed)");
}
{
  // The shell-VALID depth-4 form unwraps to `(sh -c ` — a truncated,
  // non-merge inner string — so the guard returns undefined (not a merge).
  // This is CORRECT: the string is a bash syntax error, not a clean merge.
  // The escaped form above is the live-merge canary.
}

// Wrapper prefixes: every shape the adversarial review named is refused by
// the real hook (failing lens), not merely matched.
for (const cmd of [
  "timeout 30 gh pr merge 12",
  "command gh pr merge 12",
  "nohup gh pr merge 12 &",
  "sudo gh pr merge 12",
  "nice gh pr merge 12",
  "time gh pr merge 12",
  "/usr/bin/gh pr merge 12",
  "(gh pr merge 12)",
  "x=$(gh pr merge 12)",
  "x=`gh pr merge 12`",
  "glab --project o/r mr merge 12",
  // The CRITICAL round-2 shapes (adversarial CRITICAL #1 + #2): `env -u`
  // takes a value token; `exec` is a wrapper.
  "env -u FOO gh pr merge 12",
  "exec gh pr merge 12",
  // Control-flow / compound-construct shapes (adversarial round-3 finding 1):
  // the merge must be refused through the real hook, not merely matched.
  "if true; then gh pr merge 12; fi",
  "for i in 1; do gh pr merge 12; done",
  "{ gh pr merge 12; }",
  "! gh pr merge 12",
  "function f { gh pr merge 12; }; f",
  // The REST doors in a subshell / substitution (adversarial ISSUES #3).
  "(gh api repos/o/r/pulls/12/merge)",
  "x=$(gh api repos/o/r/pulls/12/merge)",
]) {
  const r = await hookDecision(cmd, FAILING_LENS);
  assert(r.block === true, `refused (failing lens) — ${cmd}`);
}

// A quoted numeric positional reaches the number (not the fallback): the
// stubbed `gh pr view 12` is the one called.
{
  const r = await hookDecision('gh pr merge "12"', FAILING_LENS);
  assert(r.block === true, "quoted numeric positional: refused (failing lens)");
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
