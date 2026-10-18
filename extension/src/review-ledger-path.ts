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
 * It also owns `sanitiseLedgerProvenancePath` (#1449 lens round 1): the row's
 * `writtenTo` stamp comes from a file the environment names, so the value the
 * guard renders is untrusted data and is reduced (control characters stripped,
 * length capped) here, in the one module that both writers and the guard read.
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

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveMainline } from "./mainline.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { LOCAL_GIT_TIMEOUT_MS } from "./review-patch-identity.ts";
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
  const dir = await cloneGitDir(execFn, cwd);
  return dir ? path.join(dir, fileName) : undefined;
}

/**
 * The clone's SHARED git storage directory — the directory every ledger (and
 * every ledger lock) lives in, for this cwd whether it is a plain clone or a
 * worktree.
 *
 * #1449 lens round 1 — ONE private helper behind both public resolvers
 * (`ledgerPathFor` and `cloneLedgerPathFor`). The two used to carry the same
 * `git rev-parse --git-common-dir` body each, which meant a fix to the
 * worktree rule — the `worktrees/` fold below — had to be made twice, and a
 * fix made once would leave the two resolvers disagreeing about where the
 * clone's ledger is. A disagreement of exactly that kind is what the
 * misdirection predicate is supposed to DETECT, so the comparison must not be
 * built from two bodies that can drift.
 *
 * Returns undefined when git cannot answer; both callers treat that as "no
 * path", and `misdirectedLedgerWrite` treats an unresolvable dir as "nothing
 * to compare against" rather than a misdirection.
 */
