/**
 * work-driver-lens-fix-reposition-land — the safety net under the reposition
 * gate's `unlanded` arm.
 *
 * `repositionLensFixWorktree` classifies a clean worktree that holds commits
 * the branch tip does not as `unlanded` (the tip is a strict ancestor of the
 * tree HEAD) and used to BACK IT UP AND PARK. That is the right call for work
 * nobody can explain, and the wrong call for the case that actually happens:
 * a lens-fix developer committed its fix, was killed at its dispatch bound
 * (or its completion was otherwise lost), and nobody ran the integration that
 * only the adversarial step performs. The tree then holds the branch plus the
 * fixer's commits, in the right order, on the right base — and the operator
 * gets a `lens-fix-reposition` handoff whose only remedy is "restore from the
 * backup ref". Measured on two field cycles, v0.14.5+: two parks in exactly that shape.
 *
 * So a STRICTLY AHEAD tree is landed rather than parked, through the same
 * `landCommittedFix` + `git push` path the adversarial step already uses for a
 * committed lens-fix (#749). The ancestry condition is what makes that safe:
 * if the tip is a strict ancestor of the tree HEAD, the tree's commits ARE the
 * branch's descendants, so landing is a fast-forward in content terms and there
 * is nothing to conflict.
 *
 * Genuinely diverged trees — the tip is not an ancestor of the tree — are not
 * touched here: they back up and park exactly as they always have.
 *
 * repoRoot: the landing MOVES the checkout. `landCommittedFix` checks the
 * branch out at repoRoot to cherry-pick onto it, so unlike every other outcome
 * of the reposition gate this arm mutates the main checkout — which is why its
 * failure has to state the restore outcome (#797's rule): `landCommittedFix`
 * runs the verified restore on every path it can and returns the claim in its
 * error text, and `landRepoRootClaim` is what reads that claim back for the
 * trace and the park detail.
 *
 * The landing is the caller's opt-in (the `landAhead` parameter). A caller that
 * cannot name a repo root or has no `baseSha` gets the old behaviour, and
 * `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0` restores the park everywhere — including
 * the partial-fix conversion in `work-driver-lens-fix-bound-land.ts`, which
 * reads the same knob so one switch returns both halves of #1779 to the
 * park/HALT behaviour: an operator who wants every unlanded tree surfaced as a
 * handoff can have it.
 */

import { trace } from "./trace.ts";
import { landCommittedFix, repoRootOriginalRef } from "./work-driver-lens-fix-commit.ts";
import type { RepositionResult } from "./work-driver-lens-fix-reposition-gate.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import { restoreClaim } from "./work-driver-restore-claim.ts";
import { verifiedRestoreRoot } from "./work-driver-restore.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/** What the landing needs that the gate does not otherwise carry: the repo
 *  root to land at, the issue for the scratch dir, and the state whose
 *  `baseSha` bounds the cherry-pick range. */
export type LensFixLandAheadCtx = {
  repoRoot: string;
  issue: number;
  state: WorkState;
  /** #1362 — forwarded to the verified restore's repoRoot dirt read, exactly as
   *  the committed-fix integration path forwards it. */
  dirtyRootExempt?: readonly string[];
};

/** Escape hatch: `PI_ENSEMBLE_LENS_FIX_LAND_AHEAD=0` parks a strictly-ahead
 *  tree instead of landing it, AND turns off the lens-fix partial-fix
 *  conversion (both halves of #1779 — one knob, one behaviour to reason
 *  about). Read per call so tests can flip it. */
export function lensFixLandAheadEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LENS_FIX_LAND_AHEAD !== "0";
}

/**
 * Land a strictly-ahead tree's commits onto `branchName` and move the tree to
 * the new tip. Returns a `repositioned` result carrying the landed SHAs, or
 * `undefined` to tell the caller "park as before" — which it does for every
 * reason there is to not land: the knob is off, the caller supplied no landing
 * context, the ref is not pushable, or the landing itself failed.
 *
 * A failed landing never leaves the checkout on the branch: `landCommittedFix`
 * runs the verified restore on every one of its own failure paths and puts the
 * claim in the error it returns, which `landFailureNote` turns into the
 * restored / NOT-restored sentence the park detail carries. The tree itself is
 * left where it is, so the gate's backup-and-park path runs next with the
 * fixer's commits intact.
 */
