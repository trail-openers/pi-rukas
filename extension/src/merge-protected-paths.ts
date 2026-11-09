/**
 * merge-protected-paths — the protected-path predicate BOTH merge gates ask, at
 * the moment a merge is about to happen: which of the PR's own commits touch a
 * path that defines what verification, review and permission mean for this
 * repository.
 *
 * The develop-time protected-path gate halts a cycle that writes
 * `.github/`, `.pi/`, `CODEOWNERS` or `agents.json` unless the operator named
 * those paths with `--allow-protected`. Nothing at merge time knew about that
 * grant, so a cycle whose patch rewrote its own CI workflow could merge itself,
 * and an agent-run `gh pr merge` had the same hole. Both call sites ask THIS
 * module, so neither can drift on the protected set or on which side of a rename
 * counts.
 *
 * Four decisions the callers may not re-litigate:
 *
 *  - **The range is the merge-base, never a two-dot tip-to-tip diff.** A base
 *    that moved after the branch was cut would otherwise read as the branch
 *    reverting main's files, so a protected edit landed by *somebody else on
 *    main* would hold every cycle cut before it.
 *  - **The range is a commit range (`<mb>..<head>`, which is what
 *    `readCommittedProtectedPaths` spells when handed the two OIDs).** A
 *    `git diff A B` over two bare revs compares TREES and can pair a file across
 *    them by content; a commit range compares the COMMITS in between, which is
 *    what a PR is and what the review identity is computed over.
 *  - **A rename counts on both sides.** `changedPaths` gives the destinations and
 *    `renameSourcePaths` the sources, and both go through the protected
 *    predicate: `git mv .github/workflows/ci.yml src/ci.yml` is as much a
 *    protected write as the reverse. No caller applies the predicate to raw
 *    records — that is how a rename quietly disappears from a change set.
 *  - **Unreadable is not "nothing protected changed".** Every failed read returns
 *    `{ ok: false, unreadable }` naming the cause, and BOTH callers refuse on it.
 *    An empty list on a wedged git reads as a clean diff.
 *
 * **The OIDs are pinned by the caller:** `committedProtectedPaths` takes head and
 * base as object ids and issues no ref read of its own, because a gate that
 * re-resolved a moving ref between its reads would inspect one commit and merge
 * another.
 *
 * **It reads neither `PI_ENSEMBLE_PROTECTED_PATHS` nor `--allow-protected`** — the
 * switch disables the develop-time halt only, and the grant authorises a
 * develop-time write, not a merge.
 *
 * Every git call is the argv form with an explicit `timeout`: a hung filter
 * driver, a locked index or a wedged fetch must yield a refusal naming itself, not
 * a merge step that never answers. `execGit` in git-range.ts is not used — its
 * default bound is ten minutes, right for diff plumbing and wrong for a gate on
 * the merge path.
 */

import { resolveMainline } from "./mainline.ts";
import { errText } from "./protected-paths-text.ts";
import { remoteName } from "./review-ledger-path.ts";
import { LOCAL_GIT_TIMEOUT_MS } from "./review-patch-identity.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import {
  type ProtectedPathExec,
  changedPaths,
  readCommittedProtectedPaths,
  renameSourcePaths,
} from "./work-driver-protected-paths-read.ts";

/** The verdict of a protected-path read: the paths, or the reason none could be named. */
export type ProtectedMergeRead = { ok: true; paths: string[] } | { ok: false; unreadable: string };

/**
 * A git answer that is one object id and nothing else: two commits are the same
 * commit only when their OIDs are equal.
 */
const OID = /^[0-9a-f]{7,64}$/;

/** `git rev-parse --end-of-options <ref>` → the OID; throws naming the odd answer. */
async function revParse(exec: ProtectedPathExec, cwd: string, ref: string): Promise<string> {
  const { stdout } = await exec("git", {
    argv: ["rev-parse", "--end-of-options", ref],
    cwd,
    maxBuffer: 8 * 1024,
    timeout: LOCAL_GIT_TIMEOUT_MS,
  });
  const oid = stdout.trim();
  if (!OID.test(oid)) {
    throw new Error(
      `git rev-parse ${ref.slice(0, 60)} printed ${JSON.stringify(oid.slice(0, 40))}, not an object id`,
    );
  }
  return oid;
}

/** `git merge-base <a> <b>`, or the named reason there is no base to diff from. */
type MergeBaseRead = { ok: true; sha: string } | { ok: false; unreadable: string };

/** `git merge-base <a> <b>` → the OID; an empty or odd answer is a refusal, not a guess. */
async function mergeBaseOf(
  exec: ProtectedPathExec,
  cwd: string,
  a: string,
  b: string,
): Promise<MergeBaseRead> {
  let stdout = "";
  try {
    ({ stdout } = await exec("git", {
      argv: ["merge-base", "--end-of-options", a, b],
      cwd,
      maxBuffer: 8 * 1024,
      timeout: LOCAL_GIT_TIMEOUT_MS,
    }));
  } catch (err) {
    return { ok: false, unreadable: `git merge-base failed: ${errText(err)}` };
  }
  const sha = stdout.trim();
  // `git merge-base` exits 1 with no output on unrelated histories, and a
  // shallow clone whose history does not reach back prints nothing either. Both
  // are "there is no base", and neither is a licence to diff nothing.
  if (!OID.test(sha)) {
    return {
      ok: false,
      unreadable: `no merge-base between the head and the base (${JSON.stringify(sha.slice(0, 40))})`,
    };
  }
  return { ok: true, sha };
}

