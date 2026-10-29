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
 *      can say what was put back. Anything else is looked at with `lstat` at
 *      every step (`entryAt`): only a name with nothing at it, nothing in its
 *      way, is a DELETION. A link, a device, a directory, or a name behind one
 *      is REMOVED with its reason and never followed. A regular file is CAPTURED
 *      through `readOneDescriptor`, the same single-descriptor read `specify`
 *      uses; a refusal (hard link, swapped inode, over the size ceiling) also
 *      removes the path rather than committing it.
 *   4. `resetWorktreeToBase` puts the tree back to `headBefore` — commits,
 *      index, untracked files, ignore tricks and dependency links all go — and
 *      provisioning rebuilds the links. Frozen and protected files are now
 *      exactly as at `headBefore`, because git put them there, not this file.
 *   5. The captured bytes go back through `writeCaptured` (no symlinked
 *      ancestor, temp file plus rename), executable bits are restored, and the
 *      deletions are applied with `rmSync`.
 *   6. Nothing captured and nothing the commit must delete is the honest answer
 *      to "did the developer change anything": `files: []`, and the caller
 *      routes `exhausted`.
 *   7. One commit, with an EXPLICIT pathspec: `git add -- <paths>` and
 *      `git commit -- <paths>`, never `add -A`, so the commit holds the kept
 *      paths and the deletions the commit must carry, and nothing else the
 *      tree happens to hold. Then four claims are proved about it: parent is
 *      `headBefore`; its diff names no frozen and no protected path; the tree
 *      is clean; every frozen blob at the new head hashes to its record.
 *
 * Every git call here goes through `build-git.ts`, which carries the hook and
 * fsmonitor guard (`NO_HOOKS`). Anything unproven throws — the step's output is
 * a commit the run merges.
 */

import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { isProtectedPath as canonicalProtectedPath } from "../work-driver-doctrine.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { entryAt } from "./build-capture.ts";
import { BuildInfraError } from "./build-errors.ts";
import {
  changedSet,
  commitDiff,
  fields,
  frozenMatches,
  headDescendsFrom,
  headSha,
  must,
  porcelain,
} from "./build-git.ts";
import type { BuildExec, NormaliseReport } from "./build-types.ts";
import { readOneDescriptor } from "./specify-capture.ts";
import { resetWorktreeToBase, writeCaptured } from "./specify-reset.ts";

/**
 * Is `rel` a path whose contents decide what verification means? The canonical
 * set in `work-driver-doctrine.ts` covers `agents.json`, `CODEOWNERS` at any
 * depth, and `.pi/` / `.github/`. It lacks `.gitmodules`, which moves the tree a
 * verify run sees, so that one is added here.
 */
function isProtectedPath(rel: string): boolean {
  return canonicalProtectedPath(rel) || rel === ".gitmodules";
}

/** The kept bytes and their modes, after classification. */
interface Classified {
  captured: Map<string, { bytes: Buffer; exec: boolean }>;
  report: NormaliseReport;
}

/**
 * Sort the child's changed paths into kept, restored, reverted, removed, deleted.
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
    const entry = entryAt(wt, rel);
    if (entry.kind === "absent") {
      // Genuinely absent: the reset leaves nothing here either way, so the path
      // is simply gone — a deletion the commit must carry.
      report.deleted.push(rel);
      continue;
    }
    if (entry.kind === "other") {
      report.removed.push({ path: rel, why: entry.why });
      continue;
    }
    const one = readOneDescriptor(path.join(wt, rel));
    if ("why" in one) {
      report.removed.push({ path: rel, why: one.why });
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

  // 1 + 2 + 3. All reads, before any write.
  if (!(await headDescendsFrom(exec, wt, headBefore)))
    throw new BuildInfraError(
      `the developer moved HEAD away from ${headBefore} — refusing to fold its commits`,
    );
  const { captured, report } = classify(wt, await changedSet(exec, wt, headBefore), frozen);

  // 4. RESET — child commits, staging, untracked files, ignore tricks and the
  //    dependency links all go; frozen and protected files come back exactly as
  //    at `headBefore`; provisioning rebuilds what the clean removed.
  try {
    await resetWorktreeToBase(exec, wt, headBefore, branch);
  } catch (err) {
    throw new BuildInfraError(
      `could not reset the worktree to ${headBefore}: ${(err as Error).message}`,
    );
  }
  try {
    await provisionWorktree(exec, repoRoot, wt);
  } catch (err) {
    throw new BuildInfraError(
      `could not re-provision the worktree after the reset: ${(err as Error).message}`,
    );
  }

  // 5. REWRITE the kept bytes, then delete what the child deleted. Both happen
  //    after the reset, and each path is looked at again first: the reset gave
  //    back the base tree, so a name the child turned into a directory (or put a
  //    file under) is a kind change to refuse with its reason, not a write that
  //    throws. Nothing is written or removed through a link.
  const payload = new Map<string, Buffer>();
  for (const [rel, one] of captured) {
    const now = entryAt(wt, rel);
    if (now.kind === "other") {
      report.removed.push({ path: rel, why: now.why });
      captured.delete(rel);
      continue;
    }
    payload.set(rel, one.bytes);
  }
  try {
    writeCaptured(wt, payload);
  } catch (err) {
    throw new BuildInfraError(`could not rewrite the developer's files: ${(err as Error).message}`);
  }
  for (const [rel, one] of captured) {
    if (one.exec) chmodSync(path.join(wt, rel), 0o755);
  }
  const applied: string[] = [];
  for (const rel of report.deleted) {
    const now = entryAt(wt, rel);
    if (now.kind === "other") {
      report.removed.push({ path: rel, why: now.why });
      continue;
    }
    try {
      rmSync(path.join(wt, rel), { force: true });
    } catch (err) {
      throw new BuildInfraError(
        `could not apply the deletion of ${rel}: ${(err as Error).message}`,
      );
    }
    applied.push(rel);
  }
  report.deleted = applied;

  // The deletions the commit must carry are the ones git knows: a tracked file
  // the child removed. A link the child left is a deletion of nothing in HEAD,
  // and naming it to `git add` would fail the whole commit. The index is at
  // `headBefore` now, so `ls-files` answers for the reset tree.
  const deletions =
    report.deleted.length === 0
      ? []
      : fields(
          await must(
            exec,
            wt,
            ["--literal-pathspecs", "ls-files", "-z", "--", ...report.deleted],
            "read which deleted paths the commit holds",
          ),
        );

  // 6. Nothing to commit is an answer, not a fault.
  if (captured.size === 0 && deletions.length === 0) return report;

  // 7. One commit, the pathspec named on both the add and the commit: the commit
  //    holds these paths and no other, whatever else the index or tree holds.
  const paths = [...captured.keys(), ...deletions];
  await must(
    exec,
    wt,
    ["--literal-pathspecs", "add", "--", ...paths],
    "stage the developer's work",
  );
  await must(
    exec,
    wt,
    [
      "--literal-pathspecs",
      "commit",
      "-m",
      `build: attempt ${opts.attempt} for #${opts.issue}`,
      "--",
      ...paths,
    ],
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
