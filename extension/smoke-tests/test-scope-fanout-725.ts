#!/usr/bin/env bun
/**
 * #725 — the plan step cross-declares each workstream's outOfScope as the
 * other workstreams' in-scope paths (the #572 contract), while the develop
 * scope fence evaluated that cross-declaration literally — so a dependsOn
 * cycle (the dependent's worktree built from the dependency's post-commit
 * SHA) failed its own fence on inherited, unmodified files.
 *
 * The fix has three parts, each pinned here:
 *
 *   1. The diff-collection loop diffs each workstream against its OWN
 *      effective base (`workstreamBaseShas`), not the cycle-global baseSha.
 *      A reconstructed #607 fixture (ws-viewer-steer's worktree created from
 *      ws-selectable's post-commit SHA) passes the fence when the dependent
 *      commits none of the dependency's files.
 *   2. The fence exempts a fenced path only when a `dependsOn` target
 *      declares it in its own `paths` (the cross-declaration carve-out).
 *      A sibling with NO dependsOn touching the other's file still fails —
 *      the collision-prevention true positive is retained.
 *   3. The consolidated-verify dirty-repoRoot refusal is routed to its own
 *      wording ("consolidated verify was refused — repoRoot is dirty"),
 *      distinct from the cherry-pick-conflict wording, so the
 *      `consolidated-verify-conflict` cap's regex does not swallow it.
 *
 * The #607 ground truth (who touched dispatch-deck.ts) is reconstructed from
 * the recorded state file's normalisedSpec + workstreamBaseShas shape — the
 * worktrees themselves are gone; see the AC's fixture-reconstruction note.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-725-"));

/**
 * A bare-origin + clone repo with a base commit and a detached worktree per
 * id (the #669 fixture shape). `seed` files are committed at the base.
 */
