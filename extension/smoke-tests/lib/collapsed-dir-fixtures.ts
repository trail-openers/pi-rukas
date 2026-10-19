/**
 * Fixtures for the #1642 collapsed-directory rule in `worktree-loss.ts`.
 *
 * The rule: a git-COLLAPSED ignored entry (`!! dist/`) is exempt from worktree
 * loss ONLY when its TOP-LEVEL path segment names a known build output. Git
 * collapses ANY directory with no tracked entry, so the collapse alone proves
 * nothing about the contents — `!! .secrets/` and `!! data/` collapse exactly
 * like `!! dist/`, and an exemption keyed on the shape alone would let
 * `git worktree remove --force` delete a private key.
 *
 * What makes these fixtures fiddly is that the two shapes producing a collapse
 * have to be set up on the BASE commit, not in the worktree:
 *  - a directory nobody has ever tracked (`crates/`), and
 *  - a directory whose only tracked file sits in a SUBdirectory (`myapp/keep.txt`
 *    is tracked, so `dist/` inside it exists in the tree while `myapp/dist/`
 *    itself stays untracked and collapses).
 * Ignoring a name without tracking anything under it is done through
 * `.git/info/exclude`, which is not a tracked file — so it changes no tree and
 * leaves each worktree's porcelain showing the collapsed entry and nothing else.
 *
 * A dirty fixture is reported by the #545 sibling scan beside whatever case runs
 * next, hiding that case's assertion, so every case removes its own worktree once
 * its finding has been read — which is why `collapsedFinding` returns the finding
 * rather than the path.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, realExec } from "./worktree-fake-fixture.ts";
import { type DirtyWorktreeFinding, inspectWorktreeForLoss, worktreeRemove } from "../../src/worktree.ts";

/** Ignore these directory names repo-wide without tracking anything under them. */
export const COLLAPSED_IGNORES = ["build/", "target/", ".secrets/", "data/", "myapp/", "crates/"];

/**
 * The base commit every collapsed-directory case is cut from: `myapp/keep.txt`
 * tracked (so `myapp/` exists in the tree but stays collapsible above it), and
 * `COLLAPSED_IGNORES` in the shared `.git/info/exclude`. Returns the SHA.
 */
export async function makeCollapsedBase(
  repo: string,
  fromRef: string,
  setupName = "collapsed-setup",
): Promise<string> {
  const wt = path.join(repo, ".worktrees", setupName);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, fromRef]);
  mkdirSync(path.join(wt, "myapp"), { recursive: true });
  writeFileSync(path.join(wt, "myapp", "keep.txt"), "tracked\n");
  await git(wt, ["add", "-f", "myapp/keep.txt"]);
  await git(wt, ["commit", "-q", "-m", "track one file under myapp/"]);
  const sha = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
  await worktreeRemove(realExec, repo, setupName, true).catch(() => undefined);
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  writeFileSync(path.join(repo, ".git", "info", "exclude"), COLLAPSED_IGNORES.join("\n") + "\n");
  return sha;
}

/**
 * One collapsed-directory case: a worktree at `baseSha` whose only dirt is
 * `dir/file`, inspected under the DEFAULT (removal) options — the question is
 * "is this worktree safe to force-remove?" — then removed.
 */
export async function collapsedFinding(
  repo: string,
  name: string,
  baseSha: string,
  dir: string,
  file: string,
  contents: string,
): Promise<DirtyWorktreeFinding | undefined> {
  const wt = path.join(repo, ".worktrees", name);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  mkdirSync(path.join(wt, dir), { recursive: true });
  writeFileSync(path.join(wt, dir, file), contents);
  const finding = await inspectWorktreeForLoss(realExec, repo, wt, baseSha);
  await worktreeRemove(realExec, repo, name, true).catch(() => undefined);
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  return finding;
}
