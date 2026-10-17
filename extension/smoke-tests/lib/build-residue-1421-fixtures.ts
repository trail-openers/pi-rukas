#!/usr/bin/env bun
/**
 * Shared fixtures for the #1421 build-residue tests. Kept out of both test
 * files so neither has to spend its line budget on git plumbing, and so the
 * "real cargo residue" and "worktree with a commit" shapes cannot drift
 * between the two halves of the suite.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildResidueFailure } from "../../src/work-driver-dirty-root-classify.ts";
import { parkReason } from "../../src/work-queue-park-reason.ts";
import type { WorkState } from "../../src/workflow-state.ts";

const execFileP = promisify(execFile);
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
export const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

/** The queue’s reason for a state, spelled once so the assertions stay short. */
export const parkReasonOf = (state: WorkState): string => parkReason(state).reason;

export const RESIDUE = [
  "target/.rustc_info.json",
  "target/CACHEDIR.TAG",
  "target/debug/.cargo-lock",
] as const;

/**
 * The shapes `verifyCapFor` routes on, spelled exactly as the producers spell
 * them (the labels are the router’s keys).
 */
export const TIMEOUT_FAILURE =
  "[verify-timeout] verify command `bash scripts/verify.sh` exceeded its 10-min timeout in /wt — the run was killed at the bound (PI_ENSEMBLE_VERIFY_TIMEOUT_MS), so it reached no verdict about the code";
export const REAL_FAILURE =
  "verify command `bash scripts/verify.sh` failed in /wt: expected 1 to be 2";
export const RESIDUE_FAILURE = buildResidueFailure([...RESIDUE], "the repo root is not clean");

/** A repo whose `.gitignore` covers the residue — the state the classifier can prove. */
export async function makeRepo(repo: string): Promise<string> {
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  writeFileSync(path.join(repo, ".gitignore"), "/console/target/\n/target/\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return gitOut(repo, ["rev-parse", "HEAD"]);
}

/** Cargo’s build output, exactly as the incident left it. */
export function writeResidue(repo: string) {
  for (const rel of RESIDUE) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      rel.endsWith(".json") ? "{}" : rel.includes("CACHEDIR") ? "Signature: 8a" : "",
    );
  }
}

/** A worktree at `baseSha` with one commit of its own. */
export async function worktreeWithCommit(
  repo: string,
  name: string,
  baseSha: string,
  file: string,
) {
  const wt = path.join(repo, ".worktrees", name);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, file), `// ${file}\n`);
  await git(wt, ["add", file]);
  await git(wt, ["commit", "-q", "-m", `feat: ${file}`]);
  return wt;
}
