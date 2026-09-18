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
 * The claim text for the operator. One of exactly two shapes — the verified
 * post-condition, or the explicit not-restored failure with the preserved
 * diff location — so the caller cannot re-introduce an unqualified claim.
 */
export function restoreClaim(r: VerifiedRestoreResult): string {
  if (r.restored) return "repoRoot was verified restored";
  const preserved = r.preservedAt ? ` (discarded state preserved at ${r.preservedAt})` : "";
  return `repoRoot was NOT restored: ${r.detail ?? "unknown error"}${preserved}`;
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
    const { stdout: status } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    const { stdout: unstaged } = await execFn("git diff", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    const { stdout: staged } = await execFn("git diff --cached", {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (!status.trim() && !unstaged.trim() && !staged.trim()) return undefined;
    fs.mkdirSync(scratchDir, { recursive: true });
    const file = path.join(
      scratchDir,
      `restored-state-${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.diff`,
    );
    const body = `# #750 — repoRoot state discarded by a consolidation restore
# label: ${label}
# captured before: git reset --hard && git checkout --force

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
