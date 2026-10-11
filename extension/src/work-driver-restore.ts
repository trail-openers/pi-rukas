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
 *      genuinely different implementation of the same fix).
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
 */
import fs from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** A full commit SHA: the only ref form a detached start can produce. */
const FULL_SHA = /^[0-9a-f]{40}$/;
/** A name a restore may pass to git: no shell metacharacters, no leading `-`. */
const PLAIN_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/**
 * #1093 — why `ref` may not be checked out, or `undefined` when it may. A
 * 40-hex SHA, or a plain name that `git check-ref-format --branch` accepts.
 * Refused before git sees it: anything with shell or option syntax (`$(…)`,
 * backticks, a leading `-`). Callers pass the ref through argv, so this is a
 * second, validity check, not the only thing standing between a ref and sh.
 */
export async function restoreRefProblem(
  execFn: ExecFn,
  repoRoot: string,
  ref: string,
): Promise<string | undefined> {
  if (FULL_SHA.test(ref)) return undefined;
  if (!PLAIN_REF.test(ref)) return `"${ref}" contains characters a restore will not check out`;
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

/**
 * The tracked dirt at repoRoot (`git status --porcelain`, minus untracked `??`
 * entries and `.worktrees/` scaffolding). The single post-condition read every
 * restore verifies against. Throws when git cannot be read.
 */
async function trackedDirt(execFn: ExecFn, repoRoot: string): Promise<string[]> {
  const { stdout } = await execFn("git", {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
    argv: ["status", "--porcelain"],
  });
  return stdout
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("??") && !/^..\s+"?\.worktrees\//.test(l));
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
    const restored = "repoRoot was verified restored";
    if (!label) return restored;
    return label.endsWith(" ") ? `${label}${restored}` : `${label} ${restored}`;
  }
  const preserved = r.preservedAt ? ` (discarded state preserved at ${r.preservedAt})` : "";
  const tail = trailing ? ` ${trailing}` : "";
  return `repoRoot was NOT restored: ${r.detail ?? "unknown error"}${preserved}${tail}`;
}

/**
 * Capture the root's staged/unstaged/unmerged state to a scratch file.
 * Best-effort: a capture failure is traced and does not stop the restore
 * (a lost capture is worse than a lost diff, but not as bad as a stuck root).
 */
async function preserveDiscardedState(
  execFn: ExecFn,
  repoRoot: string,
  scratchDir: string,
  label: string,
): Promise<string | undefined> {
  try {
    const { stdout: status } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      argv: ["status", "--porcelain"],
    });
    const { stdout: unstaged } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      argv: ["diff"],
    });
    const { stdout: staged } = await execFn("git", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      argv: ["diff", "--cached"],
    });
    if (!status.trim() && !unstaged.trim() && !staged.trim()) return undefined;
    fs.mkdirSync(scratchDir, { recursive: true });
    const file = path.join(
      scratchDir,
      `restored-state-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.diff`,
    );
    const body = `# #750 — repoRoot state discarded by a consolidation restore
# label: ${label}
# captured before the restore's reset and checkout

--- status (git status --porcelain) ---
${status}

--- unstaged (git diff) ---
${unstaged}

--- staged (git diff --cached) ---
${staged}
`;
    fs.writeFileSync(file, body, "utf8");
    trace(`work-driver: ${label} — discarded state preserved to ${file}`);
    return file;
  } catch (err) {
    trace(
      `work-driver: ${label} — could not preserve discarded state: ${(err as Error).message?.slice(0, 160)}`,
    );
    return undefined;
  }
}

/**
 * #1093 — the non-forcing restore for an ABORT path (conflict, apply-conflict,
 * throw). The discarded state is preserved first, exactly as the forced helper
 * does. Then `git reset` (mixed) clears the index — the conflict's staged and
 * unmerged entries — WITHOUT touching the working tree, and the checkout is a
 * plain `restoreRootToRef`. Never `--hard`, never `--force`: when git refuses
 * the checkout the tree is left as it is and the detail carries the exact
 * command to run by hand. Never throws.
 */
export async function restoreRootToRefPreserving(
  execFn: ExecFn,
  opts: { repoRoot: string; ref: string; scratchDir: string; label: string },
): Promise<VerifiedRestoreResult> {
  const { repoRoot, ref, scratchDir, label } = opts;
  const preservedAt = await preserveDiscardedState(execFn, repoRoot, scratchDir, label);
  try {
    await execFn("git", { cwd: repoRoot, maxBuffer: 256 * 1024, argv: ["reset"] });
  } catch (err) {
    trace(`work-driver: ${label} — index reset failed: ${(err as Error).message?.slice(0, 160)}`);
  }
  const restore = await restoreRootToRef(execFn, { repoRoot, ref, label });
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
  opts: { repoRoot: string; ref: string; label: string },
): Promise<VerifiedRestoreResult> {
  const { repoRoot, ref, label } = opts;
  // The ref is validated first, so showing it verbatim as the operator's
  // command is safe.
  const cmd = `git checkout ${ref}`;
  const problem = await restoreRefProblem(execFn, repoRoot, ref);
  if (problem !== undefined) {
    trace(`work-driver: ${label}: ${cmd} not attempted: ${problem}`);
    return { restored: false, detail: `not checked out: ${problem}; the tree was left as it is` };
  }
  try {
    await execFn("git", { cwd: repoRoot, maxBuffer: 256 * 1024, argv: ["checkout", ref] });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 160);
    trace(`work-driver: ${label} \u2014 ${cmd} refused: ${msg}`);
    return {
      restored: false,
      detail: `${cmd} refused (${msg}); the tree was left as it is \u2014 run \`${cmd}\` at the repo root once it is clean`,
    };
  }
  try {
    const dirt = await trackedDirt(execFn, repoRoot);
    if (dirt.length > 0) {
      return {
        restored: false,
        detail: `${cmd} succeeded but tracked changes remain (${dirt
          .slice(0, 5)
          .map((l) => l.slice(3))
          .join(", ")}); nothing was reset \u2014 run \`git status\` at the repo root`,
      };
    }
  } catch (err) {
    return {
      restored: false,
      detail: `could not verify the tree after ${cmd} (${(err as Error).message?.slice(0, 160)})`,
    };
  }
  return { restored: true };
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
  const preservedAt = await preserveDiscardedState(execFn, repoRoot, scratchDir, label);

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
