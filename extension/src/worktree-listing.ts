/**
 * worktree-listing — the read side of `git worktree list`, and the two
 * decisions that hinge on whether that read ANSWERED.
 *
 * Split from `worktree.ts` (AGENTS.md §12's 500-line gate; re-exported from
 * there so every caller keeps its existing import path). The seam is the
 * listing itself: everything here asks git "which worktrees exist" and then
 * decides what a non-answer MEANS, which is a different question from
 * creating, removing, or provisioning a tree.
 *
 * The timeout policy (#1396), stated once and enforced at every read in this
 * file and in `work-driver-branch-holder.ts`:
 *
 *   Every `git worktree list` the harness runs carries `WORKTREE_LIST_TIMEOUT_MS`.
 *   `ExecFn`'s `timeout` is only honoured when the executor passes it to
 *   `execFile`, so an unbounded listing that hangs — a stale `worktree` lock,
 *   an uninterruptible I/O wait — never rejects, and the retry in
 *   `listWorktreeStrict` never gets a first attempt to fail. The call sits
 *   inside the integration lock, so a hang there holds the lock forever. A
 *   bound makes a hang a bounded rejection.
 *
 * And the rule that bound makes load-bearing (#1396 round 3): a rejection is
 * NOT an empty list. `isMissingGit` is the only rejection that means "there is
 * nothing here", and every caller that used to `catch → ""`/`catch → []` has to
 * decide with that distinction in hand — a hang that reads as "no holder" or
 * "no leftovers" is a fail-open wearing the clothes of a clean result.
 */

import path from "node:path";
import { trace } from "./trace.ts";
import {
  DirtyWorktreeError,
  type DirtyWorktreeFinding,
  WorktreeScanError,
  inspectWorktreeForLoss,
} from "./worktree-loss.ts";
import { type ExecFn, gitErrorDetail, isMissingGit, resolvePath } from "./worktree.ts";

/**
 * #1396 — the bound on every `git worktree list` the worktree helpers run.
 * `ExecFn`'s `timeout` is only honoured when the executor passes it to
 * `execFile`, so a listing that hangs — a stale `worktree` lock, an
 * uninterruptible I/O wait — never rejects, and the retry in
 * `listWorktreeStrict` never gets a first attempt to fail. The call sits
 * inside the integration lock, so a hang there holds the lock forever.
 * Passing the bound makes a hang a bounded rejection, which the strict
 * listing turns into a `WorktreeScanError` naming the attempts. Same 30s as
 * the other local git reads (`GIT_TIMEOUT_MS` in
 * `work-driver-lens-fix-reposition-queries.ts`).
 */
export const WORKTREE_LIST_TIMEOUT_MS = 30_000;

/**
 * The strict listing — an unreadable `git worktree list` throws.
 *
 * #1396 — `timeoutMs` is a seam for tests that inject a never-resolving
 * executor (a real 30s wait would not belong in the offline suite); every
 * production caller leaves it at `WORKTREE_LIST_TIMEOUT_MS`.
 */
