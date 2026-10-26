#!/usr/bin/env bun
/**
 * #1832 — unit coverage for `branchHasOpenCriticalRow`, the three-valued probe
 * the automatic-delta decision consults before letting a follow-up round be a
 * delta. The distinction the whole function exists for is `absent` vs
 * `unreadable`: `readBranchRows` answers fail-open, so a rule built on it would
 * run a delta precisely when the findings file is corrupt and a CRITICAL row may
 * still be open in it.
 *
 * Isolation follows test-review-findings-store.ts: a fixture clone plus a
 * pinned PI_AGENT_DIR, so the store lands in a temp state dir and never in the
 * operator's. Nothing here builds a judged path under the clone — the store
 * resolves through the state-dir resolver, and the corrupt/unreadable cases
 * mutate the file the resolver itself named.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { branchHasOpenCriticalRow } from "../src/review-findings-critical-probe.ts";
import { recordFindingRunOutcome } from "../src/review-findings-store.ts";
import { findingsStateDir } from "../src/review-state-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crit-probe-"));
  git(dir, "init", "-q", "-b", "feat/x");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "dev");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"));
  const commit = (content: string) => {
    writeFileSync(path.join(dir, "src", "a.ts"), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
    return git(dir, "rev-parse", "HEAD");
  };
  return { dir, commit };
}

const finding = (
  title: string,
  line: number | undefined,
  severity: Finding["severity"] = "CRITICAL",
): Finding => ({
  lens: "SECURITY",
  severity,
  path: "src/a.ts",
  ...(line === undefined ? {} : { line }),
  title,
});

const savedAgentDir = process.env.PI_AGENT_DIR;
const agentDir = await mkdtemp(path.join(os.tmpdir(), "crit-probe-agent-"));
process.env.PI_AGENT_DIR = agentDir;

try {
  const { dir, commit } = makeRepo();
  const c1 = commit(["// header", "const a = 1;", "const b = 2;", "const c = 3;"].join("\n"));
  const loc = await findingsStateDir(execp, dir);
  assert(loc !== undefined, "probe: the clone resolves a state dir");

  // No store at all yet: the file does not exist, which the raw read answers as
  // "the genuine empty store" — absent, NOT unreadable.
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
    "no findings file at all → absent (a first review stays a full review on its own merits)",
  );

  const record = (findings: Finding[], branch = "feat/x", head = c1) =>
    recordFindingRunOutcome({ cwd: dir, branch, headSha: head, findings, review: "full" });

  await record([finding("Division by zero", 2)]);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
    "an open line-bearing CRITICAL row → present",
  );
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/other")).kind === "absent",
    "the row is scoped to its own branch — another branch is absent",
  );

  // A non-CRITICAL row never forces a round. The commit only carries a line
  // change when the content actually differs, so the second commit differs.
  const c2 = commit(["// header", "const a = 1;", "const b = 22;", "const c = 3;"].join("\n"));
  await record([finding("Naming", 2, "HIGH")], "feat/high", c2);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/high")).kind === "absent",
    "an open HIGH row → absent (only CRITICAL forces a full round)",
  );

  // A CRITICAL with no line (line-less) is retired by #1469 on a full review, so
  // it never needs a forced round; same for one with no lineHash.
  await record([finding("Hardcoded secret", undefined)], "feat/noline", c2);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/noline")).kind === "absent",
    "a line-less CRITICAL → absent (it retires as not-reported, no forced round needed)",
  );

  // Corrupt the store: the fail-open read would say "no rows"; the probe must
  // say unreadable, because that is exactly when a CRITICAL may still be open.
  const file = loc?.file as string;
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "{ this is not json");
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "unreadable",
    "an unparseable findings file → unreadable, never absent",
  );
  // A directory where the file should be: a read fault with no bytes at all.
  writeFileSync(file, good);
  assert(
    (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
    "restoring the bytes restores the answer (present)",
  );

  // A state dir that cannot be resolved at all (not a git clone) is unreadable.
  const notAClone = await mkdtemp(path.join(os.tmpdir(), "crit-probe-nogit-"));
  assert(
    (await branchHasOpenCriticalRow(notAClone, "feat/x")).kind === "unreadable",
    "a directory that is not a git clone → unreadable (fail toward a full review)",
  );

  // An accepted CRITICAL row does not force a round: the round is forbidden to
  // report it, so a full review proves nothing about it.
  const rows = JSON.parse(good) as { rows: Array<Record<string, unknown>> };
  const target = rows.rows.find((r) => r.severity === "CRITICAL");
  assert(target !== undefined, "fixture: the store holds a CRITICAL row to accept");
  if (target) {
    target.status = "accepted";
    target.acceptance = { by: "op", reason: "known risk", at: 1, snippetHash: target.snippetHash };
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
      "an ACCEPTED CRITICAL row → absent (an operator decision never forces a round)",
    );
    target.status = "resolved";
    target.resolvedReason = "code-gone";
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "absent",
      "a RESOLVED CRITICAL row → absent",
    );
    target.status = "open";
    // `undefined` rather than `delete`: JSON.stringify drops an undefined
    // property, and biome's noDelete rule rules the operator out anyway.
    target.acceptance = undefined;
    target.resolvedReason = undefined;
    writeFileSync(file, JSON.stringify(rows));
    assert(
      (await branchHasOpenCriticalRow(dir, "feat/x")).kind === "present",
      "putting the row back to open makes the probe say present again",
    );
  }

  // An empty scratch dir under the agent root is not read as a corrupt store:
  // the resolver keys on the clone, not on stray directories beside it.
  mkdirSync(path.join(agentDir, "empty-branch-check"), { recursive: true });
} finally {
  if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = savedAgentDir;
}

process.exit(exit);
