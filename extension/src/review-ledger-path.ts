/**
 * review-ledger-path — the ledger file path resolution, split from
 * review-ledger.ts (file-size gate, #955).
 *
 * Owns the single cohesive unit of path resolution: the git-common-dir
 * lookup (one ledger per clone, not per worktree) and the explicit
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` override. review-ledger.ts re-exports
 * `ledgerPathFor` so importers are unchanged; this module only imports a type
 * from review-ledger.ts (no runtime cycle), so importers are unchanged.
 *
 * It also owns `identityBase` (#1305): the ONE answer to "which ref is a
 * review's patch identity taken against", shared by the ledger writer and the
 * merge guard so the two cannot resolve different bases.
 *
 * #1449 — and the ONE place the override is compared against the clone's own
 * path. `ledgerPathFor` honours `PI_ENSEMBLE_REVIEW_LEDGER_FILE` before any git
 * call, so guard and writer share one resolution and neither notices a
 * redirect; `cloneLedgerPathFor` is the override-blind twin and
 * `misdirectedLedgerWrite` is the predicate every writer uses to report a row
 * that landed outside the per-clone ledger.
 *
 * #1387 — this module imports no `work-driver*.ts` module. Its mainline lookup
 * comes from the neutral leaf `mainline.ts`, which the driver imports too.
 * `test-review-ledger-path-imports.ts` fails the suite on any driver import
 * here, direct or type-only.
 */

import path from "node:path";
import { resolveMainline } from "./mainline.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { trace } from "./trace.ts";

/**
 * #955 lens fix 6: tracks which override paths have been traced in this
 * process (one-time trace per distinct override path).
 */
const ledgerOverrideTraced = new Set<string>();

/**
 * #1449 — the env var that redirects every ledger read and write. Named once
 * here because it is the ONLY read site of it in `extension/src`; anything
 * that has to ask "where would a write land, and where SHOULD it" reads both
 * answers out of this module (`ledgerPathFor` and `cloneLedgerPathFor`).
 */
