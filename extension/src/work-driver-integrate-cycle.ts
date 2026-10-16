/**
 * work-driver-integrate-cycle — the cycle's OWN worktrees, as the integrate
 * step sees them (#1170).
 *
 * The state file's `pipelineState.worktrees` records every worktree the
 * branch step and its dependents created for this cycle (the develop
 * trees). The integrate step must not read those as foreign leftovers: a
 * develop tree is tree-identical to the branch head after consolidation,
 * and the sibling scan's "unpushed commit" reading parked the cycle. They
 * are excluded from the sibling scan, but a tree that holds work still
 * refuses — the exclusion waives "this is a leftover", never "this holds
 * work". Nothing here removes an in-cycle tree.
 *
 * It also judges the stale `issue-<N>-integrate` tree a re-entry is about to
 * replace: whether it is registered and recorded as this cycle's, whether it
 * holds work that refuses, and (#1173) which of its commits must be kept on a
 * backup ref before it goes.
 */

import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import { assertSafeRef } from "./worktree-loss.ts";
import {
  DirtyWorktreeError,
  type ExecFn,
  inspectWorktreeForLoss,
  listWorktreeStrict,
  resolvePath,
} from "./worktree.ts";

/**
 * Every worktree path the cycle's state file records (the branch step's
 * worktree map plus the integrate tree). An unreadable or absent state file
 * returns `[]` — the safe direction: the develop trees then stay in the
 * sibling scan, which is the pre-#1170 behaviour.
 */
export async function readCycleWorktreePaths(stateFile: string | undefined): Promise<string[]> {
  if (!stateFile) return [];
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as {
      pipelineState?: { worktrees?: Record<string, unknown>; integrateWorktree?: unknown };
    };
    const ps = parsed.pipelineState ?? {};
    const paths = Object.values(ps.worktrees ?? {}).filter(
      (p): p is string => typeof p === "string",
    );
    if (typeof ps.integrateWorktree === "string") paths.push(ps.integrateWorktree);
    return paths;
  } catch (err) {
    // Reads as "no recorded cycle trees" (the safe direction for the
    // sibling scan), but the operator must be able to tell it from "none".
    trace(
      `work-driver: integrate-tree cycle check — could not read state file ${stateFile}: ${(err as Error).message ?? String(err)}`,
    );
    return [];
  }
}

/**
 * #1170 — the stale integrate tree is inspected before it is removed.
 *
 * The driver-owned stale `issue-<N>-integrate` tree is about to be
 * force-removed. Every ignored entry is judged as loss except the regenerable
 * dependency trees and provisioned links that worktree-loss exempts (#1170).
 * The driver never builds in this tree (verify runs at repoRoot), so `target/`
 * or `dist/` here is operator or ops-fallback output, not re-entry residue.
 * Commits are judged against `ref` (the branch tip, else the base), so a re-entry whose HEAD is already
 * on the branch is not loss. `inspectWorktreeForLoss` reports an unreadable read as
 * `inspectError` (it never throws), so any such finding refuses with
 * `DirtyWorktreeError` BEFORE anything is removed (fail closed).
 *
 * #1173 — a finding whose ONLY content is commits goes to
 * `backupIntegrateHead`, the one place that decides whether those commits are
 * the cycle's own (kept on a backup ref, the tree replaced) or foreign (a tree
 * on another branch — refused). Refusing the cycle's own commits wedged every
 * re-entry. Returns what was kept (the ref, and any sha it replaced) when a ref
 * was written.
 */
export async function keepOrRefuseStaleIntegrateTree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
  ref: string,
  branchName: string,
  issue: number,
): Promise<IntegrateBackup | undefined> {
  const finding = await inspectWorktreeForLoss(execFn, repoRoot, abs, ref);
  if (finding === undefined) return undefined; // provably clean: nothing uncommitted, no unique commits
  // Every other loss channel is judged HERE, before the commits-only path.
  const onlyCommits =
    finding.uncommittedFiles.length === 0 &&
    finding.inspectError === undefined &&
    finding.notOwnWorktree !== true;
  if (!onlyCommits) throw new DirtyWorktreeError(finding);
  try {
    return await backupIntegrateHead(execFn, abs, ref, branchName, issue, repoRoot);
  } catch (err) {
    throw new DirtyWorktreeError({
      ...finding,
      inspectError: `its commits could not be kept on a backup ref: ${(err as Error).message ?? String(err)}`,
    });
  }
}

