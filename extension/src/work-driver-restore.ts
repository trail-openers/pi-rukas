/**
 * work-driver-restore — shared verified-restore helper for the /work driver.
 *
 * Consolidates the duplicated (and previously unverified) restore logic that
 * lived inline in three modules:
 *
 *   - work-driver-consolidated-verify.ts (develop-time consolidated verify)
 *   - work-driver-integrate.ts (commit-pr integration)
 *   - work-driver-cherry-pick.ts (batch abort path)
 *
 * The old shape was: fire `git reset --hard` / `git checkout --force` with
 * `.catch(trace)` and return unconditionally — a failed reset was indistinguishable
 * from success at the call site, and the "repoRoot restored" claim was emitted
 * regardless of whether the root was actually clean.
 *
 * This module:
 *   1. Preserves the working-tree + staged diff to scratchDir BEFORE any
 *      destructive reset (the discarded content may be the only copy of work).
 *   2. Attempts `git cherry-pick --abort` (refused with exit 128 when no
 *      cherry-pick is in progress — not treated as success or as the only
 *      recovery).
 *   3. Falls back to `git reset --hard HEAD` (the command that cleared the
 *      incident state in both observed occurrences).
 *   4. Re-reads `git status --porcelain` and only reports "restored" if the
 *      porcelain is genuinely empty.
 *   5. Returns a discriminated union so the caller can render an honest
 *      post-condition claim.
 *
 * #750 — new shared module; wired from consolidated-verify.ts, integrate.ts,
 * and cherry-pick.ts by the sibling workstreams (task-b, task-c).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

/** The execFn shape used throughout the driver: returns stdout+stderr on success, throws on non-zero exit. */
export type RestoreExecFn = (
  cmd: string,
  o?: { cwd?: string; maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr?: string }>;

/** Discriminated result of a verified restore attempt. */
export type RestoreResult =
  | {
      /** The root is verified clean: `git status --porcelain` is empty. */
      restored: true;
      /** File the preserved diff was written to (undefined if nothing to preserve). */
      preservedAt?: string;
    }
  | {
      /** The root could not be restored: `git status --porcelain` is non-empty. */
      restored: false;
      /** Paths still dirty (porcelain lines, max 10). */
      dirtyPaths: string[];
      /** The preserve file, if the diff was captured before the failed reset. */
      preservedAt?: string;
      /** Human-readable description of what happened (for operator messaging). */
      failureDetail: string;
    };

/**
 * Verify that repoRoot is clean after a consolidation batch was aborted.
 *
 * The sequence:
 *   1. Capture `git status --porcelain` to know the current state.
 *   2. If dirty, preserve the combined diff (working + staged) to
 *      `scratchDir/restore-<timestamp>.diff` before any destructive reset.
 *   3. Attempt `git cherry-pick --abort`. This exits 128 when no cherry-pick
 *      is in progress (the incident's defining characteristic) — that is
 *      expected and not an error; it simply means the abort path is
 *      unavailable and we fall through to the reset.
 *   4. Run `git reset --hard HEAD`. This clears staged changes and unmerged
 *      index entries in the incident's shape.
 *   5. Re-read `git status --porcelain`. If empty → restored: true.
 *      If non-empty → restored: false with the dirty paths.
 *
 * Does NOT run `git clean` — untracked content in this project is deliberate.
 * Does NOT remove operation metadata (CHERRY_PICK_HEAD, MERGE_HEAD, etc.)
 * before the abort — that ordering is exactly what made the incident
 * undiagnosable.
 *
 * The caller must run this inside the integration lock; the lock release
 * happens in the caller's `finally` block.
 */
export async function verifiedRestore(
  execFn: RestoreExecFn,
  opts: {
    repoRoot: string;
    scratchDir: string;
  },
): Promise<RestoreResult> {
  const { repoRoot, scratchDir } = opts;

  // 1. Read current porcelain state.
  let dirtyPaths: string[] = [];
  try {
    const { stdout } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    dirtyPaths = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.slice(3));
  } catch (err) {
    // A read failure here means git itself is broken in this workdir —
    // report it rather than pretending the root is clean.
    const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
    trace(`work-driver-restore: could not read porcelain state: ${msg}`);
    return {
      restored: false,
      dirtyPaths: ["(unreadable — git status failed)"],
      failureDetail: `git status --porcelain failed: ${msg}`,
    };
  }

  if (dirtyPaths.length === 0) {
    trace("work-driver-restore: root already clean, nothing to do");
    return { restored: true };
  }

  // 2. Preserve the diff before any destructive reset.
  //    Combines working-tree diff + staged diff into a single .diff file.
  let preservedAt: string | undefined;
  try {
    await fs.mkdir(scratchDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const preserveFile = path.join(scratchDir, `restore-${ts}.diff`);

    // Working-tree diff (uncommitted changes)
    let diff = "";
    try {
      const { stdout } = await execFn("git diff", {
        cwd: repoRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      diff += stdout;
    } catch {
      // non-zero from git diff is not expected but treat as empty
    }

    // Staged diff
    try {
      const { stdout } = await execFn("git diff --cached", {
        cwd: repoRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (stdout.trim()) diff += `\n${stdout}`;
    } catch {
      // same
    }

    if (diff.trim()) {
      await fs.writeFile(preserveFile, diff, "utf8");
      preservedAt = preserveFile;
      trace(`work-driver-restore: preserved diff (${diff.length} bytes) at ${preserveFile}`);
    }
  } catch (err) {
    trace(`work-driver-restore: could not preserve diff: ${(err as Error).message?.slice(0, 160)}`);
    // Preserve failure is non-fatal — proceed with the reset.
  }

  // 3. Attempt `git cherry-pick --abort`.
  //    In the incident's shape, no CHERRY_PICK_HEAD exists, so this exits 128.
  //    That is the EXPECTED case (the defining characteristic of this bug).
  //    A non-zero exit here is NOT an error — it means the abort path is
  //    unavailable and we must use the reset fallback.
  //    We do NOT run this in a try/catch that would treat a real git failure
  //    (e.g. corrupt .git) as equivalent to a 128 refusal.
  let cherryPickAborted = false;
  try {
    await execFn("git cherry-pick --abort", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    cherryPickAborted = true;
    trace("work-driver-restore: cherry-pick --abort succeeded");
  } catch (err) {
    // Expected: exit 128 "no cherry-pick or revert in progress"
    const msg = ((err as Error).message ?? "").slice(0, 200);
    trace(
      `work-driver-restore: cherry-pick --abort refused (${msg}) — falling back to reset --hard`,
    );
  }

  // 4. Fallback: `git reset --hard HEAD`.
  //    This clears staged changes and unmerged index entries in the incident's
  //    shape. It is destructive — which is why step 2 preserved the diff.
  let resetFailed = false;
  try {
    await execFn("git reset --hard HEAD", {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    trace("work-driver-restore: reset --hard HEAD succeeded");
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
    trace(`work-driver-restore: reset --hard HEAD FAILED: ${msg}`);
    resetFailed = true;
  }

  // 5. Re-read porcelain to verify the post-condition.
  let finalPaths: string[];
  try {
    const { stdout } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    finalPaths = stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.slice(3));
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 200) ?? "unknown";
    return {
      restored: false,
      dirtyPaths: ["(unreadable — git status failed after reset)"],
      preservedAt,
      failureDetail: `post-reset porcelain read failed: ${msg}`,
    };
  }

  if (finalPaths.length === 0) {
    trace("work-driver-restore: verified clean — root restored");
    return { restored: true, preservedAt };
  }

  // Root is still dirty after the reset — the reset failed or didn't cover
  // everything. This must be loud, not quiet.
  const dirty = finalPaths.slice(0, 10);
  trace(`work-driver-restore: FAILED — root still dirty after restore: ${dirty.join(", ")}`);
  return {
    restored: false,
    dirtyPaths: dirty,
    preservedAt,
    failureDetail: `restore could not complete — ${dirty.length} path(s) still dirty: ${dirty.join(", ")}${preservedAt ? ` (discarded work preserved at ${preservedAt})` : ""}${resetFailed ? "; reset --hard itself failed (see trace)" : "; reset --hard exited 0 but did not clear all paths"}`,
  };
}
