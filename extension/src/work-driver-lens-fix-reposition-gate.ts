/**
 * work-driver-lens-fix-reposition-gate — #981 (task-b) — the round-2+ lens-fix
 * reposition gate.
 *
 * The round-2+ fix must build on the branch tip, which may have advanced
 * by a cherry-pick of a previous round's work. This gate moves the
 * worktree onto the freshly-fetched branch so the fixer never dispatches
 * onto a stale base. It is a GATE: the fixer is dispatched only when the
 * worktree is verified at the branch tip. Anything else parks the fix
 * loop (`lens-fix-reposition` cap-hit). Unlanded/diverged trees are
 * backed up first so nothing is destroyed.
 *
 * What this gate touches, precisely: it fetches and moves the LENS-FIX
 * WORKTREE, and it used to be true that the main checkout was never its
 * concern. #1779 changed that for one arm: when a clean tree is strictly
 * AHEAD of the tip, the landing safety net (`landCommittedFix`, opted in via
 * `landAhead`) checks the branch out at repoRoot to cherry-pick onto it and
 * pushes the branch. Every other outcome — fetch, status, ff-merge, the
 * patch-equivalence checkout, the backup ref — still mutates only the tree.
 * Because that one arm moves the checkout, its failure path states the
 * verified-restore outcome (restored / NOT restored) rather than parking on
 * "unlanded" alone; the fetch, which runs outside the integration lock, still
 * only moves remote-tracking refs.
 *
 * Tip selection: the driver's worktrees are detached and the branch ref
 * is often absent, so the tip is resolved from BOTH `refs/heads/<branch>`
 * and `refs/remotes/origin/<branch>` after the fetch. If only one exists,
 * that is the tip. If both exist, the NEWER one is taken (the descendant
 * in the ancestor direction). Genuinely diverged refs return `diverged`.
 *
 * The `git cherry` landed-check (#981 normal case): in round 2+ the lens
 * worktree typically holds the previous round's fix commit, which reached
 * the branch as a DIFFERENT commit (cherry-picked, same patch). `git
 * cherry <tip> <tree>` prints `-` when a patch-equivalent exists on the
 * tip (landed), `+` when it does not. If every line is `-` the work is
 * already on the branch and the worktree is checked out at the tip.
 *
 * All git commands run through the `ExecFn` argv form (no shell re-parse).
 * Split from work-driver-lens-fix-commit.ts for the 500-line gate.
 */
import { trace } from "./trace.ts";
import type { ExecFn as DevelopExecFn } from "./work-develop-git.ts";
import { inlineCodeSafe } from "./work-driver-conflict-evidence.ts";
import {
  backupLensFixTree,
  enumerateUnlanded,
  parkCherryFailedTree,
} from "./work-driver-lens-fix-reposition-backup.ts";
import {
  type LensFixLandAheadCtx,
  landStrictlyAhead,
} from "./work-driver-lens-fix-reposition-land.ts";
import {
  GIT_TIMEOUT_MS,
  cherryLines,
  isAncestor,
  rangeAllNonEmpty,
  resolveBranchTip,
} from "./work-driver-lens-fix-reposition-queries.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { cleanWorktreeForRetry, retryTreeLine } from "./work-retry-tree-clean.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The outcome of the round-2+ reposition gate.
 *
 * - `already-at-tip` — clean and at the branch tip; nothing moved.
 * - `repositioned` — clean and BEHIND the tip; fast-forwarded (the #978
 *   shape). The fast-forward path is the common case; the cherry path is
 *   a conservative fallback.
 * - `repositioned` with `movedByPatchEquivalence` — NOT a strict ancestor
 *   of the tip, but `git cherry` shows every worktree commit has a
 *   patch-equivalent on the tip (the NORMAL #981 case: previous round's
 *   fix was cherry-picked as a different commit). A backup ref IS created
 *   (points at the old tree HEAD). `fromSha` records the move source.
 *   `movedByPatchEquivalence` is true when the tree was moved because every
 *   commit it held was patch-equivalent to the branch tip (detected with
 *   `git cherry`), rather than by a fast-forward.
 * - `dirty` — uncommitted changes; fixer NOT dispatched.
 * - `unlanded` — clean and AHEAD of the tip (strict ancestor of the tree);
 *   holds commits the tip does not. By default these are LANDED (the tip is a
 *   strict ancestor, so the tree is the branch plus the fixer's commits on top
 *   — exactly what `landCommittedFix` takes) and the result is returned as
 *   `repositioned` with `landedAheadShas`. `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0`,
 *   a landing the caller could not attempt, or a landing that failed restores
 *   the checkout (verified, with the claim in the detail) and parks: moved to a
 *   backup ref and reported.
 * - `diverged` — holds commits the tip does not and is NOT behind it
 *   either (or local/remote refs diverged during tip selection). Moved to
 *   backup ref; parks.
 * - `diverged` with `backupRef` undefined — the cherry path wanted to
 *   move the tree but the backup ref could not be created; the tree is NOT
 *   moved (fail closed) and the caller parks.
 * - `git-failed` — a git probe or the backup ref failed.
 */