/**
 * #1396 — the ONE backup ref name for an issue. Written by
 * `backupIntegrateHead`, asserted by the smoke tests, and named in
 * `docs/troubleshooting.md`. `issue` is a number from the driver's context, so
 * it cannot carry path or ref traversal; `assertSafeRef` still runs on the
 * composed name before it reaches `git update-ref`.
 */
export function integrateBackupRef(issue: number): string {
  return `refs/pi-rukas/integrate-backup/issue-${issue}`;
}

/**
 * #1173 — keep the stale integrate tree's commits before the tree is removed.
 * HEAD's commits that neither `ref` (the branch tip, else the base) nor
 * `origin/<branch>` already holds are written to
 * `refs/pi-rukas/integrate-backup/issue-<N>` — **one ref per issue**, replaced
 * in place by `git update-ref`, so a cycle that re-enters commit-pr twenty
 * times leaves one ref, not twenty. The ref is the LAST kept HEAD, not every
 * kept HEAD.
 *
 * Replacing an older ref's commit is not a new loss channel (#1173's reachability
 * proviso, retired by #1396): the driver force-removes the tree that held the
 * older HEAD immediately after this call returns, and every removal decision
 * here — `inspectWorktreeForLoss` via `keepOrRefuseStaleIntegrateTree`, the
 * operator-residue dirt check — refuses before a removal whenever the tree
 * holds uncommitted or non-regenerable work. An older backup whose commits are
 * reachable from nothing had already been destroyed by the same force-remove
 * the ref merely pointed at; nothing survives for the ref to protect.
 *
 * Only a detached HEAD or one on the cycle's own branch is the cycle's work: a
 * tree on another branch holding unique commits throws. Returns what was kept
 * — the ref and, when the ref already existed and pointed at a DIFFERENT sha,
 * the sha it replaced (#1396 six-lens: the ref is replaced in place, so without
 * this the operator's handoff could not tell that an earlier re-entry's backup
 * is gone) — or `undefined` when there was nothing to keep. Throws when git
 * cannot answer — the caller then removes nothing.
 */
