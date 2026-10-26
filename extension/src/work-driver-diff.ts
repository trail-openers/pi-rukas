/**
 * work-driver-diff — git-shell diff reads.
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure git-shell
 * diff helpers with no DriverContext dependency, used throughout the step
 * handlers to resolve worktree diffs.
 * The reply-parsing leaves that used to sit here (countPriorStepStarts /
 * parseAbort / parseBranchName) now live in work-driver-diff-replies.ts, and the
 * branch-file read (readFileAtBranch) in work-driver-diff-branch-file.ts: both
 * moved out when #1634's diff gate pushed this module past the 500-line cap.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execp } from "./exec.ts";
import { aheadOfBase, execGit, prRange, treeHasCommit } from "./git-range.ts";
import { trace } from "./trace.ts";
import { type StatusEntry, parseStatus } from "./work-develop-git.ts";
import { fetchAllDiffs } from "./work-driver-diff-merged.ts";
import { resolveMainline } from "./work-driver-git.ts";
import { isDriverArtefactPath } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

/** Validate a git SHA before shell interpolation. */
const VALID_BASEDIFF_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The markers the merged-diff producer below writes BETWEEN per-workstream
 * sections. Exported because `adversarial-diff-cap.ts` has to recognise exactly
 * these lines as belonging to no file: a generic `^(## |\[)` prefix there would
 * also swallow a real diff body line that happens to start with `##` or `[`
 * (common in markdown, TOML tables and log fixtures) and count it as unattributed
 * prose. One producer, one set of constants, so the reader cannot drift from the
 * writer.
 */
/** The three markers `fetchAllDiffs` writes between/after workstream sections. */
export const MERGED_DIFF_MARKERS = {
  /** Opens each workstream's section. */
  workstreamPrefix: "## workstream: ",
  /** Appended to a workstream body the 1 MiB budget cut mid-piece. */
  pieceTruncated: "[... truncated]",
  /** Appended when whole workstreams were dropped for size. */
  truncatedAtTotal: "[... merged diff truncated at 1 MiB total]",
} as const;

export const MERGED_DIFF_WORKSTREAM_PREFIX = MERGED_DIFF_MARKERS.workstreamPrefix;
export const MERGED_DIFF_PIECE_TRUNCATED = MERGED_DIFF_MARKERS.pieceTruncated;
export const MERGED_DIFF_TRUNCATED_AT_TOTAL = MERGED_DIFF_MARKERS.truncatedAtTotal;

/**
 * #1634 — the per-worktree diff read, the twin of #384's `readIntegratedDiff`.
 *
 * It exists because the best-effort string answer cannot say "I could not
 * tell", and its consumers render `""` as "nothing to review": the adversarial
 * gate records `adversarial-skipped-empty-diff` with `rounds: 0` and passes the
 * workstream, so a worktree whose diff could not be read cleared the pre-commit
 * gate without a review. A gate whose no-signal answer is approval is a gate
 * that cannot fail — the same shape #384 removed from the lens path. There is
 * deliberately NO string projection of this read any more: `fetchDiff` had no
 * production caller left, and a `""`-on-failure wrapper is exactly the value
 * this type was introduced to make unrepresentable.
 *
 * Which cwd it is scoped to is load-bearing: a worktree, never the repo root
 * once that leaves the feature branch — the grep canary in
 * test-work-driver-diff-head-canary.ts protects that discipline.
 *
 * #453 — the primary read is `git diff baseSha..HEAD` whenever `baseSha` is a
 * valid 40-char hex SHA, because `git diff HEAD` is empty once the developer
 * commits (HEAD IS the commit). A non-empty committed range is the whole answer.
 * The fallback is `git diff HEAD` — DELIBERATE pre-commit semantics for callers
 * without a baseSha, and for the case where the range is empty because the
 * developer has not committed yet.
 *
 * `empty` is established POSITIVELY by the porcelain probe below: no tracked
 * change and no untracked file other than the driver's own records. A diff that
 * comes back blank with dirt in the tree is NOT reported as empty. A missing
 * `cwd` is unreadable too — "no worktree resolved yet" is a driver state the
 * gate must see, not an approval. The 1 MiB read cap bounds what a runaway
 * worktree can contribute to a dispatch prompt.
 *
 * The dirt probe SPARES the DRIVER's own records: the cycle's state file and
 * scratch all live INSIDE the worktree it reads (`.pi/work-state/`,
 * `.worktrees/`, `tmp/issue-<N>/`), so a naive porcelain check finds dirt in
 * every cycle and no genuinely-clean tree is ever provable — which would turn
 * this gate into one that parks every cycle instead of one that catches
 * unreadable diffs. The exemption is `isDriverArtefactPath` from
 * work-driver-verify-tree.ts, the SAME predicate that decides tree identity for
 * the consolidated verify (#1240): it exempts ONLY the untracked artefacts the
 * driver itself writes, so `?? tmp/evil.ts` and an untracked `.pi/other` stay
 * dirt, a tracked `.pi/` edit stays dirt, and the protected-path gate (#406)
 * still sees it. NOT the broad `.pi/`/`tmp/` exemption the dirty-root gates use
 * (work-driver-branch-residue.ts), which would wave through a file that changes
 * what the read sees.
 */
