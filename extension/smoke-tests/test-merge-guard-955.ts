#!/usr/bin/env bun
/**
 * #955 — the merge guard's PR-number extraction and subshell unwrapping.
 *
 * Extends test-merge-guard.ts's matcher table and decision matrix with the
 * defect-fix cases: post-verb number extraction, -R/--repo passthrough,
 * subshell (bash -c / sh -c / eval / env) unwrapping, and the full
 * hook-decision path for the incident's exact bypass shape.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";
import { extractMergeNumber, extractMergeRepo, mergeVerbArgs } from "../src/merge-parse.ts";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { type LedgerEntry, ledgerPathFor } from "../src/review-ledger.ts";

// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the decision matrix below runs offline, without a real remote.
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

// ------------------------------------------------------------ PR-number extraction
// The number comes from the arguments AFTER the matched verb, with a
// quote-aware tokenizer that skips flag values.

{
  const a = mergeVerbArgs("gh pr merge 17 --squash");
  assert(a !== undefined, "gh pr merge 17 … matches the verb door");
  assert(extractMergeNumber(a ?? "") === 17, "gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs('oo gh pr merge 17 --squash --subject "x 12" --body "y"');
  assert(a !== undefined, "oo gh pr merge 17 --squash --subject … matches");
  assert(
    extractMergeNumber(a ?? "") === 17,
    "the number is 17, not the 12 inside the --subject flag value",
  );
}
{
  const a = mergeVerbArgs("gh pr merge https://github.com/o/r/pull/17");
  assert(a !== undefined, "gh pr merge <PR URL> matches");
  assert(extractMergeNumber(a ?? "") === 17, "the number is 17 from the URL");
  assert(extractMergeRepo(a ?? "") === "o/r", "the repo is o/r from the URL");
}
{
  const a = mergeVerbArgs("gh pr merge --squash");
  assert(a !== undefined, "gh pr merge --squash matches (no number)");
  assert(extractMergeNumber(a ?? "") === undefined, "no number → fallback");
}
{
  const a = mergeVerbArgs("gh -R o/r pr merge 17");
  // -R before the verb: the verb still matches (scan-not-anchor), the number
  // is in the post-verb tail.
  assert(a !== undefined, "gh -R o/r pr merge 17 matches the verb door");
  assert(extractMergeNumber(a ?? "") === 17, "the number is 17 (not from -R value)");
  // The repo from -R: mergeVerbRepo checks the post-verb tail first, then
  // the pre-verb -R flag.
  const { mergeVerbRepo } = await import("../src/merge-parse.ts");
  assert(
    mergeVerbRepo("gh -R o/r pr merge 17")?.kind === "repo" && mergeVerbRepo("gh -R o/r pr merge 17")?.repo === "o/r",
    "the repo is o/r from the -R flag (pre-verb)",
  );
}
{
  const a = mergeVerbArgs("cd /data/3 && gh pr merge");
  assert(a !== undefined, "cd /data/3 && gh pr merge still matches (no number)");
  assert(extractMergeNumber(a ?? "") === undefined, "the /data/3 digit is NOT picked up");
}

// ------------------------------------------------------------ subshell matcher
// The verb door must recognise merges inside subshells.

for (const cmd of [
  "bash -c 'export X=1; gh pr merge 17 --squash'",
  'sh -c "gh pr merge 17"',
  'bash -lc "cd x && gh pr merge 17"',
  'eval "gh pr merge 17"',
  "env FOO=1 bash -c 'gh pr merge 17'",
  "bash -c 'glab mr merge 7'",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (subshell): blocked — ${cmd}`);
}

for (const cmd of ["bash -c 'echo hi'", "bash -c 'gh pr view 17'", "bash -c 'echo \"pr merge\"'"]) {
  assert(mergesPr(cmd) === undefined, `allowed (subshell non-merge) — ${cmd}`);
}

// ------------------------------------------------------------ subshell number extraction
{
  const a = mergeVerbArgs("bash -c 'export X=1; gh pr merge 17 --squash'");
  assert(a !== undefined, "subshell: verb door matches the inner command");
  assert(extractMergeNumber(a ?? "") === 17, "subshell: the number is 17");
}
{
  const a = mergeVerbArgs('sh -c "gh pr merge 17"');
  assert(extractMergeNumber(a ?? "") === 17, "sh -c: the number is 17");
}
{
  const a = mergeVerbArgs('bash -lc "cd x && gh pr merge 17"');
  assert(
    extractMergeNumber(a ?? "") === 17,
    "bash -lc: the number is 17 (cd x does not interfere)",
  );
}
{
  const a = mergeVerbArgs('eval "gh pr merge 17"');
  assert(extractMergeNumber(a ?? "") === 17, "eval: the number is 17");
}
{
  const a = mergeVerbArgs("env FOO=1 bash -c 'gh pr merge 17'");
  assert(extractMergeNumber(a ?? "") === 17, "env FOO=1 bash -c: the number is 17");
}
{
  const a = mergeVerbArgs("bash -c 'glab mr merge 7'");
  assert(extractMergeNumber(a ?? "") === 7, "bash -c glab mr merge: the number is 7");
}

// ------------------------------------------------------------ guard decision matrix
// Driven through the REAL hook via `opts.execFn`.

/** Save/restore the shared ledger around a row so the matrix is side-effect-free. */
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
  }
}

