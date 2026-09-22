#!/usr/bin/env bun
/**
 * #794 (task-a) — consolidation must pick each workstream's OWN commits,
 * never the ancestors'.
 *
 * The #775 reference case: a 4-deep STACK (A → B → C → D, each worktree
 * based on its dependency's tip, disjoint content) must consolidate cleanly
 * — the pre-#794 pick range (global baseSha..HEAD for every workstream)
 * replayed each ancestor two, three and four times and the driver reported
 * a "decomposition" conflict. With own-range selection (the range measured
 * against `workstreamBaseShas[id]`, the dependency's post-commit tip), each
 * workstream contributes exactly its own commits and the integrated diff
 * contains every workstream's change exactly once.
 *
 * Also covered: a stacked dependent with MULTIPLE own commits (all land,
 * not just the tip), the regression guard (two INDEPENDENT workstreams
 * editing the same line still produce the conflict cap + message), and the
 * cap/explain text for a stacked cycle (no "decomposition is incoherent"
 * / "re-split" diagnosis).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-794-"));

interface Fixture {
  repo: string;
  baseSha: string;
  /** workstream id → worktree path. */
  worktrees: Record<string, string>;
  /** workstream id → its own commit SHAs (in order, oldest first). */
  ownShas: Record<string, string[]>;
}

/**
 * Build a bare origin + repo + base commit. `stack` = dependency chain
 * (worktrees are each based on the PREVIOUS id's tip); `independent` =
 * every worktree at the base (the N-disjoint shape).
 */
async function fixture(name: string, stack: string[], independent: string[]): Promise<Fixture> {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: baseShaOut } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = baseShaOut.trim();
  const worktrees: Record<string, string> = {};
  const ownShas: Record<string, string[]> = {};
  let fromRef = baseSha;
  for (const id of [...independent, ...stack]) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "--detach", wt, fromRef]);
    worktrees[id] = wt;
    ownShas[id] = [];
    if (stack.includes(id)) {
      fromRef = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    }
  }
  return { repo, baseSha, worktrees, ownShas };
}

function commitIn(wt: string, file: string, body: string, msg: string): Promise<string> {
  writeFileSync(path.join(wt, file), body);
  return execFileP("git", ["add", "."], { cwd: wt })
    .then(() => execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }))
    .then(() => git(wt, ["rev-parse", "HEAD"]))
    .then((r) => r.stdout.trim());
}

function shaOf(cwd: string, ref: string): Promise<string> {
  return git(cwd, ["rev-parse", ref]).then((r) => r.stdout.trim());
}

