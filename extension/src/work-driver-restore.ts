import { trace } from "./trace.ts";
/**
 * work-driver-restore — #750: the shared verified-restore helper for
 * consolidation abort paths.
 *
 * The pre-#750 restore in `runConsolidatedVerify` and `integrate` ran
 * `git reset --hard` + `git checkout --force <ref>` with `.catch(trace)` on
 * each step, so a failed reset was silently ignored and the caller
 * unconditionally claimed "repoRoot restored". The observed incident proves
 * the claim can be false: the root was left with staged (M) and unmerged (UU)
 * index entries, the cherry-pick operation markers already removed, and
 * `git status --porcelain` non-empty — poisoning every later cycle until a
 * human ran `git reset --hard` by hand.
 *
 * This helper is the single implementation all consolidation abort sites
 * (develop-time consolidated verify, commit-pr `integrate()`, handoff
 * consolidation) share:
 *
 *   1. Preserve the discarded state — `git diff`, `git diff --cached` and the
 *      status — to a scratch file BEFORE anything destructive. The discarded
 *      content may be the only copy of work (in the incident it held a
 *      genuinely different implementation of the same fix). #1258 — if that
 *      save FAILS, nothing below runs: the tree is left as it is and the
 *      result says so (work-driver-restore-save.ts).
 *   2. Reset index + working tree (`git reset --hard`). Measured on the exact
 *      incident shape (M + UU entries, no CHERRY_PICK_HEAD / MERGE_HEAD),
 *      `reset --hard` alone clears it — no `reset --merge` /
 *      `checkout --merge` leg (both SUPERSEDED in the issue). No operation
 *      metadata is removed before this: the reset itself is the recovery,
 *      and git's own `--abort` commands, when available, are the caller's to
 *      try first (they refuse — exit 128 — when no operation marker exists,
 *      which is exactly the incident state).
 *   3. Restore the original checkout (`git checkout --force <originalRef>`).
 *   4. Verify the post-condition: `git status --porcelain` must be empty of
 *      tracked dirt (untracked `??` entries and `.worktrees/` scaffolding
 *      excluded). `restored` is true ONLY when that read confirms it — never
 *      from "no exception was thrown".
 *   5. On failure, return `restored: false` with `detail` naming the
 *      still-dirty paths. The caller must emit that, not the restored claim:
 *      a failed cleanup is louder than a successful one, not quieter.
 *
 * Untracked files are never swept — `git clean` is forbidden by the issue
 * (some untracked content is deliberate). The integration lock is owned by
 * the caller (`withIntegrationLock`'s `finally`), which releases on every
 * path; this helper never holds the lock itself.
 *
 * #1093 — two restore families live here, and they are NOT the same thing:
 *   - restoreRootToRef / restoreRootToRefPreserving are the OPERATOR-CHECKOUT
 *     restores. Non-forcing by construction: a plain `git checkout`, never
 *     `--hard` / `--force`. The abort path stashes only the cycle's own paths.
 *     A refusal leaves the tree as it is and reports the exact command to run
 *     by hand. restoreCheckout (work-driver-git.ts) and the handoff
 *     consolidation path call these.
 *   - verifiedRestoreRoot is the driver's INTERNAL integration-point reset
 *     (`reset --hard` + `checkout --force`). It is forcing by design and is
 *     deliberately out of #1093's scope: it resets the driver's own integration
 *     root, not the operator's checkout.
 */
import { preserveDiscardedState } from "./work-driver-restore-save.ts";
import type { ExecFn } from "./worktree.ts";

/** A full commit SHA: the only ref form a detached start can produce. */
const FULL_SHA = /^[0-9a-f]{40}$/;
/** A name a restore may pass to git: no shell metacharacters, no leading `-`. */
const PLAIN_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
/** How many untracked paths a restore claim names before it counts the rest. */
const UNTRACKED_SHOWN = 10;

