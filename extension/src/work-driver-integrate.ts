/**
 * work-driver-integrate — #287 Part B: the ONLY path that writes to repoRoot.
 *
 * Under always-worktree, development happens in `.worktrees/issue-<N>-<id>`
 * and repoRoot is an integration point. Every workstream's slice reaches the
 * feature branch through `integrate()`: stage in the worktree, capture the
 * staged diff, apply it onto the branch at repoRoot, commit, push.
 *
 * Concentrating repoRoot mutation here is what makes #287's acceptance
 * criterion checkable — "no git command with cwd === repoRoot between branch
 * and commit-pr" is a property of the call graph, not a convention.
 *
 * Two callers, two modes:
 *   - "create"   — commit-pr. `checkout -B <branch> <baseSha>` first, so the
 *                  branch is born at the base the worktrees were cut from
 *                  rather than at whatever repoRoot's HEAD happened to be.
 *   - "followup" — lens-fix re-integration (#287 Part C). Stays on the branch
 *                  and adds a commit. Pre-#287 lens-fix edits were made in a
 *                  worktree and nothing ever pushed them, so they never
 *                  reached the PR — a latent bug this structure removes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { stagePorcelainPaths } from "./work-driver-stage.ts";
import type { WorkState } from "./workflow-state-schema.ts";
import type { ExecFn } from "./worktree.ts";

/**
 *
 * Lives here rather than in work-driver-commit.ts so the branch step can read
 * it without importing the commit module — that edge would close an import
 * cycle (#356 flags the same shape).
 */
/**
 * #289 — serialise every operation that touches repoRoot's checkout, index or
 * HEAD.
 *
 * `integrate()` below mutates all three. Two concurrent groups doing that
 * corrupt each other in ways that are silent rather than loud:
 *
 *   - `checkout -B` carries a dirty index ACROSS branches, so B's applied-but-
 *     uncommitted slice moves onto A's branch and A's commit ships B's code
 *     under A's `Fixes #N`;
 *   - `git apply --index` contends on `index.lock` and surfaces as a phantom
 *     "patch conflict", routing a healthy group to handoff;
 *   - `git rev-parse HEAD` after the commit can read a SIBLING's commit, and
 *     the worktree `reset --hard` that follows then destroys this group's work.
 *
 * Two layers, because one Pi process is not the whole story: `/work` is
 * fire-and-forget and `ctx.isIdle()` reports idle immediately after launch, so
 * a second `/work` — or a second Pi process on the same clone — can already
 * race today. The promise chain is the fast path within a process; the
 * lockfile is the cross-process backstop.
 */
let integrationChain: Promise<unknown> = Promise.resolve();

/** How long a lockfile may sit before it is presumed abandoned. */
const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "pi-ensemble-integration.lock");
}

