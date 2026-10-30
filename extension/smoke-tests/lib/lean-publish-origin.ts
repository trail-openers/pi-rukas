/**
 * lib/lean-publish-origin — the shapes origin's run branch can be in BEFORE the
 * `lean/publish` step looks, built against a real bare origin.
 *
 * Split out of `lean-publish-fixture.ts` when the rerun cases grew it past the
 * file-size cap: the fixture builds a tree and runs the step, this file only
 * arranges what origin already holds. Keeping them separate also keeps the
 * distinction the tests turn on — the step's behaviour is one thing, the state
 * of the remote it meets is another.
 *
 * Every shape here is built by PUSHING, never `update-ref`'d: a push is the only
 * path that carries the objects into the bare origin, so a case that later reads
 * the ref back is reading a remote that could exist.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "./lean-verify-fixture.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ORIGIN_ROOTS: string[] = [];

/**
 * What origin's run branch already holds before the step looks.
 *
 * - `true` — the realistic stale branch: cut from an older main, holding four of
 *   its own commits, 4 ahead of this head and non-fast-forward from it.
 * - `"descendants-reach"` — the same branch capped with a MERGE that already
 *   contains this head, so `rev-list --count ^HEAD <remote>` reads 0: the shape a
 *   count-based gate cannot see at all.
 * - `"stale-branch"` — a single ancestor commit, the shape the first version of
 *   this feature gated on.
 * - `"fast-forward"` — origin's branch at `HEAD~1`, so the push is a fast-forward
 *   rather than a rewrite.
 */
export type OriginStale = boolean | "stale-branch" | "fast-forward" | "descendants-reach";

/** Commit one file in `dir` and return the new head. */
export function commitFile(dir: string, name: string, text: string, msg: string): string {
  writeFileSync(path.join(dir, name), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Origin holds a commit of ANOTHER repo on the branch — work this run never made
 * and shares no history with. What keeps such a branch safe is the pair of
 * checks around the push (the forge's open-PR read, and origin read back after
 * it), not git's own non-fast-forward rule.
 */
export function seedForeignOrigin(opts: {
  origin: string;
  branch: string;
}): void {
  const other = mkdtempSync(path.join(tmpdir(), "lean-publish-other-"));
  ORIGIN_ROOTS.push(other);
  git(other, "init", "-q", "-b", opts.branch);
  git(other, "remote", "add", "origin", opts.origin);
  writeFileSync(path.join(other, "foreign.ts"), "export const foreign = 1;\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "foreign work");
  git(other, "push", "-q", "origin", `HEAD:refs/heads/${opts.branch}`);
}

/**
 * Origin's branch sits at `HEAD~1` of the worktree: a rerun that only re-publishes
 * its own history, so the push is a FAST-FORWARD — the shape `git push
 * --porcelain` prints UNBRACKETED (`abc..def`), which is why flag regexes are not
 * the step's success check.
 */
export function seedFastForwardOrigin(opts: { wt: string; branch: string }): void {
  git(opts.wt, "push", "-q", "origin", `HEAD~1:refs/heads/${opts.branch}`);
}

/**
 * Origin's branch is a single ancestor commit of the worktree's head: the shape
 * the first version of this feature gated on (`rev-list --count ^HEAD <remote>`
 * == 1). Kept so the widened rule still covers the narrow case.
 */
export function seedOneCommitStaleOrigin(opts: { wt: string; branch: string }): void {
  const prev = git(
    opts.wt,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    git(opts.wt, "rev-parse", "HEAD^"),
    "-m",
    "feat: the previous run's head",
  );
  git(opts.wt, "push", "-q", "--force-with-lease", "origin", `${prev}:refs/heads/${opts.branch}`);
}

/**
 * The realistic stale branch: cut from the OLDER main (`baseMain`) and holding
 * FOUR commits of its own, none of them in this rerun's history, while the
 * rerun's head sits on the newer main. `rev-list --count ^HEAD <remote>` answers
 * 4 — exactly why the step may not gate its lease on that number.
 *
 * `containsHead` caps that branch with a MERGE whose second parent is the
 * rerun's head, so the same count answers ZERO: the shape the old gate could
 * never see, because a stale branch that already contains our work looked like
 * nothing to replace while four commits of stale work still stood on it.
 */
export function seedStaleOrigin(opts: {
  origin: string;
  branch: string;
  baseMain: string;
  wt: string;
  issue: number;
  containsHead?: boolean;
}): void {
  const stale = mkdtempSync(path.join(tmpdir(), "lean-publish-stale-"));
  ORIGIN_ROOTS.push(stale);
  git(stale, "init", "-q", "-b", opts.branch);
  git(stale, "remote", "add", "origin", opts.origin);
  git(stale, "fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main");
  git(stale, "checkout", "-q", "-B", opts.branch, opts.baseMain);
  if (opts.containsHead === true) {
    git(opts.wt, "push", "-q", "origin", `HEAD:refs/heads/lean/rerun-${opts.issue}`);
    git(stale, "fetch", "-q", "origin", `refs/heads/lean/rerun-${opts.issue}:refs/rerun`);
  }
  for (let i = 1; i <= 4; i++) {
    commitFile(stale, `previous-${i}.ts`, `export const p${i} = ${i};\n`, `feat: run ${i}`);
  }
  if (opts.containsHead === true) {
    git(
      stale,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge: the rerun's head, from the first attempt",
      "refs/rerun",
    );
  }
  git(stale, "push", "-q", "origin", `HEAD:refs/heads/${opts.branch}`);
}