export const LEDGER_OVERRIDE_ENV = "PI_ENSEMBLE_REVIEW_LEDGER_FILE";

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
  const override = process.env[LEDGER_OVERRIDE_ENV]?.trim();
  if (override) {
    // #955 lens fix 6: one-time trace per process so an operator-set
    // override is visible in the trace log.
    if (!ledgerOverrideTraced.has(override)) {
      ledgerOverrideTraced.add(override);
      trace(`review-ledger: ledger override in effect → ${override}`);
    }
    // #955 (perf, LOW a): the docs say the override is an absolute path, but
    // be tolerant — a relative path is resolved against the given cwd via
    // path.resolve so it works whether the operator sets it relative or
    // absolute.
    return path.isAbsolute(override) ? override : path.resolve(cwd, override);
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

/**
 * #1449 — where a ledger row is SUPPOSED to land: the per-clone git common
 * dir, with NO `PI_ENSEMBLE_REVIEW_LEDGER_FILE` short-circuit.
 *
 * `ledgerPathFor` honours the override before any git call, so within one
 * process the writer and the #912 guard agree on the redirected file and
 * NEITHER can notice the mismatch — that is why the misdirected-write signal
 * cannot come from the guard re-deriving a path (it would read the same
 * poisoned `process.env`). It comes from the write side, which compares its
 * resolved path against THIS one — the override-blind answer — and names the
 * file it actually wrote to.
 *
 * The override stays legitimate (docs/troubleshooting.md documents it as the
 * operator's scratch-ledger, and the whole offline suite isolates on it): this
 * resolver never changes where anything is written, only what gets reported.
 * Its one cost is a `git rev-parse --git-common-dir` call per comparison —
 * paid only while the override is set, so a normal run pays nothing.
 */
export async function cloneLedgerPathFor(
  execFn: LedgerExecFn,
  cwd: string,
  fileName = "review-ledger.json",
): Promise<string | undefined> {
  try {
    const { stdout } = await execFn("git rev-parse --git-common-dir", { cwd, maxBuffer: 8 * 1024 });
    const raw = stdout.trim();
    if (!raw) return undefined;
    const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    // Same worktree rule as `ledgerPathFor`: the SHARED storage is the main
    // .git, so every worktree of a clone has one expected ledger.
    const dir =
      raw.startsWith("worktrees/") && !commonDir.endsWith(".git")
        ? path.join(commonDir, "..", "..")
        : commonDir;
    return path.join(dir, fileName);
  } catch (err) {
    trace(`review-ledger: cannot resolve the clone ledger dir: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * #1449 — the operator-visible line a review's tool summary carries when its
 * ledger row landed somewhere other than the per-clone ledger: a
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` inherited through the process tree (a test
 * helper that leaked one, a parent shell that exported one, a child Pi process
 * that spread it) silently relocates BOTH the guard's read and the writer's
 * write, so a review that ran reads as "no lens review on file" at merge time.
 *
 * A constant rather than prose per site so the lens note, the adversarial note
 * and the guard's refusal all say the same thing, and so it is textually
 * distinct from the by-design no-write outcomes (`noReview`, carry, no-branch,
 * no-patch-id, and NOT_RECORDED_NOTE) that write nothing at all.
 */
export const MISDIRECTED_LEDGER_NOTE =
  "⚠ LEDGER WRITE MISDIRECTED — this review's ledger row was written to an overridden path, NOT the per-clone review ledger under the git common dir, so the #912 merge guard has NO record of it and will refuse the merge. The override is `PI_ENSEMBLE_REVIEW_LEDGER_FILE`, inherited through the process environment (it is re-read on every ledger access, never cached); unset it and re-run the review to record this round.";

/**
 * #1449 — the one comparison a writer runs before reporting a misdirected row.
 *
 * Returns the resolved path when the write landed outside the per-clone ledger
 * (and the per-clone path is knowable — an unresolvable git dir is NOT
 * reported as a misdirection: there is nothing to compare against, and a
 * non-repo cwd is a by-design skip, not a misdirection). Returns undefined for
 * "no misdirection", the overwhelmingly common case: no override set, the
 * override already pointing at the clone's own file, or git unreadable.
 *
 * Every ledger writer (lens + adversarial) and every caller that reports the
 * outcome (the tool summary, the round-cap note) goes through this ONE
 * predicate, so the two writers can never disagree about what a misdirection
 * is.
 */
export async function misdirectedLedgerWrite(
  execFn: LedgerExecFn,
  cwd: string,
  resolved: string | undefined,
): Promise<string | undefined> {
  if (!resolved) return undefined;
  if (!process.env[LEDGER_OVERRIDE_ENV]?.trim()) return undefined;
  const expected = await cloneLedgerPathFor(execFn, cwd);
  if (!expected) return undefined;
  return resolved === expected ? undefined : resolved;
}

/**
 * The remote the forge detection resolves against: `origin` → `upstream` →
 * the first remote in `git remote` order — the same precedence as
 * `detectForge` (forge-detect.ts). The guard and the ledger writers both
 * call this, so a repo whose remote is NOT named `origin` resolves the same
 * ref on both sides of the patchId comparison. Returns undefined when the
 * repo has no remotes — the callers fail closed.
 */
export async function remoteName(execFn: LedgerExecFn, cwd: string): Promise<string | undefined> {
  for (const name of ["origin", "upstream"]) {
    try {
      const { stdout } = await execFn(`git config --get remote.${name}.url`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      if (stdout.trim()) return name;
    } catch {
      /* try the next */
    }
  }
  try {
    const { stdout } = await execFn("git remote", { cwd, maxBuffer: 64 * 1024 });
    return stdout.trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The successful `identityBase` answer, exported so a caller that resolved it
 * ONCE can hand the same pair to every consumer of the identity (the patch-id
 * computation and #1360's range check) rather than asking twice and trusting
 * two git reads to agree.
 */
export interface IdentityBase {
  remote: string;
  mainline: string;
}

/**
 * #1305 — the base every review identity is taken against:
 * `<remote>/<mainline>` (mainline via `resolveMainline`, remote via
 * `remoteName`). The writer (`workingTreePatchId`) and the merge guard
 * (`mergeIdentity`) both call this, so the identity the guard recomputes is
 * built against the same ref the ledger entry was. A failure is
 * `{ ok: false, reason }` — every caller fails closed.
 */
export async function identityBase(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<{ ok: true; remote: string; mainline: string } | { ok: false; reason: string }> {
  const mainline = await resolveMainline(cwd, execFn);
  if (!mainline.ok) {
    return { ok: false, reason: `cannot resolve the mainline branch (${mainline.reason})` };
  }
  const remote = await remoteName(execFn, cwd);
  if (!remote) return { ok: false, reason: "no git remote found (origin/upstream/first)" };
  return { ok: true, remote, mainline: mainline.branch };
}
