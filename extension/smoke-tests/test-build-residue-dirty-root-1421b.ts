#!/usr/bin/env bun
/**
 * #1421 (part 2) — the handoff half: a declined consolidation names the
 * driver’s actual cause AND the worktrees + HEAD SHAs where the reviewed
 * commits still are.
 *
 * The pre-fix message was the fixed string "consolidation infeasible (work
 * remains on its worktree detached HEADs)" — it named neither the worktree nor
 * the commit, so an operator reading the handoff could not find the work the
 * cycle had already paid for. Split out of part 1 for the 500-line file gate;
 * the two share `lib/build-residue-1421-fixtures.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { makeHandoffEmittedEvent } from "../src/work-driver-handoff-post.ts";
import type { HandoffCommittedWorkEntry } from "../src/work-driver-handoff-post.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { gitOut, makeRepo, worktreeWithCommit } from "./lib/build-residue-1421-fixtures.ts";
import { realExec } from "./lib/exec-fake.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1421b-"));

try {
  // =============================================== 4. the handoff names the work
  {
    const repo = path.join(root, "consolidate");
    const base = await makeRepo(repo);
    const a = await worktreeWithCommit(repo, "issue-1421-a", base, "a.rs");
    // Dirt the consolidation cannot sweep: an unignored untracked file.
    writeFileSync(path.join(repo, "operator-work.ts"), "export const y = 2;\n");

    let s = initialState(1421, 1_000_000) as WorkState;
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-1421-x",
        baseSha: base,
        worktrees: { a },
      },
    };
    const out = await consolidateWorktreesToBranch(
      { repoRoot: repo, issue: 1421, scratchDir: path.join(repo, "tmp", "issue-1421") },
      s,
    );
    assert(
      out.ok === false,
      "#4: a dirty root still refuses consolidation (this half is unchanged)",
    );
    assert(
      out.ok === false && /operator-work\.ts/.test(out.reason ?? ""),
      `#4: the refusal names the dirt (got: ${(out.ok ? "" : (out.reason ?? "")).slice(0, 140)})`,
    );

    const head = await gitOut(a, ["rev-parse", "HEAD"]);
    const committedWork: HandoffCommittedWorkEntry[] = [
      { worktreeId: "a", path: a, headSha: head, ahead: 1 },
    ];
    const ev = makeHandoffEmittedEvent({
      at: Date.now(),
      commentUrl: undefined,
      labelApplied: false,
      handoffBodyPath: "/tmp/body.md",
      consolidated: false,
      consolidationReason: `consolidation did not run — the committed work is NOT lost: ${committedWork
        .map(
          (w) =>
            `worktree ${w.worktreeId} at ${w.path} (HEAD ${w.headSha.slice(0, 8)}, ${w.ahead} commit(s) ahead of the base)}`,
        )
        .join("; ")}. See the recovery steps below for the cherry-pick commands; driver's reason: ${
        out.ok ? "" : out.reason
      }`,
    });
    assert(
      (ev.consolidationReason ?? "").includes("NOT lost") &&
        (ev.consolidationReason ?? "").includes(a) &&
        (ev.consolidationReason ?? "").includes(head.slice(0, 8)),
      "#4: the handoff reason names the worktree path AND the HEAD sha where the commits are",
    );
    assert(
      (ev.consolidationReason ?? "").includes("driver's reason:") &&
        (ev.consolidationReason ?? "").includes("operator-work.ts"),
      "#4: the handoff reason carries the driver's actual cause, not a fixed sentence",
    );
    assert(
      !(ev.consolidationReason ?? "").includes("consolidation infeasible"),
      "#4: the old fixed 'consolidation infeasible' wording is gone",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
