/**
 * work-driver-fix-pass-named — the finding-named widening of a fix pass's fence.
 *
 * Split from `work-driver-adversarial-fix-scope.ts`, which owns the ladder that
 * consumes the result. This is the ONE question the plan step asks before any pass
 * runs: which files does a reviewer's finding authorise this pass to touch?
 *
 * It is a module of its own because the answer is a rule with three independent
 * conditions and a caller who must not be able to relax any of them. The widening
 * is how a fix pass fixes the thing the reviewer actually found — without it, a
 * finding that says "the guard in `auth.ts`" is unfixable by a pass whose plan
 * named only `login.ts` — and every condition below exists because the widening
 * without it is an unfenced pass.
 */

import { anchorDirs, dirOfPath, pathTokenIn } from "./work-driver-declared-path.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";

/**
 * Named paths a fix pass may widen its fence onto. Generic, not a project list:
 * a finding-named path qualifies only if it is (a) in `candidates` — the union
 * of the tree tracked at base and the files this cycle already committed
 * (#1698: a file the cycle's own round created is never tracked at base, so
 * the tracked-at-base reading alone made it un-nameable by construction),
 * (b) not protected per `protectedPathsIn` (the single source of protected
 * paths), and (c) in the same directory as an anchor — a declared path or a
 * file the workstream already changed. A directory entry (`src/foo/`) is its
 * own directory. The repo root is not an anchor: a root-level anchor would make
 * every root file widenable. Named as a whole path token (`data.txt` does not
 * name `a.txt`).
 */
export function namedPaths(
  findings: string,
  candidates: readonly string[],
  anchors: readonly string[],
): string[] {
  const dirs = anchorDirs(anchors);
  return [...new Set(candidates)].filter(
    (p) => protectedPathsIn([p]).length === 0 && dirs.has(dirOfPath(p)) && pathTokenIn(findings, p),
  );
}