async function fixture(name: string, ids: string[], seed: Record<string, string>) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) {
    const p = path.join(repo, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
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
  const pi = path.join(repo, ".pi");
  mkdirSync(pi, { recursive: true });
  return { repo, baseSha, worktrees };
}

function writeRel(wt: string, rel: string, body: string) {
  const p = path.join(wt, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
}

function commitIn(wt: string, msg: string) {
  return git(wt, ["add", "."]).then(() => git(wt, ["commit", "-q", "-m", msg]));
}

try {
  // --------------------------------------------------------------- case 1
  // Reconstructed #607: two workstreams, cross-declared fences, dependsOn
  // chain. A commits deck.ts + test-deck.ts; B's worktree is created from
  // A's post-commit SHA; B commits ONLY its own paths. The global-baseSha
  // diff would have put deck.ts in B's changed set (inherited, unmodified)
  // and failed B's outOfScope fence. Under the fix: no fence failure.
  {
    const f = await fixture("607", ["ws-selectable", "ws-viewer-steer"], {
      "extension/src/deck.ts": "const deck = 1;\n",
      "extension/src/interactive.ts": "const inter = 1;\n",
    });
    // A: commits its declared paths (deck.ts + its test).
    writeRel(f.worktrees["ws-selectable"], "extension/src/deck.ts", "const deck = 2;\n");
    writeRel(
      f.worktrees["ws-selectable"],
      "extension/smoke-tests/test-deck.ts",
      "console.log('deck test');\n",
    );
    await commitIn(f.worktrees["ws-selectable"], "feat: selectable deck");
    const { stdout: aHead } = await git(f.worktrees["ws-selectable"], ["rev-parse", "HEAD"]);
    const aHeadSha = aHead.trim();

    // B: worktree created FROM A's post-commit SHA (the #679 dependent shape).
    const bWt = path.join(root, "607", "ws-viewer-steer-dependent");
    await git(f.repo, ["worktree", "add", "--detach", bWt, aHeadSha]);
    writeRel(bWt, "extension/src/interactive.ts", "const inter = 2;\n");
    await git(bWt, ["add", "."]);
    await git(bWt, ["commit", "-q", "-m", "feat: viewer steer"]);
    f.worktrees["ws-viewer-steer"] = bWt;

    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "true\n");

    let s = initialState(607, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-607",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        // #607's recorded shape (reconstructed): A's base = global baseSha,
        // B's base = A's post-commit SHA (B dependsOn A).
        workstreamBaseShas: { "ws-selectable": f.baseSha, "ws-viewer-steer": aHeadSha },
        workstreams: {
          "ws-selectable": {
            id: "ws-selectable",
            scope: "selectable deck rows",
            paths: ["extension/src/deck.ts", "extension/smoke-tests/test-deck.ts"],
            outOfScope: ["extension/src/interactive.ts"],
          },
          "ws-viewer-steer": {
            id: "ws-viewer-steer",
            scope: "viewer + steer",
            paths: ["extension/src/interactive.ts"],
            outOfScope: ["extension/src/deck.ts"],
            dependsOn: ["ws-selectable"],
          },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 607,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(
      gate.ok,
      `#607 fixture: both workstreams pass their own gate → consolidated develop OK (got: ${gate.failures.join("; ")})`,
    );
    assert(
      !gate.failures.some((fl) => /out-of-scope path/.test(fl)),
      `#607 fixture: the inherited deck.ts is not a fence hit (got: ${gate.failures.join("; ")})`,
    );
  }

  // --------------------------------------------------------------- case 2
  // The #679 true positive, unchanged: B commits a file its OWN outOfScope
  // fence names (and A also declares it — a real cross-workstream edit of
  // someone else's file). Still fails, with or without dependsOn.
  {
    const f = await fixture("fp", ["a", "b"], {
      "extension/src/deck.ts": "const deck = 1;\n",
      "extension/src/interactive.ts": "const inter = 1;\n",
    });
    writeRel(f.worktrees.a, "extension/src/deck.ts", "const deck = 2;\n");
    await commitIn(f.worktrees.a, "feat: a deck");
    const { stdout: aHead } = await git(f.worktrees.a, ["rev-parse", "HEAD"]);
    const aHeadSha = aHead.trim();
    // B's own commit touches deck.ts — its own fence's path.
    writeRel(f.worktrees.b, "extension/src/deck.ts", "const deck = 3;\n");
    await commitIn(f.worktrees.b, "feat: b edits deck");
    // Re-point B's recorded base at A's commit so the inherited diff is
    // empty; B's OWN commit still touches deck.ts → fence fires.
    const sBase = f.baseSha;
    let s = initialState(725, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-725",
        baseSha: sBase,
        worktrees: f.worktrees,
        workstreamBaseShas: { a: sBase, b: aHeadSha },
        workstreams: {
          a: {
            id: "a",
            scope: "deck",
            paths: ["extension/src/deck.ts"],
            outOfScope: ["extension/src/interactive.ts"],
          },
          b: {
            id: "b",
            scope: "interactive",
            paths: ["extension/src/interactive.ts"],
            outOfScope: ["extension/src/deck.ts"],
          },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 725,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(
      gate.failures.some((fl) =>
        /out-of-scope path extension\/src\/deck\.ts/.test(fl),
      ),
      `#679 true positive: a dependent's OWN commit touching a fenced path still fails (got: ${gate.failures.join("; ")})`,
    );
  }

  // --------------------------------------------------------------- case 3
  // The fanout gate in isolation: dependsOn-gated exemption.
  const aFence = {
    id: "a",
    scope: "deck",
    paths: ["extension/src/deck.ts"],
    outOfScope: ["extension/src/interactive.ts"],
  };
  const bDep = {
    id: "b",
    scope: "interactive",
    paths: ["extension/src/interactive.ts"],
    outOfScope: ["extension/src/deck.ts"],
    dependsOn: ["a"],
  };
  const bNoDep = { ...bDep, dependsOn: undefined };
  const changed = new Map([
    ["a", new Set(["extension/src/deck.ts"])],
    ["b", new Set(["extension/src/deck.ts"])],
  ]);
  {
    // dependsOn present + a declares deck.ts → exempt.
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate({ a: aFence, b: bDep }, changed, failures, notes);
    assert(
      !failures.some((fl) => /out-of-scope path/.test(fl)),
      `fanout: dependsOn-gated exemption — a fenced path a dependency declares in paths is not a fence hit (got: ${failures.join("; ")})`,
    );
  }
  {
    // No dependsOn → the same shape still fails (collision prevention).
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate({ a: aFence, b: bNoDep }, changed, failures, notes);
    assert(
      failures.some((fl) => /out-of-scope path extension\/src\/deck\.ts/.test(fl)),
      `fanout: independent sibling touching the other's path still fails (got: ${failures.join("; ")})`,
    );
  }
  {
    // dependsOn present but the dependency does NOT declare the path → no
    // blanket exemption; still fails.
    const aNoDecl = { ...aFence, paths: ["extension/src/other.ts"] };
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate({ a: aNoDecl, b: bDep }, changed, failures, notes);
    assert(
      failures.some((fl) => /out-of-scope path extension\/src\/deck\.ts/.test(fl)),
      `fanout: exemption requires the dependency to DECLARE the path in its own paths (got: ${failures.join("; ")})`,
    );
  }
  {
    // N=1 default workstream: unchanged semantics (empty fence, empty diff).
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "x", paths: ["a.ts"], outOfScope: [] } },
      new Map([["default", new Set(["a.ts", "b.ts"])] as [string, Set<string>] as [string, Set<string>]]),
      failures,
      notes,
    );
    assert(
      !failures.some((fl) => /out-of-scope path/.test(fl)),
      `fanout: N=1 with empty outOfScope is unaffected (got: ${failures.join("; ")})`,
    );
  }
  {
    // N=1 with a declared fence still fires (no accidental widening).
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "x", paths: ["a.ts"], outOfScope: ["b.ts"] } },
      new Map([["default", new Set(["b.ts"])] as [string, Set<string>] as [string, Set<string>]]),
      failures,
      notes,
    );
    assert(
      failures.some((fl) => /out-of-scope path b\.ts/.test(fl)),
      `fanout: N=1 declared fence still fires (got: ${failures.join("; ")})`,
    );
  }

  // --------------------------------------------------------------- case 4
  // Dirty repoRoot: the consolidated-verify preflight refusal must not
  // match the `consolidated-verify-conflict` cap's regex (cherry-pick /
  // apply conflict wording) — it gets its own wording.
  {
    const f = await fixture("dirty", ["a", "b"], {
      "extension/src/one.ts": "const one = 1;\n",
    });
    writeRel(f.worktrees.a, "extension/src/one.ts", "const one = 2;\n");
    await commitIn(f.worktrees.a, "feat: a one");
    // Dirty the repo root — residue from a prior cycle.
    writeFileSync(path.join(f.repo, "leftover.ts"), "const old = 1;\n");

    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), "true\n");
    let s = initialState(725, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-725",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreams: {
          a: { id: "a", scope: "one", paths: ["extension/src/one.ts"], outOfScope: [] },
          b: { id: "b", scope: "none", paths: [], outOfScope: [] },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 725,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(
      !gate.ok,
      `dirty root: the cycle is not ok (got: ${gate.failures.join("; ")})`,
    );
    const dirtyFailure = gate.failures.find((fl) => /repoRoot is dirty/.test(fl));
    assert(
      dirtyFailure !== undefined,
      `dirty root: a failure names the dirty-repoRoot cause (got: ${gate.failures.join("; ")})`,
    );
    // The dirty-root failure must NOT be the cherry-pick-conflict wording —
    // that wording is what routes the cycle to the
    // `consolidated-verify-conflict` cap.
    assert(
      !gate.failures.some((fl) =>
        /cherry-pick \/ apply conflict|could not combine the workstreams/.test(fl),
      ),
      `dirty root: the refusal does not present as a cherry-pick conflict (got: ${gate.failures.join("; ")})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
