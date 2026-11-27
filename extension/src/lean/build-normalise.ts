/**
 * lean/build-normalise — CAPTURE, RESET, REWRITE for the build step.
 *
 * The developer child is a model: it may commit, edit a frozen acceptance test, write into `.pi/` or
 * `.github/`, or hand the tree a symlink and a hard link. `specify` already owns an algorithm that
 * survives exactly that — read the bytes you intend to keep, reset the tree to a known commit, write
 * those bytes back — so there is ONE design for "the tree is not trustworthy" in this step family.
 *
 *   1. HEAD must still descend from `headBefore`. A child that reset HEAD is refused outright — the
 *      `merge-base --is-ancestor` check, read before anything mutates.
 *   2. The changed set is `git diff --name-only -z headBefore` unioned with
 *      `git ls-files --others --exclude-standard -z`.
 *   3. Each path is classified. A frozen or protected path in that set is IGNORED — stage 4 undoes it
 *      — and only recorded. Anything else is inspected with `lstat` at every step (`entryAt`): only a
 *      name with nothing at it, nothing in its way, is a DELETION. A link, device, directory, or a
 *      name behind one is REMOVED with its reason and never followed. A regular file is CAPTURED
 *      through `readOneDescriptor`; a refusal also removes the path.
 *   4. `resetWorktreeToBase` puts the tree back to `headBefore` — commits, index, untracked files,
 *      ignore tricks and dependency links all go — and provisioning rebuilds the links.
 *   5. The captured bytes go back through `writeCaptured`, executable bits are restored, and
 *      deletions are applied.
 *   6. Nothing captured and nothing to delete is `files: []`, and the caller routes `exhausted`.
 *   7. One commit with an EXPLICIT pathspec — `git add -- <paths>` and `git commit -- <paths>`, never
 *      `add -A`. Then four claims are proved about it: parent is `headBefore`; its diff names no
 *      frozen and no protected path; the tree is clean; every frozen blob at the new head hashes to
 *      its record.
 *
 * Every git call goes through `build-git.ts`, which carries the hook and fsmonitor guard (`NO_HOOKS`).
 * Anything unproven throws — the step's output is a commit the run merges.
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
import { protectedGlobMatches } from "./protected-globs.ts";
import { CaptureBudget, readOneDescriptor } from "./specify-capture.ts";
import { resetWorktreeToBase, writeCaptured } from "./specify-reset.ts";
import { type SubmoduleNote, submoduleNoteClause } from "./specify-submodules.ts";

/**
 * Is `rel` a path whose contents decide what verification means? The canonical set in
 * `work-driver-doctrine.ts` covers `agents.json`, `CODEOWNERS` at any depth, and `.pi/` /
 * `.github/`; `.gitmodules` moves the tree a verify run sees, so that one is added here.
 */
function isProtectedPath(rel: string): boolean {
  return canonicalProtectedPath(rel) || rel === ".gitmodules";
}

/**
 * The fold's protected predicate: the built-in rule plus every configured glob the step handed
 * in, built once per fold so the compiled patterns are shared by `classify`'s revert arm and
 * `verifyCommit`'s leak filter — the two must agree, or a routine revert also throws as a leak.
 * Configured entries match VERBATIM: `changedSet` and `commitDiff` print repo-relative paths
 * with no `./` and no doubling, which is the spelling the config validator admits.
 */
function protectedPredicate(globs: readonly string[] | undefined): (rel: string) => boolean {
  if (globs === undefined || globs.length === 0) return isProtectedPath;
  return (rel) => isProtectedPath(rel) || globs.some((entry) => protectedGlobMatches(entry, rel));
}

/** The kept bytes and their modes, after classification. */
interface Classified {
  captured: Map<string, { bytes: Buffer; exec: boolean }>;
  report: NormaliseReport;
}

