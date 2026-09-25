#!/usr/bin/env bun
/**
 * Smoke test for verifyConsolidation coverage rule (#540 + #778).
 *
 * Covers:
 *   F5.1-F5.4: Full-set subsumption rule (original #540 tests)
 *   F5.5: Declared path with planner annotation → covered (#744 false positive)
 *   F5.6: Renamed file (R-code source) → covered (#744 rename case)
 *   F5.7: #655 multi-workstream: one present, one absent → uncovered detected
 *   F5.8: Interior-paren filename through verifyConsolidation
 *
 * F5.9-F5.15 (#875 cumulative cases) live in
 * test-work-driver-verify-consolidation-875.ts (AGENTS.md §12 file-size limit).
 *
 * These use REAL git repos so `git diff --name-status -M origin/main..HEAD`
 * produces actual output (baseline commit = origin/main; committed files =
 * the feature-branch diff).
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

// Minimal ExtensionAPI stub — only the methods verifyConsolidation actually calls.
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
    await execp2("git add . && git commit -q -m baseline", {
      cwd: dir,
      shell: "/bin/bash",
    });
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
        worktrees: Object.fromEntries(
          Object.keys(workstreams).map((id) => [id, `/tmp/fake-${id}`]),
        ),
        workstreams,
      },
    };
    return s;
  };

  const wsA = (paths: string[]) => ({ id: "a", scope: "task-a", paths, outOfScope: [] });
  const wsB = (paths: string[]) => ({ id: "b", scope: "task-b", paths, outOfScope: [] });

  // #875 — a detached worktree at <dir>/<sub> of the repo, committed from
  // the recorded base (the workstream's own range base, mirroring the
  // driver's `git worktree add --detach` shape). Each worktree gets its
  // own index file so the porcelain read is isolated (linked worktrees
  // share the main repo's index, which would cross-contaminate the
  // porcelain read in the test fixture).
  const mkWorktree = async (dir: string, sub: string, files: string[]) => {
    const wtDir = path.join(dir, sub);
    await execp2(`git worktree add --detach ${JSON.stringify(wtDir)} HEAD`, {
      cwd: dir,
      shell: "/bin/bash",
    });
    // Isolate the index so this worktree's `git status` doesn't see the
    // main repo's or sibling worktrees' staged paths.
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
  const baseShaOf = async (dir: string) =>
    (await execp2("git rev-parse HEAD", { cwd: dir })).stdout.trim();

  // F5.1 + F5.2 — commit={a.ts,b.ts} → both covered (B's full set present,
  // A's own paths present) → no missing.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-covered-"));
    try {
      await mkGitRepo(dir, ["src/a.ts", "src/b.ts"]);
      const state = mkConsolidationState({
        a: wsA(["src/a.ts", "src/b.ts"]),
        b: wsB(["src/b.ts"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      assert(
        res.missing.length === 0,
        `F5.1/F5.2: both paths committed → both covered (got: ${JSON.stringify(res.missing)})`,
      );
      assert(
        JSON.stringify(res.filesPresent.sort()) === JSON.stringify(["src/a.ts", "src/b.ts"]),
        `F5.1: filesPresent records the committed file list (got: ${JSON.stringify(res.filesPresent)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.3 — commit={b.ts} only: B covered (own full set present), A NOT
  // covered (a.ts absent; B's full set {b.ts} does not cover a.ts).
  // Cap fires naming A — the false-pass direction must NOT be allowed.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-partial-"));
    try {
      await mkGitRepo(dir, ["src/b.ts"]);
      const state = mkConsolidationState({
        a: wsA(["src/a.ts", "src/b.ts"]),
        b: wsB(["src/b.ts"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      assert(
        res.missing.length === 1 && res.missing[0].id === "a",
        `F5.3: partial sibling cannot cover — A not covered (got: ${JSON.stringify(res.missing)})`,
      );
      assert(
        !res.missing.some((m) => m.id === "b"),
        "F5.3: B is covered (b.ts in diff) — not flagged missing",
      );
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "uncovered" &&
          JSON.stringify(aVerdict.uncoveredPaths) === JSON.stringify(["src/a.ts"]),
        `F5.3: A's verdict names exactly the uncovered path (got: ${JSON.stringify(aVerdict)})`,
      );
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "complete",
        `F5.3: B's verdict is complete (got: ${JSON.stringify(bVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.4 — empty diff → all workstreams missing.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-empty-"));
    try {
      await mkGitRepo(dir, []);
      const state = mkConsolidationState({
        a: wsA(["src/a.ts", "src/b.ts"]),
        b: wsB(["src/b.ts"]),
      });
      const res = await verifyConsolidation(
        { pi: makeFakePi().pi, repoRoot: dir, issue: 540 },
        state,
      );
      const ids = res.missing.map((m) => m.id).sort();
      assert(
        JSON.stringify(ids) === JSON.stringify(["a", "b"]),
        `F5.4: empty diff → all missing (got: ${JSON.stringify(ids)})`,
      );
      assert(res.filesPresent.length === 0, "F5.4: empty diff → empty filesPresent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.5 — declared path with planner annotation → covered (#744 false positive).
  // The declared path carries a trailing "(new)" annotation that normaliseDeclaredPath
  // strips. The file IS committed at the stripped path. The verifier must NOT report
  // it uncovered — that was the #744 false positive that parked the cycle.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-annotation-"));
    try {
      await mkGitRepo(dir, ["src/new-module.ts"]);
      const state = mkConsolidationState({
        a: wsA(["src/new-module.ts (new)"]),
        b: wsB(["src/other.ts"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "complete",
        `F5.5: declared path with "(new)" annotation is covered when file is present (got: ${JSON.stringify(aVerdict)})`,
      );
      assert(
        !res.missing.some((m) => m.id === "a"),
        "F5.5: no missing workstream for the annotated path",
      );
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "uncovered",
        `F5.5: B's genuinely-absent path is still uncovered (got: ${JSON.stringify(bVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.6 — renamed file → covered (the #744 rename case).
  // A declared path is renamed during develop/consolidation: the old name is
  // the SOURCE of an R### rename in `git diff --name-status -M`, the new name
  // is the TARGET. The declared (old) path must be reported covered because the
  // content shipped under the new name. The R-code source is NOT in filesPresent
  // (it no longer exists); only the target is.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-rename-"));
    try {
      // Set up a repo where the committed file is a RENAME of a baseline file.
      await execp2("git init -q", { cwd: dir });
      await execp2('git config user.email "t@t" && git config user.name "T"', {
        cwd: dir,
        shell: "/bin/bash",
      });
      // Baseline: the OLD name exists.
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "old-name.ts"), "original content\n");
      await fs.writeFile(path.join(dir, ".gitkeep"), "\n");
      await execp2("git add . && git commit -q -m baseline", { cwd: dir, shell: "/bin/bash" });
      await execp2("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
      await execp2("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
        cwd: dir,
      });
      await execp2("git checkout -qb feature/issue-540-test", { cwd: dir });
      // The developer renames the file (git mv → R100 in --name-status -M).
      await execp2("git mv src/old-name.ts src/new-name.ts", { cwd: dir, shell: "/bin/bash" });
      await execp2("git commit -q -m 'rename module'", { cwd: dir, shell: "/bin/bash" });

      const state = mkConsolidationState({
        a: wsA(["src/old-name.ts"]),
        b: wsB(["src/genuinely-absent.ts"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "complete",
        `F5.6: renamed file (R-code source) is covered (got: ${JSON.stringify(aVerdict)})`,
      );
      assert(!res.missing.some((m) => m.id === "a"), "F5.6: no missing for the renamed workstream");
      // B is genuinely absent → uncovered.
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "uncovered",
        `F5.6: genuinely-absent file is still uncovered (got: ${JSON.stringify(bVerdict)})`,
      );
      // The rename SOURCE (old name) must NOT be in filesPresent — it no
      // longer exists. Only the target (new name) shipped.
      assert(
        !res.filesPresent.includes("src/old-name.ts"),
        "F5.6: rename source is not in filesPresent (it was moved)",
      );
      assert(
        res.filesPresent.includes("src/new-name.ts"),
        `F5.6: rename target IS in filesPresent (got: ${JSON.stringify(res.filesPresent)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.7 — #655 multi-workstream: one workstream fully present, another
  // genuinely absent → the absent one is uncovered, the present one is not.
  // This is the false-NEGATIVE guard: the fix must not be so permissive that
  // co-located-but-different files count as covering a declared path.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-655-"));
    try {
      // Commit: only workstream A's files are present.
      await mkGitRepo(dir, ["src/measure2.ts", "src/measurement-report.md"]);
      const state = mkConsolidationState({
        a: wsA(["src/measure2.ts", "src/measurement-report.md"]),
        b: wsB(["src/measurement.ts", "src/report.json"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      // A is fully present → covered.
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "complete",
        `F5.7: workstream A (fully present) is covered (got: ${JSON.stringify(aVerdict)})`,
      );
      // B's files are genuinely absent → uncovered. Co-located files with
      // different names do NOT cover B's declared paths.
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "uncovered" &&
          JSON.stringify(bVerdict.uncoveredPaths) ===
            JSON.stringify(["src/measurement.ts", "src/report.json"]),
        `F5.7: workstream B (genuinely absent) is uncovered with both paths named (got: ${JSON.stringify(bVerdict)})`,
      );
      assert(
        res.missing.length === 1 && res.missing[0].id === "b",
        `F5.7: missing lists exactly B (got: ${JSON.stringify(res.missing)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // F5.8 — interior-paren filename through verifyConsolidation.
  // A declared path like "docs/notes (draft).md" has a parenthetical INSIDE
  // the filename — normaliseDeclaredPath must NOT strip it (only trailing
  // annotations are stripped). The file is committed at the literal path.
  // The verifier must report it covered, not mangle the name.
  {
    const dir = mkdtempSync(path.join(tmpdir(), "f5-interior-paren-"));
    try {
      // Manually create the repo with the interior-paren file committed.
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
      await fs.mkdir(path.join(dir, "docs"), { recursive: true });
      await fs.writeFile(path.join(dir, "docs", "notes (draft).md"), "content\n");
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src", "other.ts"), "other\n");
      await execp2("git add . && git commit -q -m 'add docs'", { cwd: dir, shell: "/bin/bash" });

      const state = mkConsolidationState({
        a: wsA(["docs/notes (draft).md"]),
        b: wsB(["src/absent.ts"]),
      });
      const ctx: DriverContext = { pi: makeFakePi().pi, repoRoot: dir, issue: 540 };
      const res = await verifyConsolidation(ctx, state);
      const aVerdict = res.verdicts.find((v) => v.id === "a");
      assert(
        aVerdict?.status === "complete",
        `F5.8: interior-paren filename is covered (not mangled by normalisation) (got: ${JSON.stringify(aVerdict)})`,
      );
      assert(
        res.filesPresent.includes("docs/notes (draft).md"),
        `F5.8: interior-paren filename appears intact in filesPresent (got: ${JSON.stringify(res.filesPresent)})`,
      );
      const bVerdict = res.verdicts.find((v) => v.id === "b");
      assert(
        bVerdict?.status === "uncovered",
        `F5.8: genuinely-absent sibling is still uncovered (got: ${JSON.stringify(bVerdict)})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
