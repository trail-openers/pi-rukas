/**
 * Shared harness for the #1404 commit-pr baseline-probe tests.
 *
 * Both probe test files (`test-integration-verify-baseline-probe.ts` for the
 * attribution decisions, `test-integration-verify-baseline-events.ts` for the
 * event log, escape hatch and cost) build the same object: a real git repo
 * whose gate IS the suite's own `verify-loop.sh` over its own fixtures, with a
 * worktree carrying "the change". Split out for the 500-line cap (AGENTS.md
 * §12); the fixture builder is ~60 lines of git and file setup that reads
 * better once than twice, and a fixture that drifts between the two files would
 * quietly make one of them test a different shape than the other.
 *
 * The gate is a shell script that resolves its own directory and hands the loop
 * a fixed list, which is deliberate: it is how a committed `gate.sh` really
 * behaves, and it is the reason the attribution parser sees absolute paths
 * under whichever tree ran it rather than the cwd.
 */

import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);

export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/**
 * Repo-relative test path -> the suite fixture it is a copy of. The repo's own
 * file names are free-form (`tests/test-red.ts`); the fixture is what decides
 * whether that test passes or fails, so the mapping is the whole fixture
 * vocabulary: fixture-1 / fixture-3 always exit 1, allpass-* always exit 0.
 */
export function fixtureMap(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of paths) {
    const base = path.basename(rel);
    if (base.startsWith("allpass")) out[rel] = base;
    else if (/regressed|new-red/.test(base)) out[rel] = "fixture-2.ts";
    else out[rel] = "fixture-1.ts";
  }
  return out;
}

/** The gate script: the real smoke loop, over a fixed list, in whichever tree it lives. */
export function loopCmd(files: string[]): string {
  const loopPath = path.join(import.meta.dirname, "..", "lib", "verify-loop.sh");
  const listed = files.map((f) => `"$DIR/${f}"`).join(" ");
  return [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    `exec bash ${loopPath} ${listed}`,
  ].join(String.fromCharCode(10));
}

/**
 * Build a repo + worktree pair whose verify command is red.
 *
 * `gateFiles` is what the BASE gate lists; `changeGateFiles` is what the
 * change's gate lists (when the change adds or removes a test). `baseSeed`
 * are files the BASE owns outright — a test the change keeps listing — which
 * is what makes the base red for its own reasons rather than for want of a
 * file the change had not written yet.
 */
export async function redGateFixture(
  root: string,
  name: string,
  gateFiles: string[],
  change: Record<string, string>,
  changeGateFiles?: string[],
  baseSeed: Record<string, string> = {},
) {
  const fixtures = path.join(import.meta.dirname, "..", "fixtures", "verify-loop");  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, fixtureBase] of Object.entries(
    fixtureMap([...gateFiles, ...Object.keys(baseSeed)]),
  )) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    copyFileSync(path.join(fixtures, fixtureBase), abs);
  }
  for (const [rel, body] of Object.entries(baseSeed)) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  writeFileSync(path.join(repo, "gate.sh"), loopCmd(gateFiles), { mode: 0o755 });
  chmodSync(path.join(repo, "gate.sh"), 0o755);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "chore: base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  const wt = path.join(dir, "wt-a");
  await git(repo, ["worktree", "add", "-q", "-d", wt, "HEAD"]);
  await git(wt, ["config", "user.email", "t@example.com"]);
  await git(wt, ["config", "user.name", "T"]);
  for (const [rel, body] of Object.entries(change)) {
    const abs = path.join(wt, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  if (changeGateFiles) {
    writeFileSync(path.join(wt, "gate.sh"), loopCmd(changeGateFiles), { mode: 0o755 });
    chmodSync(path.join(wt, "gate.sh"), 0o755);
  }
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "feat: the change"]);
  return { repo, scratch, baseSha, worktrees: { a: wt } as Record<string, string>, originDir };
}

/** Copy a suite fixture into a worktree — a test the change ADDS to the gate. */
export async function addFixture(wt: string, fixtureBase: string, rel: string): Promise<void> {
  const abs = path.join(wt, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  copyFileSync(path.join(import.meta.dirname, "..", "fixtures", "verify-loop", fixtureBase), abs);
}