/**
 * The protected paths the committed diff from `merge-base(head, base)` to `head`
 * touches, or the reason that could not be established. `headOid` and `baseOid`
 * are object ids the CALLER resolved and holds, and the merge-base and the diff
 * are both taken over those two values — a ref that moves between the reads is how
 * a protected file goes missing from a change set while the read still claims to
 * have seen it.
 */
export async function committedProtectedPaths(
  exec: ProtectedPathExec,
  cwd: string,
  headOid: string,
  baseOid: string,
): Promise<ProtectedMergeRead> {
  for (const [what, oid] of [
    ["head", headOid],
    ["base", baseOid],
  ] as const) {
    if (!OID.test(oid)) {
      return {
        ok: false,
        unreadable: `the ${what} OID is not an object id: ${JSON.stringify(oid.slice(0, 40))}`,
      };
    }
  }
  const mb = await mergeBaseOf(exec, cwd, headOid, baseOid);
  if (!mb.ok) return mb;
  // The reader spells the range itself (`<base>..<head>`, one argv element after
  // `--end-of-options`), so the base goes in as the bare merge-base OID.
  const read = await readCommittedProtectedPaths(exec, cwd, mb.sha, headOid, {
    // The merge-path read carries its own bound: the develop gate keeps its
    // longer default, while a gate on the merge path answers with a refusal
    // rather than holding the step open.
    timeout: LOCAL_GIT_TIMEOUT_MS,
  });
  if (!read.ok) return { ok: false, unreadable: read.unreadable };
  const bothSides = [...changedPaths(read.targets), ...renameSourcePaths(read.targets)];
  return { ok: true, paths: protectedPathsIn(bothSides) };
}

/** Resolved refs for one merge decision: the two OIDs to diff, or the reason none. */
type MergeRefs = { ok: true; headOid: string; baseOid: string } | { ok: false; unreadable: string };

/**
 * Bring the two refs this read is over into the caller's tree through the
 * driver's bounded, non-interactive network-git seam, then resolve them to OIDs
 * ONCE. A wedged fetch is answered here, by the fetch that caused it, rather than
 * by the reads that follow it.
 */
async function fetchMergeRefs(
  exec: ProtectedPathExec,
  cwd: string,
  remote: string,
  headBranch: string,
  mainline: string,
  headOid?: string,
): Promise<MergeRefs> {
  const bad = netRefProblem(remote, headBranch, mainline);
  if (bad) return { ok: false, unreadable: `git fetch refused: ${bad}` };
  try {
    await runNetGit(exec, "git", {
      cwd,
      maxBuffer: 64 * 1024,
      argv: ["fetch", remote, headBranch, mainline],
    });
  } catch (err) {
    return {
      ok: false,
      unreadable: `git fetch of ${remote}/${headBranch} ${remote}/${mainline} failed: ${errText(err)}`,
    };
  }
  try {
    // The head is resolved only when the caller has no OID of its own: reading
    // a ref the caller already pinned is a second chance for it to have moved.
    const head = headOid ?? (await revParse(exec, cwd, `${remote}/${headBranch}`));
    return { ok: true, headOid: head, baseOid: await revParse(exec, cwd, `${remote}/${mainline}`) };
  } catch (err) {
    return { ok: false, unreadable: errText(err) };
  }
}

/**
 * The protected paths one PR's own commits touch, where the PR is named by its
 * head BRANCH and the base is the mainline. The remote and mainline are resolved
 * the way every review identity resolves them (`remoteName` + `resolveMainline`):
 * the question is what the PR's own commits change, and a review recorded against
 * the mainline is what any merge is licensed by.
 *
 * `headOid` is the OID a caller has already verified, so the gate inspects exactly
 * what the merge would land; a caller with no such value passes `undefined` and
 * gets the fetched `<remote>/<branch>`, resolved here once and never re-read.
 */
export async function mergeProtectedPathsForBranch(
  exec: ProtectedPathExec,
  cwd: string,
  headBranch: string,
  headOid?: string,
): Promise<ProtectedMergeRead> {
  const remote = await remoteName(exec, cwd);
  if (!remote) return { ok: false, unreadable: "no git remote found (origin/upstream/first)" };
  const mainline = await resolveMainline(cwd, exec);
  if (!mainline.ok) {
    return { ok: false, unreadable: `cannot resolve the mainline branch (${mainline.reason})` };
  }
  const refs = await fetchMergeRefs(exec, cwd, remote, headBranch, mainline.branch, headOid);
  if (!refs.ok) return refs;
  return committedProtectedPaths(exec, cwd, refs.headOid, refs.baseOid);
}
