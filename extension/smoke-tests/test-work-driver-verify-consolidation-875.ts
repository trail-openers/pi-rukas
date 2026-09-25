#!/usr/bin/env bun
/**
 * #875 — cumulative "touched by the workstream" evidence for
 * verifyConsolidation. Split from test-work-driver-verify-consolidation.ts
 * (AGENTS.md §12 file-size limit).
 *
 * Covers:
 *   F5.9:  N=1 short-circuit (regression — #875 must not relax it)
 *   F5.10: over-declaration (range + porcelain clean, committed diff lacks
 *          the path) → complete, no cap input (the #799 shape)
 *   F5.11: range touches the path but the committed diff lacks it →
 *          uncovered (a dropped slice, not an over-declaration)
 *   F5.12: porcelain-only (modified + untracked) → uncovered
 *   F5.13: unreadable worktree → uncovered (never a silent pass)
 *   F5.14: own range base (workstreamBaseShas) — an ancestor's file does
 *          not taint the dependent's verdict
 *   F5.15: dirty-flag rendering — explainCap reads ONLY the persisted
 *          per-verdict `dirty` flag (no git calls at render time)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { verifyConsolidation } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

process.env.PI_ENSEMBLE_VERIFY = "1";

{
  const fs = await import("node:fs/promises");
  const { exec: execChild } = await import("node:child_process");
  const { promisify: promisifyUtil } = await import("node:util");
  const execp2 = promisifyUtil(execChild);

  const mkGitRepo = async (dir: string, committedFiles: string[]) => {
    await execp2("git init -q", { cwd: dir });
    await execp2('git config user.email "t@t" && git config user.name "T"', {
      cwd: dir,
      shell: "/bin/bash",
    });
    await fs.writeFile(path.join(dir, ".gitkeep"), "\n");
    await execp2("git add . && git commit -q -m baseline", { cwd: dir, shell: "/bin/bash" });
    await execp2("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
    await execp2("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: dir,
    });
    await execp2("git checkout -qb feature/issue-540-test", { cwd: dir });
    for (const f of committedFiles) {
      const fp = path.join(dir, f);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, `content of ${f}\n`);
    }
    if (committedFiles.length > 0) {
      await execp2("git add . && git commit -q -m 'committed work'", {
        cwd: dir,
        shell: "/bin/bash",
      });
    }
  };

  const mkConsolidationState = (
    workstreams: Record<string, WorkState["pipelineState"]["workstreams"][string]>,
  ) => {
    let s = initialState(540, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-540-test",
        worktrees: Object.fromEntries(Object.keys(workstreams).map((id) => [id, `/tmp/fake-${id}`])),
        workstreams,
      },
    };
    return s;
  };

  const wsA = (paths: string[]) => ({ id: "a", scope: "task-a", paths, outOfScope: [] });
  const wsB = (paths: string[]) => ({ id: "b", scope: "task-b", paths, outOfScope: [] });

  // A detached worktree at <dir>/<sub> with its own index file (linked
  // worktrees share the main repo's index, which would cross-contaminate
  // the porcelain read).
  const mkWorktree = async (dir: string, sub: string, files: string[]) => {
    const wtDir = path.join(dir, sub);
    await execp2(`git worktree add --detach ${JSON.stringify(wtDir)} HEAD`, {
      cwd: dir,
      shell: "/bin/bash",
    });
    const idx = path.join(wtDir, ".git-standalone-index");
    await execp2(`GIT_INDEX_FILE=${JSON.stringify(idx)} git read-tree HEAD`, {
      cwd: wtDir,
      shell: "/bin/bash",
    });
    if (files.length > 0) {
      for (const f of files) {
        const fp = path.join(wtDir, f);
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, `worktree content of ${f}\n`);
      }
      await execp2(
        `GIT_INDEX_FILE=${JSON.stringify(idx)} git add -A && GIT_INDEX_FILE=${JSON.stringify(idx)} git commit -q -m 'worktree commit'`,
        { cwd: wtDir, shell: "/bin/bash" },
      );
    }
    return wtDir;
  };
  const baseShaOf = async (dir: string) => (await execp2("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  const ctx = (dir: string): DriverContext => ({ pi: makeFakePi().pi, repoRoot: dir, issue: 540 });

  // F5.9 — N=1 short-circuit (regression: the #875 cumulative read must not
  // relax the structural unverifiability of single-workstream cycles).
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-n1-"));
    try {
      await mkGitRepo(dir, ["src/a.ts"]);
      const state = mkConsolidationState({ a: wsA(["src/genuinely-absent.ts"]) });
      const res = await verifyConsolidation(ctx(dir), state);
      assert(
        res.missing.length === 0 && res.verdicts.length === 0,
        `F5.9: N=1 short-circuits to empty (got: ${JSON.stringify(res.missing)} / ${JSON.stringify(res.verdicts)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.10 — over-declaration (the #799 shape): workstream b declares
  // src/keep-green.ts; its worktree range and porcelain never touch it,
  // and the committed diff lacks it → complete (no cap-hit input).
  // Workstream a's genuinely-absent path stays uncovered (unreadable
  // worktree → fail closed).
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-overdecl-"));
    try {
      await mkGitRepo(dir, ["src/a.ts"]);
      const base = await baseShaOf(dir);
      const wtB = await mkWorktree(dir, "wt-b", []);
      const state = mkConsolidationState({
        a: wsA(["src/a.ts", "src/gone.ts"]),
        b: wsB(["src/keep-green.ts"]),
      });
      state.pipelineState.worktrees = { a: "/tmp/fake-a-unreadable", b: wtB };
      state.pipelineState.baseSha = base;
      const res = await verifyConsolidation(ctx(dir), state);
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "complete",
        `F5.10: over-declaration passes — b is complete (got: ${JSON.stringify(bVerdict)})`,
      );
      assert(!res.missing.some((m) => m.id === "b"), "F5.10: no cap-hit input for b");
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "uncovered" && aVerdict.uncoveredPaths.includes("src/gone.ts"),
        `F5.10: a's genuinely-absent path still uncovered (got: ${JSON.stringify(aVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.11 — cumulative catches a dropped slice: the workstream's committed
  // RANGE touches src/p.ts (committed in the worktree) but the integration
  // diff lacks it → uncovered.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-cumdrop-"));
    try {
      await mkGitRepo(dir, ["src/other.ts"]);
      const base = await baseShaOf(dir);
      const wtA = await mkWorktree(dir, "wt-a", ["src/p.ts"]);
      const state = mkConsolidationState({ a: wsA(["src/p.ts"]), b: wsB(["src/other.ts"]) });
      state.pipelineState.worktrees = { a: wtA, b: "/tmp/fake-b" };
      state.pipelineState.baseSha = base;
      const res = await verifyConsolidation(ctx(dir), state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "uncovered" && aVerdict.uncoveredPaths.includes("src/p.ts"),
        `F5.11: range-touched path absent from committed diff → uncovered (got: ${JSON.stringify(aVerdict)})`,
      );
      assert(res.missing.some((m) => m.id === "a"), "F5.11: a is in missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.12 — porcelain-only: P exists only as a MODIFIED tracked file and an
  // UNTRACKED new file in the worktree (nothing committed in the range,
  // nothing in the integration diff) → uncovered.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-porcelain-"));
    try {
      await mkGitRepo(dir, ["src/other.ts"]);
      const base = await baseShaOf(dir);
      const wtA = await mkWorktree(dir, "wt-a", []);
      await fs.mkdir(path.join(wtA, "src"), { recursive: true });
      await fs.writeFile(path.join(wtA, ".gitkeep"), "modified baseline\n");
      await fs.writeFile(path.join(wtA, "src/p.ts"), "untracked new file\n");
      const state = mkConsolidationState({ a: wsA(["src/p.ts"]), b: wsB(["src/other.ts"]) });
      state.pipelineState.worktrees = { a: wtA, b: "/tmp/fake-b" };
      state.pipelineState.baseSha = base;
      const res = await verifyConsolidation(ctx(dir), state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "uncovered" && aVerdict.uncoveredPaths.includes("src/p.ts"),
        `F5.12: porcelain-only path → uncovered (got: ${JSON.stringify(aVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.13 — unreadable worktree: the worktree path in state does not exist
  // (the /tmp/fake-<id> stub shape) → the cumulative read fails → treated
  // as touched → uncovered. A worktree the driver cannot read never passes
  // as over-declaration.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-unreadable-"));
    try {
      await mkGitRepo(dir, ["src/other.ts"]);
      const base = await baseShaOf(dir);
      const state = mkConsolidationState({ a: wsA(["src/p.ts"]), b: wsB(["src/other.ts"]) });
      state.pipelineState.worktrees = { a: "/tmp/fake-a-nonexistent", b: "/tmp/fake-b" };
      state.pipelineState.baseSha = base;
      const res = await verifyConsolidation(ctx(dir), state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "uncovered" && aVerdict.uncoveredPaths.includes("src/p.ts"),
        `F5.13: unreadable worktree → uncovered, never a silent pass (got: ${JSON.stringify(aVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.14 — own range base: workstream b's worktree is based on a (recorded
  // in workstreamBaseShas) and b declares src/p.ts — a file that IS in a's
  // range but NOT in b's own range. The cumulative read must use
  // workstreamBaseShas[b], not the global baseSha (the #794 stacked
  // shape): b's own range + porcelain are both clean, and the committed
  // diff lacks the file, so b is complete.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-ownbase-"));
    try {
      await mkGitRepo(dir, ["src/p.ts"]);
      const base = await baseShaOf(dir);
      const wtA = await mkWorktree(dir, "wt-a", ["src/p.ts"]);
      const tipA = await baseShaOf(wtA);
      await mkWorktree(dir, "wt-b", []);
      const state = mkConsolidationState({ a: wsA(["src/p.ts"]), b: wsB(["src/p.ts"]) });
      state.pipelineState.worktrees = { a: wtA, b: path.join(dir, "wt-b") };
      state.pipelineState.baseSha = base;
      state.pipelineState.workstreamBaseShas = { a: base, b: tipA };
      const res = await verifyConsolidation(ctx(dir), state);
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "complete",
        `F5.14: own range base — ancestor's file does not taint b (got: ${JSON.stringify(bVerdict)})`,
      );
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "complete",
        `F5.14: a is covered via the committed diff (got: ${JSON.stringify(aVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.15 — dirty-flag rendering: explainCap reads ONLY the persisted
  // per-verdict `dirty` flag. dirty=false → no "uncommitted on disk"
  // claim (cherry-pick recovery offered). dirty=true → the claim is
  // present. Legacy verdicts (no flag) keep the old wording.
  {
    const mkState = (verdicts: unknown) => {
      let s = initialState(875, 1_000_000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          worktrees: { b: "/tmp/fake-b" },
          incompleteConsolidation: { verdicts, filesPresent: [] },
        },
      };
      return s;
    };
    const cap = "commit-pr-incomplete-consolidation" as const;
    const uncovered = (dirty?: boolean) => [
      { id: "b", status: "uncovered", uncoveredPaths: ["src/keep-green.ts"], ...(dirty !== undefined ? { dirty } : {}) },
    ];
    const dirtyFalse = explainCap(cap, mkState(uncovered(false)));
    assert(!dirtyFalse.includes("uncommitted on disk"), "F5.15: dirty=false → no claim present");
    assert(dirtyFalse.includes("cherry-pick"), "F5.15: dirty=false → cherry-pick recovery offered");
    const dirtyTrue = explainCap(cap, mkState(uncovered(true)));
    assert(dirtyTrue.includes("uncommitted on disk"), "F5.15: dirty=true → the claim is present");
    const legacy = explainCap(cap, mkState(uncovered()));
    assert(
      legacy.includes("uncommitted on disk"),
      "F5.15: legacy verdict (no dirty flag) keeps the old wording",
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
