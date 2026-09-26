#!/usr/bin/env bun
/**
 * #861 (decision 5) — the consolidated verify's WHOLE repoRoot section runs
 * under the integration lock.
 *
 * runConsolidatedVerify's repoRoot section (dirty-root preflight read,
 * checkout -B, cherry-pick, verify, the single flake re-run, restoreRoot and
 * branch -D) used to run UNLOCKED, while every other repoRoot-mutating path
 * (integrate(), runCommitPr, handoff-consolidate, merged teardown) held
 * withIntegrationLock. Two concurrent cycles (or one cycle's develop gate
 * racing its own commit-pr) could interleave their checkouts: the phantom
 * "consolidated-verify-conflict" that parked live issue #844 was exactly this
 * — #844's verify cherry-pick collided with #841's ops commit written into
 * the shared root.
 *
 * The probe: two CONCURRENT runConsolidatedVerify calls on one real repo,
 * both with a real worktree carrying a commit (so each call actually
 * checkouts, cherry-picks and restores the root). A wrapper execFn records
 * the order of the two boundary commands:
 *
 *   - preflight: `git status --porcelain -uall` at repoRoot (the dirty-root
 *     preflight read — the first command of the repoRoot section);
 *   - restore:   `git reset --hard` at repoRoot (the START of restoreRoot —
 *     the section-end region; branch -D is the final step of the same
 *     restore, a few milliseconds later, so the ordering is equivalent).
 *
 * Serialized: call 2's preflight must appear AFTER call 1's restore.
 * Unserialized: the two spans overlap (call 2's preflight inside call 1's
 * checkout→restore window).
 *
 * Anti-vacuity control: the SAME two calls are repeated against
 * runConsolidatedVerifyUnlocked (the body with the lock removed — the seam
 * exported precisely for this). A small artificial delay is injected between
 * preflight and checkout (simulating the ~ms of real git work in between) to
 * guarantee the spans overlap deterministically. If the harness did not show
 * overlap here, the "no overlap" assertion above would be vacuous.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { __resetIntegrationLock } from "../src/work-driver-lock.ts";
import {
  runConsolidatedVerify,
  runConsolidatedVerifyUnlocked,
} from "../src/work-driver-consolidated-verify.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

type Boundary = "preflight" | "restore";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-861-lock-"));

/** Build a real repo with one committed worktree (so the verify does a real
 * checkout → cherry-pick → restore cycle at the root). */
async function makeRepo(name: string): Promise<{ repo: string; baseSha: string; wt: string }> {
  const repo = path.join(root, name);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "probe-861");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "b.txt"), "workstream work\n");
  await git(wt, ["add", "b.txt"]);
  await git(wt, ["commit", "-q", "-m", "ws: add b"]);
  return { repo, baseSha, wt };
}

type ExecFn = NonNullable<Parameters<typeof runConsolidatedVerify>[0]>;

/** Build a recording execFn for one of the two concurrent calls. Records
 * (kind, seq) boundary events into `order`. `delayMs` (anti-vacuity only)
 * injects an artificial delay after the preflight to widen the window. */
function makeRecordingExec(
  f: { repo: string },
  seq: 0 | 1,
  order: Array<{ kind: Boundary; seq: 0 | 1 }>,
  delayMs: number,
): ExecFn {
  const realExec: ExecFn = async (cmd, o) => {
    try {
      const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
        cwd: o?.cwd,
        maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
      });
      return { stdout };
    } catch (err) {
      const e = err as Error & { stderr?: string };
      e.stderr = e.stderr ?? "";
      throw e;
    }
  };
  return async (cmd, o) => {
    if (o?.cwd === f.repo) {
      if (cmd === "git status --porcelain -uall") {
        order.push({ kind: "preflight", seq });
        if (delayMs > 0) await sleep(delayMs);
      } else if (cmd === "git reset --hard") {
        order.push({ kind: "restore", seq });
      }
    }
    return realExec(cmd, o);
  };
}