export type RepositionResult =
  | { kind: "already-at-tip"; tipSha: string }
  | {
      kind: "repositioned";
      fromSha: string;
      tipSha: string;
      /**
       * True when the tree was moved because every commit it held was
       * patch-equivalent to the branch tip (detected with `git cherry`),
       * rather than by a fast-forward.
       */
      movedByPatchEquivalence?: boolean;
      /** The backup ref created before the cherry-landed move (the old tree HEAD). */
      backupRef?: string;
      /**
       * The tree's own commits that this reposition LANDED onto the branch
       * (oldest first), and the SHAs they took there. Set only by the
       * strictly-ahead landing: the tree held commits the tip did not, the tip
       * was their strict ancestor, and the safety net landed them instead of
       * parking (`work-driver-lens-fix-reposition-land.ts`).
       */
      landedAheadShas?: string[];
    }
  | {
      kind: "dirty";
      detail: string;
      /** #1391 — the dirt is the residue of a lens-fix child this cycle lost. */
      attemptLost?: boolean;
    }
  | { kind: "unlanded"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "diverged"; detail: string; backupRef?: string; aheadShas?: string[] }
  | { kind: "git-failed"; detail: string; backupRef?: string };

const TRACE_PREFIX = "lens-fix-reposition";

/**
 * #981 — move the lens-fix worktree onto the freshly-fetched branch tip
 * BEFORE the round-2+ fixer dispatch. See {@link RepositionResult} for the
 * outcome kinds; only the two success kinds are safe to dispatch on.
 *
 * The guard is deliberately conservative: it fast-forwards ONLY a CLEAN
 * worktree that is strictly BEHIND the tip, and it moves a CLEAN worktree
 * that is NOT behind the tip ONLY when `git cherry` proves every commit it
 * holds is already on the branch by patch-equivalence (the normal #981
 * round-2+ shape). Anything else — a dirty tree, a clean tree holding
 * commits with no patch-equivalent on the branch, or a branch-tip pair
 * that has split — moves the tree to a backup ref (when it can) and
 * returns a failure kind so the caller parks rather than dispatching a fix
 * onto a base it cannot trust.
 */
