/**
 * work-driver-verify — driver-side outcome-verification gate.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Checks
 * EXECUTED evidence (git status, verify command, skip-ratchet, product
 * smoke, PR existence) rather than trusting an agent's "done" claim.
 * Used by runDevelop and runCommitPr as a post-dispatch safety gate.
 *
 * After issue #338 extraction:
 *   - verifyCmdFor → work-driver-verify-cmd.ts
 *   - develop branch → work-driver-verify-develop.ts (verifyDevelopOutcome)
 *   - commit-pr branch + verifyConsolidation remain here.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { detectMainline } from "./work-driver-git.ts";
import type { ConsolidationVerdict } from "./workflow-state-consolidation.ts";
import type { WorkState } from "./workflow-state.ts";

// Re-export for existing consumers (smoke tests) so import paths stay valid.
export { verifyCmdFor } from "./work-driver-verify-cmd.ts";
// Re-export for existing consumers (smoke tests).
export { judgePrIdentity, verifyStepOutcome } from "./work-driver-verify-pr17.ts";
export type { PrView } from "./work-driver-verify-pr17.ts";

const execp = promisify(exec);

const VALID_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * #875 — the workstream's cumulative "touched" evidence. Returns the set of
 * normalised paths its own committed range (`git diff --name-status -M
 * <ownBase>..HEAD` in its worktree) and its worktree porcelain (`git status
 * --porcelain`) touch, or `undefined` when the worktree CANNOT be read
 * (missing path in `worktrees`, no usable base SHA, or a git failure in
 * either read).
 *
 * Failure direction is deliberately asymmetric with the integrated diff
 * read (which stays best-effort): `undefined` means TOUCHED — every path
 * counts as touched, so the covered-check fails closed and the workstream
 * falls through to the uncovered/park logic. A worktree the driver cannot
 * read cannot prove the slice shipped; it never passes.
 */
async function workstreamTouchedSet(
  ctx: DriverContext,
  state: WorkState,
  id: string,
  execFn?: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
): Promise<Set<string> | undefined> {
  const ps = state.pipelineState;
  const wt = ps.worktrees?.[id];
  if (!wt) return undefined;
  const fn = execFn ?? ctx.verifyExecFn;
  if (!fn) return undefined;
  const touched = new Set<string>();

  // (a) the committed range — the workstream's OWN base (the #794
  // stacked-workstream shape: a global range would include ancestors).
  const ownBase = ps.workstreamBaseShas?.[id] ?? ps.baseSha;
  if (ownBase !== undefined && VALID_SHA_RE.test(ownBase)) {
    let rangeOut: string;
    try {
      const { stdout } = await fn(`git diff --name-status -M ${JSON.stringify(ownBase)}..HEAD`, {
        cwd: wt,
        maxBuffer: 1024 * 1024,
      });
      rangeOut = stdout;
    } catch {
      return undefined; // unreadable range → fail closed
    }
    for (const line of rangeOut.split("\n")) {
      const fields = line.split("\t");
      const code = fields[0]?.trim() ?? "";
      const codeBase = code[0];
      if (!codeBase) continue;
      if (codeBase === "R" && fields.length >= 3) {
        const src = normaliseDeclaredPath(fields[1] ?? "");
        if (src) touched.add(src);
        const tgt = normaliseDeclaredPath(fields[2] ?? "");
        if (tgt) touched.add(tgt);
        continue;
      }
      const p = normaliseDeclaredPath(fields[1] ?? "");
      if (p) touched.add(p);
    }
  }

  // (b) the worktree porcelain — modified AND untracked (`??` counts).
  let porcelainOut: string;
  try {
    const { stdout } = await fn("git status --porcelain", { cwd: wt, maxBuffer: 1024 * 1024 });
    porcelainOut = stdout;
  } catch {
    return undefined; // unreadable worktree → fail closed
  }
  for (const line of porcelainOut.split("\n")) {
    if (line.length < 4) continue;
    const p = normaliseDeclaredPath(line.slice(3));
    if (p) touched.add(p);
  }
  return touched;
}

