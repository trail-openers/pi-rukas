/**
 * worktree-create-guard — the pre-add guards of `worktreeCreate` (split
 * from worktree.ts for the AGENTS.md §12 500-line cap; same seam as
 * worktree-provision.ts / worktree-salvage.ts: a focused helper module
 * that worktree.ts calls and re-exports nothing from).
 *
 * Two guards, deliberately split (the six-lens #753 review found the
 * original code skipping BOTH for in-cycle paths — the #475 guard at the
 * TARGET path must never be waived):
 *
 *  1. The SIBLING scan (#545): a dirty SAME-ISSUE leftover anywhere under
 *     `.worktrees/issue-<N>-` that is NOT part of the current cycle. In-cycle
 *     paths are excluded here (an earlier workstream's legitimate in-progress
 *     dirt is not a leftover).
 *  2. The TARGET-path #475 guard: a dirty worktree at the target path —
 *     runs UNCONDITIONALLY, in-cycle membership never waives it. Only the
 *     pre-remove is skipped for an in-cycle path.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import {
  DirtyWorktreeError,
  type DirtyWorktreeFinding,
  type ExecFn,
  findDirtySameIssueLeftover,
  inspectWorktreeForLoss,
  resolvePath,
  worktreePath,
  worktreeRemove,
} from "./worktree.ts";

export interface CreateGuardOpts {
  repoRoot: string;
  name: string;
  fromRef: string;
  /**
   * #861 — the integrate-worktree's own contract: the caller
   * (ensureIntegrateWorktree) has ALREADY force-removed any driver-owned
   * stale tree at this path (recording its HEAD first) or verified the path
   * absent, and is about to run `git worktree add` on it. Under this option
   * the target-path #475 inspection is skipped ONLY when the target is
   * verified ABSENT at guard time (fs.access) — a live worktree appearing
   * after the caller's pre-removal (a race, or the pre-removal silently
   * failing) is still inspected and a dirty one still throws
   * `DirtyWorktreeError`. No other caller passes this: `worktreeCreate`'
   * normal workstream path runs the target inspection unconditionally.
   */
  callerVerifiedTargetAbsent?: boolean;
}

/**
 * Run both pre-add guards. Returns `undefined` when the caller may proceed
 * to `git worktree add`; throws `DirtyWorktreeError` when a guard fired.
 * `inCycleWorktrees` are the worktree paths that belong to the current
 * cycle (created by the branch step or an earlier dependent): they are
 * excluded from the SIBLING scan only — never from the target-path guard.
 */