export async function repositionLensFixWorktree(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  issues: number[],
  issueTitle: string | undefined,
  /**
   * #1391 — set when this cycle already lost a lens-fix child into `tree`
   * (`lostAttemptOnStep`). Dirt is then the driver's own residue: it goes
   * through the retry save-then-clean and the tree is re-read. Unset, a dirty
   * tree parks exactly as before, with nothing saved, cleaned or written.
   */
  lostAttempt?: { repoRoot: string; issue: number; state: WorkState },
  /**
   * The strictly-ahead landing needs a repo root to land at and a state whose
   * `baseSha` bounds the cherry-pick range. Both absent (every existing caller)
   * keeps the pre-landing shape: a strictly-ahead tree backs up and parks.
   */
  landAhead?: LensFixLandAheadCtx,
): Promise<RepositionResult> {
  // 1. Fetch the branch, then resolve the tip from the local + remote
  //    refs (documented tip selection, module header). A fetch failure or
  //    an unresolvable tip means the base cannot be trusted; park rather
  //    than guess.
  try {
    // #981 — `git fetch` runs OUTSIDE the integration lock on purpose:
    // fetch only updates remote-tracking refs, which git locks per ref, so
    // concurrent fetches never collide; the integration lock serialises
    // working-tree mutations at repoRoot, and THIS step is not one of them —
    // it touches neither checkout, only the lens-fix worktree `tree` and the
    // refs. (The strictly-ahead landing further down IS a repoRoot mutation
    // and takes the lock itself, inside `landCommittedFix`.) So the fetch does
    // not need it.
    // Bounded + non-interactive via runNetGit (#1095). Match sharedFetch
    // (work-driver-branch-mechanized.ts): the fetch's pack output scales with
    // branch history, not a fixed 64 KiB, hence the 1 MiB buffer.
    const refProblem = netRefProblem(branchName);
    if (refProblem !== undefined) throw new Error(refProblem);
    await runNetGit(execFn, "git", {
      cwd: tree,
      maxBuffer: 1024 * 1024,
      argv: ["fetch", "origin", branchName, "--quiet"],
    });
  } catch (e) {
    // #981 LOW: branchName is operator-supplied data; route it through
    // inlineCodeSafe (a backtick or newline would break the markdown span
    // the handoff renders the detail into).
    const detail = `could not fetch origin/${inlineCodeSafe(branchName)}: ${e}`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "git-failed", detail };
  }
  const tip = await resolveBranchTip(execFn, tree, branchName);
  if (!tip.ok) {
    // #981 LOW: branchName is operator-supplied data interpolated into the
    // detail; route it through inlineCodeSafe (a backtick or newline would
    // break the markdown span the handoff renders it into).
    const detail = tip.detail.replaceAll(`${branchName}`, inlineCodeSafe(branchName));
    trace(`${TRACE_PREFIX}: ${tip.kind}: ${detail}`);
    return tip.kind === "diverged" ? { kind: "diverged", detail } : { kind: "git-failed", detail };
  }
  const tipSha = tip.tipSha;

  // 2. Dirty check — a worktree with uncommitted changes is never moved
  //    (moving HEAD under an in-flight fix would lose or corrupt it), and
  //    the fixer is not dispatched onto one either. Operator dirt is never
  //    stashed or cleaned; the operator inspects and clears it. Dirt a lost
  //    attempt left (#1391) is saved, then cleaned, then re-read.
  const readStatus = async (): Promise<string | RepositionResult> => {
    try {
      const st = await execFn("git", {
        cwd: tree,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        argv: ["status", "--porcelain"],
      });
      return st.stdout.trim();
    } catch (e) {
      trace(`${TRACE_PREFIX}: git-failed (status): ${e}`);
      return { kind: "git-failed", detail: `git status --porcelain failed: ${e}` };
    }
  };
  let porcelain = await readStatus();
  if (typeof porcelain !== "string") return porcelain;
  let saved = "";
  if (porcelain !== "" && lostAttempt !== undefined) {
    const clean = await cleanWorktreeForRetry({
      execFn: execFn as DevelopExecFn,
      ...lostAttempt,
      step: "lens-fix",
      tree,
    });
    saved =
      clean.kind === "none"
        ? ""
        : ` (left by the lens-fix attempt this cycle lost — ${retryTreeLine(clean)})`;
    if (clean.kind === "cleaned")
      trace(`${TRACE_PREFIX}: lost attempt's residue — ${retryTreeLine(clean)}`);
    porcelain = await readStatus();
    if (typeof porcelain !== "string") return porcelain;
  }
  if (porcelain !== "") {
    const paths = porcelain
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // #981 LOW: porcelain paths are operator-supplied data; route them
    // through inlineCodeSafe (a backtick or newline in a path would break
    // the markdown span the handoff renders the detail into).
    const detail = `worktree has uncommitted changes: ${paths.map((p) => inlineCodeSafe(p)).join(", ")}${inlineCodeSafe(saved)}`;
    trace(`${TRACE_PREFIX}: ${detail}`);
    return { kind: "dirty", detail, ...(lostAttempt ? { attemptLost: true } : {}) };
  }

  // 3. Where is the worktree relative to the tip? A clean tree at the tip
  //    is the no-op; a clean tree strictly BEHIND it is the repositionable
  //    shape. Anything else (the tree holds commits the tip does not) is
  //    either the normal #981 shape (every such commit has a patch-
  //    equivalent on the tip — `git cherry` all `-`) or a guard failure —
  //    back up the tree and park.
  let treeSha: string;
  try {
    const hp = await execFn("git", {
      cwd: tree,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      argv: ["rev-parse", "HEAD"],
    });
    treeSha = hp.stdout.trim();
  } catch (e) {
    trace(`${TRACE_PREFIX}: git-failed (rev-parse HEAD): ${e}`);
    return { kind: "git-failed", detail: `git rev-parse HEAD failed: ${e}` };
  }

  if (treeSha === tipSha) {
    trace(`${TRACE_PREFIX}: already-at-tip ${tipSha.slice(0, 12)}`);
    return { kind: "already-at-tip", tipSha };
  }

  // Strict-ancestor test in the fast-forward direction: if the tree IS an
  // ancestor of the tip, the tree is strictly behind it and a
  // `git merge --ff-only` is safe. If it is NOT, the tree holds commits the
  // tip does not — the normal #981 case is a cherry-picked previous-round
  // fix (patch-equivalent on the branch), which the `git cherry` check
  // below detects and repositions; anything with a `+` line is un-landed
  // or diverged and must park.
  // #981: `isAncestor` distinguishes "git says no" (exit 1 → false) from
  // "git could not answer" (any other failure → { error }). The fast-forward
  // move requires a POSITIVE ancestry proof; an unreadable probe must not
  // fall through to the cherry path (which would move the tree on a base it
  // never verified), so it parks as `git-failed` with the git error — fail
  // closed, the tree is never moved.
  const treeIsAncestorOfTip = await isAncestor(execFn, tree, treeSha, tipSha);
  if ("error" in treeIsAncestorOfTip) {
    trace(`${TRACE_PREFIX}: git-failed (ancestry probe): ${treeIsAncestorOfTip.error}`);
    return { kind: "git-failed", detail: treeIsAncestorOfTip.error };
  }
  if (treeIsAncestorOfTip.isAncestor) {
    // Clean fast-forward: the tree is strictly behind the tip.
    try {
      await execFn("git", {
        cwd: tree,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        argv: ["merge", "--ff-only", "--quiet", tipSha],
      });
      const hp2 = await execFn("git", {
        cwd: tree,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        argv: ["rev-parse", "HEAD"],
      });
      const newSha = hp2.stdout.trim();
      if (newSha !== tipSha) {
        const detail = `fast-forward did not land on the tip (expected ${tipSha.slice(0, 12)}, got ${newSha.slice(0, 12)})`;
        trace(`${TRACE_PREFIX}: ${detail}`);
        return { kind: "git-failed", detail };
      }
      trace(`${TRACE_PREFIX}: repositioned ${treeSha.slice(0, 12)} -> ${newSha.slice(0, 12)}`);
      return { kind: "repositioned", fromSha: treeSha, tipSha };
    } catch (e) {
      trace(`${TRACE_PREFIX}: reposition failed: ${e}`);
      return {
        kind: "git-failed",
        detail: `git merge --ff-only ${tipSha.slice(0, 12)} failed: ${e}`,
      };
    }
  }

  // The tree is NOT an ancestor of the tip: it holds commits the branch
  // does not contain by identity. The NORMAL #981 round-2+ case: the
  // previous round's fix commit reached the branch as a DIFFERENT
  // (cherry-picked) commit with the same patch. `git cherry <tip> <tree>`
  // marks each such worktree commit `-` when a patch-equivalent exists on
  // the tip and `+` otherwise. All `-` (or empty — no commits beyond the
  // tip) means the work is already on the branch: move the clean tree to
  // the tip. Any `+` means genuinely un-landed work: back up and park.
  //
  // `rangeAllNonEmpty` guards the all-`-` path against `git cherry`'s
  // empty-patch-id collision: its contract covers only NON-EMPTY patches,
  // and every empty commit produces the same (empty) patch-id, so an all-`-`
  // result can be a false positive when the worktree's range holds an empty
  // commit (or a real fix riding on one). Such work is NOT on the branch,
  // so an empty range commit falls through to the backup-and-park path.
  const lines = await cherryLines(execFn, tree, tipSha, treeSha);
  if (lines !== undefined) {
    const plusShas = lines
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    const minusShas = lines
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    if (plusShas.length === 0) {
      const allNonEmpty = await rangeAllNonEmpty(execFn, tree, tipSha, treeSha);
      if (allNonEmpty === true) {
        // Landed via cherry: every worktree commit beyond the tip is a
        // NON-EMPTY commit with a patch-equivalent on the tip. Back up the
        // tree BEFORE the detach checkout (which orphans the old HEAD),
        // then move. `fromSha` records where the tree moved from.
        const cherryBackup = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
        const cherryBackupRef = cherryBackup.ref;
        if (cherryBackupRef === undefined) {
          // Fail closed: without the backup ref the detach checkout would
          // orphan the old HEAD with no way back, so the tree must NOT
          // move. Park via the diverged kind (no `backupRef` recorded).
          // The backup helper's git error rides in the detail (first line,
          // ≤200 chars) so the operator knows WHY the ref was not created.
          const detail = `backup ref could not be created (${cherryBackup.error ?? "git error"}); refusing to move a tree that is not a fast-forward`;
          trace(`${TRACE_PREFIX}: ${detail}`);
          return { kind: "diverged", detail };
        }
        try {
          await execFn("git", {
            cwd: tree,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            argv: ["checkout", "--detach", "--quiet", tipSha],
          });
          const hp2 = await execFn("git", {
            cwd: tree,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            argv: ["rev-parse", "HEAD"],
          });
          const newSha = hp2.stdout.trim();
          if (newSha !== tipSha) {
            const detail = `checkout to the tip did not land on the tip (expected ${tipSha.slice(0, 12)}, got ${newSha.slice(0, 12)})`;
            trace(`${TRACE_PREFIX}: ${detail}`);
            return {
              kind: "git-failed",
              detail,
              ...(cherryBackupRef ? { backupRef: cherryBackupRef } : {}),
            };
          }
          trace(
            `${TRACE_PREFIX}: repositioned (movedByPatchEquivalence) ${treeSha.slice(0, 12)} -> ${newSha.slice(0, 12)}${cherryBackupRef ? ` (backed up to ${cherryBackupRef})` : ""} — ${minusShas.length} worktree commit(s) already on the branch by patch-equivalence: ${minusShas.join(", ") || "(none beyond the tip)"}`,
          );
          return {
            kind: "repositioned",
            fromSha: treeSha,
            tipSha,
            movedByPatchEquivalence: true,
            ...(cherryBackupRef ? { backupRef: cherryBackupRef } : {}),
          };
        } catch (e) {
          trace(`${TRACE_PREFIX}: checkout to tip failed: ${e}`);
          return {
            kind: "git-failed",
            detail: `git checkout --detach ${tipSha.slice(0, 12)} failed: ${e}`,
            ...(cherryBackupRef ? { backupRef: cherryBackupRef } : {}),
          };
        }
      }
      // all-`-` but the range contains an empty commit (or the emptiness
      // read failed): the cherry result is UNVERIFIED. Fall through to the
      // backup-and-park path below — do NOT move the tree to the tip, and
      // do NOT skip the backup (the all-`-` no-backup rationale does not
      // apply to unverifiable ranges).
      trace(
        `${TRACE_PREFIX}: cherry result all-\`-\` but the range ${tipSha.slice(0, 12)}..${treeSha.slice(0, 12)} contains an empty commit (or the emptiness read failed) — treating as unverified, backing up and parking`,
      );
    }

    // Genuinely un-landed work (`+` lines), or an unverifiable all-`-`
    // range (empty commit). Distinguish unlanded (tip is an ancestor of
    // the tree — the tree is ahead) from true divergence (neither is an
    // ancestor of the other). Both are guard failures; back up the tree
    // and park. An ancestry PROBE that git failed on is neither — it
    // parks as `git-failed` (fail closed: the tree is not moved) rather
    // than guessing `diverged`.
    const tipIsAncestorOfTree = await isAncestor(execFn, tree, tipSha, treeSha);
    if ("error" in tipIsAncestorOfTree) {
      trace(`${TRACE_PREFIX}: git-failed (ancestry probe): ${tipIsAncestorOfTree.error}`);
      return { kind: "git-failed", detail: tipIsAncestorOfTree.error };
    }
    const backupRef = await backupLensFixTree(execFn, tree, branchName, issues, issueTitle);
    const backupRefName = backupRef.ref;
    const aheadShas =
      plusShas.length > 0 ? plusShas : await enumerateUnlanded(execFn, tree, tipSha);
    const kind: "unlanded" | "diverged" = tipIsAncestorOfTree.isAncestor ? "unlanded" : "diverged";
    // THE SAFETY NET. A clean tree whose commits sit strictly ON TOP of the
    // branch tip is not a problem to park on — it is the branch plus a fix that
    // nobody landed, which is what `landCommittedFix` exists to land. Parking
    // it stranded a killed fixer's work in a backup ref (the field shape this
    // row closes); landing it lets the cycle continue and the adversarial gate
    // judge the content like any other fix. A tree that is NOT strictly ahead
    // (`diverged`) still backs up and parks exactly as before.
    if (kind === "unlanded") {
      const landed = await landStrictlyAhead(execFn, tree, branchName, aheadShas, landAhead);
      // A landing that failed on its way back from the branch is a PARK with a
      // reason, not a silent fall-through: the checkout moved, so the result
      // carries the restore claim the landing read from the verified restore.
      if (landed !== undefined && !("kind" in landed && landed.kind === "unlanded")) return landed;
      if (landed !== undefined) {
        trace(`${TRACE_PREFIX}: ${landed.detail}`);
        return {
          kind: "unlanded",
          detail: landed.detail,
          ...(backupRefName ? { backupRef: backupRefName } : {}),
          aheadShas,
        };
      }
    }
    const detail =
      kind === "unlanded"
        ? `worktree holds ${aheadShas.length} commit(s) the branch tip ${tipSha.slice(0, 12)} does not (previous-round work unlanded): ${aheadShas.join(", ") || "(unreadable)"}`
        : `worktree has diverged from the branch tip ${tipSha.slice(0, 12)} — the tree holds commits the branch does not: ${aheadShas.join(", ") || "(unreadable)"}`;
    trace(`${TRACE_PREFIX}: ${kind}: ${detail}`);
    return {
      kind,
      detail,
      ...(backupRefName ? { backupRef: backupRefName } : {}),
      aheadShas,
    };
  }

  // `git cherry` itself failed — treat the tree as untrustworthy: back it
  // up and park (conservative — we cannot prove the work is landed).
  return parkCherryFailedTree(execFn, tree, branchName, issues, issueTitle, tipSha);
}
