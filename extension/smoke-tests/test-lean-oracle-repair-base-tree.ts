#!/usr/bin/env bun
/**
 * A real git checkout of the run's base, which is what the judge actually reads and runs.
 *
 * The judge compares a replacement against the ORIGINAL frozen bytes — but the base tree it runs them in is a
 * checkout another part of the same round may already have written into. Reading the original off disk would
 * then compare one submission against another and call it a judgement, and the round is the one place lean
 * lets a child rewrite the contract it is graded on. So the original is read out of the commit, by `git show`,
 * and its hash is checked against the record before it is trusted. Each case here is the mutant that rule
 * exists to catch, run against a real repository rather than a fake exec, so the assertion is about what git
 * returns and not about what a stub was told to say.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import {
  RepairJudgeError,
  judgeRepairSubmission,
  type ReplacementInput,
} from "../src/oracle-repair-judge.ts";
import { outsideDir } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.log(`\u2717 ${msg}`);
    exit = 1;
  }
}

const FILE = "tests/AC1.test.sh";
const RUNNER = "sh {file}";
const ORIGINAL =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh old case" 1>&2; exit 1; fi\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh second case" 1>&2; exit 1; fi\nexit 0\n';
/** All the contract's cases, with one the contract never printed — the mutation the new-red rule catches. */
const NEW_RED =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh old case" 1>&2; exit 1; fi\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh second case" 1>&2; exit 1; fi\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh new case" 1>&2; exit 1; fi\nexit 0\n';
/** The contract's bytes verbatim — the resubmission the identity rule exists to catch. */
const SAME_RED =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh old case" 1>&2; exit 1; fi\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh second case" 1>&2; exit 1; fi\nexit 0\n';
const RED_BASE = "export const retry = () => { throw new Error('not-implemented'); };\n";

/** A git repository whose HEAD holds the frozen file and a base implementation the frozen test is red against. */
function baseRepo(): { root: string; sha: string } {
  const root = mkdtempSync(outsideDir());
  const git = (...argv: string[]): string =>
    execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "src/retry.ts"), RED_BASE);
  writeFileSync(path.join(root, FILE), ORIGINAL, { mode: 0o755 });
  git("add", "-A");
  git("commit", "-q", "-m", "base + frozen test");
  return { root, sha: git("rev-parse", "HEAD") };
}

const judge = (repo: { root: string; sha: string }, replacement: ReplacementInput) =>
  judgeRepairSubmission({
    exec: execp,
    baseTree: repo.root,
    baseRef: repo.sha,
    template: RUNNER,
    named: [FILE],
    replacements: [replacement],
  });

const frozen = sha256(ORIGINAL);

// ── (1) the honest mutant: the original's own red, with a passing case bolted on ──────────────────────
{
  const repo = baseRepo();
  // Different bytes from the contract, so a byte-identity rule waves it through: its red is the frozen file's
  // own, which is the whole thing this rule exists to refuse.
  const j = await judge(repo, { path: FILE, bytes: Buffer.from(SAME_RED), frozenHash: frozen });
  assert(
    j.accepted === false,
    `(1) a replacement whose only red the frozen file already printed is refused (got ${JSON.stringify(j.accepted ? "accepted" : j.why)})`,
  );
}

// ── (2) the rule reads the COMMITTED oracle, never the checkout the round wrote into ─────────────────
{
  // The judge lays each submitted file into the base checkout before running it, so "the original" read off
  // that disk is another submission's bytes once the round has written one. This submission deletes the
  // contract's second case, keeps a line that was only ever in the FIRST replacement, and is red on exactly
  // that line: judged against the disk it is a new red and the round accepts an oracle that dropped a case.
  const repo = baseRepo();
  const written = NEW_RED;
  const survivor = '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh new case" 1>&2; exit 1; fi\nexit 0\n';
  const first = await judge(repo, { path: FILE, bytes: Buffer.from(written), frozenHash: frozen });
  assert(first.accepted === true, `(2) the first replacement is accepted (${JSON.stringify(first.accepted === false ? first.why : "")})`);
  const second = await judge(repo, { path: FILE, bytes: Buffer.from(survivor), frozenHash: frozen });
  assert(
    second.accepted === false,
    `(2) a later replacement is refused against the COMMITTED oracle, not the round's own write (got ${JSON.stringify(second.accepted ? "accepted" : second.why)})`,
  );
}

// ── (3) a base tree that does not hold the contract the record claims is an observed nothing ──────────
{
  const repo = baseRepo();
  // The record's hash does not match what the commit holds: the judge has no trustworthy original, and a
  // judgement made without one is a verdict on an unseen file.
  const j = await judge(repo, {
    path: FILE,
    // The original's own red makes this a submission the identity rule would not catch: only the record check
    // can refuse it, which is what the case is about.
    bytes: Buffer.from(SAME_RED),
    frozenHash: sha256("some other file entirely"),
  }).catch((err: unknown) => ({ accepted: false, why: err instanceof Error ? err.name : String(err) }));
  assert(
    "accepted" in j && j.accepted === false && j.why.includes("RepairJudgeError"),
    `(3) a record that does not match the committed oracle throws instead of judging (got ${JSON.stringify("accepted" in j ? (j.accepted ? "accepted" : j.why) : "?")})`,
  );
  void RepairJudgeError;
}

console.log(exit === 0 ? "\nlean oracle repair base tree: OK" : "\nFAILED");
process.exit(exit);
