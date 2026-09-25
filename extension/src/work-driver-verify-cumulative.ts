/**
 * work-driver-verify-cumulative — #875 cumulative "touched by the
 * workstream" evidence for verifyConsolidation.
 *
 * `verifyConsolidation` (work-driver-verify.ts) can only see the
 * integration branch's committed diff. A workstream that legitimately
 * left a declared path untouched (the #799 shape — the file needed no
 * edit) is then indistinguishable from one whose slice was dropped.
 *
 * The cumulative rule closes the gap: a workstream's OWN evidence is
 * the UNION of
 *
 *   (a) its committed range — `git diff --name-status -M <ownBase>..HEAD`
 *       in its worktree, where `<ownBase>` is the workstream's own range
 *       base (workstreamBaseShas[id] → globalBaseSha → baseSha, the
 *       measureConsolidationCompleteness ownBase pattern — a stacked
 *       workstream's global range would include its ancestors' files);
 *   (b) its worktree porcelain — `git status --porcelain` (modified
 *       AND untracked; porcelain `??` entries count — a workstream
 *       whose entire slice is new untracked files would otherwise pass
 *       as over-declaration, the #483 shape);
 *
 * and a declared path absent from BOTH and absent from the committed
 * integration diff is an over-declaration — the workstream is COMPLETE.
 *
 * Failure direction is load-bearing and asymmetric with the integrated
 * diff read (which stays best-effort — a git-shell failure there returns
 * no-missing, unchanged): a worktree whose range or porcelain read
 * FAILED (git error, missing worktree path, missing base SHA) is treated
 * as TOUCHED — every path counts as touched, so the covered-check fails
 * closed and the workstream falls through to the existing
 * uncovered/park logic. A worktree the driver cannot read cannot prove
 * the slice shipped; it never passes.
 *
 * `normaliseDeclaredPath` applies on BOTH sides (declared paths and the
 * git output), and a rename's SOURCE counts as touched, matching the
 * #778 rename treatment of the committed-diff side.
 */

import type { DriverContext } from "./work-driver-context.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { WorkState } from "./workflow-state.ts";

const VALID_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The workstream's cumulative touched set — the normalised paths its own
 * committed range and its worktree porcelain touch (see the module header
 * for the two sources and the ownBase rule).
 *
 * Returns `undefined` when the worktree CANNOT be read (missing path in
 * `worktrees`, no usable base SHA for the range, or a git failure in
 * either read). The caller must treat `undefined` as FULLY touched
 * (fail-closed): a worktree the driver cannot read cannot prove the
 * slice shipped, so the workstream parks instead of passing.
 */
export async function workstreamTouchedSet(
  ctx: DriverContext,
  state: WorkState,
  id: string,
  execFn?: (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string }>,
): Promise<Set<string> | undefined> {
  const ps = state.pipelineState;
  const wt = ps.worktrees?.[id];
  if (!wt) return undefined;
  const fn = execFn ?? ctx.verifyExecFn;
  if (!fn) return undefined; // no injected git → unreadable → fail closed
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
      // #778 — a rename's SOURCE is touched even though the old name no
      // longer exists (the same treatment as the committed-diff side).
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

  // (b) the worktree porcelain — modified AND untracked (`??` counts;
  // porcelain `??` entries matter because a workstream whose entire slice
  // is new untracked files would otherwise pass as over-declaration, the
  // #483 shape).
  let porcelainOut: string;
  try {
    const { stdout } = await fn("git status --porcelain", {
      cwd: wt,
      maxBuffer: 1024 * 1024,
    });
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