export type WorktreeDiff =
  | { ok: true; diff: string; empty: boolean }
  | { ok: false; reason: string; readFailed?: string };

export async function readWorktreeDiff(
  cwd: string | undefined,
  baseSha?: string,
  // Same seam readIntegratedDiff takes: a test supplies its own exec so a read
  // fails DETERMINISTICALLY instead of mutating process.env.PATH, which is a
  // race with any sibling test that spawns git.
  exec: ExecFn = execp,
): Promise<WorktreeDiff> {
  if (!cwd) return { ok: false, reason: "no worktree path resolved for this workstream" };
  // #1634 — "is there a working tree here at all" is asked FIRST, before any git
  // call, because it is the question git itself cannot answer for us: a plain
  // directory (a scratch `mkdtemp` fixture with no `git init`, or a worktree
  // path that has since vanished) makes `git diff HEAD` fail outright, and its
  // stderr — "Not a git repository", or "unknown revision" for a repository
  // with no commits — carries no "unreadable" to pattern-match on. Answering it
  // from the filesystem keeps the whole unreadable class ONE shape: a reason the
  // fan-out's failure event can be asserted against, rather than git's truncated
  // diagnostic. A real worktree always has a `.git` (a linked worktree's or a
  // submodule's is a gitfile pointing at the admin dir), so this costs one stat
  // per read and never changes the answer for a genuine worktree.
  //
  // PM's decision for #1634 is that production stays STRICT: a worktree that is
  // not a git repository, or has vanished, is the unreadable case this gate
  // exists for — never "there is nothing to review".
  if (!treeHasGitDir(cwd)) {
    // PM's ruling for #1634 is that production stays STRICT on a path that is
    // there but is not a repository: that is the shape a real integration
    // failure takes (a worktree removed under the driver, a `git worktree add`
    // that failed and left a bare checkout), and calling it "nothing to review"
    // is the bug this gate exists to close.
    return {
      ok: false,
      reason: `unreadable: ${cwd} is not a git working tree — an empty diff here means the worktree could not be read, not that there is nothing to review`,
    };
  }
  // Does this tree have a commit yet? Asked ONCE, because two later questions
  // depend on it and each used to ask in its own way — which is how the
  // pre-initial-commit case got a different answer from one call site to the
  // next. A young repository is not an unreadable one: `git diff HEAD` is fatal
  // without a HEAD and `git status` proves nothing about a tree with no commit
  // to be clean relative to, so a cycle whose developer has not committed (and
  // a driver harness that never ran the branch step) must read as EMPTY, not
  // fail with "could not establish whether the tree has changes".
  const hasHead = await treeHasCommit(exec, cwd);
  // #453 — try committed diff first when baseSha is available and valid.
  // `git diff baseSha..HEAD` shows everything the developer committed,
  // which `git diff HEAD` misses once the working tree is clean.
  const shaValid = baseSha !== undefined && VALID_BASEDIFF_SHA_RE.test(baseSha);
  // The committed range read, carried forward to the fallback below: a valid
  // baseSha asks git for the SAME range twice otherwise, because `diffRange`
  // resolves to `${baseSha}..HEAD` whenever the SHA is valid.
  let committedRange: string | undefined;
  if (shaValid) {
    try {
      const stdout = await execGit(exec, cwd, ["diff", "--end-of-options", `${baseSha}..HEAD`], {
        maxBuffer: 1024 * 1024,
      });
      committedRange = stdout;
      // A non-empty committed diff is the whole answer; the probe below only
      // decides what a BLANK one means.
      if (stdout.trim()) return { ok: true, diff: stdout, empty: false };
    } catch (err) {
      // #1153 — an invalid baseSha is refused by both branches, so reaching
      // here means a VALID ref git itself could not resolve. That is a failure
      // to read, not "the developer committed nothing": falling through to
      // `git diff HEAD` would answer a range the gate asked about with a
      // different one, and the pre-commit case that legitimately falls through
      // is the tree-dirty probe below.
      return {
        ok: false,
        reason: `git diff ${baseSha}..HEAD failed: ${errText(err)}`,
        readFailed: "git diff <baseSha>..HEAD",
      };
    }
  }
  // Fallback: uncommitted diff — DELIBERATE pre-commit semantics for callers
  // without a baseSha and for the case where baseSha..HEAD is empty
  // (developer hasn't committed yet).
  // #1153 — the SHA gate applies here too: the primary branch above already
  // refuses an invalid baseSha, and interpolating one into the fallback
  // would just move the unsanitised value to the other call site.
  const diffRange = shaValid ? `${baseSha}..HEAD` : "HEAD";
  let diff: string;
  if (committedRange !== undefined) {
    // The fallback asks for exactly the range the primary read already
    // returned — and it returned SUCCESSFULLY, since a throw above answered
    // unreadable. Re-running it would be a second git fork for one answer.
    diff = committedRange;
  } else {
    try {
      diff = await execGit(exec, cwd, ["diff", "--end-of-options", diffRange], {
        maxBuffer: 1024 * 1024, // 1 MiB cap
      });
    } catch (err) {
      // A tree with no commit yet has no `HEAD` to diff against, and git calls
      // that fatal (`ambiguous argument 'HEAD'`) rather than answering empty.
      // That is the pre-initial-commit state every worktree passes through, not
      // a failed read — answering UNREADABLE here parked a cycle whose developer
      // had simply not committed. `hasHead` is the hoisted answer.
      if (!hasHead) {
        diff = "";
      } else {
        return {
          ok: false,
          reason: `git diff ${diffRange} failed: ${errText(err)}`,
          readFailed: `git diff ${diffRange}`,
        };
      }
    }
  }
  if (!diff.trim()) {
    // Blank, and a real tree. Decide WHICH blank this is: a clean tree (nothing
    // to review) or a read that produced nothing while the tree holds work.
    //
    // A tree with no commit has nothing to be clean RELATIVE to — `git status`
    // cannot answer that question, and asking it produced "could not establish
    // whether the tree has changes" for every pre-commit case. Nothing is
    // committed, nothing is diffable: that is empty, positively established.
    if (!hasHead) return { ok: true, diff: "", empty: true };
    const entries = await worktreeStatusEntries(exec, cwd);
    if (entries === undefined) {
      return {
        ok: false,
        reason: `could not establish whether ${cwd} has changes against ${diffRange}`,
        // The diff itself read blank and CLEAN — so what failed is the probe
        // that decides whether a blank means "nothing to review".
        readFailed: "git status --porcelain -z --untracked-files=all",
      };
    }
    if (entries.length === 0) return { ok: true, diff: "", empty: true };
    return {
      ok: false,
      reason: `git diff ${diffRange} came back empty but the tree is not clean — uncommitted work exists that the diff did not show`,
    };
  }
  return { ok: true, diff, empty: false };
}

