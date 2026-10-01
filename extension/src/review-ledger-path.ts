/**
 * review-ledger-path — the ledger file path resolution, split from
 * review-ledger.ts (file-size gate, #955).
 *
 * Owns the single cohesive unit of path resolution: the git-common-dir
 * lookup (one ledger per clone, not per worktree) and the explicit
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override. review-ledger.ts re-exports
 * `ledgerPathFor` so importers are unchanged; this module imports nothing
 * from review-ledger.ts, so there is no import cycle.
 */

import path from "node:path";
import type { LedgerExecFn } from "./review-ledger.ts";
import { trace } from "./trace.ts";

/**
 * #955 lens fix 6: tracks which override paths have been traced in this
 * process (one-time trace per distinct override path).
 */
const ledgerOverrideTraced = new Set<string>();

/**
 * Resolve the ledger file path for a clone.
 *
 * `git rev-parse --git-common-dir` resolves to the MAIN clone's .git for
 * worktrees (worktrees live under .git/worktrees/… and their common dir
 * points back), so every worktree shares one ledger. Absolute-path: a
 * relative answer (a plain clone at cwd) is anchored on `cwd`.
 *
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` is an explicit absolute-path override.
 * When set it is returned verbatim and no git call is made. Tests set this
 * to a private temp file so fixture writes never touch the real per-clone
 * ledger; operators normally do not set it.
 *
 * Injects the git executor (tests stub it) and the file name (tests point
 * the ledger at a fixture without touching git).
 */
export async function ledgerPathFor(
  execFn: LedgerExecFn,
  cwd: string,
  fileName = "review-ledger.json",
): Promise<string | undefined> {
  // An explicit override short-circuits before any git call: the override is
  // authoritative (tests point the ledger at a private temp file so concurrent
  // runs never clobber the real per-clone ledger).
  const override = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE?.trim();
  if (override) {
    // #955 lens fix 6: one-time trace per process so an operator-set
    // override is visible in the trace log.
    if (!ledgerOverrideTraced.has(override)) {
      ledgerOverrideTraced.add(override);
      trace(`review-ledger: ledger override in effect → ${override}`);
    }
    return override;
  }
  try {
    const { stdout } = await execFn("git rev-parse --git-common-dir", { cwd, maxBuffer: 8 * 1024 });
    const raw = stdout.trim();
    if (!raw) return undefined;
    const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    // A worktree's common dir is .git/worktrees/<name>; the SHARED storage
    // is the main .git — one ledger per clone, not per worktree.
    const dir =
      raw.startsWith("worktrees/") && !commonDir.endsWith(".git")
        ? path.join(commonDir, "..", "..")
        : commonDir;
    return path.join(dir, fileName);
  } catch (err) {
    trace(`review-ledger: cannot resolve git common dir: ${(err as Error).message}`);
    return undefined;
  }
}