try {
  // --------------------------------------------------------------- case 1
  // #775 reference: 4-deep stack, disjoint content. Consolidation must
  // succeed (no conflict) and each workstream's change lands exactly once.
  {
    const f = await fixture("stack4", ["a", "b", "c", "d"], []);
    const a1 = await commitIn(f.worktrees.a, "a.txt", "A\n", "task-a: add a");
    // B is based on A's tip: its own range is B's single commit only.
    await commitIn(f.worktrees.b, "b.txt", "B\n", "task-b: add b");
    await commitIn(f.worktrees.c, "c.txt", "C\n", "task-c: add c");
    await commitIn(f.worktrees.d, "d.txt", "D\n", "task-d: add d");
    f.ownShas = { a: [a1], b: [], c: [], d: [] };
    // Record every workstream's effective base: baseSha for A, the tip of
    // the previous workstream for the rest — exactly what the develop step
    // records in `workstreamBaseShas`.
    const baseShaOf: Record<string, string> = {};
    let prev = f.baseSha;
    for (const id of ["a", "b", "c", "d"]) {
      baseShaOf[id] = prev;
      prev = (await git(f.worktrees[id], ["rev-parse", "HEAD"])).stdout.trim();
    }
    const s = {
      ...initialState(794, 1_000_000),
      pipelineState: {
        ...initialState(794, 1_000_000).pipelineState,
        branchName: "feature/issue-794",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreamBaseShas: baseShaOf,
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [], dependsOn: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [], dependsOn: ["a"] },
          c: { id: "c", scope: "c", paths: [], outOfScope: [], dependsOn: ["b"] },
          d: { id: "d", scope: "d", paths: [], outOfScope: [], dependsOn: ["c"] },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 794,
      verifyExecFn: realExec,
    };
    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      workstreamBaseShas: baseShaOf,
      scratchDir: path.join(root, "scratch-1"),
      verifyCmd: "true",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "passed",
      `#794 case 1: stacked 4-deep consolidation PASSES (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    assert(
      cons.status === "passed" && cons.applied.length === 4,
      `#794 case 1: all four workstreams landed (applied: ${JSON.stringify(cons.status === "passed" ? cons.applied : cons)})`,
    );
    // The consolidated tree must contain every change exactly once. Prove it
    // by rebuilding the tree exactly like the pick does: base + own commits
    // in topological order. The integrated branch is gone (restored), so
    // rebuild a scratch ref from base + the own SHAs and diff it.
    const scratch = path.join(root, "case1-verify");
    await execFileP("git", ["clone", "-q", f.repo, scratch]);
    await git(scratch, ["checkout", "-q", "-B", "rebuild", f.baseSha]);
    for (const id of ["a", "b", "c", "d"]) {
      const shas = (
        await git(f.worktrees[id], ["rev-list", `--reverse`, `${baseShaOf[id]}..HEAD`])
      ).stdout
        .split("\n")
        .filter(Boolean);
      for (const sha of shas) await git(scratch, ["cherry-pick", "--quiet", sha]);
    }
    const names = (await git(scratch, ["diff", "--name-only", f.baseSha, "HEAD"])).stdout
      .split("\n")
      .filter(Boolean)
      .sort();
    assert(
      JSON.stringify(names) === JSON.stringify(["a.txt", "b.txt", "c.txt", "d.txt"]),
      `#794 case 1: the integration contains exactly a.txt b.txt c.txt d.txt once each (got: ${JSON.stringify(names)})`,
    );
    await git(f.repo, ["worktree", "prune"]);
    await rmSync(scratch, { recursive: true, force: true });
  }

  // --------------------------------------------------------------- case 2
  // Regression guard: two INDEPENDENT workstreams editing the SAME line
  // must STILL produce the conflict status (the fix changes which commits
  // are selected, not whether genuine conflicts fail).
  {
    const f = await fixture("indep-conflict", [], ["a", "b"]);
    await commitIn(f.worktrees.a, "shared.txt", "line1\nA says hi\nline3\n", "task-a: edit line2");
    await commitIn(f.worktrees.b, "shared.txt", "line1\nB says hi\nline3\n", "task-b: edit line2");
    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      workstreamBaseShas: { a: f.baseSha, b: f.baseSha },
      scratchDir: path.join(root, "scratch-2"),
      verifyCmd: "true",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "conflict",
      `#794 case 2: independent same-line conflict STILL fails (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    // The gate's failure text must still carry the router-matched phrase.
    const s = {
      ...initialState(794, 1_000_000),
      pipelineState: {
        ...initialState(794, 1_000_000).pipelineState,
        branchName: "feature/issue-794",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [] },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 794,
      verifyExecFn: realExec,
    };
    mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "true\n");
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(!gate.ok, "#794 case 2: the develop gate fails");
    assert(
      gate.failures.some((x) =>
        /cherry-pick \/\*? ?apply conflict|could not combine the workstreams/.test(x),
      ),
      `#794 case 2: the failure carries the router-matched conflict phrase (got: ${gate.failures.join("; ").slice(0, 200)})`,
    );
    // The independent case MAY still call the overlap a decomposition
    // problem (that prose is only wrong for a stack).
  }

  // --------------------------------------------------------------- case 3
  // A stacked dependent with MULTIPLE own commits: all of them land, not
  // just the tip (the "always pick tips only" fix is wrong).
  {
    const f = await fixture("stack-multi", ["a", "b"], []);
    const a1 = await commitIn(f.worktrees.a, "a.txt", "A\n", "task-a: add a");
    const b1 = await commitIn(f.worktrees.b, "b1.txt", "B1\n", "task-b: add b1");
    const b2 = await commitIn(f.worktrees.b, "b2.txt", "B2\n", "task-b: add b2");
    const baseShaOf: Record<string, string> = { a: f.baseSha, b: a1 };
    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      workstreamBaseShas: baseShaOf,
      scratchDir: path.join(root, "scratch-3"),
      verifyCmd: "true",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "passed" && cons.applied.length === 2,
      `#794 case 3: stacked dependent with 2 own commits PASSES (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    const scratch = path.join(root, "case3-verify");
    await execFileP("git", ["clone", "-q", f.repo, scratch]);
    await git(scratch, ["checkout", "-q", "-B", "rebuild", f.baseSha]);
    const aShas = (
      await git(f.worktrees.a, ["rev-list", "--reverse", `${baseShaOf.a}..HEAD`])
    ).stdout
      .split("\n")
      .filter(Boolean);
    const bShas = (
      await git(f.worktrees.b, ["rev-list", "--reverse", `${baseShaOf.b}..HEAD`])
    ).stdout
      .split("\n")
      .filter(Boolean);
    assert(
      bShas.length === 2,
      `#794 case 3: the dependent's own range has 2 commits (got ${bShas.length})`,
    );
    for (const sha of [...aShas, ...bShas]) await git(scratch, ["cherry-pick", "--quiet", sha]);
    const names = (await git(scratch, ["diff", "--name-only", f.baseSha, "HEAD"])).stdout
      .split("\n")
      .filter(Boolean)
      .sort();
    assert(
      JSON.stringify(names) === JSON.stringify(["a.txt", "b1.txt", "b2.txt"]),
      `#794 case 3: ALL of the dependent's commits landed (got: ${JSON.stringify(names)})`,
    );
    await rmSync(scratch, { recursive: true, force: true });
  }

  // --------------------------------------------------------------- case 4
  // A dependent with ZERO own commits (a workstream that declared a
  // dependency but produced nothing): it must not contribute, not error,
  // and the independent ancestor's work still lands.
  {
    const f = await fixture("stack-empty", ["a", "b"], []);
    await commitIn(f.worktrees.a, "a.txt", "A\n", "task-a: add a");
    const aHead = (await git(f.worktrees.a, ["rev-parse", "HEAD"])).stdout.trim();
    const baseShaOf: Record<string, string> = { a: f.baseSha, b: aHead };
    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      workstreamBaseShas: baseShaOf,
      scratchDir: path.join(root, "scratch-4"),
      verifyCmd: "true",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "passed",
      `#794 case 4: empty dependent contributes nothing, consolidation passes (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    assert(
      cons.status === "passed" && cons.applied.length === 1 && cons.applied[0] === "a",
      `#794 case 4: only the ancestor's work landed (applied: ${JSON.stringify(cons.status === "passed" ? cons.applied : cons)})`,
    );
  }

  // --------------------------------------------------------------- case 5
  // The explainCap text for a STACKED cycle must not assert "the
  // decomposition is incoherent" / "re-split the work" (the #775
  // misdiagnosis); the independent case keeps its existing text.
  {
    const stackedState = {
      ...initialState(794, 1_000_000),
      pipelineState: {
        ...initialState(794, 1_000_000).pipelineState,
        worktrees: { a: "/w/a", b: "/w/b" },
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [], dependsOn: ["a"] },
        },
      },
    };
    stackedState.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: "cherry-pick conflict — two workstreams edited the same lines",
    });
    const stackedText = explainCap("consolidated-verify-conflict", stackedState);
    assert(
      !/decomposition is incoherent/.test(stackedText),
      `#794 case 5: stacked cap text does NOT assert "the decomposition is incoherent" (got: ${stackedText.slice(0, 200)})`,
    );
    assert(
      !/re-split the work into non-overlapping/.test(stackedText),
      `#794 case 5: stacked cap text does NOT tell the operator to re-split`,
    );
    assert(
      /stacked|dependency/.test(stackedText),
      `#794 case 5: stacked cap text names the stack (got: ${stackedText.slice(0, 200)})`,
    );

    const indepState = {
      ...initialState(794, 1_000_000),
      pipelineState: {
        ...initialState(794, 1_000_000).pipelineState,
        worktrees: { a: "/w/a", b: "/w/b" },
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [] },
        },
      },
    };
    indepState.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-conflict",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: "cherry-pick conflict — two workstreams edited the same lines",
    });
    const indepText = explainCap("consolidated-verify-conflict", indepState);
    assert(
      /combined|overlap/.test(indepText),
      `#794 case 5: independent cap text still explains the overlap (got: ${indepText.slice(0, 200)})`,
    );
  }

  // --------------------------------------------------------------- case 6
  // Pre-#679 state (no workstreamBaseShas map at all): consolidation must
  // fall back to the global baseSha — byte-identical to the pre-#794
  // behaviour for the N-disjoint case.
  {
    const f = await fixture("n1-fallback", [], ["default"]);
    await commitIn(f.worktrees.default, "x.txt", "X\n", "task: add x");
    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      // no workstreamBaseShas — the pre-#679 shape.
      scratchDir: path.join(root, "scratch-6"),
      verifyCmd: "true",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "passed" && cons.applied.length === 1,
      `#794 case 6: no workstreamBaseShas → baseSha fallback still works (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