/**
 * The uncommitted entries of `cwd`, with the driver's own artefacts removed —
 * `undefined` when the read or the parse failed (never `false`-as-"unknown":
 * the caller must tell "clean" from "could not tell").
 *
 * ONE probe, not two. The previous shape also ran `git diff --quiet <range>`,
 * which porcelain strictly covers: `status --porcelain` reports every tracked
 * modification and deletion, so the extra fork decided nothing and cost a
 * process per blank diff. The stream is parsed by `parseStatus`
 * (work-develop-git.ts) — the SAME reader the develop step's save/reset uses,
 * so renames (`R  new\0orig\0`, whose origin is its own NUL token) and
 * malformed payloads are handled here rather than by a fourth local predicate.
 * Read with `-z` so a path carrying a newline, quote or control byte arrives
 * verbatim instead of C-quoted; a payload the reader cannot parse is
 * `undefined`, never a `true` that approves a review.
 */
async function worktreeStatusEntries(
  exec: ExecFn,
  cwd: string,
): Promise<StatusEntry[] | undefined> {
  let stdout: string;
  try {
    // 4 MiB: porcelain is one short line per path, but a tree with tens of
    // thousands of untracked files must not trip the default buffer and be
    // reported as "could not tell" when the answer was readable all along.
    stdout = await execGit(exec, cwd, ["status", "--porcelain", "-z", "--untracked-files=all"], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  const parsed = parseStatus(stdout);
  if ("unreadable" in parsed) return undefined;
  // The driver's own records are not the developer's work — see the read's
  // docstring for why the predicate is the NARROW one.
  return parsed.filter((e) => !(e.untracked && isDriverArtefactPath(e.path)));
}

/**
 * Does `cwd` resolve to a git working tree — i.e. is there a tree here for git
 * to read at all? True for a normal clone, a linked worktree and a submodule
 * checkout (the last two carry `.git` as a gitfile pointing at the admin dir);
 * false for a plain directory, a scratch `mkdtemp` fixture, or a vanished path.
 * Deliberately a filesystem probe rather than `git rev-parse --git-dir`: the
 * question is "is there a tree here to read", and a fork per blank diff is
 * worth paying for a gate that cannot be fooled by an empty-string answer.
 */
function treeHasGitDir(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * #287 — the integrated diff, read at repoRoot from the pushed branch:
 * `origin/<mainline>...origin/<branch>` (three-dot, from the merge base —
 * #1134). This is the shape lens-review wants once `integrate()` has committed
 * and pushed, and it is independent of any worktree's HEAD (which stays
 * detached at baseSha).
 *
 * #384 — this read is the ONLY one, and it is able to say "I could not tell".
 * Its former best-effort twin `fetchIntegratedDiff` swallowed every error and
 * returned `""`, and `runLens` treats an empty diff as APPROVED: a transient
 * git failure, a stale `origin/<branch>` ref, or a `maxBuffer` overrun all
 * produced the same value as "there is genuinely nothing to review", and that
 * value meant approve, then merge. A gate whose no-signal answer is approval is
 * a gate that cannot fail — the same defect #380 removed from the merge step.
 * There is deliberately no string projection any more: it had no caller, and a
 * `""`-on-failure wrapper is the value this type exists to make unrepresentable.
 *
 * `empty` is established POSITIVELY, by counting commits ahead of base, rather
 * than inferred from the absence of output. Proving the green is the whole
 * difference between a gate and a formality.
 */
export type IntegratedDiff =
  | { ok: true; diff: string; empty: boolean }
  | { ok: false; reason: string };

function errText(err: unknown): string {
  return ((err as Error).message ?? String(err)).slice(0, 200);
}

export async function readIntegratedDiff(
  repoRoot: string,
  branchName: string,
  // The same injection seam `readWorktreeDiff` takes, so a test makes this read
  // fail deterministically instead of mutating process.env.PATH.
  exec: ExecFn = execp,
): Promise<IntegratedDiff> {
  // The mainline, resolved by resolveMainline (#1134) — the same call verify-pr17
  // makes, so both read one base. Unresolved means there is no base to diff
  // against: unreadable, not a guessed "main". A throw or unexpected shape is
  // the same unresolved outcome, never an escaping exception.
  const mainline = await resolveMainline(repoRoot, exec);
  // The mainline is unknowable, so the diff below would be meaningless.
  if (!mainline.ok) return { ok: false, reason: mainline.reason };
  const base = mainline.branch;
  let diffOut: string;
  try {
    // Three-dot: the diff is taken from the MERGE BASE, so a base that moved
    // after the branch was cut contributes nothing. Two-dot would diff the
    // branch tip against the base tip and report the base's new commits as
    // reversed (phantom CRITICAL findings, #1134).
    diffOut = await execGit(exec, repoRoot, [
      "diff",
      "--end-of-options",
      prRange(`origin/${base}`, `origin/${branchName}`),
    ]);
  } catch (err) {
    return {
      ok: false,
      reason: `git diff origin/${base}...origin/${branchName} failed: ${errText(err)}`,
    };
  }
  if (diffOut.trim()) return { ok: true, diff: diffOut, empty: false };
  // Empty output. Confirm it means "no commits ahead" rather than "the read
  // silently produced nothing" — those are the two cases this whole type
  // exists to separate.
  // The PR's own commits, whatever the base has done since (#1134).
  const ahead = await aheadOfBase(exec, repoRoot, `origin/${base}`, `origin/${branchName}`);
  switch (ahead.kind) {
    case "empty":
      return { ok: true, diff: "", empty: true };
    case "ahead":
      // Commits exist but the diff is empty. Possible legitimately (an empty
      // commit, or changes that cancel out), but it is not something to approve
      // on silently.
      return {
        ok: false,
        reason: `branch is ${ahead.n} commit(s) ahead of origin/${base} but the diff came back empty`,
      };
    case "unpushed":
      return {
        ok: false,
        reason: `origin/${branchName} not found in this clone — the branch was not pushed from here`,
      };
    case "unresolved":
      return { ok: false, reason: ahead.reason };
    case "unknown":
      return { ok: false, reason: ahead.error };
  }
}

/** Paths a unified diff touches, in order, deduplicated. */
export function pathsInDiff(diff: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const p = line.slice(4).replace(/^b\//, "").trim();
    if (p === "/dev/null" || p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * #384 — `fetchAllMergedDiffs` with the failure case preserved.
 * The plain version cannot distinguish "nothing to review" from "could not
 * find out", and `runLens` approves on both. Lens review is the last gate
 * before merge, so it is the one place that distinction has to survive.
 */
export async function readAllMergedDiffs(
  worktrees: Record<string, string>,
  repoRoot: string,
  branchName?: string,
  baseSha?: string,
  exec: ExecFn = execp,
): Promise<IntegratedDiff> {
  // With a branch name the integrated read is authoritative in BOTH
  // directions: a confirmed-empty diff means no commits ahead of base, which
  // no per-worktree read can contradict, and a failure means we do not know.
  if (branchName) return readIntegratedDiff(repoRoot, branchName, exec);
  // N>1 per-worktree diff path: each worktree's diff is relative to its own
  // baseSha (the detatch point), so we can read committed work with
  // `git diff <baseSha>..HEAD`. Without baseSha we fall back to `git diff
  // HEAD` (uncommitted work only), which is correct for pre-commit
  // scenarios but would return empty after a developer commit.
  const ids = Object.keys(worktrees);
  if (ids.length > 0) {
    // #1634 — the same failure case kept for the lens path's no-branch leg:
    // `fetchAllDiffs` folded every per-worktree read failure into "", and
    // `empty: !diff.trim()` then reported it as a CONFIRMED empty diff, which
    // `runLens` skips to `lens-approved`. One unreadable workstream now makes
    // the whole read unreadable — the review cannot approve over it.
    //
    // M3 — `empty` DERIVES from the reads, not from the merged string. The
    // `## workstream: <id>` headers make a merged document non-empty even when
    // every body is blank, so a caller that asked `!diff.trim()` would see a
    // non-empty diff and dispatch a reviewer over headers alone (the PR7
    // hallucination this producer's header rule exists to prevent). A single
    // source of the answer: every read succeeded AND reported itself empty.
    const all = await fetchAllDiffs(worktrees, repoRoot, baseSha, exec);
    if (!all.ok) return { ok: false, reason: all.reason };
    return { ok: true, diff: all.diff, empty: all.empty };
  }
  // No branch and no worktrees: we cannot read a diff, so fail closed.
  // A confirmed-empty diff (branch exists, nothing ahead) is different —
  // it means there is genuinely nothing to review.
  return { ok: false, reason: "no branch name and no worktrees to diff" };
}