/**
 * #1093 — the syntactic half of the ref check, with no git call: a 40-hex SHA,
 * or a plain name. Refuses shell or option syntax (`$(…)`, backticks, a leading
 * `-`) before git sees it. Callers still pass refs through argv; this is the
 * refusal, not the only defence.
 */
function restoreRefSyntaxProblem(ref: string): string | undefined {
  if (FULL_SHA.test(ref)) return undefined;
  if (!PLAIN_REF.test(ref)) return `"${ref}" contains characters a restore will not check out`;
  return undefined;
}

/**
 * #1093 — why `ref` may not be checked out, or `undefined` when it may: the
 * syntactic check, then `git check-ref-format --branch` for names. Validate a
 * ref ONCE per restore: resolveRestoreTarget (work-driver-git.ts) is the one
 * caller on the restore path; restoreRootToRef re-checks syntax only.
 */
export async function restoreRefProblem(
  execFn: ExecFn,
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  const syntax = restoreRefSyntaxProblem(ref);
  if (syntax !== undefined) return syntax;
  if (FULL_SHA.test(ref)) return undefined;
  try {
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      argv: ["check-ref-format", "--branch", ref],
    });
    return undefined;
  } catch (err) {
    return `"${ref}" is not a valid branch name (${(err as Error).message?.slice(0, 120)})`;
  }
}

/** One record of the structured `git status` read at repoRoot. */
interface StatusEntry {
  /** The two-character XY porcelain code (`??` for untracked). */
  code: string;
  path: string;
  /** A rename or copy's original path (the record after the entry). */
  origPath?: string;
}

/** Paths the driver never counts as checkout dirt: its scaffolding and state. */
function isExcludedStatusPath(p: string): boolean {
  return p.startsWith(".worktrees/") || p.startsWith(".pi/work-state/");
}

/** A tracked entry: anything git knows about, staged, unstaged or unmerged. */
const isTracked = (e: StatusEntry): boolean => e.code !== "??";

/**
 * #1093 — the ONE structured status read at repoRoot. The abort path's
 * changed-path list and every restore post-condition derive from it, so they
 * cannot disagree about what is dirty. `-uall` lists each untracked file (a
 * bare `-u` collapses a directory into one `dir/` entry); `-z` keeps unusual
 * names unquoted. Throws when git cannot be read.
 */
async function readStatus(execFn: ExecFn, repoRoot: string): Promise<StatusEntry[]> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
    argv: ["status", "--porcelain", "-z", "-uall"],
  });
  const records = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const entry: StatusEntry = { code: rec.slice(0, 2), path: rec.slice(3) };
    if (/[RC]/.test(entry.code)) entry.origPath = records[++i] ?? "";
    if (!isExcludedStatusPath(entry.path)) entries.push(entry);
  }
  return entries;
}

/**
 * #1093 — the paths the cycle changed at repoRoot: every TRACKED entry (a
 * staged NEW file included, and a rename's original path too). Read BEFORE the
 * abort path's mixed reset, which would turn those files untracked and leave
 * them indistinguishable from the operator's own untracked files. Throws when
 * git cannot be read.
 */
async function cycleChangedPaths(execFn: ExecFn, repoRoot: string): Promise<string[]> {
  const entries = await readStatus(execFn, repoRoot);
  return entries
    .filter(isTracked)
    .flatMap((e) => (e.origPath !== undefined ? [e.path, e.origPath] : [e.path]));
}

/** The verified post-condition of a restore attempt. */
export interface VerifiedRestoreResult {
  /** True only when `git status --porcelain` at repoRoot was empty of
   *  tracked dirt after the reset + checkout. Callers MUST NOT claim
   *  "restored" unless this is true. */
  restored: boolean;
  /** When `restored` is false: the distinct failure, naming the paths still
   *  dirty (or the command that could not run). */
  detail?: string;
  /** Where the discarded state was preserved, if it was captured. */
  preservedAt?: string;
  /** #1093 — true when the checkout itself succeeded (HEAD moved), even if
   *  tracked dirt then remained and `restored` is false. */
  checkedOut?: boolean;
  /** #1093 — untracked files present at repoRoot after a successful restore.
   *  They do not make `restored` false (the restore never sweeps them), but
   *  the claim must name them rather than say "verified restored". */
  untracked?: string[];
}