/**
 * PR14 + #540 + #875 — Verify the integration branch's committed diff
 * (vs origin/main) covers every active workstream. Used as the
 * post-dispatch safety gate in runCommitPr.
 *
 * Coverage rule (#540): a workstream W is COVERED iff for EVERY declared
 * path p of W: p is in the committed diff, OR p is declared by a sibling S
 * whose ENTIRE declared path set is present in the committed diff
 * (full-set subsumption — a partial sibling cannot cover; unchanged and
 * still applied on top of #875). With A={a,b}, B={b} and commit={b}
 * only, B is covered (its own full set is present) but A is NOT: b is
 * present, but a is absent and B's full set {b} does not cover a.
 *
 * #875 cumulative rule: a declared path p of W is ALSO covered (and W is
 * COMPLETE, not uncovered) when p is absent from BOTH the workstream's
 * own cumulative evidence — its committed range (`git diff --name-status
 * -M <workstreamBase>..HEAD` in its worktree) UNION its worktree
 * porcelain — AND the committed integration diff (over-declaration: the
 * file legitimately needed no edit, the #799 shape). A path in the
 * cumulative set but absent from the committed diff stays uncovered
 * (a dropped slice). The worktree read FAILS CLOSED: a missing worktree
 * path, a missing base SHA, or a git error counts the workstream as
 * touched — it parks, never passes. This is deliberately asymmetric
 * with the integrated diff read below, which stays best-effort.
 *
 * #778 rename awareness (both sides): the integrated diff and the
 * per-workstream range are read with `--name-status -M` so a move is a
 * rename code (R###), not a silent absence; a path is covered/touched
 * when the normalised path is an exact entry, sits beneath a changed
 * entry (directory declaration), or a rename's SOURCE equals it. No
 * basename/substring matching, so co-located-but-different files (#655)
 * still read uncovered.
 *
 * Returns BOTH sides of the verdict: `missing` (workstreams not covered,
 * for backward compat with the PR14 cap-hit message) AND `filesPresent`
 * (the committed file list — what actually shipped, so the handoff can
 * render present + missing).
 *
 * Best-effort (integrated diff read only): a git-shell failure there
 * returns no-missing (don't false-alarm on a transient git issue).
 * The N=1 case short-circuits — there's only one workstream and
 * partial-commit doesn't apply (the gate is structurally unverifiable
 * there; regression-asserted).
 */