export async function backupIntegrateHead(
  execFn: ExecFn,
  abs: string,
  ref: string,
  branchName: string,
  issue: number,
  repoRoot: string,
): Promise<IntegrateBackup | undefined> {
  assertSafeRef(ref);
  const opts = { cwd: abs, maxBuffer: 64 * 1024 };
  const sha = (await execFn("git rev-parse --verify HEAD", opts)).stdout.trim();
  assertSafeRef(sha);
  const { stdout } = await execFn(`git rev-list --count ${JSON.stringify(`${ref}..${sha}`)}`, opts);
  if (Number.parseInt(stdout.trim(), 10) === 0) return undefined;
  // A read that cannot answer is NOT evidence of reachability: an unreadable
  // `merge-base` must fall through to the keep below, never to the
  // "already on origin, nothing to keep" return — that is the quiet way a
  // commit dies with the tree. (An unreadable keep below then throws, and the
  // caller removes nothing.)
  if ((await headReachableFrom(execFn, abs, `origin/${branchName}`)) === true) return undefined;
  const head = (await execFn("git rev-parse --symbolic-full-name HEAD", opts)).stdout.trim();
  if (head !== "HEAD" && head !== `refs/heads/${branchName}`) {
    throw new Error(`HEAD is on ${head}, not ${branchName} — not this cycle's work`);
  }
  const backup = integrateBackupRef(issue);
  assertSafeRef(backup);
  // #1396 six-lens — the ref is one per issue and `update-ref` replaces it in
  // place, so the sha it held until now is about to lose its only named
  // reference. Read it FIRST: a ref that does not exist yet answers empty via
  // `--verify --quiet` (exit 1), which is "nothing superseded", not an error.
  //
  // The read runs at `repoRoot`, NOT in `abs`. Both are links to the same
  // object database and the same refs, but `abs` is the tree about to be
  // force-removed: its `.git` file points at a gitdir the driver deletes, and
  // in the plain-directory shape (`notOwnWorktree`) there is no valid gitdir
  // at all. A read that fails there is indistinguishable from a transient git
  // error, and this function's contract is "throws when git cannot answer, so
  // the caller removes nothing" — a broken stale tree would then refuse a
  // re-entry that has nothing to lose. repoRoot is a real worktree the driver
  // never removes, so "could not read" from there means what it says. The read
  // is `git rev-parse --verify --quiet <ref>`, which is fully discriminating
  // against a real repository (measured on git 2.50.1):
  //   present  → exit 0, the sha on stdout, stderr empty
  //   absent   → exit 1, **stdout AND stderr empty**  — a definite negative
  //   broken   → exit 1 with `warning: ignoring broken ref …` on stderr
  //   no repo  → exit 128 with `fatal: …` on stderr
  // so quiet exit 1 reads as "nothing superseded" and every other rejection is
  // "could not answer", which this function's contract says must throw so the
  // caller removes nothing. Same discrimination as
  // `worktree-create-guard.ts`'s `baseRefResolves`.
  let previous: string | undefined;
  try {
    const r = await execFn(`git rev-parse --verify --quiet ${JSON.stringify(backup)}`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    previous = r.stdout.trim();
  } catch (err) {
    const e = err as {
      code?: unknown;
      signal?: unknown;
      killed?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const quietExit1 =
      (e.code === 1 || e.code === "1") &&
      !e.signal &&
      !e.killed &&
      String(e.stdout ?? "") === "" &&
      String(e.stderr ?? "") === "";
    // Definite negative: the ref does not exist, so nothing was superseded.
    if (quietExit1) previous = "";
    else throw err;
  }
  const supersededSha = previous && previous !== sha ? previous : undefined;
  // #1396 six-lens — the write runs at `repoRoot` for the same reason the read
  // above does: `abs` is the tree about to be force-removed, and `git update-ref`
  // there writes through a `.git` file that points at a gitdir the driver is
  // deleting. `update-ref` validates the ref it is overwriting before writing,
  // so a broken link made it fail with `unable to resolve reference` — which
  // this function's contract turns into "remove nothing", wedging the re-entry
  // the backup exists to unblock. Both trees share one object database and one
  // ref store, so the write lands in the same place either way.
  await execFn(`git update-ref ${JSON.stringify(backup)} ${JSON.stringify(sha)}`, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024,
  });
  trace(
    `work-driver: kept the stale integrate tree's unpushed commits on ${backup} (${sha})${
      supersededSha
        ? ` — replaces the older backup ${supersededSha} for this issue`
        : " — replaces any older backup for this issue"
    }`,
  );
  return { ref: backup, ...(supersededSha ? { supersededSha } : {}) };
}

/** What `backupIntegrateHead` kept: the ref, and the sha it replaced if any. */
export interface IntegrateBackup {
  ref: string;
  /**
   * The sha the per-issue backup ref pointed at BEFORE this call replaced it.
   * Present only when the ref already existed with a different sha — i.e. only
   * when a previous re-entry's kept commits have just lost their only named
   * reference.
   */
  supersededSha?: string;
}

/**
 * Whether HEAD is provably an ancestor of `remoteRef`. `remoteRef` is built
 * from the branch name `ensureIntegrateWorktree` already validated with
 * `assertSafeRef`, so it is not re-validated here.
 *
 * Three-valued (#1396): `git merge-base --is-ancestor` exits 1 for "not an
 * ancestor" and >1 for "could not answer" (a missing ref, a corrupt object),
 * and `promisify(exec)` surfaces both as rejections. Collapsing the two — the
 * old `catch → false` — manufactured a backup ref for commits already on
 * `origin/<branch>` (a second, quieter source of ref growth) while the fail-open
 * direction that actually loses work was never distinguished. An unreadable
 * answer now returns `undefined`, and the one caller treats it as NOT reachable,
 * i.e. keep the commit.
 *
 * The exit code is read as BOTH shapes: `child_process.exec` reports the
 * numeric status, but the executor is the driver's injected `ExecFn` and a
 * non-numeric implementation (a shell wrapper, a test fake) reports `"1"`.
 * Accepting only the number sent a string `"1"` down the "could not answer"
 * branch, which keeps a commit that is provably already on `origin/<branch>`
 * — a needless write, not a loss, so the old code got away with it. A kill or
 * a signal is never exit-1: those stay "could not answer".
 */
async function headReachableFrom(
  execFn: ExecFn,
  abs: string,
  remoteRef: string,
): Promise<boolean | undefined> {
  const cmd = `git merge-base --is-ancestor HEAD ${JSON.stringify(remoteRef)}`;
  try {
    await execFn(cmd, { cwd: abs, maxBuffer: 64 * 1024 });
    return true;
  } catch (err) {
    const e = err as { code?: unknown; signal?: unknown; killed?: unknown };
    if ((e.code === 1 || e.code === "1") && !e.signal && !e.killed) return false;
    trace(
      `work-driver: could not tell whether HEAD is on ${remoteRef} — treating it as NOT there, so its commits are kept (${(err as Error).message ?? String(err)})`,
    );
    return undefined;
  }
}

/**
 * Refuse when any of the cycle's OTHER worktrees (not the integrate path
 * `abs`) holds work: uncommitted or ignored-non-regenerable entries, an
 * unreadable tree, or a directory that is not its own worktree. A tree that
 * differs from the base only by its own commits is the cycle's output and
 * passes. The main working tree (`repoRoot`) is never a cycle tree and is
 * skipped: the integrate step handles it separately (the detach path).
 * `inspectWorktreeForLoss` is the single no-loss definition (#1170).
 */
export async function refuseDirtyCycleTrees(
  execFn: ExecFn,
  cycleTrees: string[],
  abs: string,
  repoRoot: string,
  baseSha: string,
): Promise<void> {
  const target = resolvePath(abs);
  const main = resolvePath(repoRoot);
  for (const p of cycleTrees) {
    if (resolvePath(p) === target || resolvePath(p) === main) continue;
    // Ignored entries are not refused here: in-cycle trees are never removed,
    // so an ignored build artefact (target/) is not a reason to stop the
    // integration. Tracked/untracked work, unreadable trees and foreign
    // directories still refuse.
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, p, baseSha, {
      ignoredIsLoss: false,
    });
    if (finding === undefined) continue;
    // Tree-differs alone is the cycle's own output (a develop commit) — only
    // work the finding actually holds refuses here.
    if (
      finding.uncommittedFiles.length > 0 ||
      finding.inspectError !== undefined ||
      finding.notOwnWorktree === true
    ) {
      throw new DirtyWorktreeError(finding);
    }
  }
}