async function listWorktreePorcelain(
  execFn: ExecFn,
  repoRoot: string,
  timeoutMs = WORKTREE_LIST_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFn("git worktree list --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}

/**
 * #1170 — the strict listing for the branch step's sibling scan. A transient
 * `git worktree list` failure is retried once (250ms) before it refuses, so a
 * single flaky read does not park a clean cycle; the refusal names the attempts.
 *
 * #1396 — shared with the integrate step's stale-tree discriminator
 * (`isRegisteredWorktree`): every read whose failure would let a removal
 * through uses THIS helper, so "could not read the listing" is one
 * `WorktreeScanError` shape everywhere, not a per-caller invention.
 *
 * #1396 (six-lens round) — each attempt carries `WORKTREE_LIST_TIMEOUT_MS`, so
 * a HANG is a failure too. Without it the retry loop could only ever see a
 * command that *rejected*: a `git worktree list` that never answered held the
 * integration lock indefinitely and the 250ms retry never fired, which is the
 * same unbounded wait the rest of the git seams bound.
 */
export async function listWorktreeStrict(
  execFn: ExecFn,
  repoRoot: string,
  timeoutMs = WORKTREE_LIST_TIMEOUT_MS,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await listWorktreePorcelain(execFn, repoRoot, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new WorktreeScanError(`${gitErrorDetail(lastErr)} (after 2 attempts)`);
}

export async function worktreeList(execFn: ExecFn, repoRoot: string): Promise<string> {
  const { stdout } = await execFn("git worktree list --porcelain", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
    // #1396 — the same bound every other listing carries: this one is called
    // from the #654 branch-holder sweep, which runs inside the integration
    // path, and an unbounded hang there is the same lock-holding defect.
    timeout: WORKTREE_LIST_TIMEOUT_MS,
  });
  return stdout;
}

/** Inspect every listed worktree whose path matches a substring. */
async function inspectListedWorktrees(
  execFn: ExecFn,
  repoRoot: string,
  list: string,
  fromRef: string,
  pathSubstrings: string[],
  exclude?: string,
): Promise<{ path: string; name: string; finding?: DirtyWorktreeFinding }[]> {
  const out: { path: string; name: string; finding?: DirtyWorktreeFinding }[] = [];
  for (const line of list.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("worktree ")) continue;
    const wtPath = l.slice("worktree ".length);
    if (!pathSubstrings.some((p) => wtPath.includes(p))) continue;
    const name = path.basename(wtPath);
    if (name === exclude) continue;
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, wtPath, fromRef).catch(
      () => undefined,
    );
    out.push({ path: wtPath, name, finding });
  }
  return out;
}

/**
 * Scan `git worktree list` for attached worktrees whose path contains any of
 * the given path substrings, skipping any name in `exclude`. An unreadable
 * list returns an empty array — the safe direction (no action) for every
 * caller, and the contract they have always had (a #545 refusal degrades to
 * the raw git error; a residue pass degrades to no-op).
 *
 * #1396 (round 3) keeps that contract and says why it is not the fail-open it
 * looks like: the caller that would actually take an unsafe action on `[]` —
 * the branch step's residue pass — makes its own `WorktreeScanError` /
 * `isMissingGit` decision in `work-driver-branch-residue.ts`, where a hang
 * parks instead of reporting a clean pass. The two other readers either have a
 * strict mode of their own or do not act on the answer.
 *
 * Shared by `findDirtySameIssueLeftover` (returns the first dirty hit) and
 * `findSameIssueLeftovers` (returns all) so the porcelain parsing and the
 * `inspectWorktreeForLoss` loop live in one place.
 */
export async function scanWorktrees(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  pathSubstrings: string[],
  exclude?: string,
): Promise<{ path: string; name: string; finding?: DirtyWorktreeFinding }[]> {
  let list: string;
  try {
    list = await listWorktreePorcelain(execFn, repoRoot);
  } catch (err) {
    // #1396 (round 3) — the fail-open contract this function has always had, and
    // which its callers depend on: `findDirtySameIssueLeftover` (non-strict) and
    // the #730 residue pass both treat "no siblings" as the safe answer to a
    // read that failed, and each has its own handling for the case where the
    // read genuinely cannot be trusted (`WorktreeScanError` on the strict path;
    // `work-driver-branch-residue.ts`'s `worktree-listing-unreadable` cap for the
    // residue pass, which is the caller that must NOT see `[]` over a hang).
    //
    // What changed is only WHY a read fails. Before #1396 the listing had no
    // timeout, so "failed" meant git had answered with an error; the 30 s bound
    // added a second kind — a HANG — and this line would have turned that into
    // "no leftovers". `isMissingGit` is not consulted here: an absent-git
    // rejection and an error git reported both take the same degradation this
    // function has always taken, and the caller that needs the distinction
    // already makes it at the level where a decision is actually taken.
    trace(`worktree: sibling listing unreadable — scanning without it (${gitErrorDetail(err)})`);
    return [];
  }
  return inspectListedWorktrees(execFn, repoRoot, list, fromRef, pathSubstrings, exclude);
}

