/**
 * work-driver-handoff-snapshot — PR5: capture a worktree snapshot at handoff
 * time so the operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal, the GitHub body) can answer WHERE the work is without re-shelling
 * git on every call.
 *
 * Split from work-driver-handoff.ts (AGENTS.md §12 file-size limit) so the
 * handoff step handler stays under the 500-line hard cap as the #775
 * delivery-provenance work grows it. Behaviour-neutral: the function body is
 * unchanged, and the exported name/path stay reachable from
 * work-driver-handoff.ts so no consumer's import path changes.
 */

import { execp } from "./lens-exec.ts";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * PR5 — capture a snapshot of the worktree at handoff time. Lets the
 * operator-facing surfaces (in-chat sendUserMessage, /work-status
 * terminal renderer, GitHub renderHandoffMarkdown) answer WHERE the
 * work is without re-shelling git on every call.
 *
 * Best-effort: every git invocation is try/catch'd so a missing branch /
 * gh-auth / network issue degrades gracefully — the snapshot's
 * `branchPushed: false` and empty `modifiedFiles` is meaningful by
 * itself; absence of the snapshot field is not. A local read that FAILED is
 * recorded in `unreadable`, because its empty default is otherwise read as
 * "nothing there".
 *
 * Caps file list at 50 entries to keep state-file readable; the
 * `unstagedCount + stagedCount` totals are always accurate even when
 * the per-file list is truncated.
 */
