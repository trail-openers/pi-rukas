/**
 * lean/build-normalise — CAPTURE, RESET, REWRITE for the build step.
 *
 * The developer child is a model. It may commit, edit a frozen acceptance test,
 * write into `.pi/` or `.github/`, or hand the tree a symlink and a hard link.
 * The specify step already owns an algorithm that survives exactly that: read
 * the bytes you intend to keep, reset the tree to a known commit, write those
 * bytes back. `build` uses the same shape, so there is ONE design for "the tree
 * is not trustworthy" in this step family rather than two, and per-path
 * restore, unlink and hard-link bookkeeping never exist to get wrong.
 *
 *   1. HEAD must still descend from `headBefore`. A child that reset HEAD is
 *      refused outright — that is the `merge-base --is-ancestor` check, read
 *      before anything is mutated.
 *   2. The changed set is `git diff --name-only -z headBefore` unioned with
 *      `git ls-files --others --exclude-standard -z`: tracked edits, deletions
 *      and the child's own commits, plus untracked files.
 *   3. Each path is classified. A frozen or protected path in that set is
 *      IGNORED — stage 4 is what undoes it — and only recorded, so the handback
 *      can say what was put back. Anything else is a DELETION (not a regular
 *      file in the tree) or is CAPTURED through one `O_RDONLY|O_NOFOLLOW`
 *      descriptor; a capture refusal (link, device, swapped inode) DROPS the
 *      path rather than committing it. A name holding no regular file at all is
 *      a DELETION, which is what separates `removed` from `deleted` in the
 *      report: the first is a path the step refused, the second a path the
 *      child asked to have gone.
 *   4. `resetWorktreeToBase` puts the tree back to `headBefore` — commits,
 *      index, untracked files, ignore tricks and dependency links all go — and
 *      provisioning rebuilds the links. Frozen and protected files are now
 *      exactly as at `headBefore`, because git put them there, not this file.
 *   5. The captured bytes go back through `writeCaptured` (no symlinked
 *      ancestor, temp file plus rename), executable bits are restored, and the
 *      deletions are applied with `rmSync`.
 *   6. Nothing captured and nothing deleted is the honest answer to "did the
 *      developer change anything": `files: []`, and the caller routes `exhausted`.
 *   7. One commit, hooks off, with four claims proved about it: parent is
 *      `headBefore`; its diff names no frozen and no protected path; the tree
 *      is clean; every frozen blob at the new head hashes to its record.
 *
 * Anything unproven throws — the step's output is a commit the run merges.
 */

import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { provisionWorktree } from "../worktree-provision.ts";
import { captureOne, isRealFile } from "./build-capture.ts";
import { BuildInfraError } from "./build-errors.ts";
import {
  changedSet,
  commitDiff,
  frozenMatches,
  headDescendsFrom,
  headSha,
  must,
  porcelain,
} from "./build-git.ts";
import type { BuildExec, NormaliseReport } from "./build-types.ts";
import { resetWorktreeToBase, writeCaptured } from "./specify-reset.ts";

/** Paths a developer may not change, however the issue is worded. */
const PROTECTED_DIRS = [".pi/", ".github/", ".gitmodules"] as const;
const PROTECTED_FILES = ["CODEOWNERS"] as const;