export async function verifyConsolidation(
  ctx: DriverContext,
  state: WorkState,
): Promise<{
  missing: Array<{ id: string; paths: string[] }>;
  filesPresent: string[];
  verdicts: ConsolidationVerdict[];
}> {
  const workstreams = state.pipelineState.workstreams ?? {};
  const ids = Object.keys(workstreams);
  if (ids.length <= 1) return { missing: [], filesPresent: [], verdicts: [] };
  // Resolve the mainline branch to diff against.
  let base = "main";
  const mainline = await detectMainline(ctx.repoRoot, execp);
  if (mainline && "branch" in mainline) {
    base = mainline.branch;
  }
  let statusOut = "";
  try {
    // #451 — name the integration branch explicitly. Under worktree isolation
    // the repo root sits on mainline; bare `..HEAD` would compare mainline
    // against itself and return empty (passing the gate unconditionally).
    // #778 — `--name-status -M` (not `--name-only`): renames emit R### with
    // the SOURCE path in the diff output, so a move is visible evidence
    // instead of a silent absence of the old name.
    const branch = state.pipelineState.branchName ?? "HEAD";
    const { stdout } = await execp(`git diff --name-status -M origin/${base}..${branch}`, {
      cwd: ctx.repoRoot,
      maxBuffer: 1024 * 1024,
    });
    statusOut = stdout;
  } catch (err) {
    trace(
      `work-driver: verifyConsolidation diff failed (treating as no-missing): ${(err as Error).message?.slice(0, 120)}`,
    );
    return { missing: [], filesPresent: [], verdicts: [] };
  }
  const changedFiles = new Set<string>();
  // #778 — rename SOURCES (the old side of R### codes): a declared path that
  // was renamed away still shipped; exact-string membership only.
  const renamedSources = new Set<string>();
  for (const line of statusOut.split("\n")) {
    const fields = line.split("\t");
    const code = fields[0]?.trim() ?? "";
    if (!code) continue;
    const codeBase = code[0];
    // A rename (R###) has two columns; the second is the rename's TARGET and
    // is what landed — it belongs in the present set, not the source set.
    if (codeBase === "R" && fields.length >= 3) {
      for (const col of [1, 2] as const) {
        const p = normaliseDeclaredPath(fields[col] ?? "");
        if (!p) continue;
        changedFiles.add(p);
        if (col === 1) renamedSources.add(p);
      }
      continue;
    }
    // #778 — only a RENAME source can cover a declared path. A plain delete
    // (D) still lists the name in `--name-status` — the pre-#778 behavior —
    // so treating D as coverage would let a deleted file keep a workstream
    // "covered"; a moved file is the only move that ships its content.
    const p = normaliseDeclaredPath(fields[1] ?? "");
    if (p && codeBase !== "D") changedFiles.add(p);
  }
  // #778 — filesPresent is the COMMITTED side of the record (what shipped);
  // the rename source may no longer exist, so it is not a "present" file —
  // it only covers a declared path via the source set above.
  const filesPresent = [...changedFiles].filter((p) => p === "" || !renamedSources.has(p));
  // A declared path counts as "in the diff" when a committed file equals it,
  // sits beneath it (a directory declaration covers its contents), or a
  // rename's source equals it (the #778/#744 move case). The exact-match Set
  // lookups are O(1) and are the common case; the prefix scan only fires for
  // directory declarations.
  const declaredPathInDiff = (p: string): boolean =>
    changedFiles.has(p) ||
    renamedSources.has(p) ||
    Array.from(changedFiles).some((f) => f.startsWith(`${p}/`));
  // Normalised declared paths per workstream, so a sibling's set and this
  // workstream's paths compare like-for-like.
  const declaredOf = (ws: { paths: string[] }): string[] =>
    ws.paths.map(normaliseDeclaredPath).filter((p) => p.length > 0);
  // Precomputed once per workstream so the per-path covered-check below is
  // an O(W) scan against precomputed data, not an O(W·F) recompute per path.
  const siblingSets = new Map<string, Set<string>>();
  const siblingFullyPresent = new Map<string, boolean>();
  for (const sid of ids) {
    const s = workstreams[sid];
    if (!s || s.paths.length === 0) continue;
    const set = new Set(declaredOf(s));
    siblingSets.set(sid, set);
    siblingFullyPresent.set(sid, Array.from(set).every(declaredPathInDiff));
  }
  const missing: Array<{ id: string; paths: string[] }> = [];
  const verdicts: ConsolidationVerdict[] = [];
  for (const id of ids) {
    const ws = workstreams[id];
    if (!ws || ws.paths.length === 0) {
      // No paths declared → can't verify; note, don't false-alarm.
      verdicts.push({ id, status: "unverifiable", reason: "no declared paths" });
      continue;
    }
    const own = declaredOf(ws);
    // #875 — the workstream's own cumulative evidence (committed range +
    // porcelain in its worktree), resolved ONCE per worktree. `undefined` =
    // unreadable worktree → fail closed: every declared path counts as
    // touched, so it falls through to uncovered (never a silent pass).
    const cumulative: Set<string> | undefined = await workstreamTouchedSet(
      ctx,
      state,
      id,
      ctx.verifyExecFn ?? execp,
    );
    const cumulativeOf = (p: string): boolean => {
      if (cumulative === undefined) return true; // unreadable → touched
      return cumulative.has(p) || Array.from(cumulative).some((f) => f.startsWith(`${p}/`));
    };
    // #540 full-set subsumption: a declared path p of W is covered when p
    // is in the committed diff, OR p is also declared by a sibling whose
    // ENTIRE declared set is present — a partial sibling cannot cover.
    // #875: OR p is absent from BOTH the workstream's cumulative evidence
    // and the committed diff (over-declaration — covered, not dropped).
    const uncovered = own.filter((p) => {
      if (declaredPathInDiff(p)) return false;
      if (!cumulativeOf(p)) return false;
      return !ids.some((sid) => {
        if (sid === id) return false;
        const s = workstreams[sid];
        if (!s) return false;
        return siblingFullyPresent.get(sid) === true && (siblingSets.get(sid)?.has(p) ?? false);
      });
    });
    if (uncovered.length > 0) {
      missing.push({ id, paths: ws.paths });
      verdicts.push({ id, status: "uncovered", uncoveredPaths: uncovered });
    } else {
      verdicts.push({ id, status: "complete" });
    }
  }
  return { missing, filesPresent, verdicts };
}

/**
 * A declared path as `git` would spell it.
 *
 * `paths` is prose from the plan step, not `git` output, and — measured across
 * the real state files on this host — it carries annotations the planner added
 * for a human reader:
 *
 *     "extension/src/work-driver-verify-cmd.ts (new)"
 *     "extension/src/role-tools.ts (no changes)"
 *
 * Compared by exact equality against `git diff --name-only`, neither ever
 * matches, so the workstream reads as MISSING even when its files changed. The
 * failure is one-directional — a false alarm at commit-pr, never a false pass —
 * which is why it went unnoticed.
 *
 * A trailing parenthetical is stripped; one INSIDE a name ("notes (draft).md")
 * is not, because that is a real filename.
 */
export function normaliseDeclaredPath(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/^[`*\s]+|[`*\s]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}
