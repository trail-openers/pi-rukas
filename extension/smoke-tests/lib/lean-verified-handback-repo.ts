/**
 * lib/lean-verified-handback-repo — the git half of the verified-handback rig.
 *
 * The rule's cases are not only about a step log: the ones that matter assert what
 * ORIGIN holds afterwards, and "origin holds" is a fact read back with `ls-remote`,
 * never inferred from a local `rev-parse`. This is the module that makes a repo
 * whose origin can be moved, refused, and re-read — the log half lives beside it in
 * `lean-verified-handback-fixture.ts`, which is where the drive and the scripted
 * walks are.
 *
 * The one design fact worth carrying: a stranger that is meant to defeat a
 * `--force-with-lease` cannot be made in the run's own clone. See `strangerOnTop`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";
import { git, makeRepo } from "./lean-review-fixtures.ts";
import { BRANCH, ISSUE, ROOTS } from "./lean-verified-handback-fixture.ts";

/** What origin holds for one ref of any name, or `undefined` when it holds nothing. */
export function originRefSha(origin: string, ref: string): string | undefined {
  const r = spawnSync("git", ["ls-remote", ".", ref], {
    cwd: origin,
    encoding: "utf8",
    env: { ...gitTestEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0) throw new Error(`ls-remote ${ref} failed: ${(r.stderr ?? "").trim()}`);
  const out = (r.stdout ?? "").trim();
  if (out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return sha === "" ? undefined : sha;
}

/** Origin's branch, or `undefined` when origin has no such branch. */
export function originBranchSha(origin: string, branch = BRANCH): string | undefined {
  return originRefSha(origin, `refs/heads/${branch}`);
}

/**
 * The head the rule's cases use: a real head from a real repo, so a rewind driven
 * with it can be read back out of origin.
 */
export function shaOf(repoRoot: string, rev: string): string {
  return git(repoRoot, "rev-parse", rev);
}

/** Push an existing commit into origin's branch — how a case moves it behind lean's back. */
export function pushToOrigin(repoRoot: string, sha: string, branch = BRANCH): void {
  git(repoRoot, "push", "-q", "origin", `${sha}:refs/heads/${branch}`);
}

/**
 * A repo whose origin's branch holds a fix head pushed on top of the base commit.
 *
 * `baseSha` is the head the green `verify` certified and `headSha` the one the fix
 * wave put on top of it; both are real commits with real content, and
 * `branchHeadSha` is what origin's branch holds when the case starts — the head the
 * rewind's lease is bound to, and the one the keeping-ref must hold afterwards.
 *
 * The base is made reachable on origin under a ref of its own first: a push writes
 * objects, and origin would otherwise refuse the rewind for a reason that has
 * nothing to do with the lease.
 *
 * Every fact here is READ back off origin rather than assumed from the local repo:
 * a case whose "head the run pushed" was a local `rev-parse` could pass while
 * origin held something else, which is the whole subject of these cases.
 */
export function repoWithFixHead(): {
  repoRoot: string;
  origin: string;
  baseSha: string;
  headSha: string;
  branchHeadSha: string;
} {
  const { repoRoot, origin, baseSha } = makeRepo();
  ROOTS.push(repoRoot, origin);
  git(repoRoot, "checkout", "-q", "-B", BRANCH);
  git(repoRoot, "commit", "-q", "--allow-empty", "-m", "fix: the review's finding");
  const headSha = git(repoRoot, "rev-parse", "HEAD");
  // Keep the base reachable on origin by a name the rewind never touches, so the
  // rewind's push of it is refused only ever by its lease.
  git(repoRoot, "push", "-q", "origin", `${baseSha}:refs/lean/base/${String(ISSUE)}`);
  git(repoRoot, "push", "-q", "origin", `${headSha}:refs/heads/${BRANCH}`);
  const branchHeadSha = originBranchSha(origin);
  if (branchHeadSha !== headSha)
    throw new Error(
      `origin's branch holds ${String(branchHeadSha)}, not the fix head ${headSha} — every head fact below would be a guess`,
    );
  return { repoRoot, origin, baseSha, headSha, branchHeadSha };
}

/**
 * A commit on top of `base`, made in a scratch repo, PUSHED TO ORIGIN ONLY.
 *
 * Two properties the lease cases need together, and only this shape gives them.
 *
 * **Origin has moved and the run's clone has not been told.** A stranger cannot be
 * made in the run's own clone: `--force-with-lease=<ref>:<sha>` checks the sha
 * against the clone's remote-tracking ref, and a commit made and pushed locally
 * leaves that ref in exactly the state that makes a lease on the old head succeed —
 * so a case that moved origin that way would watch the rewind accept a branch
 * somebody else had moved and call it a refusal.
 *
 * **The run's clone has never seen the stranger's objects.** A clone of origin
 * would fetch the stranger's chain into the run's own object store, and the rewind's
 * push would then be refused by its lease rather than by git failing to supply the
 * objects the refspecs name. Both refusals are correct refusals; they print
 * different reasons, so the case that pins each has to produce exactly one of them.
 * Pushing from a scratch repo whose origin is the bare repo leaves the run's clone
 * holding nothing of the commit it is being refused over — which is the state a
 * resumed run whose clone never fetched the stranger is really in.
 */
export function strangerOnTop(
  repo: { repoRoot: string; origin: string },
  base: string,
  message: string,
): string {
  const other = mkdtempSync(path.join(tmpdir(), "lean-handback-other-"));
  ROOTS.push(other);
  git(other, "init", "-q", "-b", BRANCH);
  // The stranger is made on the run's base commit and pushed to origin directly, so
  // origin's branch moves ahead of what the run's clone was told — without ever
  // travelling through that clone's object store or its remote-tracking refs.
  git(other, "fetch", "-q", repo.repoRoot, base);
  git(other, "checkout", "-q", "-B", BRANCH, "FETCH_HEAD");
  git(other, "commit", "-q", "--allow-empty", "-m", message);
  const sha = git(other, "rev-parse", "HEAD");
  git(other, "push", "-q", "--force", repo.origin, `HEAD:refs/heads/${BRANCH}`);
  return sha;
}

/** A commit on top of `sha`, detached, so no branch moves. */
export function commitOnTop(repoRoot: string, sha: string, message: string): string {
  git(repoRoot, "checkout", "-q", "--detach", sha);
  git(repoRoot, "commit", "-q", "--allow-empty", "-m", message);
  return git(repoRoot, "rev-parse", "HEAD");
}

/**
 * Whether `repoRoot`'s object store holds `sha`.
 *
 * The cases use it as a PRECONDITION, not an assertion about lean: the stranger and
 * the unreachable-head arms are only the case they claim while the run's clone cannot
 * supply the objects the rewind's refspecs name, and `cat-file -e` is how a test finds
 * that out rather than assuming it. A scratch dir, not a checkout, so nothing here
 * moves a branch or a ref of the run's clone.
 */
export function cloneHolds(repoRoot: string, sha: string): boolean {
  const r = spawnSync("git", ["--git-dir", path.join(repoRoot, ".git"), "cat-file", "-e", sha], {
    cwd: existsSync(repoRoot) ? repoRoot : tmpdir(),
    encoding: "utf8",
    env: { ...gitTestEnv(), GIT_TERMINAL_PROMPT: "0" },
  });
  return r.status === 0;
}