/** Is `rel` a path whose contents decide what verification means? */
export function isProtectedPath(rel: string): boolean {
  const p = rel.replace(/^\.\//, "");
  for (const d of PROTECTED_DIRS) if (p === d.slice(0, -1) || p.startsWith(d)) return true;
  for (const f of PROTECTED_FILES) if (p === f || p.endsWith(`/${f}`)) return true;
  return false;
}

/** The kept bytes and their modes, after classification. */
interface Classified {
  captured: Map<string, { bytes: Buffer; exec: boolean }>;
  report: NormaliseReport;
}

/**
 * Sort the child's changed paths into kept, restored, reverted, dropped, deleted.
 *
 * Frozen and protected paths are NOT restored here — the reset is what undoes
 * them — they are only recorded. That is the whole reason the classification
 * runs before the reset: after it, "what the child did" is a fact only this
 * function still holds.
 */
function classify(wt: string, changed: string[], frozen: Record<string, string>): Classified {
  const captured = new Map<string, { bytes: Buffer; exec: boolean }>();
  const report: NormaliseReport = {
    files: [],
    restored: [],
    reverted: [],
    removed: [],
    deleted: [],
  };
  for (const rel of changed) {
    if (frozen[rel] !== undefined) {
      report.restored.push(rel);
      continue;
    }
    if (isProtectedPath(rel)) {
      report.reverted.push(rel);
      continue;
    }
    if (!isRealFile(wt, rel)) {
      // Absent, or a name holding nothing but a link or device: the reset leaves
      // nothing behind either way, so the path is simply gone — a deletion the
      // commit must carry, never a capture the step refused.
      report.deleted.push(rel);
      continue;
    }
    const one = captureOne(path.join(wt, rel));
    if ("why" in one) {
      report.removed.push(rel);
      continue;
    }
    captured.set(rel, one);
  }
  return { captured, report };
}

/**
 * Fold the child's work into one provable commit on `headBefore`.
 *
 * Returns `files: []` when the tree held nothing to commit. Throws on a HEAD
 * the step cannot account for or on a commit whose contents it cannot prove.
 */
export async function normaliseBuild(opts: {
  exec: BuildExec;
  wt: string;
  repoRoot: string;
  branch: string;
  headBefore: string;
  frozen: Record<string, string>;
  attempt: number;
  issue: number;
}): Promise<NormaliseReport> {
  const { exec, wt, repoRoot, branch, headBefore, frozen } = opts;
  const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

  // 1 + 2 + 3. All reads, before any write.
  if (!(await headDescendsFrom(exec, wt, headBefore)))
    throw new BuildInfraError(
      `the developer moved HEAD away from ${headBefore} — refusing to fold its commits`,
    );
  const { captured, report } = classify(wt, await changedSet(exec, wt, headBefore), frozen);

  // 4. RESET — child commits, staging, untracked files, ignore tricks and the
  //    dependency links all go; frozen and protected files come back exactly as
  //    at `headBefore`; provisioning rebuilds what the clean removed.
  await resetWorktreeToBase(exec, wt, headBefore, branch);
  await provisionWorktree(exec, repoRoot, wt);

  // 5. REWRITE the kept bytes, then delete what the child deleted. Both happen
  //    after the reset, so `writeCaptured` never meets a name that exists and
  //    `rmSync` never wonders whether it is removing the child's file or a link.
  const payload = new Map<string, Buffer>();
  for (const [rel, one] of captured) payload.set(rel, one.bytes);
  try {
    writeCaptured(wt, payload);
  } catch (err) {
    throw new BuildInfraError(`could not rewrite the developer's files: ${(err as Error).message}`);
  }
  for (const [rel, one] of captured) {
    if (one.exec) chmodSync(path.join(wt, rel), 0o755);
  }
  for (const rel of report.deleted) {
    try {
      rmSync(path.join(wt, rel), { force: true });
    } catch (err) {
      throw new BuildInfraError(
        `could not apply the deletion of ${rel}: ${(err as Error).message}`,
      );
    }
  }

  // 6. Nothing to commit is an answer, not a fault.
  if (captured.size === 0 && report.deleted.length === 0) return report;

  // 7. One commit, and everything it claims gets checked afterwards.
  await must(exec, wt, [...NO_HOOKS, "add", "-A"], "stage the developer's work");
  await must(
    exec,
    wt,
    [...NO_HOOKS, "commit", "-m", `build: attempt ${opts.attempt} for #${opts.issue}`],
    "make the build commit",
  );

  await verifyCommit(exec, wt, headBefore, frozen, report);
  return report;
}

/**
 * Prove the commit the step just made: parent is `headBefore`; no frozen or
 * protected path is in its diff; the tree is clean; every frozen blob at the
 * new head hashes to its record. Each check throws rather than reporting,
 * because the caller's next step merges whatever this returns.
 */
async function verifyCommit(
  exec: BuildExec,
  wt: string,
  headBefore: string,
  frozen: Record<string, string>,
  report: NormaliseReport,
): Promise<void> {
  const newHead = await headSha(exec, wt);
  if (newHead === headBefore)
    throw new BuildInfraError("HEAD did not move — the build commit was never made");
  // Whole SHAs compared as full strings: a short `rev-parse` and a full
  // `headBefore` would never be equal, and a prefix match would pass a fork.
  const parent = await must(exec, wt, ["rev-parse", "HEAD^"], "read the build commit's parent");
  if (parent !== headBefore)
    throw new BuildInfraError(
      `the build commit's parent is ${parent || "unreadable"}, not ${headBefore}`,
    );

  report.files = await commitDiff(exec, wt, headBefore, newHead);
  const leaked = report.files.filter((p) => frozen[p] !== undefined || isProtectedPath(p));
  if (leaked.length > 0)
    throw new BuildInfraError(`the build commit contains untouchable path(s) ${leaked.join(", ")}`);

  const dirty = await porcelain(exec, wt);
  if (dirty !== "")
    throw new BuildInfraError(
      `the worktree is not clean after the build commit: ${dirty.slice(0, 400)}`,
    );

  const mismatched = await frozenMatches(exec, wt, newHead, frozen);
  if (mismatched.length > 0)
    throw new BuildInfraError(
      `the frozen tests do not match the record at the build commit: ${mismatched.join(", ")}`,
    );
}

/** The pre-dispatch preconditions: the run froze tests, and they still match. */
export async function assertFrozenIntact(
  exec: BuildExec,
  wt: string,
  headBefore: string,
  frozen: Record<string, string>,
): Promise<void> {
  if (Object.keys(frozen).length === 0)
    throw new BuildInfraError("frozen tests do not match the record: the run froze no tests");
  const bad = await frozenMatches(exec, wt, headBefore, frozen);
  if (bad.length > 0)
    throw new BuildInfraError(
      `frozen tests do not match the record: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? ` (+${bad.length - 8} more)` : ""}`,
    );
}