/**
 * The configured globs that named nothing of their own in `changed`, or `undefined` when every
 * glob bit. A glob that matched only a path the built-in list already reverts (`.pi/work.json`
 * under `**\/*.json`) said nothing of its own: either belongs on the inert list, where a
 * protection that quietly rotted becomes visible. Entries arrive validated by the loader, so a
 * glob lands here only when the project named no path for its rule. A BUILT-IN path is not
 * reported here: the built-in list is the shipped rule, not one this project wrote, so naming it
 * in a list of the project's own configured globs would tell the reader to delete a rule that
 * belongs to no config.
 */
function inertGlobs(globs: readonly string[], changed: string[]): string[] | undefined {
  // A built-in path cannot make a configured glob count as having bitten: if the only changed path
  // a glob names is one the shipped rule already reverts, the project's rule said nothing of its
  // own, and that is exactly the rot this list exists to expose. Built-ins are filtered out of the
  // evidence rather than added to the disclosure.
  const itsOwn = changed.filter((rel) => !isProtectedPath(rel));
  const hits = (entry: string): boolean => itsOwn.some((rel) => protectedGlobMatches(entry, rel));
  const inert = globs.filter((entry) => !hits(entry));
  return inert.length === 0 ? undefined : inert;
}

/**
 * Sort the child's changed paths into kept, restored, reverted, removed, deleted. Frozen and protected
 * paths are only RECORDED here — the reset undoes them — so this runs first: after the reset "what the
 * child did" is unrecoverable.
 */
function classify(
  wt: string,
  changed: string[],
  frozen: Record<string, string>,
  budget: CaptureBudget,
  isProtected: (rel: string) => boolean,
  globs: readonly string[] | undefined,
): Classified {
  const captured = new Map<string, { bytes: Buffer; exec: boolean }>();
  const report: NormaliseReport = {
    files: [],
    restored: [],
    reverted: [],
    removed: [],
    deleted: [],
  };
  if (globs !== undefined && globs.length > 0)
    report.protectedUnmatched = inertGlobs(globs, changed);
  for (const rel of changed) {
    if (frozen[rel] !== undefined) {
      report.restored.push(rel);
      continue;
    }
    if (isProtected(rel)) {
      report.reverted.push(rel);
      continue;
    }
    const entry = entryAt(wt, rel);
    if (entry.kind === "absent") {
      // Genuinely absent: the reset leaves nothing here either way, so the path is simply gone — a
      // deletion the commit must carry.
      report.deleted.push(rel);
      continue;
    }
    if (entry.kind === "other") {
      report.removed.push({ path: rel, why: entry.why });
      continue;
    }
    // Once the aggregate ceiling is spent the path is removed unread, so the step never holds more
    // than the budget in memory.
    if (budget.stopped) {
      report.removed.push({ path: rel, why: `not captured: ${budget.why}` });
      continue;
    }
    const one = readOneDescriptor(path.join(wt, rel));
    if ("why" in one) {
      report.removed.push({ path: rel, why: one.why });
      continue;
    }
    if (!budget.admit(one.bytes.length)) {
      report.removed.push({ path: rel, why: `not captured: ${budget.why}` });
      continue;
    }
    captured.set(rel, one);
  }
  return { captured, report };
}

