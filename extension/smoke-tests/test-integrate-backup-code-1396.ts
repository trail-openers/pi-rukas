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
import { integrateBackupRef } from "../src/work-driver-integrate-cycle.ts";
import { type ExecFn, WORKTREE_LIST_TIMEOUT_MS, worktreeList } from "../src/worktree.ts";
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

  // #1396 (round 3) — a superseded value is only reported when it is a SHA.
  // `git rev-parse --verify` canonicalises, so a non-hex answer from the ref
  // store means it said something other than "here is an object". Reporting it
  // as "the backup you are about to lose" sends the operator to `git fsck` with
  // a token that names nothing, so it is dropped — while the ref still takes
  // the new sha (the keep itself is not the thing under test).
  for (const [tag, garbage, reports] of [
    ["a non-hex ref value is NOT reported as superseded", "refs/heads/whatever", false],
    ["a truncated hex value is not a full object id", "abc123", false],
    ["an uppercase hex value is not the canonical form", "DEADBEEFCAFE1234567890ABCDEF1234567890AB", false],
  ] as const) {
    const { repo, baseSha, branch, wt, stateFile } = await fixture(
      `superseded-${tag.replace(/\W+/g, "-").slice(0, 40)}`,
    );
    writeFileSync(path.join(wt, "a.txt"), `base\nintegrated ${tag}\n`);
    await git(wt, ["commit", "-q", "-am", `integration ${tag}`]);
    // The prior "ref" holds the garbage value. `update-symbolic-ref` is used
    // because `update-ref` would reject a non-object value outright — the point
    // is what a reader does with a value the store somehow carries.
    const fakePrior: ExecFn = async (cmd, o) => {
      if (cmd.includes("rev-parse --verify --quiet") && cmd.includes("integrate-backup")) {
        return { stdout: `${garbage}\n` };
      }
      return realExec(cmd, o);
    };
    const res = await ensureIntegrateWorktree(
      fakePrior,
      { repoRoot: repo, issue: 17, branchName: branch, baseSha },
      stateFile,
    ).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, err: e }),
    );
    assert(
      res.ok &&
        ((res.ok ? res.r.supersededSha : undefined) !== undefined) === reports &&
        (reports ? res.ok && res.r.supersededSha === garbage : res.ok && !res.r.supersededSha),
      `(n) ${tag} (${res.ok ? `supersededSha=${String(res.ok ? res.r.supersededSha : "-")}` : (res.err as Error).message.split("\n")[0]})`,
    );
    assert(
      res.ok && (await git(repo, ["rev-parse", "--verify", "--quiet", ISSUE_17_BACKUP_REF])).stdout.trim() !== "",
      `(n) ${tag}: the ref still records the NEW kept commit — dropping the bogus value never skips the write`,
    );
  }

  // #1396 (round 3) — `integrateBackupRef` composes the operator's only pointer
  // to recoverable commits, so a garbage issue number must not silently produce
  // `…/issue-undefined` (a ref the halt would name and nothing would resolve).
  for (const bad of [0, -3, 1.5, Number.NaN]) {
    let threw = false;
    try {
      integrateBackupRef(bad);
    } catch {
      threw = true;
    }
    assert(threw, `(o) integrateBackupRef(${String(bad)}) throws rather than composing a dead ref`);
  }
  assert(
    integrateBackupRef(17) === ISSUE_17_BACKUP_REF,
    "(o) a positive integer still composes the documented ref name",
  );

  // #1396 (round 3, PM item d) — canary: the plain `worktreeList` carries the
  // timeout. It is the read the #654 sweep runs inside the integration path; a
  // regression that drops the bound there is invisible to every other test in
  // this file, which each use their own exec — so assert the option directly.
  {
    const seen: Array<number | undefined> = [];
    const spy: ExecFn = async (cmd, o) => {
      if (cmd === "git worktree list --porcelain") seen.push(o?.timeout);
      return { stdout: "" };
    };
    await worktreeList(spy, "/repo");
    assert(
      seen.length === 1 && seen[0] === WORKTREE_LIST_TIMEOUT_MS,
      `#1396 canary: worktreeList passes WORKTREE_LIST_TIMEOUT_MS to the executor (got ${String(seen[0])})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
