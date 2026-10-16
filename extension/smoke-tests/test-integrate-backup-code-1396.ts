#!/usr/bin/env bun
/**
 * #1396 (six-lens round) — the reachability probe's exit code arrives in BOTH
 * shapes, and a kill is not an answer.
 *
 * `backupIntegrateHead` asks `git merge-base --is-ancestor HEAD origin/<branch>`
 * to decide whether a stale integrate tree's commits are already safely on the
 * remote. Exit 1 means "not an ancestor" (the ordinary answer — keep the
 * commit); anything else means "git could not answer" (also keep, fail open).
 * Before the fix only `code === 1` matched, so a string `"1"` — which is what a
 * non-`child_process.exec` implementation of the driver's injected `ExecFn`
 * reports — fell to the "could not answer" branch. Both readings keep the
 * commit here, so the bug was invisible in outcome; what this pins is that the
 * ORDINARY answer is classified as the ordinary answer, and that a kill or a
 * signal — which can carry any code — never reads as a definite "not an
 * ancestor" (the direction that would let a commit die with its tree).
 *
 * Split out of test-integrate-stale-tree-1170.ts, which shares this fixture
 * shape and sits at the AGENTS.md §12 500-line cap.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureIntegrateWorktree } from "../src/work-driver-integrate-worktree.ts";
import type { ExecFn } from "../src/worktree.ts";
import { ISSUE_17_BACKUP_REF, git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1396-backup-code-"));

/** A real repo on main @ base, plus a driver-owned stale integrate tree at base. */
async function fixture(name: string) {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = "feature/issue-17-x";
  await git(repo, ["branch", branch, baseSha]);

  const wt = path.join(repo, ".worktrees", "issue-17-integrate");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);

  const stateFile = path.join(repo, ".pi", "work-state", "17.json");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({ pipelineState: { integrateWorktree: wt, branchName: branch, baseSha } }),
  );
  return { repo, baseSha, branch, wt, stateFile };
}

try {
  // `keeps` is the expected outcome: true = the commit lands on the backup ref.
  // A kill or a signal is never a definite "not an ancestor" whatever code it
  // carries, so it reads as "could not answer" — which also keeps (fail open).
  for (const [tag, code, extra, keeps] of [
    ['a string "1" is the ordinary "not an ancestor" answer', "1", {}, true],
    ['a numeric 1 is the ordinary "not an ancestor" answer', 1, {}, true],
    ["a killed probe is not an answer", 1, { killed: true }, true],
    ["a signalled probe is not an answer", 1, { signal: "SIGKILL" }, true],
    // The counterfactual that makes the above meaningful: an exit code that is
    // neither of those (128 — a corrupt object) is unambiguously "could not
    // answer", and also keeps. If every rejection kept regardless of code, the
    // four cases above would pass for the wrong reason.
    ['an exit 128 is "could not answer"', 128, {}, true],
    // Canary: the probe ANSWERING "reachable" (exit 0) must write NO ref, so a
    // keep in the cases above is the classification doing the work, not the
    // backup writing a ref no matter what the probe said.
    ["exit 0 means already on origin, so nothing is kept", 0, {}, false],
  ] as const) {
    const { repo, baseSha, branch, wt, stateFile } = await fixture(
      `probe-${tag.replace(/\W+/g, "-").slice(0, 40)}`,
    );
    writeFileSync(path.join(wt, "a.txt"), `base\nintegrated ${tag}\n`);
    await git(wt, ["commit", "-q", "-am", `integration ${tag}`]);
    const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const probe: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git merge-base --is-ancestor")) {
        if (code === 0) return { stdout: "" };
        const e = new Error(`exit ${String(code)}`) as Error & Record<string, unknown>;
        e.code = code;
        for (const [k, v] of Object.entries(extra)) e[k] = v;
        throw e;
      }
      return realExec(cmd, o);
    };
    const res = await ensureIntegrateWorktree(
      probe,
      { repoRoot: repo, issue: 17, branchName: branch, baseSha },
      stateFile,
    ).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, err: e }),
    );
    const kept = (
      await git(repo, ["rev-parse", "--verify", "--quiet", ISSUE_17_BACKUP_REF]).catch(() => ({
        stdout: "",
      }))
    ).stdout.trim();
    assert(
      res.ok && (kept === sha) === keeps,
      `(l) ${tag}: ${keeps ? "keeps" : "does not keep"} the commit on the backup ref (${res.ok ? `kept ${kept ? kept.slice(0, 8) : "nothing"}` : (res.err as Error).message.split("\n")[0]})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