export async function runCreateGuards(
  execFn: ExecFn,
  opts: CreateGuardOpts,
  inCycleWorktrees?: string[],
): Promise<void> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  // #1170 — an unresolvable base ref is a REF error, not worktree state. Every
  // inspection below reads `<fromRef>^{tree}`, so with a bad ref each existing
  // worktree would read as unreadable → "loss" and the failure would be
  // misclassified as a dirty leftover. Nothing is removed on this path: the
  // guards return and `git worktree add` itself refuses the ref, surfacing the
  // real git stderr (create-error). An existing worktree is still refused by
  // `git worktree add`'s own path-exists check, so nothing is destroyed.
  // Fail closed (#1170 round 3): ONLY exit 1 with no output means "unresolved"
  // (a create error here, with no `worktree add` run — that add builds a shell
  // string and must never receive a ref that did not resolve). A timeout, a
  // signal, any other exit code or any stderr text is a probe failure: the
  // guards are not skipped on it, the probe throws.
  // #1170 — the base ref is interpolated into shell strings below (the probe
  // and every inspection). Only a plain ref name may reach one: anything else
  // is refused as a create error before any command runs.
  if (!SAFE_REF.test(opts.fromRef) || opts.fromRef.startsWith("-")) {
    throw new Error(
      `worktreeCreate: ${opts.name} failed: base ref ${JSON.stringify(opts.fromRef)} is not a valid ref name`,
    );
  }
  if (!(await baseRefResolves(execFn, opts))) {
    trace(
      `worktree: base ref ${opts.fromRef} does not resolve \u2014 deferring to git worktree add`,
    );
    return;
  }
  // #545 — the mechanism that killed the #540 restart: `worktree add` itself
  // refuses against ANY leftover worktree of the same cycle (e.g. the
  // cycle's OWN dead siblings from a parked run, all named
  // `issue-<N>-<id>`). Inspect what's attached first so a dirty one becomes
  // a refusal WITH salvage instead of a bare `fatal: ... already exists`
  // error. A clean foreign leftover is still handled by `worktree add`'s
  // own path-exists error — unchanged.
  const issuePrefix = opts.name.split("-").slice(0, 2).join("-");
  // #753 — the SIBLING scan excludes this cycle's own worktrees (the exclusion
  // happens inside findDirtySameIssueLeftover, which resolves both sides —
  // an earlier workstream's legitimate in-progress dirt is not a leftover).
  // #753 (six-lens FIX 2) — the sibling scan degrades the SAFE direction:
  // a transient `git worktree list` failure returns "no finding" and creation
  // proceeds EXACTLY as pre-#545 did (the raw git error from `git worktree
  // add`, now plumbed via `gitErrorDetail`). A throw here instead escaped to
  // `create-error` with no dirty finding AND let `git worktree add` proceed
  // onto an UNSCANNED dirty sibling — the shape #545 exists to prevent.
  // This mirrors `scanWorktrees`' documented "unreadable list → empty array
  // — the safe direction (no action)" and `inspectWorktreeForLoss`'s #475
  // fail-open ("an unreadable worktree is removed as today").
  const siblingDirty = await findDirtySameIssueLeftover(
    execFn,
    opts.repoRoot,
    opts.fromRef,
    issuePrefix,
    opts.name,
    inCycleWorktrees,
  ).catch((e) => {
    trace(
      `worktree: sibling scan failed for ${opts.name} — proceeding without it (${e instanceof Error ? e.message : String(e)})`,
    );
    return undefined;
  });
  if (siblingDirty) {
    throw new DirtyWorktreeError(siblingDirty);
  }
  // The TARGET path: the #475 dirty guard runs UNCONDITIONALLY (in-cycle
  // membership never waives it — a dirty pre-existing worktree here still
  // holds work a force-remove would destroy), and the pre-remove is skipped
  // for an in-cycle path (nothing to remove; a clean in-cycle path means
  // `git worktree add`'s own "already exists" error is the signal).
  // #861 — the in-cycle set doubles as the TARGET-path exemption: the
  // caller (ensureIntegrateWorktree) has already force-removed any
  // driver-owned stale tree at this path (recording its HEAD first) or
  // verified the path absent, so a path the caller itself created in this
  // cycle is re-inspected as ABSENT — the guard's `git rev-parse` in a
  // nonexistent directory fails and returns no finding. The SIBLING scan
  // above still runs: a foreign same-issue leftover is still a hazard.
  const inCycleSet = new Set((inCycleWorktrees ?? []).map((p) => resolvePath(p)));
  const targetAbsent =
    opts.callerVerifiedTargetAbsent === true && (await pathExists(abs)) === false;
  if (!targetAbsent) {
    const leftover = await inspectWorktreeForLoss(execFn, opts.repoRoot, abs, opts.fromRef);
    if (leftover) {
      throw new DirtyWorktreeError(leftover);
    }
  }
  // #753 — the in-cycle set: this worktree is part of the current cycle (the
  // branch step or an earlier dependent created it, so it is registered in
  // `git worktree list`). `git worktree list --porcelain` emits symlink-
  // resolved paths (macOS /private/var/…) while `abs` is the logical form
  // (/var/…), so both sides go through the same realpath resolution as the
  // sibling scan.
  if (!inCycleSet.has(resolvePath(abs))) {
    await worktreeRemove(execFn, opts.repoRoot, opts.name, true).catch(() => undefined);
  }
  trace(`worktree: guards passed for ${opts.name} — proceeding to create`);
}

/** Re-export of the finding type for callers of the guard. */
export type { DirtyWorktreeFinding };

/** A ref name made only of characters that are inert inside double quotes. */
const SAFE_REF = /^[A-Za-z0-9._/^{}~@-]+$/;

/**
 * Probe `<fromRef>^{tree}` (the ref is JSON-quoted and pre-validated by
 * SAFE_REF). `true` = resolves; `false` = cleanly unresolved (exit 1, empty
 * stdout and stderr, no signal or kill). Any other failure throws a create error.
 */
async function baseRefResolves(execFn: ExecFn, opts: CreateGuardOpts): Promise<boolean> {
  try {
    await execFn(`git rev-parse --verify --quiet ${JSON.stringify(`${opts.fromRef}^{tree}`)}`, {
      cwd: opts.repoRoot,
      maxBuffer: 64 * 1024,
    });
    return true;
  } catch (err) {
    const e = err as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const quietExit1 =
      e?.code === 1 &&
      !e.signal &&
      !e.killed &&
      String(e.stdout ?? "") === "" &&
      String(e.stderr ?? "") === "";
    if (quietExit1) return false;
    const detail = String(e?.stderr ?? "").trim() || String(e?.message ?? err).trim();
    const wrapped = new Error(
      `worktreeCreate: ${opts.name} failed: base ref probe for ${opts.fromRef} did not complete (${detail})`,
    );
    (wrapped as Error & { stderr?: string }).stderr = detail;
    throw wrapped;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
