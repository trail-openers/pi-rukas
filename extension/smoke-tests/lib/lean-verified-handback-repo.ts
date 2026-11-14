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
 * The one design fact worth carrying: the two strangers here are NOT
 * interchangeable, and which one a case gets decides whether the lease refuses, accepts,
 * or never gets asked. See `strangerOnTop` and `moveOriginBehindClone`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
 * made in the run's own clone and pushed from it: a push refreshes
 * `refs/remotes/origin/<branch>`, and the rewind's `ls-remote` would then read the
 * stranger as origin's own value and bind the lease to it — a lease that matches is a
 * lease that accepts, so a case that moved origin that way would watch the rewind
 * rewrite somebody else's commit and call it a refusal. The only thing the
 * expected-value lease compares against is the sha the step read off origin, so
 * refusing a move needs origin to hold something the step's own read did not name.
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

/**
 * Move origin's branch to `sha` WITHOUT this clone's remote-tracking ref following.
 *
 * The lease the rewind builds carries its EXPECTED value — `<ref>:<sha this step read
 * off origin>` — so a case that wants the lease to be the thing that refuses has to
 * make origin hold something other than the sha the step will read, and it has to do
 * that without telling this clone. A push from this clone refreshes
 * `refs/remotes/origin/<branch>` and a fetch refreshes it too; either way the case has
 * destroyed the state it claims to pin. A ref written straight into origin's ref store
 * (`forceOriginRef`) does not need a transport, but origin then names bytes nobody can
 * supply, and the push dies in transport (`bad object`) before the lease is evaluated.
 *
 * So the stranger is made in this clone — which is what puts its objects where the
 * rewind's push can supply them — and origin is moved behind the clone's back by
 * rewriting origin's own ref file to the sha the case already knows origin was pushed
 * to. Origin is the fixture's private bare repo, and `ls-remote` — the read the rewind
 * under test makes — reports exactly this value.
 *
 * The case that uses it asserts BOTH halves of its own premise: that the clone holds
 * the stranger's objects (so a refusal is the lease's and not a transport failure),
 * and that the clone's tracking ref still names the head the run pushed (so the lease
 * really is the mismatched one).
 */
/**
 * Move origin's branch to a commit this clone made, WITHOUT this clone being told.
 *
 * The counterpart to `strangerOnTop`, and the reason both exist is that the two
 * refusal arms a lease case can be in are built by opposite moves. This one builds the
 * arm where the lease is SATISFIED and the rewind must still land a non-fast-forward
 * move: origin's branch really has moved, origin really holds the objects, and this
 * clone was told nothing — so the step's `ls-remote` reads the stranger, binds the
 * lease to it, and the lease accepts.
 *
 * Two operations, because neither alone does the job (each measured on git 2.53.0):
 *
 *   - a push FROM this clone to the branch carries the objects but refreshes
 *     `refs/remotes/origin/<branch>`, so the clone is told — and a `fetch` tells it just
 *     as well. Pushing to a ref the rewind never names carries the same objects while
 *     leaving that tracking ref where it was, which is the only way to get objects into
 *     origin from a repo that holds them without announcing the move;
 *   - the branch is then repointed at that sha by ref file (`forceOriginRef`) — the half
 *     that tells nobody. Written on its own it would name bytes origin has never
 *     received, and the rewind's push would die in transport (`bad object`) before the
 *     lease was evaluated, which is `strangerOnTop`'s arm.
 *
 * So: the objects travel on a side ref, and the branch moves by ref file. Both halves
 * are read back here rather than assumed — a control that asserted a landed rewind while
 * origin had not moved, or while the objects were missing, would be pinning an accident.
 */
export function moveOriginBehindClone(
  repo: { repoRoot: string; origin: string },
  sha: string,
  branch = BRANCH,
): void {
  const before = originBranchSha(repo.origin, branch);
  // Half one: the objects travel, on a ref the rewind never names, from the clone that
  // holds them. `--force` because the ref may already exist from an earlier call here.
  git(repo.repoRoot, "push", "-q", "--force", "origin", `${sha}:refs/lean/stranger/${String(ISSUE)}`);
  // Half two: the branch is repointed, by ref file, at a sha origin now really holds.
  forceOriginRef(repo.origin, sha, `refs/heads/${branch}`);
  if (originBranchSha(repo.origin, branch) !== sha)
    throw new Error(
      `origin's ${branch} was not moved: it holds ${String(originBranchSha(repo.origin, branch))}, not ${sha}`,
    );
  if (before === sha)
    throw new Error(`origin's ${branch} already held ${sha}, so this case moved nothing`);
  if (!cloneHolds(repo.repoRoot, sha))
    throw new Error(
      `the run's clone does not hold ${sha.slice(0, 12)}, so the rewind below would die in transport and not land`,
    );
}

/** A commit on top of `sha`, detached, so no branch moves. */
export function commitOnTop(repoRoot: string, sha: string, message: string): string {
  git(repoRoot, "checkout", "-q", "--detach", sha);
  git(repoRoot, "commit", "-q", "--allow-empty", "-m", message);
  return git(repoRoot, "rev-parse", "HEAD");
}

/**
 * Make `sha` origin's own value for one ref of ANY name — by name, not by content.
 *
 * The stranger arms move the branch by PUSHING a commit, which carries objects; the
 * forged-head arm has to make origin name a sha no clone holds anywhere, and every
 * normal way of doing that is refused before the case reaches the code under test: a
 * push of such a sha dies in transport (`bad object`), and `update-ref` refuses a
 * nonexistent object whatever `receive.denyCurrentBranch` says — that setting governs
 * pushes to the current branch, not this validity check. So the ref file is written
 * directly, which is the only operation that makes a git repository name bytes it does
 * not have. Origin is the fixture's own private bare repo; `ls-remote` — the read the
 * rewind under test makes — reports exactly this sha for the ref.
 */
export function forceOriginRef(origin: string, sha: string, ref: string): void {
  const dir = path.join(origin, ...ref.split("/"));
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, `${sha}\n`, { encoding: "utf8" });
}

/**
 * A branch of ANOTHER name on the fixture's origin, holding `sha`.
 *
 * The non-lean-branch case needs origin to hold a branch the rewind is never allowed
 * to touch — and a target that does not exist would make a missing guard fail in
 * transport rather than land, which is the difference between pinning a refusal and
 * pinning an accident. The run's clone already holds `sha`, so the push is ordinary.
 */
export function pushBranchOnOrigin(repoRoot: string, sha: string, branch: string): void {
  git(repoRoot, "push", "-q", "--force", "origin", `${sha}:refs/heads/${branch}`);
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