async function acquireLockfile(repoRoot: string): Promise<() => Promise<void>> {
  const file = lockPath(repoRoot);
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      // `wx` is O_EXCL: the create itself is the atomic test-and-set.
      const fh = await fs.open(file, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return async () => {
        await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only .git, permissions). Fail
        // OPEN: the in-process chain still serialises this process, and
        // refusing to integrate would be a worse failure than a lock we
        // could not take.
        trace(`integration-lock: lockfile unavailable, continuing: ${(err as Error).message}`);
        return async () => undefined;
      }
      // Held. Sweep it if the holder is long gone, otherwise wait.
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as { at?: number };
        if (typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS) {
          trace("integration-lock: sweeping a stale lockfile");
          await fs.rm(file, { force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        // Unreadable/corrupt lock — treat as stale rather than deadlocking.
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        trace("integration-lock: waited past the stale window, proceeding");
        return async () => undefined;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Run `fn` holding the integration lock.
 *
 * The chain deliberately never inherits a prior rejection (`then(fn, fn)`) and
 * is re-armed with a swallowing `catch` — otherwise one failed integration
 * would poison every subsequent one for the life of the process.
 */
export function withIntegrationLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const run = integrationChain.then(
    () => guarded(repoRoot, fn),
    () => guarded(repoRoot, fn),
  );
  integrationChain = run.catch(() => undefined);
  return run;
}

async function guarded<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLockfile(repoRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Test seam: reset the in-process chain between fixtures. */
export function __resetIntegrationLock(): void {
  integrationChain = Promise.resolve();
}

/**
 * The issue title, from the body artifact the explore step cached. Used for
 * the deterministic branch slug and the commit/PR title. Falls back to
 * undefined so callers can supply their own generic text.
 */
export async function cachedIssueTitle(state: WorkState): Promise<string | undefined> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return undefined;
  try {
    const body = await fs.readFile(artifact, "utf8");
    return body.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export interface IntegrateOpts {
  repoRoot: string;
  branchName: string;
  /** Commit-ish the branch is created at. Required for mode "create". */
  baseSha?: string;
  worktrees: Record<string, string>;
  /** Where conflict patches are preserved for the operator. */
  scratchDir: string;
  commitTitle: string;
  commitBody: string;
  mode: "create" | "followup";
  /**
   * Fail if ANY workstream produced no diff, rather than consolidating the
   * rest. commit-pr sets this: a silently-skipped workstream is how
   * /work 577 shipped 1 of 3 slices and closed the issue with the root fix
   * missing (v0.12.13). Lens-fix leaves it off — a fix round legitimately
   * touches only the worktree that had findings.
   */
  requireAllNonEmpty?: boolean;
  /**
   * The project's verify command, run against the CONSOLIDATED tree between
   * the commit and the push.
   *
   * Every gate before this one saw a single workstream in isolation: the
   * develop gate ran inside one worktree, and adversarial reviewed one
   * worktree's diff. Nothing had ever compiled the combination — the first
   * build of the integrated tree happened at `ci`, after six lenses had
   * already spent up to two hours reviewing it. Two workstreams that each
   * verify alone can still fail together (one renames what the other calls),
   * and that failure is created BY integration, so integration is where it
   * has to be caught.
   *
   * Omitted (or absent from the project) means the check is skipped, exactly
   * as before — a project with no verify command is not newly blocked.
   */
  verifyCmd?: string;
  /** Executor for `verifyCmd`. Defaults to `execFn`; tests inject. */
  verifyExecFn?: ExecFn;
  /** Wall-clock for `verifyCmd`. */
  verifyTimeoutMs?: number;
}

/**
 * #492 — which worktrees produced no diff, keyed by workstream id.
 *
 * The value is the worktree path itself: that IS the git evidence an operator
 * inspects (`git -C <path> status`). Naming the exact path is what lets the
 * cap say "the fixer produced no diff in `<path>`" instead of "integration
 * failed or the fixer wrote nothing — pick one."
 */
export type NoDiff = Record<string, string>;

export type IntegrateResult =
  | {
      ok: true;
      workstreams: string[];
      empty: false;
      /** #492 — worktrees that were clean at stage time (the fixer/developer
       *  produced no diff there). Set only when at least one worktree was
       *  clean, so a caller can tell "this one wrote nothing" apart from the
       *  workstreams that did ship. */
      noDiff?: NoDiff;
    }
  /**
   * Nothing to integrate — every worktree was clean. Not an error.
   *
   * #492 — `noDiff` names the worktree(s) that produced no diff, so the
   *  lens-fix caller can surface "the fixer produced no diff in `<path>`"
   *  rather than collapsing it into the generic "integration failed" reading.
   */
  | { ok: true; workstreams: []; empty: true; noDiff: NoDiff }
  | {
      ok: false;
      reason: string;
      conflictPatch?: string;
      /**
       * Set when the CONSOLIDATED tree failed the project's verify command.
       * Callers must not launder this into a judgmental retry: the LLM
       * commit-pr fallback exists to absorb environment variance (an apply
       * conflict, a rejected push), and a tree that does not build is a
       * verdict. Treating them alike makes the gate one that cannot fail.
       */
      failure?: "verify";
    };

/**
 * Consolidate every worktree onto the feature branch at repoRoot.
 *
 * Fails rather than forces at every step. In particular the dirty-repoRoot
 * preflight (#283's gate, relocated here from the branch step) runs before
 * `checkout -B`, because that command would otherwise silently carry an
 * operator's uncommitted work onto the feature branch — the incident-#602
 * shape, where stale repoRoot residue was swept into a merged PR.
 */
export async function integrate(execFn: ExecFn, opts: IntegrateOpts): Promise<IntegrateResult> {
  const { repoRoot, branchName, worktrees, mode } = opts;
  const ids = Object.keys(worktrees);
  // Where repoRoot was before we touched it. A failed integration must put it
  // back: the previous code returned from inside the apply loop with the
  // checkout already switched and 0..N-1 workstreams already in the index, so
  // the operator found a half-applied feature branch and the NEXT cycle's
  // dirty-repoRoot preflight refused to run at all.
  let originalRef: string | undefined;
  const restoreRoot = async () => {
    if (!originalRef) return;
    try {
      await execFn("git reset --hard", { cwd: repoRoot, maxBuffer: 256 * 1024 });
      await execFn(`git checkout --force ${JSON.stringify(originalRef)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    } catch (err) {
      trace(
        `work-driver: integrate — could not restore repoRoot to ${originalRef}: ${(err as Error).message?.slice(0, 160)}`,
      );
    }
  };
  try {
    // 1. Preflight: repoRoot must be clean before we touch its checkout.
    const { stdout: rootStatus } = await execFn("git status --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
    // `.worktrees/` is the driver's own scaffolding, not operator residue.
    // `.git/info/exclude` normally hides it; this filter is the backstop for
    // when that write failed, because treating it as dirt would block every
    // integration forever.
    const rootDirt = rootStatus
      .split("\n")
      .filter((l) => l.trim() && !/^..\s+"?\.worktrees\//.test(l));
    if (rootDirt.length > 0) {
      const files = rootDirt
        .slice(0, 10)
        .map((l) => l.slice(3))
        .join(", ");
      return {
        ok: false,
        reason: `repo root has uncommitted changes, refusing to integrate onto ${branchName}: ${files}. Commit, stash, or discard them — integration would otherwise sweep them into the PR.`,
      };
    }

    // 2. Put repoRoot on the integration branch, remembering where it was.
    //    A detached HEAD has no symbolic ref, so fall back to the raw sha.
    originalRef = await execFn("git symbolic-ref --quiet --short HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    })
      .then((r) => r.stdout.trim())
      .catch(async () =>
        (await execFn("git rev-parse HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 })).stdout.trim(),
      );
    if (mode === "create") {
      if (!opts.baseSha) return { ok: false, reason: "baseSha is required to create a branch" };
      await execFn(
        `git checkout -B ${JSON.stringify(branchName)} ${JSON.stringify(opts.baseSha)}`,
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      );
    } else {
      await execFn(`git checkout ${JSON.stringify(branchName)}`, {
        cwd: repoRoot,
        maxBuffer: 256 * 1024,
      });
    }

    // 3. Transplant each worktree's slice. Staging inside the worktree first
    //    is what captures untracked new files — `git diff HEAD` alone misses
    //    them, which silently dropped whole files pre-PR19.
    const applied: string[] = [];
    // #492 — which worktrees produced no diff, keyed by workstream id. The
    // value is the worktree PATH: that is the git evidence an operator
    // inspects (`git -C <path> status`), and naming it is what lets the cap
    // say "the fixer wrote nothing in `<path>`" instead of "integration
    // failed or the fixer wrote nothing — pick one".
    const noDiff: NoDiff = {};
    for (const id of ids) {
      const wt = worktrees[id];
      if (!wt) continue;
      // Porcelain, not the staged diff, is the emptiness signal: it is what
      // says "this developer wrote nothing", and it is checked before any
      // staging so a worktree that produced no work is identified as such
      // rather than inferred from a diff that may be empty for other reasons.
      const staged = await stagePorcelainPaths(execFn, wt);
      if (staged === 0) {
        noDiff[id] = wt;
        if (opts.requireAllNonEmpty) {
          await restoreRoot();
          return {
            ok: false,
            reason: `worktree '${id}' has no uncommitted work — nothing to consolidate (developer may not have written). Refusing to ship a partial consolidation.`,
          };
        }
        trace(`work-driver: integrate — workstream '${id}' produced no diff, skipping`);
        continue;
      }
      // `--binary` is not optional: without it a blob is emitted as the
      // textual placeholder `Binary files a/x and b/x differ`, which
      // `git apply` refuses. One icon or fixture blob aborted the run.
      const { stdout: patch } = await execFn("git diff --cached --binary", {
        cwd: wt,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!patch.trim()) {
        if (opts.requireAllNonEmpty) {
          await restoreRoot();
          return { ok: false, reason: `worktree '${id}' staged diff came back empty` };
        }
        // Staged N paths yet the cached diff is empty — classify it as a
        // clean worktree rather than an integration error, for the same
        // reason as the `staged === 0` branch above.
        noDiff[id] = wt;
        continue;
      }
      const patchFile = path.join(opts.scratchDir, `integrate-${id}.patch`);
      await fs.mkdir(path.dirname(patchFile), { recursive: true });
      await fs.writeFile(patchFile, patch, "utf8");
      try {
        // `--3way` rather than a plain index apply. Worktrees share this
        // repo's object database, so the blobs a 3-way merge needs are always
        // present — and that is what lets two workstreams edit different
        // regions of one shared registry/barrel file. A plain `--index` apply
        // rejects the second patch outright, because the first workstream
        // already moved the context it expects. At N=10 workstreams that
        // collision is close to certain.
        await execFn(`git apply --3way --binary ${JSON.stringify(patchFile)}`, {
          cwd: repoRoot,
          maxBuffer: 1024 * 1024,
        });
      } catch (err) {
        const e = err as Error & { stderr?: string };
        // A 3-way apply that still fails is a genuine content conflict: two
        // workstreams changed the same lines. Stop here — the tree now holds
        // conflict markers, so attempting the rest would report conflicts
        // that are ours, not theirs — but say plainly what was skipped, and
        // put repoRoot back before returning.
        const notAttempted = ids.slice(ids.indexOf(id) + 1);
        await restoreRoot();
        const skipped =
          notAttempted.length > 0 ? ` Not attempted: ${notAttempted.join(", ")}.` : "";
        return {
          ok: false,
          reason:
            `git apply failed for workstream '${id}': ${(e.stderr ?? e.message ?? "").toString().trim().slice(0, 200)}.` +
            `${skipped} repoRoot restored to ${originalRef}.`,
          conflictPatch: patchFile,
        };
      }
      applied.push(id);
    }
    if (applied.length === 0) return { ok: true, workstreams: [], empty: true, noDiff };

    // 4. Commit.
    await execFn(
      `git commit -m ${JSON.stringify(opts.commitTitle)} -m ${JSON.stringify(opts.commitBody)}`,
      { cwd: repoRoot, maxBuffer: 256 * 1024 },
    );

    // 5. Verify the CONSOLIDATED tree before it becomes a PR. See `verifyCmd`.
    //    Rolling back on failure is safe: the worktrees still hold every
    //    workstream's staged work — they are only advanced past it after a
    //    successful push, below.
    if (opts.verifyCmd) {
      const verifyExec = opts.verifyExecFn ?? execFn;
      let failure: string | undefined;
      try {
        await verifyExec(opts.verifyCmd, {
          cwd: repoRoot,
          maxBuffer: 8 * 1024 * 1024,
          timeout: opts.verifyTimeoutMs,
        });
      } catch (err) {
        const e = err as Error & { stderr?: string; stdout?: string };
        failure = (e.stderr || e.stdout || e.message || "").toString().trim();
      }
      if (failure !== undefined) {
        await restoreRoot();
        return {
          ok: false,
          failure: "verify",
          reason:
            `the consolidated tree fails the project's verify command (\`${opts.verifyCmd}\`), so it was not pushed. ` +
            `Each workstream passed alone; the combination does not. Tail: ${failure.slice(-600)}`,
        };
      }
    }

    // 6. Push.
    await execFn(`git push -u origin ${JSON.stringify(branchName)}`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });

    // Advance each worktree to the commit its work just became.
    //
    // Without this the worktree keeps the slice staged, so the NEXT
    // integration re-captures the same patch — which either fails to apply
    // (already present) or re-commits stale content. That is precisely how a
    // lens-fix round would have silently shipped the pre-fix version.
    //
    // `reset --hard` is safe here specifically because everything porcelain
    // listed was staged and applied a moment ago: the commit is a superset of
    // the worktree's state, so nothing can be lost.
    const { stdout: newHead } = await execFn("git rev-parse HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    const headSha = newHead.trim();
    if (headSha) {
      for (const id of applied) {
        const wt = worktrees[id];
        if (!wt) continue;
        await execFn(`git reset --hard ${JSON.stringify(headSha)}`, {
          cwd: wt,
          maxBuffer: 256 * 1024,
        }).catch((err) =>
          trace(
            `work-driver: integrate — could not advance worktree '${id}' to ${headSha.slice(0, 8)}: ${(err as Error).message?.slice(0, 160)}`,
          ),
        );
      }
    }
    return {
      ok: true,
      workstreams: applied,
      empty: false,
      noDiff: Object.keys(noDiff).length > 0 ? noDiff : undefined,
    };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // Anything that threw mid-integration leaves the same half-applied tree a
    // conflict does, so it gets the same treatment.
    await restoreRoot();
    return {
      ok: false,
      reason: (e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300),
    };
  }
}