/**
 * #545 — `git worktree add` refuses against any leftover worktree of the
 * same cycle (not just the one at the target path). Find attached
 * worktrees with the same issue prefix that hold work a force-remove would
 * destroy. `strict` (the branch step, #1170) makes an unreadable
 * `git worktree list` THROW `WorktreeScanError` after one retry: a listing that
 * cannot be read cannot prove the absence of a dirty sibling. Non-strict callers
 * read it as no siblings (the fail-open contract they always had).
 *
 * `excludePaths` — additional worktree paths to skip (in addition to
 * `selfName`). #753: this cycle's own worktrees (created by the branch step
 * or by an earlier dependent) are legitimate in-progress work, not
 * "leftover" — without this exclusion the scan would park the cycle on a
 * false positive.
 */
export async function findDirtySameIssueLeftover(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  issuePrefix: string,
  selfName: string,
  excludePaths?: string[],
  strict = false,
): Promise<DirtyWorktreeFinding | undefined> {
  const wtMarker = `.worktrees${path.sep}${issuePrefix}`;
  // #1170 — strict: an unreadable listing refuses (WorktreeScanError) so the
  // branch step never reaches the LLM ops fallback unscanned.
  let list: string;
  if (strict) {
    list = await listWorktreeStrict(execFn, repoRoot);
  } else {
    try {
      list = await listWorktreePorcelain(execFn, repoRoot);
    } catch (e) {
      trace(
        `worktree: sibling scan unreadable for ${selfName} — proceeding without it (${gitErrorDetail(e)})`,
      );
      return undefined;
    }
  }
  const hits = await inspectListedWorktrees(execFn, repoRoot, list, fromRef, [wtMarker], selfName);
  // #753 — on macOS, `git worktree list --porcelain` returns symlink-resolved
  // paths (/private/var/...) while our paths are the logical form (/var/...).
  // Resolve both sides before comparing.
  const excludeSet = new Set((excludePaths ?? []).map((p) => resolvePath(p)));
  for (const hit of hits) {
    if (excludeSet.has(resolvePath(hit.path))) continue;
    if (hit.finding) return hit.finding;
  }
  return undefined;
}

/**
 * #654 — the target branch for `git checkout <branch>` is held by another
 * worktree. git refuses the checkout outright ("fatal: '<branch>' is
 * already used by worktree at '<path>'") — the census found 2 cycles
 * parking exactly on this string. The worktree machinery already knows how
 * to remove clean holders safely; a DIRTY holder must never be force-removed
 * (the #475 convention) — refuse with the existing `DirtyWorktreeError`.
 *
 * Called from `integrate()` in followup mode, BEFORE the checkout. A cycle
 * whose own worktree map still holds the branch (a parked prior cycle's
 * leftover, or a sibling group that hasn't torn down yet) blocks the
 * checkout; removing the clean holder unblocks it mechanically. A dirty
 * holder holds work that is not in the object database — force-removing it
 * would be exactly the #475 incident, so the refusal carries the absolute
 * path and the operator's salvage instructions.
 *
 * Returns true when the branch was held and is now free (a clean holder was
 * removed); false when no holder exists (the normal case); throws
 * `DirtyWorktreeError` when the holder holds uncommitted work or local
 * commits.
 *
 * #1396 (six-lens round 3) — an unreadable `git worktree list` is NOT "no
 * holder" any more. It used to `.catch(() => "")`, and once the listing grew
 * `WORKTREE_LIST_TIMEOUT_MS` that became a new fail-open: a `git worktree list`
 * that HANGS (a stale `worktree` lock, an uninterruptible I/O wait) rejected on
 * the 30s bound, the sweep read "no holder", and the checkout went ahead into
 * the very `already used by worktree` fatal this function exists to prevent.
 * A rejection now propagates via `listWorktreeStrict` (one retry, then
 * `WorktreeScanError`) — the caller's existing catch in `integrate()` plumbs
 * it, which is the same failure surface as before with the direction reversed:
 * integration refuses rather than proceeding blind. The old degradation
 * The two degradations the sweep makes are deliberately decided on the ERROR
 * CODE, never on its message text, and that choice is the safety property.
 * Measured against `promisify(exec)` on this machine: a directory that is not a
 * repo rejects with `code: 128` and `fatal: not a git repository` on stderr;
 * only a missing binary or cwd gives `code: "ENOENT"`. A message match would
 * let either a wrapper that folds stderr into `message`, or a test fake that
 * throws the words "not a git repository", degrade a real refusal to silence.
 * So: `ENOENT` = "there is nothing here", degrades; everything else = "I could
 * not look", refuses. The killed listing above is the second kind; the `!THROW!`
 * fake below carries no code at all, which is why the pre-#1396 assertion it
 * pins is reported at the caller rather than swallowed here.
 *
 * The one caller that has to keep BOTH readings working is `integrate()`'s
 * followup path (and the lens-fix commit that reuses it): a non-repository
 * `repoRoot` — a fixture path, a checkout that vanished mid-cycle — is "there is
 * nothing here", and refusing the whole integration over it is the worse
 * failure. `integrate()` catches the refusal, records it, and proceeds to the
 * checkout, where git reports the real problem. `isUnbornRoot` is that caller's
 * test; it is deliberately NOT part of the sweep's own decision, so a fake that
 * merely mentions "not a git repository" in a code-less rejection still refuses
 * here (the case the round-3 kill switch exists for).
 */