export async function landStrictlyAhead(
  execFn: ExecFn,
  tree: string,
  branchName: string,
  aheadShas: string[],
  landAhead: LensFixLandAheadCtx | undefined,
): Promise<RepositionResult | undefined> {
  if (!lensFixLandAheadEnabled() || landAhead === undefined || aheadShas.length === 0) {
    return undefined;
  }
  const fromSha = await treeHead(execFn, tree);
  if (fromSha === undefined) return undefined;
  const land = await landCommittedFix(
    execFn,
    { repoRoot: landAhead.repoRoot, issue: landAhead.issue },
    landAhead.state.pipelineState,
    tree,
  );
  if (!land.ok) {
    // THE PARK MUST SAY WHAT HAPPENED TO THE CHECKOUT. This is the one arm of
    // the reposition gate that moves the main checkout — `landCommittedFix`
    // checks the branch out at repoRoot to cherry-pick onto it — so a failed
    // landing that merely reported "unlanded" would leave the operator unable
    // to tell a restored tree from one abandoned on the branch. Every claim
    // below is READ from the landing's own verified restore (#797), never
    // asserted: `landCommittedFix` restores on each of its failure paths and
    // puts the outcome in its error text; `landRepoRootClaim` reads it back.
    const claim = landRepoRootClaim(land.error);
    trace(
      `lens-fix-reposition: strictly-ahead tree could not be landed (${land.error.slice(0, 200)}) — ${claim}; backing up and parking as before`,
    );
    if (!land.error.includes("repoRoot was")) {
      // The landing died before it could restore (or report): no restore ran
      // under its lock, so one runs here and the claim it returns — restored or
      // NOT restored, with the preserved-state path — is what the park says.
      const restore = await verifiedRestoreRoot(execFn, {
        repoRoot: landAhead.repoRoot,
        originalRef: (await repoRootOriginalRef(execFn, landAhead.repoRoot)) ?? "HEAD",
        scratchDir: scratchDir(landAhead.repoRoot, landAhead.issue),
        label: "lens-fix-reposition-landing",
        dirtyRootExempt: landAhead.dirtyRootExempt,
      });
      return { kind: "unlanded", detail: landFailureNote(land.error, restoreClaim(restore)) };
    }
    return { kind: "unlanded", detail: landFailureNote(land.error, claim) };
  }
  // The land is only real once the remote has it: the whole point of landing
  // here (rather than parking) is that the work stops being stranded, and a
  // local-only landing the next round cannot see is the same stranding with a
  // different shape. A push failure therefore falls back to the park, which is
  // the disclosure the operator needs.
  const refProblem = netRefProblem(branchName);
  if (refProblem !== undefined) {
    trace(`lens-fix-reposition: landing not pushed — ${refProblem}`);
    return undefined;
  }
  try {
    await runNetGit(execFn, "git", {
      cwd: landAhead.repoRoot,
      argv: ["push", "origin", branchName],
    });
  } catch (e) {
    trace(
      `lens-fix-reposition: landed locally but the push failed (${(e as Error).message?.slice(0, 160)}) — backing up and parking as before`,
    );
    return undefined;
  }
  const landedShas = await landedTipShas(execFn, landAhead.repoRoot, branchName, land.sha);
  await moveTreeToTip(execFn, tree, land.sha);
  trace(
    `lens-fix-reposition: landed ${aheadShas.length} strictly-ahead commit(s) from ${tree} onto ${branchName} (${landedShas.map((s) => s.slice(0, 8)).join(", ")}) — no park`,
  );
  return { kind: "repositioned", fromSha, tipSha: land.sha, landedAheadShas: landedShas };
}

/**
 * The repoRoot claim an operator needs after a failed landing. `landCommittedFix`
 * checks the branch out at repoRoot to cherry-pick onto it and runs the
 * verified restore on every failure path, putting its claim in the error text —
 * so the claim is READ from there rather than re-derived, and the three states
 * are distinguished the way `work-driver-adversarial.ts` distinguishes them for
 * the same landing: verified restored, explicitly NOT restored, or unknown.
 * `NOT restored` is the one that needs a human before the next cycle.
 */
export function landRepoRootClaim(error: string): string {
  if (error.includes("repoRoot was verified restored")) {
    return "repoRoot was verified restored";
  }
  if (error.includes("repoRoot was NOT restored")) {
    return "repoRoot was NOT restored — manual repair required before any further /work cycle";
  }
  if (error.includes("repoRoot was restored")) {
    return "repoRoot was restored (the landing claims the restore in its error text)";
  }
  if (error.includes("the batch was aborted")) {
    // The restore was attempted and the batch unwound; no claim came back.
    return "repoRoot restore claim unreadable — check git status at the repo root";
  }
  return "repoRoot state unknown — the landing failed before it reported a restore";
}

/**
 * The park detail for a landing that failed: `landCommittedFix`'s own failure
 * text (which already carries its verified-restore claim, or the manual-repair
 * hint when it could not restore) with the subject stated, and the repoRoot
 * claim made explicit so the handoff cannot read as a silent park. Bounded so
 * it cannot crowd the gate's other evidence out.
 */
function landFailureNote(error: string, claim: string): string {
  const head = error.split("\n")[0]?.trim() ?? "unknown error";
  return `strictly-ahead landing failed — ${head.slice(0, 240)} — ${claim}`;
}

async function treeHead(execFn: ExecFn, tree: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: tree, maxBuffer: 64 * 1024 });
    const sha = stdout.trim();
    return sha.length >= 7 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SHAs the branch actually carries now — the ones the operator can verify.
 * `landCommittedFix` returns the SOURCE tree's HEAD, which is not what landed
 * when the range had to be cherry-picked, so the branch is read rather than
 * assumed. When the read fails the caller is given the source SHAs: a wrong
 * evidence list is not a reason to lose the fact that the landing happened.
 */
async function landedTipShas(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
  fallbackHead: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFn(`git rev-list ${fallbackHead}..${branchName}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    const shas = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (shas.length > 0) return shas;
  } catch {
    // fall through to the source SHAs below
  }
  try {
    const { stdout } = await execFn(`git rev-list ${branchName}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 1);
  } catch {
    return [fallbackHead];
  }
}

/** Move the (detached) tree onto the new tip so the next dispatch builds on
 *  what the branch carries. A failed move is not fatal here — the work IS on
 *  the branch — but it is traced, and the tree simply stays where it is. */
async function moveTreeToTip(execFn: ExecFn, tree: string, tipSha: string): Promise<void> {
  try {
    await execFn("git", {
      cwd: tree,
      argv: ["checkout", "--detach", "--quiet", tipSha],
    });
  } catch (e) {
    trace(`lens-fix-reposition: landed but the worktree could not follow the tip: ${e}`);
  }
}
