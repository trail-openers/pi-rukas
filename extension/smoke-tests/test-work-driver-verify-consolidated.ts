#!/usr/bin/env bun
/**
 * #669 — the develop gate must see the COMBINED tree.
 *
 * Cases 1–3: #669 (per-worktree pass/union fail, cross-dep, cherry-pick
 * conflict). #777's cases 4–6 and the #750/#669 cap cases live in
 * test-work-driver-verify-consolidated-cases.ts (the 500-line gate split);
 * this file owns the live-git cases and the shared fixture helpers (which
 * that file imports).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

// #1012 — empty glob list disables frontend-only classification (also
// for files that import this module).
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

export const realExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    e.stdout = e.stdout ?? "";
    e.stderr = e.stderr ?? (err as unknown as { stderr?: string }).stderr ?? "";
    throw e;
  }
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

export async function fixture(
  root: string,
  name: string,
  ids: string[],
  seed: Record<string, string>,
) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) writeFileSync(path.join(repo, rel), body);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
    worktrees[id] = wt;
  }
  // .pi/verify-cmd at the repo root — discovered by verifyCmdFor(repoRoot).
  const pi = path.join(repo, ".pi");
  mkdirSync(pi, { recursive: true });
  return { repo, baseSha, worktrees, originDir };
}

export function commitIn(wt: string, msg: string) {
  return execFileP("git", ["add", "."], { cwd: wt }).then(() =>
    execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }),
  );
}

// The live-git cases 1–3 below keep their own temp root; cases 4–6 and the
// #750/#669 cap cases live in test-work-driver-verify-consolidated-cases.ts
// (the 500-line gate split), which imports fixture/commitIn/realExec from
// here.
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-669-"));

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #1005 — the live-git cases 1–3 run ONLY when this file is the entrypoint;
// when imported (by test-work-driver-verify-consolidated-cases.ts for the
// shared fixture helpers), the top-level try/finally + process.exit must not
// fire, or the importing test's own cases would never run. `import.meta.main`
// is the correct primitive (Bun supports it; the pre-#1005
// `process.argv[1]` comparison was a workaround for Bun not exposing it).
const isEntry = import.meta.main;

if (isEntry) {
  try {
    // --------------------------------------------------------------- case 1
    // Per-worktree verify PASSES, consolidated verify FAILS (the #645 mirror).
    // A deletes helper.sh; B adds main.sh that references it. Verify cmd:
    // "helper exists OR caller doesn't" — passes alone, fails in the union.
    {
      const f = await fixture(root, "union-fails", ["a", "b"], {
        "helper.sh": "echo helper\n",
        "main.sh": "echo main\n",
      });
      // A: delete helper.sh. B: add a caller (rewrite main.sh to invoke helper).
      rmSync(path.join(f.worktrees.a, "helper.sh"));
      await commitIn(f.worktrees.a, "task-a: remove helper");
      writeFileSync(path.join(f.worktrees.b, "main.sh"), "sh ./helper.sh\n");
      await commitIn(f.worktrees.b, "task-b: call helper");

      const verifyCmd = "sh -c 'test -f helper.sh || [ ! -f main.sh ]'";
      writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${verifyCmd}\n`);

      let s = initialState(669, 1_000_000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          branchName: "feature/issue-669",
          baseSha: f.baseSha,
          worktrees: f.worktrees,
          workstreams: {
            a: { id: "a", scope: "remove helper", paths: [], outOfScope: [] },
            b: { id: "b", scope: "add caller", paths: [], outOfScope: [] },
          },
        },
      };
      const ctx: DriverContext = {
        pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
        repoRoot: f.repo,
        issue: 669,
        verifyExecFn: realExec,
      };
      const gate = await verifyStepOutcome(ctx, s, "develop");
      assert(!gate.ok, "#669 case 1: per-worktree passes, consolidated fails → NOT ok");
      assert(
        gate.failures.some((f) => /CONSOLIDATED tree/.test(f)),
        "#669 case 1: failure cites the CONSOLIDATED tree, not just a worktree",
      );
    }

    // --------------------------------------------------------------- case 2
    // #1005 — per-worktree fails, consolidated passes → NOT ok. The consolidated
    // pass does NOT excuse the per-worktree defect (the #669 downgrade is
    // reversed: a workstream that fails in its OWN tree must block, even when
    // the combined tree passes). The passing consolidated run is still
    // recorded in notes (the evidence that the combination is not the cause
    // is preserved; the per-worktree defect is not excused).
    // Per-worktree verify FAILS, consolidated verify PASSES (the #645 shape).
    {
      const f = await fixture(root, "cross-dep", ["a", "b"], {
        "lib.sh": "echo lib\n",
      });
      writeFileSync(path.join(f.worktrees.a, "util.sh"), "echo util\n");
      await commitIn(f.worktrees.a, "task-a: add util");
      writeFileSync(path.join(f.worktrees.b, "test-util.sh"), "cat util.sh\n");
      await commitIn(f.worktrees.b, "task-b: test reads util");
      writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "test -f util.sh\n");

      let s = initialState(669, 1_000_000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          branchName: "feature/issue-669",
          baseSha: f.baseSha,
          worktrees: f.worktrees,
          workstreams: {
            a: { id: "a", scope: "add util", paths: [], outOfScope: [] },
            b: { id: "b", scope: "test util", paths: [], outOfScope: [] },
          },
        },
      };
      const ctx: DriverContext = {
        pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
        repoRoot: f.repo,
        issue: 669,
        verifyExecFn: realExec,
      };
      const gate = await verifyStepOutcome(ctx, s, "develop");
      assert(
        !gate.ok,
        `#1005 (reverses #669 case 2): per-worktree fails, consolidated passes → NOT ok (the combined pass does not excuse the per-worktree defect; got failures: ${gate.failures.join("; ")})`,
      );
      assert(
        gate.notes.some((n) => /consolidated verify passed/.test(n)),
        "#1005 case 2: the passing consolidated run is still recorded in notes (evidence the combination is not the cause)",
      );
    }

    // --------------------------------------------------------------- case 3
    // Cherry-pick conflict: both workstreams edit the SAME line.
    {
      const f = await fixture(root, "conflict", ["a", "b"], {
        "shared.txt": "line1\nline2\nline3\n",
      });
      // Both workstreams edit line2 differently.
      writeFileSync(path.join(f.worktrees.a, "shared.txt"), "line1\nA says hi\nline3\n");
      await commitIn(f.worktrees.a, "task-a: edit line2");
      writeFileSync(path.join(f.worktrees.b, "shared.txt"), "line1\nB says hi\nline3\n");
      await commitIn(f.worktrees.b, "task-b: edit line2");

      writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "true\n");

      let s = initialState(669, 1_000_000);
      s = {
        ...s,
        pipelineState: {
          ...s.pipelineState,
          branchName: "feature/issue-669",
          baseSha: f.baseSha,
          worktrees: f.worktrees,
          workstreams: {
            a: { id: "a", scope: "edit line2 A", paths: [], outOfScope: [] },
            b: { id: "b", scope: "edit line2 B", paths: [], outOfScope: [] },
          },
        },
      };
      const ctx: DriverContext = {
        pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
        repoRoot: f.repo,
        issue: 669,
        verifyExecFn: realExec,
      };
      const gate = await verifyStepOutcome(ctx, s, "develop");
      assert(!gate.ok, "#669 case 3: cherry-pick conflict → NOT ok");
      assert(
        gate.failures.some((f) => /cherry-pick \/\*? ?apply conflict|could not combine/.test(f)),
        `#669 case 3: failure names the consolidation conflict (got: ${gate.failures.join("; ").slice(0, 200)})`,
      );

      // --------------------------------------------------------------- #750
      // Regression 1 — the abort VERIFIably leaves repoRoot clean.
      const { stdout: rootPorcelain } = await git(f.repo, ["status", "--porcelain"]);
      const trackedDirt = rootPorcelain.split("\n").filter((l) => l.trim() && !l.startsWith("??"));
      assert(
        trackedDirt.length === 0,
        `#750 regression 1: repoRoot is verifiably clean after the conflict abort (porcelain: ${JSON.stringify(trackedDirt)})`,
      );
      const { stdout: rootHead } = await git(f.repo, ["rev-parse", "HEAD"]);
      assert(
        rootHead.trim() === f.baseSha,
        "#750 regression 1: repoRoot is back on its original ref (scratch branch not left behind)",
      );

      // Regression 2 — the claim matches the VERIFIED post-condition.
      const conflictFailure = gate.failures.find((fl) =>
        /cherry-pick \/\*? ?apply conflict|could not combine/.test(fl),
      );
      assert(
        conflictFailure?.includes("verified restored"),
        `#750 regression 2: the conflict claim states the VERIFIED post-condition (got: ${conflictFailure?.slice(0, 240)})`,
      );
      assert(
        conflictFailure !== undefined && !/NOT restored/.test(conflictFailure),
        "#750 regression 2: a successful restore does not carry the loud not-restored failure",
      );

      // Untracked files must not be swept by the restore.
      const f2 = await fixture(root, "untracked-safety", ["a", "b"], {
        "shared.txt": "line1\nline2\nline3\n",
      });
      writeFileSync(path.join(f2.worktrees.a, "shared.txt"), "line1\nA says hi\nline3\n");
      await commitIn(f2.worktrees.a, "task-a: edit line2");
      writeFileSync(path.join(f2.worktrees.b, "shared.txt"), "line1\nB says hi\nline3\n");
      await commitIn(f2.worktrees.b, "task-b: edit line2");
      writeFileSync(path.join(f2.repo, ".pi", "verify-cmd"), "true\n");
      // Create the untracked file BEFORE the gate runs: it will trip the
      // dirty-root refusal (untracked IS dirt), and the file must survive
      // the refusal (the refusal parks, it does not stash or clean).
      writeFileSync(path.join(f2.repo, "untracked-keep.txt"), "deliberate\n");
      let s2 = initialState(669, 1_000_000);
      s2 = {
        ...s2,
        pipelineState: {
          ...s2.pipelineState,
          branchName: "feature/issue-669",
          baseSha: f2.baseSha,
          worktrees: f2.worktrees,
          workstreams: {
            a: { id: "a", scope: "edit line2 A", paths: [], outOfScope: [] },
            b: { id: "b", scope: "edit line2 B", paths: [], outOfScope: [] },
          },
        },
      };
      const ctx2: DriverContext = {
        pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
        repoRoot: f2.repo,
        issue: 669,
        verifyExecFn: realExec,
      };
      const gate2 = await verifyStepOutcome(ctx2, s2, "develop");
      // The gate must have hit the dirty-root refusal (untracked IS dirt).
      assert(
        gate2.failures.some((f) => /refused — repoRoot is dirty/.test(f)),
        `#750 regression 3: untracked file trips the dirty-root refusal (got: ${gate2.failures.join("; ").slice(0, 200)})`,
      );
      // The file survived the refusal: it was present during it (created
      // above, before the gate ran) and is still here.
      const { stdout: afterPorcelain } = await git(f2.repo, ["status", "--porcelain"]);
      assert(
        afterPorcelain
          .split("\n")
          .some((l) => l.startsWith("??") && l.includes("untracked-keep.txt")),
        "#750 regression 3: the untracked file SURVIVED the refusal (no git clean)",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (isEntry) {
  console.log(`\nexit ${exit}`);
  process.exit(exit);
}