async function cloneGitDir(execFn: LedgerExecFn, cwd: string): Promise<string | undefined> {
  try {
    // `LOCAL_GIT_TIMEOUT_MS` — the bound every other guard-side git read uses
    // (review-patch-identity.ts, and the same value review-branch.ts carries).
    // A stalled `git` here used to hang the ledger write with no bound at all,
    // and on the guard's path it hangs the merge evaluation with it.
    const { stdout } = await execFn("git rev-parse --git-common-dir", {
      cwd,
      maxBuffer: 8 * 1024,
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    const raw = stdout.trim();
    if (!raw) return undefined;
    const commonDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    // A worktree's common dir is .git/worktrees/<name>; the SHARED storage
    // is the main .git — one ledger per clone, not per worktree.
    return raw.startsWith("worktrees/") && !commonDir.endsWith(".git")
      ? path.join(commonDir, "..", "..")
      : commonDir;
  } catch (err: unknown) {
    // `instanceof`, never a cast: `(err as Error).message` is erased at compile
    // time and throws a TypeError INSIDE this catch when what threw was not an
    // Error — a bare string from a stub executor, or an odd property access —
    // turning "git could not answer" into "the ledger module exploded".
    const reason = err instanceof Error ? err.message : String(err);
    trace(`review-ledger: cannot resolve git common dir: ${reason}`);
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
  // Same body as `ledgerPathFor`'s git branch by construction — both read
  // `cloneGitDir`, so the worktree fold can only ever have one definition.
  const dir = await cloneGitDir(execFn, cwd);
  return dir ? path.join(dir, fileName) : undefined;
}

/**
 * #1449 lens round 1 — the `writtenTo` stamp, reduced to something it is safe
 * to put inside a refusal message.
 *
 * The stamp is written by whichever process made the write, and it is read
 * back out of a file the environment names — so by the time the #912 guard
 * renders it, it is untrusted data. Two properties have to hold before it
 * reaches prose:
 *
 * - **no control characters / newlines.** A refusal is rendered into the
 *   agent's tool-result text; a row stamped with an embedded `\n` (or an
 *   ANSI/OSC escape) would inject lines into a message whose authority is the
 *   guard's. Stripped rather than rejected, because a path carrying a stray
 *   control byte is still the operator's best clue to the leaked file.
 * - **bounded length.** The value is a path from a hostile-ish source and the
 *   refusal is one line among the guard's output; 240 chars is comfortably
 *   longer than any real filesystem path and short enough that a pathological
 *   stamp cannot crowd the refusal out of view.
 *
 * Returns undefined for anything that was never a usable stamp (not a
 * string, empty after sanitising) — the caller then renders the plain
 * never-reviewed refusal, which is the right text for "we have nothing to
 * name".
 */
/**
 * The length cap `sanitiseLedgerProvenancePath` clamps to. Exported so the
 * #1449 fixtures can size a path *past* it from the same number the
 * sanitiser uses — a literal in a test is a second source of truth that
 * drifts the day the cap moves, and on a host with a short temp root a
 * hand-counted fixture silently becomes the short case instead.
 */
export const LEDGER_PROVENANCE_PATH_MAX = 240;

export function sanitiseLedgerProvenancePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Stripping C0/C1 IS the operation, so the class is written from the character
  // codes rather than as control-character literals in a pattern: a literal range
  // in a regex is both the thing the linter flags and the thing a reader has to
  // decode, and neither is improved by a suppression comment the linter ignores.
  const stripped = [...value]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join("")
    .trim();
  if (!stripped) return undefined;
  return stripped.slice(0, LEDGER_PROVENANCE_PATH_MAX);
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
 *
 * #1449 round 2 — the comparison must be fed the RAW resolved paths, never the
 * sanitised stamp: `sanitiseLedgerProvenancePath` clamps at 240 chars, so a
 * long clone path clamps to a PREFIX of itself and every ordinary write would
 * read as a redirect. Sanitising is a render-time operation (the guard prints
 * the value) and this predicate is a decision-time one.
 */
export function sameResolvedPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  if (x === y) return true;
  // #1449 round 2 — resolve BOTH sides independently instead of letting one
  // failure collapse the whole comparison. `realpathSync` throws ENOENT for a
  // path that does not exist yet, and a ledger file legitimately does not exist
  // before the first write — so the old blanket `catch` fired on the ORDINARY
  // first review of a fresh clone and reported it as a redirect. The lexical
  // equality above already ruled out the trivial case; what is left to decide
  // is whether either side is a symlink (or a `..`-laden spelling) of the
  // other, and that only needs the side that EXISTS resolved.
  //
  // So each side falls back to its own lexical resolve when realpath fails,
  // rather than the pair falling back to "different". A side that cannot be
  // realpath'd is compared as its absolute path — which is what both callers
  // handed in anyway (`ledgerPathFor` / `cloneLedgerPathFor` both `path.resolve`
  // their output), so the comparison stays meaningful. The fail direction is
  // unchanged for the case the catch was written for: two paths that differ and
  // cannot both be resolved still compare unequal, and the caller still reports
  // a redirect rather than hiding one.
  return realpathOrSelf(x) === realpathOrSelf(y);
}

/**
 * True when `p`'s PARENT DIRECTORY exists.
 *
 * Exists so the writer — which compares paths BEFORE it has written anything —
 * can settle "same file?" without a `git rev-parse` when no aliasing is
 * possible. A path whose parent directory does not exist cannot be a symlink
 * and cannot contain one, so the lexical comparison is the whole truth and the
 * extra spawn would buy nothing. When the parent DOES exist, a symlink anywhere
 * in it is possible and the caller pays the git call to find out.
 */
function pathParentExists(p: string): boolean {
  try {
    return statSync(path.dirname(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * #1449 round 2 — "did this row land outside the clone's own ledger?" Answered
 * from the two RAW resolved paths.
 *
 * #1449 round 2 — note what is NOT sanitised here. `sanitiseLedgerProvenancePath`
 * clamps at 240 chars, so stamping (or comparing) the sanitised value makes a
 * long clone path collapse to a PREFIX of itself and every ordinary write past
 * the cap reads as a redirect. The stamp is therefore the raw resolved path
 * (review-ledger.ts) and this comparison consumes raw paths; sanitising happens
 * only where the value is RENDERED, in `misdirectedWriteOf`. The comparison is
 * deliberately a SEPARATE function from `sameResolvedPath` — one call site that
 * sanitises before comparing would otherwise re-introduce the bug by editing the
 * wrong one of two callers.
 *
 * Two things separate it from plain `sameResolvedPath`:
 *
 * 1. the arguments are RAW, never the sanitised stamp.
 * 2. the no-spawn fast path. `appendLedgerEntry` wants to skip
 *    `cloneLedgerPathFor` (a `git rev-parse` on EVERY write) when it cannot
 *    change the answer. With no override the two paths come from the same
 *    resolver and the same `fileName`, so they are equal by construction — but
 *    that claim does not cover the case where the override points at a COPY of
 *    the clone's ledger (an operator's scratch file moved into the git dir, a
 *    fixture that copied it): then the override IS set and the two paths can
 *    coincide textually or through a symlink. So the spawn is skipped only when
 *    no aliasing is possible: no override set, or the ledger's parent directory
 *    absent (nothing there can be a symlink).
 *
 * Returns the resolved path when the write landed outside the clone's ledger,
 * undefined when it landed in it (or there was nothing to compare against).
 */
export async function ledgerWriteLandedAt(
  execFn: LedgerExecFn,
  cwd: string,
  resolved: string,
  fileName = "review-ledger.json",
): Promise<string | undefined> {
  if (!process.env[LEDGER_OVERRIDE_ENV]?.trim()) return undefined;
  const clone = pathParentExists(resolved)
    ? await cloneLedgerPathFor(execFn, cwd, fileName)
    : path.join(path.dirname(resolved), fileName);
  return sameResolvedPath(resolved, clone) ? undefined : resolved;
}

/** `realpathSync` when the path exists; the absolute path itself when it does not. */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // ENOENT (not yet written) and ENOTDIR (a parent is a file) both mean
    // "nothing more to learn here" — the lexical path is the best answer.
    return p;
  }
}

export async function misdirectedLedgerWrite(
  execFn: LedgerExecFn,
  cwd: string,
  resolved: string | undefined,
): Promise<string | undefined> {
  if (!resolved) return undefined;
  if (!process.env[LEDGER_OVERRIDE_ENV]?.trim()) return undefined;
  const expected = await cloneLedgerPathFor(execFn, cwd);
  if (!expected) return undefined;
  return sameResolvedPath(resolved, expected) ? undefined : resolved;
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