/**
 * The claim text for the operator. Every caller emits one of exactly three
 * shapes — the verified post-condition, the explicit not-restored failure
 * with the preserved diff location, or the aborted-batch marker (`r ===
 * undefined`: the restore never ran because no originalRef was captured)
 * — so no site can re-introduce an unqualified "restored" claim. `label`
 * prefixes the post-condition for the caller's own wording (integrate,
 * consolidated verify, handoff consolidation each say slightly different
 * things before the claim); `trailing` appends a hint after the not-restored
 * failure (the handoff's not-restored variant tells the operator to run git
 * status).
 */
export function restoreClaim(
  r: VerifiedRestoreResult | undefined,
  opts: { label?: string; trailing?: string } = {},
): string {
  const { label, trailing } = opts;
  if (r === undefined) return "the batch was aborted";
  if (r.restored) {
    const untracked = r.untracked ?? [];
    const more =
      untracked.length > UNTRACKED_SHOWN ? ` (+${untracked.length - UNTRACKED_SHOWN} more)` : "";
    const restored =
      untracked.length > 0
        ? `repoRoot checkout was restored, but ${untracked.length} untracked file(s) remain in the checkout — they may be yours or left by the cycle: ${untracked.slice(0, UNTRACKED_SHOWN).join(", ")}${more}`
        : "repoRoot was verified restored";
    if (!label) return restored;
    return label.endsWith(" ") ? `${label}${restored}` : `${label} ${restored}`;
  }
  const preserved = r.preservedAt ? ` (discarded state preserved at ${r.preservedAt})` : "";
  const tail = trailing ? ` ${trailing}` : "";
  return `repoRoot was NOT restored: ${r.detail ?? "unknown error"}${preserved}${tail}`;
}

/**
 * #1258 — the restore result when the discarded state could not be saved.
 * Nothing destructive has run: the tree is the only copy of what it holds,
 * so it is left exactly as it is and the claim says so, with the path, for
 * a recovery by hand. The root stays dirty, and the next cycle's dirty-root
 * gate refuses to start until the operator has dealt with it — on purpose.
 */
function saveFailedRestore(repoRoot: string, error: string): VerifiedRestoreResult {
  return {
    restored: false,
    checkedOut: false,
    detail: `the discarded state could not be saved (${error}), so nothing was reset or checked out — the tree at ${repoRoot} is left exactly as it was; recover its changes by hand`,
  };
}

/**
 * #1093 — the non-forcing restore for an ABORT path (conflict, apply-conflict,
 * throw). The discarded state is preserved to a file first; if that save
 * fails, the tree is left untouched (#1258). The cycle's own
 * changed paths are read, then `git reset` (mixed) clears the index (the
 * conflict's staged and unmerged entries), then `git stash push -u -- <those
 * paths>` moves exactly those paths out of the working tree. Scoping the stash
 * to the cycle's paths matters: a whole-tree `-u` would also stash the
 * operator's OWN untracked files in repoRoot. The mixed reset is needed
 * because it keeps the cycle's edits as unstaged modifications, which a plain
 * checkout would otherwise carry onto the target. The stash is recoverable
 * (`git stash list`), so nothing is lost. The caller guarantees repoRoot was
 * clean before the cycle touched it, so every tracked change here is the
 * cycle's. Never `--hard`, never `--force`. If the stash fails the checkout is
 * not attempted, and the detail carries the commands to run by hand. Never
 * throws.
 */