/** Run one consolidated verify (locked or unlocked) with the recording execFn. */
async function runOne(
  f: { repo: string; baseSha: string; wt: string },
  seq: 0 | 1,
  order: Array<{ kind: Boundary; seq: 0 | 1 }>,
  delayMs: number,
  fn: (execFn: ExecFn, opts: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const execFn = makeRecordingExec(f, seq, order, delayMs);
  await fn(execFn, {
    repoRoot: f.repo,
    baseSha: f.baseSha,
    worktrees: { a: f.wt },
    scratchDir: path.join(f.repo, "tmp", "issue-861"),
    verifyCmd: "true",
    timeoutMs: 30_000,
  });
}

/** True when the two calls' spans are serialized: one call's preflight
 * appears strictly after the other call's restore (the section-end region).
 * Returns which call ran first (0 or 1) or -1 if boundaries are missing. */
function serialized(order: Array<{ kind: Boundary; seq: 0 | 1 }>): 0 | 1 | -1 {
  const idx = (kind: Boundary, seq: 0 | 1) => order.findIndex((e) => e.kind === kind && e.seq === seq);
  const p0 = idx("preflight", 0);
  const r0 = idx("restore", 0);
  const p1 = idx("preflight", 1);
  const r1 = idx("restore", 1);
  if (p0 < 0 || r0 < 0 || p1 < 0 || r1 < 0) return -1;
  // Call 0 first, call 1 after: p0 < r0 < p1 < r1
  if (p0 < r0 && r0 < p1) return 0;
  // Call 1 first, call 0 after: p1 < r1 < p0 < r0
  if (p1 < r1 && r1 < p0) return 1;
  return -1;
}

/** True when the two calls' spans overlap: one call's preflight landed
 * between the other call's preflight and its restore (or vice versa). */
function spansOverlap(order: Array<{ kind: Boundary; seq: 0 | 1 }>): boolean {
  const idx = (kind: Boundary, seq: 0 | 1) => order.findIndex((e) => e.kind === kind && e.seq === seq);
  const p0 = idx("preflight", 0);
  const r0 = idx("restore", 0);
  const p1 = idx("preflight", 1);
  const r1 = idx("restore", 1);
  if (p0 < 0 || r0 < 0 || p1 < 0 || r1 < 0) return false;
  // Overlap: p1 inside (p0, r0) OR p0 inside (p1, r1).
  return (p1 > p0 && p1 < r0) || (p0 > p1 && p0 < r1);
}

function orderDesc(order: Array<{ kind: Boundary; seq: 0 | 1 }>): string {
  return order.map((e) => `${e.kind}${e.seq}`).join(" < ");
}

try {
  // ------------------------------------------------- serialized under lock
  {
    __resetIntegrationLock();
    const f = await makeRepo("serialized");
    const order: Array<{ kind: Boundary; seq: 0 | 1 }> = [];
    await Promise.all([
      runOne(f, 0, order, 0, (execFn, opts) => runConsolidatedVerify(execFn, opts as never)),
      runOne(f, 1, order, 0, (execFn, opts) => runConsolidatedVerify(execFn, opts as never)),
    ]);
    const winner = serialized(order);
    assert(
      winner >= 0,
      `#861 AC: two concurrent runConsolidatedVerify calls serialize — one call's preflight begins strictly after the other's restoreRoot (order: ${orderDesc(order)})`,
    );
    assert(
      !spansOverlap(order),
      "#861 AC: the two repoRoot sections did not overlap at all",
    );
  }

  // -------------------- anti-vacuity: the same harness MUST see overlap
  // when the lock is removed. The artificial delay (200 ms) widens the
  // preflight→checkout window so git's internal index.lock cannot prevent
  // the overlap from being recorded. If the harness did not show overlap
  // here, the "no overlap" assertion above would be vacuous.
  {
    __resetIntegrationLock();
    const f = await makeRepo("unlocked");
    const order: Array<{ kind: Boundary; seq: 0 | 1 }> = [];
    await Promise.all([
      runOne(f, 0, order, 200, (execFn, opts) => runConsolidatedVerifyUnlocked(execFn, opts as never)),
      runOne(f, 1, order, 200, (execFn, opts) => runConsolidatedVerifyUnlocked(execFn, opts as never)),
    ]);
    assert(
      spansOverlap(order),
      `anti-vacuity: the SAME two calls, run through the UNLOCKED body, DO overlap — the probe can detect overlap (order: ${orderDesc(order)})`,
    );
    assert(
      serialized(order) === -1,
      "anti-vacuity: without the lock, the two sections are NOT serialized",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