/**
 * #861 round 2 — the stale-tree ownership check. The state file (the cycle's
 * `.pi/work-state/<issue>.json`) records the branch step's worktree map
 * (id → path). If the integrate path appears in that map, the tree at that
 * path is driver-owned re-entry residue (this cycle created it). If it does
 * NOT appear, the tree is NOT this cycle's — it is operator residue the
 * driver must not silently destroy (a dirty one HALTS; a clean one is
 * pre-removed by the #475 target guard below).
 *
 * An unreadable state file returns false (the safe direction: the path is
 * then treated as NOT this cycle's, so a dirty one halts rather than being
 * silently destroyed; a clean one is pre-removed and the fresh creation
 * proceeds — the same shape as the "unregistered directory" case).
 */
export function isIntegrateTreeInCycle(cycleTrees: string[], abs: string): boolean {
  const target = resolvePath(abs);
  return cycleTrees.some((p) => resolvePath(p) === target);
}

/**
 * Whether the path is a REGISTERED worktree (`git worktree list --porcelain`
 * contains it). This is the driver's stale-tree discriminator: a registered
 * tree at the integrate path is driver-owned re-entry residue (an earlier
 * attempt of this same cycle created it), so it is force-replaced. A
 * directory that exists but is registered NOWHERE is not driver-owned
 * residue — it is left for the unconditional #475 target guard, which
 * refuses a dirty one.
 *
 * #1396 — the read is the strict listing (`listWorktreeStrict`: one retry at
 * 250ms, then `WorktreeScanError`). It used to catch every git failure and
 * return false, and false is not a neutral answer here: it routes the caller
 * to "unregistered directory", which skips the record-HEAD + backup branch
 * entirely and can leave the driver force-removing a tree it never proved was
 * residue. A listing that cannot be read cannot prove absence, so it refuses
 * the whole creation — the same contract the branch step's sibling scan
 * already has (#1170).
 */
export async function isRegisteredWorktree(
  execFn: ExecFn,
  repoRoot: string,
  abs: string,
): Promise<boolean> {
  const stdout = await listWorktreeStrict(execFn, repoRoot);
  const target = resolvePath(abs);
  return stdout
    .split("\n")
    .some(
      (l) =>
        l.trim().startsWith("worktree ") &&
        resolvePath(l.trim().slice("worktree ".length)) === target,
    );
}