/**
 * Fold the child's work into one provable commit on `headBefore`.
 *
 * Returns `files: []` when the tree held nothing to commit. Throws on a HEAD the step cannot account
 * for or on a commit whose contents it cannot prove.
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
  /** The aggregate capture ceiling; the default is the production one. */
  budget?: CaptureBudget;
  /**
   * The project's own protected globs (`.pi/work.json` `lean.protectedPaths`), already
   * resolved by `protectedPathsOf` — so the switch's off arm and an absent field are one
   * value here. Every caller resolves the list ONCE per step, from the config it read at the
   * run's base sha, and hands the SAME list to every fold. A changed path matching one is
   * REVERTED and reported in `reverted` exactly as a built-in protected path is, and is never
   * reported as leaked: both arms below ask the same predicate.
   */
  protected?: readonly string[];
}): Promise<NormaliseReport> {
  const { exec, wt, repoRoot, branch, headBefore, frozen } = opts;

  const isProtected = protectedPredicate(opts.protected);

  // 1 + 2 + 3. All reads, before any write.
  if (!(await headDescendsFrom(exec, wt, headBefore)))
    throw new BuildInfraError(
      `the developer moved HEAD away from ${headBefore} — refusing to fold its commits`,
    );
  const { captured, report } = classify(
    wt,
    await changedSet(exec, wt, headBefore),
    frozen,
    opts.budget ?? new CaptureBudget(),
    isProtected,
    opts.protected,
  );

  // 4. RESET — child commits, staging, untracked files, ignore tricks and the dependency links all
  //    go; frozen and protected files come back exactly as at `headBefore`; provisioning rebuilds what
  //    the clean removed.
  let submoduleNotes: readonly SubmoduleNote[] = [];
  try {
    // What the reset's submodule pass could not supply is kept on the report: a fold that
    // restored a tree with no submodule in it is a fold whose commit cannot be reproduced.
    submoduleNotes = await resetWorktreeToBase(exec, wt, headBefore, branch);
    report.submodules = submoduleNoteClause(submoduleNotes);
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

  // 5. REWRITE the kept bytes, then delete what the child deleted. Both happen after the reset, and
  //    each path is looked at again first: a name the child turned into a directory is a kind change
  //    to refuse with its reason, not a write that throws.
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

  // The deletions the commit must carry are the ones git knows: a tracked file the child removed. A
  // link the child left is a deletion of nothing in HEAD, and naming it to `git add` would fail the
  // whole commit. The index is at `headBefore` now.
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

  // 7. One commit, the pathspec named on both the add and the commit: the commit holds these paths
  //    and no other, whatever else the index or tree holds.
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

  await verifyCommit(exec, wt, headBefore, headBefore, frozen, report, isProtected);
  return report;
}

/**
 * Prove the commit the step just made: parent is `headBefore`; no frozen or protected path is in its
 * diff; the tree is clean; every frozen blob at the new head hashes to its record. Each check throws
 * rather than reporting, because the caller's next step merges whatever this returns.
 *
 * `diffBase` is the sha the leak filter ranges from, and it is NOT always `headBefore`: the fold has
 * just reset the tree, so the only paths this fold could have written are the ones it captured, and a
 * protected path already present in `headBefore` is not one of them. Ranging from the commit the fold
 * itself sat on (its parent, or `headBefore` when no commit was made) is what keeps the check about
 * THIS fold's writing rather than about bytes the branch already held when the step began.
 */
async function verifyCommit(
  exec: BuildExec,
  wt: string,
  diffBase: string,
  headBefore: string,
  frozen: Record<string, string>,
  report: NormaliseReport,
  isProtected: (rel: string) => boolean,
): Promise<void> {
  // Whole SHAs compared as full strings: a prefix match would pass a fork. Reading `HEAD^` also proves
  // HEAD moved — a fold that made no commit has an unreadable parent here.
  const newHead = await headSha(exec, wt);
  const parent = await must(exec, wt, ["rev-parse", "HEAD^"], "read the build commit's parent");
  if (parent !== headBefore)
    throw new BuildInfraError(
      `the build commit's parent is ${parent || "unreadable"}, not ${headBefore}`,
    );

  report.files = await commitDiff(exec, wt, diffBase, newHead);
  const leaked = report.files.filter((p) => frozen[p] !== undefined || isProtected(p));
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
  // An empty map is not a mismatch: the step says there is nothing to build against rather than
  // reporting a hash that failed.
  if (Object.keys(frozen).length === 0)
    throw new BuildInfraError("the run froze no tests — build has nothing to build against");
  const bad = await frozenMatches(exec, wt, headBefore, frozen);
  if (bad.length > 0)
    throw new BuildInfraError(
      `frozen tests do not match the record: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? ` (+${bad.length - 8} more)` : ""}`,
    );
}