export async function restoreRootToRefPreserving(
  execFn: ExecFn,
  opts: { repoRoot: string; ref: string; scratchDir: string; label: string },
): Promise<VerifiedRestoreResult> {
  const { repoRoot, ref, scratchDir, label } = opts;
  const save = await preserveDiscardedState(execFn, repoRoot, scratchDir, label);
  if (save.kind === "failed") return saveFailedRestore(repoRoot, save.error);
  const preservedAt = save.kind === "saved" ? save.path : undefined;
  let paths: string[];
  try {
    paths = await cycleChangedPaths(execFn, repoRoot);
  } catch (err) {
    return {
      restored: false,
      checkedOut: false,
      preservedAt,
      detail: `could not list the cycle's changed paths (${(err as Error).message?.slice(0, 160)}); no checkout was attempted and the tree was left as it is`,
    };
  }
  try {
    await execFn("git", { cwd: repoRoot, maxBuffer: 256 * 1024, argv: ["reset"] });
  } catch (err) {
    trace(`work-driver: ${label} — index reset failed: ${(err as Error).message?.slice(0, 160)}`);
  }
  if (paths.length > 0) {
    try {
      const message = `pi-rukas #1093 ${label}: cycle changes (preserved at ${preservedAt ?? "none"})`;
      // `-u` so the cycle's staged NEW files (untracked after the reset) go too;
      // the pathspec is the cycle's own list, never the whole tree.
      await execFn("git", {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
        argv: ["--literal-pathspecs", "stash", "push", "-u", "-m", message, "--", ...paths],
      });
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 160);
      trace(`work-driver: ${label} — stash of the cycle's changes failed: ${msg}`);
      return {
        restored: false,
        checkedOut: false,
        preservedAt,
        detail: `could not stash the cycle's changes (${msg}); no checkout was attempted and the tree was left as it is — run \`git stash push -u -- <the cycle's paths>\` then \`git checkout ${ref} --\` at the repo root`,
      };
    }
  }
  const restore = await restoreRootToRef(execFn, { repoRoot, ref, label, paths });
  return { ...restore, preservedAt };
}

/**
 * #1093 — the non-forcing restore for a SUCCESSFUL consolidation: check
 * `ref` out at repoRoot with a plain `git checkout` (no reset, no --force).
 * A refusal leaves the tree exactly as it is and returns `restored: false`
 * with the exact command the operator runs by hand. The post-condition read
 * is the same as `verifiedRestoreRoot`'s, so "restored" is only ever claimed
 * when the checkout succeeded and no tracked dirt remains.
 */
export async function restoreRootToRef(
  execFn: ExecFn,
  opts: { repoRoot: string; ref: string; label: string; paths?: string[] },
): Promise<VerifiedRestoreResult> {
  const { repoRoot, ref, label, paths } = opts;
  // The ref is validated first, so showing it verbatim as the operator's
  // command is safe. `--` is part of the command the operator is told to run:
  // without it git reads a deleted branch name as a pathspec.
  const cmd = `git checkout ${ref} --`;
  const problem = restoreRefSyntaxProblem(ref);
  if (problem !== undefined) {
    trace(`work-driver: ${label}: ${cmd} not attempted: ${problem}`);
    return {
      restored: false,
      checkedOut: false,
      detail: `not checked out: ${problem}; the tree was left as it is`,
    };
  }
  try {
    // `--` ends the revision list: a ref that no longer exists (a deleted start
    // branch) errors instead of falling back to a pathspec that would overwrite
    // a same-named tracked file's uncommitted edit.
    await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
      argv: ["checkout", ref, "--"],
    });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 160);
    trace(`work-driver: ${label} \u2014 ${cmd} refused: ${msg}`);
    return {
      restored: false,
      checkedOut: false,
      detail: `${cmd} refused (${msg}); the tree was left as it is \u2014 run \`${cmd}\` at the repo root once it is clean`,
    };
  }
  // One structured read gives both answers: tracked dirt (scoped to the cycle's
  // paths on the abort path) fails the restore; untracked files are listed by
  // the claim. The read always runs, so an empty `paths` is never a free pass.
  let entries: StatusEntry[];
  try {
    entries = await readStatus(execFn, repoRoot);
  } catch (err) {
    return {
      restored: false,
      checkedOut: true,
      detail: `could not verify the tree after ${cmd} (${(err as Error).message?.slice(0, 160)})`,
    };
  }
  const scope = paths === undefined ? undefined : new Set(paths);
  const dirt = entries.filter((e) => isTracked(e) && (scope === undefined || scope.has(e.path)));
  if (dirt.length > 0) {
    return {
      restored: false,
      checkedOut: true,
      detail: `${cmd} succeeded but ${paths !== undefined ? "changes remain" : "tracked changes remain"} (${dirt
        .slice(0, 5)
        .map((e) => e.path)
        .join(", ")}); nothing was reset \u2014 run \`git status\` at the repo root`,
    };
  }
  const untracked = entries.filter((e) => !isTracked(e)).map((e) => e.path);
  return { restored: true, checkedOut: true, untracked };
}