export async function sweepBranchHolders(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const list = await worktreeList(execFn, repoRoot).catch(async (err: unknown) => {
    if (isMissingGit(err)) {
      trace(
        `worktree: no git to ask for branch holders of ${branchName} — sweeping without the listing (${gitErrorDetail(err)})`,
      );
      return "";
    }
    // #1396 round 3 — the ONLY classification that may degrade is the error CODE
    // saying git is not there (`ENOENT`, above). Everything else is "I could not
    // look", and the strict listing turns it into one `WorktreeScanError` shape
    // naming the attempts. Deliberately not consulted here: whether a
    // "not a git repository" refusal is the caller's "nothing here" or a halt is
    // decided at the call site (`work-driver-integrate.ts`), where the command's
    // role in the step is known — never by matching text inside the read, which
    // is how a fake or a stderr-folding wrapper would earn a silent no-holder.
    await listWorktreeStrict(execFn, repoRoot);
    throw new WorktreeScanError(`${gitErrorDetail(err)} (after the retry, the listing was empty)`);
  });
  const lines = list.split("\n");
  let holderPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]?.trim() ?? "";
    if (l.startsWith("worktree ")) {
      // The worktree line is followed by one or more attribute lines
      // (e.g. "HEAD <sha>", "branch refs/heads/<name>", "detached"). The
      // branch we care about is in the `branch` line, not the worktree line
      // itself, so we must walk forward from each worktree marker.
      const start = i;
      let j = i + 1;
      let found: string | undefined;
      while (j < lines.length) {
        const attr = lines[j]?.trim() ?? "";
        if (attr.startsWith("worktree ")) break; // next worktree entry
        if (attr === `branch refs/heads/${branchName}`) {
          found = lines[start]?.slice("worktree ".length).trim();
          break;
        }
        j++;
      }
      if (found !== undefined) {
        holderPath = found;
        break;
      }
    }
  }
  if (!holderPath) return false;
  // The main working tree (repoRoot itself) is not a worktree that can be
  // removed — if it's holding the branch, that's the normal state and there
  // is nothing to sweep. macOS /tmp is a symlink to /private/tmp, so
  // normalise both sides before comparing.
  if (resolvePath(holderPath) === resolvePath(repoRoot)) {
    return false;
  }
  const finding = await inspectWorktreeForLoss(execFn, repoRoot, holderPath, "HEAD");
  if (finding) {
    throw new DirtyWorktreeError(finding);
  }
  // Clean holder — remove it so the checkout can proceed.
  await execFn(`git worktree remove ${JSON.stringify(holderPath)}`, {
    cwd: repoRoot,
    maxBuffer: 256 * 1024,
  });
  trace(`worktree: removed clean holder ${holderPath} for branch ${branchName}`);
  return true;
}
