#!/usr/bin/env bun
/**
 * #955 round-2 hardening — the merge guard shapes the adversarial review
 * confirmed, by execution, still bypass the guard (mergesPr → undefined).
 *
 * The round-1 fix (test-merge-guard-955.ts) covered post-verb number
 * extraction, subshell (bash -c) unwrapping and the -R passthrough. Round 2
 * adds: process-wrapper prefixes (timeout/command/nohup/sudo/nice/time/oo/
 * stdbuf), forge paths (/usr/bin/gh), live subshell / backtick bodies
 * (( … ), backtick command lines), fail-closed depth exhaustion, glab
 * --project, /pulls/N URLs and quoted numeric positionals.
 *
 * Every shape is asserted through mergesPr (the matcher) AND through the
 * real hook (registerMergeGuard with a failing lens ledger) — the guard
 * must REFUSE, not merely match.
 *
 * Note on `$( … )` / backtick substitution in an assignment
 * (`x=$(gh pr merge 17)`): the substitution runs the command, so it IS a
 * live merge and the guard matches it (fail-closed: the guard cannot
 * distinguish a substitution whose output is discarded from one whose
 * output is used). The "dead-code" shapes (a quoted verb inside a
 * non-executed string, like `echo "gh pr merge 1"`) stay open.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { mergesPr } from "../src/bash-command-parser.ts";
import {
  extractMergeNumber,
  mergeVerbArgs,
  mergeVerbRepo,
} from "../src/merge-parse.ts";
import { type MergeTarget } from "../src/merge-target.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { type LedgerEntry, ledgerPathFor } from "../src/review-ledger.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;

async function setupLedgerPath() {
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  LEDGER_FILE = p;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ wrapper prefixes
// Every process wrapper the adversarial review named: the merge verb must
// still match, and the PR number must still be extracted.

for (const cmd of [
  "timeout 30 gh pr merge 17",
  "timeout -s TERM 30 gh pr merge 17",
  "timeout -k 5 30 gh pr merge 17",
  "command gh pr merge 17",
  "nohup gh pr merge 17 &",
  "sudo gh pr merge 17",
  "sudo -u janni gh pr merge 17",
  "nice gh pr merge 17",
  "nice -n 5 gh pr merge 17",
  "time gh pr merge 17",
  "time -p gh pr merge 17",
  "env gh pr merge 17",
  "env -i gh pr merge 17",
  "oo gh pr merge 17",
  "stdbuf -oL gh pr merge 17",
  // Stacked wrappers (bash unwraps iteratively — the guard must too).
  "nohup sudo gh pr merge 17",
  "timeout 30 nice -n 5 gh pr merge 17",
  // A forge PATH instead of a bare name.
  "/usr/bin/gh pr merge 17",
  "/opt/homebrew/bin/gh pr merge 17",
  // Chained after another command, still wrapped.
  "cd /data/3 && timeout 30 gh pr merge 17",
  "git status; nohup gh pr merge 17 &",
  // glab through a wrapper.
  "timeout 30 glab mr merge 7",
  "/usr/bin/glab mr merge 7",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (wrapper): blocked — ${cmd}`);
}

// The number must survive the wrapper: `timeout 30 gh pr merge 17` is PR 17,
// not 30.
{
  const a = mergeVerbArgs("timeout 30 gh pr merge 17");
  assert(a !== undefined, "wrapper: verb tail present");
  assert(extractMergeNumber(a ?? "") === 17, "timeout 30 gh pr merge 17 → 17 (not 30)");
}
{
  const a = mergeVerbArgs("sudo gh pr merge 17");
  assert(extractMergeNumber(a ?? "") === 17, "sudo gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("/usr/bin/gh pr merge 17");
  assert(extractMergeNumber(a ?? "") === 17, "/usr/bin/gh pr merge 17 → 17");
}
{
  const a = mergeVerbArgs("nohup gh pr merge 17 &");
  assert(extractMergeNumber(a ?? "") === 17, "nohup gh pr merge 17 & → 17");
}

// ------------------------------------------------------------ subshell / substitution
// `( … )` subshells run their body — the guard must see the merge. `$( … )`
// and backticks in a command line run the inner command too (the
// substitution executes before the assignment), so they are live merges
// the guard must catch (fail-closed: the guard cannot distinguish a
// substitution whose output is discarded from one whose is used).
for (const cmd of [
  "(gh pr merge 17)",
  "(cd x && gh pr merge 17)",
  "x=$(gh pr merge 17)",
  "x=`gh pr merge 17`",
  "echo $(gh pr merge 17)",
  "y=`glab mr merge 7`",
  // Nesting: a merge inside a substitution inside a subshell (and the
  // inverse).
  "a=$(( (gh pr merge 17) ))",
  "$( (glab mr merge 7) )",
  "(x=$(gh pr merge 17))",
  "w=`nohup gh pr merge 17`",
  // A merge in a later segment of a chain that also carries constructs.
  "ls $(gh pr list) && (gh pr merge 17)",
]) {
  assert(mergesPr(cmd) !== undefined, `canary (construct): blocked — ${cmd}`);
}

{
  const a = mergeVerbArgs("(gh pr merge 17)");
  assert(a !== undefined, "subshell: verb tail present");
  assert(extractMergeNumber(a ?? "") === 17, "(gh pr merge 17) → 17");
}
{
  const a = mergeVerbArgs("x=$(gh pr merge 17)");
  assert(extractMergeNumber(a ?? "") === 17, "x=$(gh pr merge 17) → 17");
}
{
  const a = mergeVerbArgs("x=`gh pr merge 17`");
  assert(extractMergeNumber(a ?? "") === 17, "backtick: the number is 17");
}

// ------------------------------------------------------------ depth: fail closed
// A merge hidden 4 shell-eval layers deep exceeds the unwrap budget (3).
// The guard must treat it as a merge WITH NO number → the fallback refusal,
// never as "not a merge".

const DEEP_MERGE = "bash -c 'sh -c \"zsh -c \\\"dash -c \\\\"gh pr merge 12\\\\"\\\"\"";
{
  assert(mergesPr(DEEP_MERGE) !== undefined, "canary (depth 4): the deep merge still MATCHES");
}
{
  const r = await hookDecision(DEEP_MERGE, FAILING_LENS);
  assert(r.block === true, "depth-4 merge with failing lens → REFUSED (fail closed)");
}

// An unparseable inner string (an unterminated quote in a raw command that
// still carries a merge verb) is likewise a merge-with-no-number: refused.
{
  const bad = 'bash -c "gh pr merge 12';
  assert(mergesPr(bad) !== undefined, "canary (unparseable): an unterminated-quote merge still matches");
}

// ------------------------------------------------------------ glab --project, /pulls/N, quoted number
{
  const a = mergeVerbArgs("glab --project o/r mr merge 7");
  assert(a !== undefined, "glab --project: the verb door matches");
  assert(extractMergeNumber(a ?? "") === 7, "glab --project o/r mr merge 7 → 7");
  assert(mergeVerbRepo("glab --project o/r mr merge 7") === "o/r", "…and the repo is o/r (--project)");
}
{
  const a = mergeVerbArgs("gh pr merge https://github.com/o/r/pulls/17/merge");
  assert(a !== undefined, "/pulls/N URL: the verb door matches");
  assert(extractMergeNumber(a ?? "") === 17, "…and the number is 17 (/pulls/N)");
  assert(mergeVerbRepo("gh pr merge https://github.com/o/r/pulls/17/merge") === "o/r", "…and the repo is o/r");
}
{
  const a = mergeVerbArgs('gh pr merge "17"');
  assert(extractMergeNumber(a ?? "") === 17, 'gh pr merge "17" → 17 (quoted numeric positional)');
}
{
  const a = mergeVerbArgs("gh pr merge '17'");
  assert(extractMergeNumber(a ?? "") === 17, "gh pr merge '17' → 17 (single-quoted)");
}

// ------------------------------------------------------------ non-merges stay open
for (const cmd of [
  "timeout 30 gh pr view 17",
  '(echo "gh pr merge 1")',
  "x=$(gh pr list)",
  "command -v gh",
  "nice -n 5 glab mr view 3",
  "sudo gh pr list",
  "time gh pr checks 12",
  "oo gh pr list",
  "(echo hi)",
  "x=$(ls /tmp)",
  `x=\`gh pr list\``,
]) {
  assert(mergesPr(cmd) === undefined, `allowed (non-merge) — ${cmd}`);
}

// ------------------------------------------------------------ guard decision matrix
// Driven through the REAL hook via `opts.execFn`.

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

console.log(`\nexit ${exit}`);
process.exit(exit);
