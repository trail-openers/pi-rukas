#!/usr/bin/env bun
/**
 * #1095 — every driver network git call runs through `runNetGit`, with the
 * non-interactive environment and a bounded wait.
 *
 * Three things pinned here:
 *   1. The env contract: GIT_TERMINAL_PROMPT=0; an operator's GIT_SSH_COMMAND
 *      is kept verbatim, and `-o BatchMode=yes` / `-o ConnectTimeout=30` are
 *      appended only when absent (no duplicates).
 *   2. The wrapper hands every call the env, the timeout bound and the argv
 *      form, and passes non-timeout failures through unchanged.
 *   3. Enumeration: no driver source file runs a network git command (fetch,
 *      pull, push, ls-remote) directly through an exec function. Each file
 *      that does so must route through `runNetGit`, and the per-file call
 *      counts are pinned, so a new call site fails here until it is listed.
 *
 * The real-git hang behaviour lives in test-work-driver-net-git-timeout.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NET_GIT_TIMEOUT_DEFAULT_MS,
  NET_GIT_TIMEOUT_ENV,
  NetGitTimeoutError,
  isNetGitTimeout,
  netGitEnv,
  netGitTimeoutMs,
  runNetGit,
  withSshDefaults,
} from "../src/work-driver-net-git.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

console.log("1. env contract");
const bare = netGitEnv({});
assert(bare.GIT_TERMINAL_PROMPT === "0", "GIT_TERMINAL_PROMPT=0");
assert(
  bare.GIT_SSH_COMMAND === "ssh -o BatchMode=yes -o ConnectTimeout=30",
  "no operator ssh: default ssh with BatchMode and ConnectTimeout",
);
const operator = netGitEnv({ GIT_SSH_COMMAND: "ssh -i /keys/deploy" });
assert(
  operator.GIT_SSH_COMMAND === "ssh -i /keys/deploy -o BatchMode=yes -o ConnectTimeout=30",
  "operator GIT_SSH_COMMAND preserved; defaults appended",
);
// core.sshCommand outranks GIT_SSH but not GIT_SSH_COMMAND; a repo-configured
// key must survive the wrapper (#1095 review).
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
  delete process.env[k];
}
const cfgRepo = mkdtempSync(path.join(tmpdir(), "net-git-cfg-"));
execFileSync("git", ["init", "-q", cfgRepo]);
execFileSync("git", ["-C", cfgRepo, "config", "core.sshCommand", "ssh -i /keys/cfg"]);
assert(
  netGitEnv({}, cfgRepo).GIT_SSH_COMMAND ===
    "ssh -i /keys/cfg -o BatchMode=yes -o ConnectTimeout=30",
  "core.sshCommand honoured when no GIT_SSH_COMMAND is set",
);
assert(
  netGitEnv({ GIT_SSH_COMMAND: "ssh -i /keys/deploy" }, cfgRepo).GIT_SSH_COMMAND ===
    "ssh -i /keys/deploy -o BatchMode=yes -o ConnectTimeout=30",
  "GIT_SSH_COMMAND outranks core.sshCommand",
);
rmSync(cfgRepo, { recursive: true, force: true });
const already = withSshDefaults("ssh -o BatchMode=no -o ConnectTimeout=5");
assert(
  already === "ssh -o BatchMode=no -o ConnectTimeout=5",
  "operator options are not duplicated",
);
assert(
  withSshDefaults("ssh -o BatchMode=yes") === "ssh -o BatchMode=yes -o ConnectTimeout=30",
  "only the absent option is appended",
);

console.log("2. timeout bound");
const saved = process.env[NET_GIT_TIMEOUT_ENV];
delete process.env[NET_GIT_TIMEOUT_ENV];
assert(netGitTimeoutMs() === NET_GIT_TIMEOUT_DEFAULT_MS, "unset → 300000 default");
assert(NET_GIT_TIMEOUT_DEFAULT_MS === 300_000, "default constant is 300000");
process.env[NET_GIT_TIMEOUT_ENV] = "5000";
assert(netGitTimeoutMs() === 5000, "positive integer honoured");
for (const bad of ["abc", "0", "-1", "1.5"]) {
  process.env[NET_GIT_TIMEOUT_ENV] = bad;
  assert(netGitTimeoutMs() === NET_GIT_TIMEOUT_DEFAULT_MS, `"${bad}" → default`);
}
process.env[NET_GIT_TIMEOUT_ENV] = "4321";

console.log("3. runNetGit applies env, bound and argv");
type Seen = { cmd: string; opts: Record<string, unknown> | undefined };
const seen: Seen[] = [];
const stub = async (cmd: string, opts?: Record<string, unknown>) => {
  seen.push({ cmd, opts });
  return { stdout: "ok\n" };
};
const out = await runNetGit(stub, "git fetch origin main", { cwd: "/repo" });
assert(out.stdout === "ok\n", "resolves with the executor's result");
const call = seen[0];
assert(call?.cmd === "git fetch origin main", "shell form passes the command");
assert(call?.opts?.cwd === "/repo", "cwd forwarded");
assert(call?.opts?.timeout === 4321, "timeout = PI_ENSEMBLE_GIT_NET_TIMEOUT_MS");
assert(
  (call?.opts?.env as NodeJS.ProcessEnv | undefined)?.GIT_TERMINAL_PROMPT === "0",
  "env carries GIT_TERMINAL_PROMPT=0",
);
await runNetGit(stub, "git", { cwd: "/repo", argv: ["fetch", "origin", "b"] });
assert(seen[1]?.opts?.argv?.join(" ") === "fetch origin b", "argv form forwarded");
await runNetGit(stub, "git ls-remote", { cwd: "/repo", timeoutMs: 10_000 });
assert(seen[2]?.opts?.timeout === 4321, "per-call bound above the env ceiling is clamped to it");
await runNetGit(stub, "git ls-remote", { cwd: "/repo", timeoutMs: 100 });
assert(seen[3]?.opts?.timeout === 100, "per-call bound below the ceiling is honoured");

const boom = new Error("Permission denied (publickey)");
let passed: unknown;
try {
  await runNetGit(async () => {
    throw boom;
  }, "git fetch origin main");
} catch (err) {
  passed = err;
}
assert(passed === boom, "non-timeout failure passes through unchanged");
assert(!isNetGitTimeout(passed), "…and is not mistaken for a timeout");

let hung: unknown;
process.env[NET_GIT_TIMEOUT_ENV] = "50";
try {
  await runNetGit(() => new Promise<never>(() => {}), "git push origin b");
} catch (err) {
  hung = err;
}
assert(hung instanceof NetGitTimeoutError, "a never-settling executor is cut off at the bound");
assert(
  hung instanceof Error && hung.message.startsWith("network git timed out after 50ms"),
  "named cause leads the message (survives the 200-char callers' slice)",
);
if (saved === undefined) delete process.env[NET_GIT_TIMEOUT_ENV];
else process.env[NET_GIT_TIMEOUT_ENV] = saved;

console.log("4. enumeration of driver network git call sites");
const SRC = path.resolve(import.meta.dir, "../src");
// Raw = a network git exec issued directly: a shell string, or the argv form
// (`execFn("git", { … argv: ["fetch", …] })`). The wrapper's own argv sits
// inside `runNetGit(execFn, "git", {`, which the leading `runNetGit(` keeps out.
const RAW =
  /(?:\bexecFn|\bexecp|\bexec|\bverifyExec|\bexecFileP)\(\s*["'`]git (?:fetch|pull|push|ls-remote)\b|\bexecFn\(\s*["']git["'],\s*\{[\s\S]{0,240}?argv:\s*\[\s*["'](?:fetch|pull|push|ls-remote)["']/g;
const WRAPPED = /\brunNetGit\(/g;

// Pinned per-file call counts of runNetGit. Adding a network git call site
// means adding a row here — deliberately, so it cannot skip the wrapper.
const EXPECTED: Record<string, number> = {
  "work-driver-branch-mechanized.ts": 1,
  "work-driver-git.ts": 2,
  "work-driver-integrate.ts": 1,
  "work-driver-adversarial.ts": 1,
  "work-driver-adversarial-lensfix.ts": 1,
  "work-driver-branch-ops.ts": 1,
  "work-driver-handoff-consolidate-branch.ts": 1,
  "work-driver-worktree-sweep.ts": 1,
  "work-driver-handoff-snapshot.ts": 1,
  "work-driver-lens-fix-reposition-gate.ts": 1,
  "merge-guard.ts": 1,
  "lens-review-residuals.ts": 1,
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const rawHits: string[] = [];
const wrappedCounts: Record<string, number> = {};
for (const file of sourceFiles(SRC)) {
  const base = path.basename(file);
  const lines = readFileSync(file, "utf8").split("\n");
  const code = lines.filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join("\n");
  for (const m of code.matchAll(RAW)) {
    const line = code.slice(0, m.index).split("\n").length;
    rawHits.push(`${base}:${line}`);
  }
  if (base === "work-driver-net-git.ts") continue; // the definition, not a caller
  const text = lines.filter((l) => !l.trim().startsWith("//")).join("\n");
  const n = text.match(WRAPPED)?.length ?? 0;
  if (n > 0) wrappedCounts[base] = n;
}

assert(rawHits.length === 0, `no raw network git exec in src (${rawHits.join(", ") || "none"})`);
const unexpected = Object.keys(wrappedCounts).filter((f) => !(f in EXPECTED));
const missing = Object.keys(EXPECTED).filter((f) => !(f in wrappedCounts));
const mismatched = Object.keys(EXPECTED).filter(
  (f) => f in wrappedCounts && wrappedCounts[f] !== EXPECTED[f],
);
assert(
  unexpected.length === 0,
  `no unlisted runNetGit caller (${unexpected.join(", ") || "none"})`,
);
assert(missing.length === 0, `every listed caller still wraps (${missing.join(", ") || "none"})`);
assert(
  mismatched.length === 0,
  `per-file call counts match (${mismatched.map((f) => `${f}: ${wrappedCounts[f]}≠${EXPECTED[f]}`).join(", ") || "none"})`,
);

console.log(failures === 0 ? "\nAll network-git env checks passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