export async function captureWorktreeSnapshot(
  repoRoot: string,
  branchName: string | undefined,
  worktrees?: Record<string, string>,
  baseSha?: string,
): Promise<NonNullable<WorkState["pipelineState"]["handoffSnapshot"]>> {
  const snapshot: NonNullable<WorkState["pipelineState"]["handoffSnapshot"]> = {
    modifiedFiles: [],
    unstagedCount: 0,
    stagedCount: 0,
    branchExists: false,
    branchPushed: false,
    repoRootHeadSha: "",
    capturedAt: Date.now(),
  };
  const unreadable: string[] = [];
  // #287 — the developer's uncommitted work lives in the WORKTREES, not at
  // repoRoot. Snapshotting repoRoot alone would report "0 files modified" on
  // exactly the handoffs where the operator needs to know what survived.
  // Scan every worktree (falling back to repoRoot when none were recorded,
  // i.e. a pre-branch halt), prefixing paths
  // with the workstream id when there is more than one so the file list is
  // unambiguous.
  const scanRoots = Object.entries(worktrees ?? {});
  const targets: Array<{ id: string | undefined; dir: string }> =
    scanRoots.length > 0
      ? scanRoots.map(([id, dir]) => ({ id: scanRoots.length > 1 ? id : undefined, dir }))
      : [{ id: undefined, dir: repoRoot }];
  // git status --porcelain (XY format: column 1 = staged tier, column 2 = unstaged tier).
  for (const { id, dir } of targets) {
    try {
      const { stdout } = await execp("git status --porcelain", {
        cwd: dir,
        maxBuffer: 256 * 1024,
      });
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        if (x !== " " && x !== "?") snapshot.stagedCount += 1;
        if (y !== " ") snapshot.unstagedCount += 1;
        const filePath = line.slice(3);
        if (snapshot.modifiedFiles.length < 50) {
          snapshot.modifiedFiles.push(id ? `${id}: ${filePath}` : filePath);
        }
      }
    } catch (err) {
      unreadable.push(`git status in ${dir}: ${readError(err)}`);
      trace(
        `work-driver: captureWorktreeSnapshot git status failed for ${dir}: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  // repoRoot's HEAD short SHA — the operator's checkout, NOT the feature
  // branch (see `branchTip` below for that).
  try {
    const { stdout } = await execp("git rev-parse --short HEAD", { cwd: repoRoot });
    snapshot.repoRootHeadSha = stdout.trim();
  } catch (err) {
    unreadable.push(`git rev-parse HEAD in ${repoRoot}: ${readError(err)}`);
    trace(
      `work-driver: captureWorktreeSnapshot git rev-parse failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  if (branchName) {
    // Local branch existence. `--quiet` makes a missing ref exit 1 with no
    // output, so any OTHER failure (git could not run at all) is a failed
    // read rather than proof the branch was never created.
    try {
      // argv form: the branch name is never re-parsed by a shell.
      const { stdout } = await execp("git", {
        cwd: repoRoot,
        argv: ["rev-parse", "--verify", "--quiet", branchName],
      });
      snapshot.branchExists = true;
      // The branch's OWN tip. `repoRootHeadSha` above is repoRoot's checkout, which
      // the pre-handoff consolidation restores to where the operator was —
      // so a branch that had just received the cycle's commits was printed
      // as sitting at the base commit (#1286).
      const sha = stdout.trim();
      if (sha) snapshot.branchTip = { sha };
    } catch (err) {
      snapshot.branchExists = false;
      if ((err as { code?: unknown }).code !== 1) {
        unreadable.push(`git rev-parse --verify ${branchName}: ${readError(err)}`);
      }
    }
    // `baseSha` is read from the state file, so it is shape-checked before it
    // reaches git. An unusable base is recorded as unread, never guessed at.
    if (snapshot.branchTip && baseSha) {
      if (!COMMIT_SHA_SHAPE.test(baseSha)) {
        unreadable.push(
          `commits on ${branchName} ahead of base: base "${baseSha.slice(0, 40)}" is not a commit SHA`,
        );
      } else {
        try {
          const { stdout } = await execp("git", {
            cwd: repoRoot,
            argv: ["rev-list", "--count", `${baseSha}..${snapshot.branchTip.sha}`],
          });
          const ahead = Number.parseInt(stdout.trim(), 10);
          if (Number.isFinite(ahead)) snapshot.branchTip.ahead = ahead;
          else
            unreadable.push(
              `commits on ${branchName} ahead of base: unparseable output "${stdout.trim().slice(0, 40)}"`,
            );
        } catch (err) {
          unreadable.push(`commits on ${branchName} ahead of base: ${readError(err)}`);
        }
      }
    }
    // Remote tracking (best-effort; network may be down). 10s timeout
    // because ls-remote can hang on unreachable remotes (#1095: still 10s,
    // now enforced through runNetGit).
    try {
      const refProblem = netRefProblem(branchName);
      if (refProblem !== undefined) throw new Error(refProblem);
      const { stdout } = await runNetGit(execp, "git", {
        cwd: repoRoot,
        timeoutMs: 10_000,
        argv: ["ls-remote", "--heads", "origin", branchName],
      });
      snapshot.branchPushed = stdout.trim().length > 0;
    } catch {
      snapshot.branchPushed = false;
    }
  }
  if (unreadable.length > 0) snapshot.unreadable = unreadable;
  return snapshot;
}

/** One line of a failed git read, for `handoffSnapshot.unreadable`. */
export function readError(err: unknown): string {
  const e = err as Error & { stderr?: string };
  const text = `${e.stderr ?? ""}`.trim() || e.message || "unknown error";
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * The "this snapshot is not evidence" block, shared by every handoff surface.
 * Empty when every read succeeded. Names each recorded worktree with the
 * command that lists its commits and the one that attaches them to a branch,
 * since the driver could not establish either itself.
 */
export function unreadableSnapshotLines(ps: WorkState["pipelineState"]): string[] {
  const failed = ps.handoffSnapshot?.unreadable ?? [];
  if (failed.length === 0) return [];
  const wts = Object.entries(ps.worktrees ?? {});
  const range = ps.baseSha ? `${ps.baseSha.slice(0, 12)}..HEAD` : "-20";
  const branch = ps.branchName ?? "<branch>";
  return [
    `WORKTREE STATE NOT READ — ${failed.length} git read(s) failed, so the counts above are NOT evidence that no work or no branch exists:`,
    ...failed.slice(0, 5).map((f) => `  ${f}`),
    ...(wts.length > 0
      ? [
          "Developers commit on detached-HEAD worktrees; once git runs again, list each one's commits and attach them to a branch:",
          ...wts.flatMap(([id, wt]) => [
            `  git -C ${wt} log --oneline ${range}`,
            `  git -C ${wt} branch ${wts.length > 1 ? `${branch}-${id}` : branch} HEAD`,
          ]),
        ]
      : []),
  ];
}

/** A full or abbreviated commit SHA — the only shape a base may take before git. */
const COMMIT_SHA_SHAPE = /^[0-9a-f]{7,40}$/;

/**
 * The branch tip as every handoff surface prints it: "tip <sha8>, N commit(s)
 * ahead of base". An unknown distance is said to be unknown — never omitted or
 * shown as 0. `fmtSha` lets a surface wrap the short SHA (markdown backticks).
 */
export function branchTipText(
  tip: { sha: string; ahead?: number },
  fmtSha: (sha: string) => string = (sha) => sha,
): string {
  const ahead =
    tip.ahead === undefined
      ? "commits ahead of base unknown (NOT READ)"
      : `${tip.ahead} commit(s) ahead of base`;
  return `tip ${fmtSha(tip.sha.slice(0, 8))}, ${ahead}`;
}

/**
 * What the branch line says after the branch name: the feature branch's own
 * tip and its distance from the cycle's base. Falls back to repoRoot's HEAD,
 * labelled as such, for a state file written before `branchTip` existed or a
 * cycle that never created a branch.
 */
export function branchTipTag(
  snap: WorkState["pipelineState"]["handoffSnapshot"] | undefined,
): string {
  const tip = snap?.branchTip;
  if (tip) return ` · ${branchTipText(tip)}`;
  return snap?.repoRootHeadSha ? ` · repo-root HEAD ${snap.repoRootHeadSha}` : "";
}