/**
 * Restore repoRoot to `originalRef` after a consolidation abort, and VERIFY
 * it. Never throws: a failed restore is returned as `{ restored: false,
 * detail }` so the caller emits the loud, explicit failure (see
 * `restoreClaim`) instead of a bare "restored" claim.
 */
export async function verifiedRestoreRoot(
  execFn: ExecFn,
  opts: {
    repoRoot: string;
    /** Where repoRoot's checkout was before the caller touched it. */
    originalRef: string;
    /** Where the discarded state is preserved. Must exist or be creatable. */
    scratchDir: string;
    /** Label for trace lines and the preserved file (identifies the caller). */
    label: string;
  },
): Promise<VerifiedRestoreResult> {
  const { repoRoot, originalRef, scratchDir, label } = opts;

  // #750 — capture the root's staged/unstaged/unmerged state to a scratch
  // file BEFORE anything destructive. The discarded content may be the only
  // copy of work (in the incident it held a genuinely different
  // implementation of the same fix); a post-destroy capture would be empty.
  // #1258 — a capture that FAILED stops the restore here: the reset below
  // would destroy the only copy, so the tree is left as it is instead.
  const save = await preserveDiscardedState(execFn, repoRoot, scratchDir, label);
  if (save.kind === "failed") return saveFailedRestore(repoRoot, save.error);
  const preservedAt = save.kind === "saved" ? save.path : undefined;

  // Reset index + working tree. `reset --hard` clears both the staged (M) and
  // unmerged (UU) entries measured in the incident; a refusal means the
  // post-condition read below will report it — we never proceed on "no
  // exception".
  try {
    await execFn("git reset --hard", { cwd: repoRoot, maxBuffer: 256 * 1024 });
  } catch (err) {
    trace(`work-driver: ${label} — reset --hard failed: ${(err as Error).message?.slice(0, 160)}`);
  }

  // Restore the original checkout.
  try {
    await execFn(`git checkout --force ${JSON.stringify(originalRef)}`, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
  } catch (err) {
    trace(
      `work-driver: ${label} — could not restore repoRoot to ${originalRef}: ${(err as Error).message?.slice(0, 160)}`,
    );
  }

  // The post-condition: the porcelain read IS the check. Untracked `??`
  // entries and `.worktrees/` scaffolding are not dirt for this purpose.
  // The read uses a fresh `git status --porcelain` subprocess via the
  // injected `execFn`, NOT a cached or in-memory state — it reflects the
  // ACTUAL on-disk state after the reset + checkout, not a snapshot from
  // before the restore ran. Untracked files are never swept (`git clean`
  // is forbidden by #750), so they are never counted as a failed restore.
  let dirt: string[];
  try {
    const { stdout } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    dirt = stdout
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("??") && !/^..\s+"?\.worktrees\//.test(l));
  } catch (err) {
    return {
      restored: false,
      detail: `post-restore verification failed — could not read git status: ${(err as Error).message?.slice(0, 200)}`,
      preservedAt,
    };
  }
  if (dirt.length === 0) return { restored: true, preservedAt };

  const dirtyPaths = dirt
    .slice(0, 10)
    .map((l) => l.slice(3))
    .join(", ");
  return {
    restored: false,
    detail: `repoRoot was NOT restored — still dirty after reset + checkout: ${dirtyPaths}`,
    preservedAt,
  };
}