/** Register the real guard on a fake pi and drive it through `opts.execFn`. */
async function makeHook(env: {
  target: MergeTarget;
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
  failFetch?: boolean;
  failGh?: boolean;
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
    // #985 — branchPatchId resolves the merge-base first (three-dot
    // semantics); the mock returns a fixed SHA so the patch-id diff runs.
    if (cmd.includes("git merge-base")) return { stdout: "mb00000000000000000000000000000000000000\n" };
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

const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "janni",
  labels: [],
};

const GOOD_ENTRIES: LedgerEntry[] = [
  { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
];

await setupLedgerPath();

// The incident's exact bypass shape: a subshell merge with a failing lens entry.
{
  // Latest lens entry is passed: false (the lievo #17 shape).
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: false, at: 2 },
  ];
  const r = await hookDecision("bash -c 'export X=1; gh pr merge 12 --squash'", entries);
  assert(r.block === true, "subshell merge with failing lens → REFUSED");
  assert(/no passing lens/.test(r.reason ?? ""), "…naming the missing lens review");
}
{
  // The env-prefixed form is also refused.
  const entries: LedgerEntry[] = [
    { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
    { branch: "feature/x", kind: "lens", patchId: "p1", passed: false, at: 2 },
  ];
  const r = await hookDecision("env X=1 gh pr merge 12 --squash", entries);
  assert(r.block === true, "env-prefixed merge with failing lens → REFUSED");
  assert(/no passing lens/.test(r.reason ?? ""), "…naming the missing lens review");
}
{
  // The -R passthrough is visible in the stubbed exec calls.
  const r = await hookDecision("gh -R o/r pr merge 12", []);
  assert(
    r.calls.some((c) => c.includes("-R o/r")),
    "-R o/r is passed through to the gh pr view read",
  );
}
{
  // A passing ledger allows the subshell merge.
  const r = await hookDecision("bash -c 'gh pr merge 12 --squash'", GOOD_ENTRIES);
  assert(r.block === false, "subshell merge with passing ledger → ALLOWED");
}

// ------------------------------------------------------------ repo injection (item 1)
// A malicious repo value must be refused and never interpolated into an
// exec string. The guard refuses with "unsafe repo value" and zero exec
// calls contain the bad value.

{
  const r = await hookDecision('gh pr merge 17 -R "o/r; touch /tmp/x"', []);
  assert(r.block === true, "repo injection: -R with shell metachar → REFUSED");
  assert(/unsafe repo value/.test(r.reason ?? ""), "…reason names the unsafe repo value");
  assert(
    r.calls.every((c) => !c.includes("o/r; touch")),
    "…no exec call contains the injected value",
  );
}
{
  const r = await hookDecision('gh pr merge 17 --repo "o/r;id"', []);
  assert(r.block === true, 'repo injection: --repo "o/r;id" (quoted) → REFUSED');
  assert(/unsafe repo value/.test(r.reason ?? ""), "…reason names the unsafe repo value");
  assert(
    r.calls.every((c) => !c.includes("o/r;id")),
    "…no exec call contains the injected value",
  );
}
{
  const r = await hookDecision('gh pr merge 17 -R "$(id)"', []);
  assert(r.block === true, "repo injection: -R $(id) → REFUSED");
  assert(/unsafe repo value/.test(r.reason ?? ""), "…reason names the unsafe repo value");
  assert(
    r.calls.every((c) => !c.includes("$(id)")),
    "…no exec call contains the injected value",
  );
}
{
  // A valid repo value still passes through.
  const r = await hookDecision("gh -R o/r pr merge 12", []);
  assert(
    r.calls.some((c) => c.includes("-R o/r")),
    "valid repo o/r still passes through to the gh pr view read",
  );
}
{
  // A valid GitLab subgroup value still passes through.
  const r = await hookDecision("glab -R group/sub/proj mr merge 12", []);
  assert(
    r.block === true || r.block === false,
    "valid GitLab subgroup group/sub/proj does not trigger unsafe repo value",
  );
  assert(!/unsafe repo value/.test(r.reason ?? ""), "…no unsafe repo refusal for valid subgroup");
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
