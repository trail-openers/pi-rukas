#!/usr/bin/env bun
/**
 * #777 + #750/#669 — the consolidated-verify classification and cap cases.
 *
 * Case 4: #777 (consolidation-created classification). Case 5: #777
 * (N=1 invariant). Case 6 + the #669 cap: cap rendering (explainCap).
 * #750 regression 4: a restore that cannot restore fails loudly.
 *
 * Split out of test-work-driver-verify-consolidated.ts (500-line gate); the
 * live-git cases 1–3 (#669 per-worktree/consolidated + the #750 conflict
 * regressions 1–3) live there, along with the shared fixture helpers
 * (fixture/commitIn/realExec) imported here.
 */

import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import { fixture, commitIn, realExec } from "./test-work-driver-verify-consolidated.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-669b-"));

try {
  // --------------------------------------------------------------- #777
  // Case 4 — consolidation-created: per-worktree passes, consolidated fails.
  // The failure must be classified, name the assertion + both workstream ids.
  {
    const f = await fixture(root, "777-consolidation-created", ["a", "b"], {
      "file-a.ts": "export const a = 1;\n",
      "file-b.ts": "export const b = 2;\n",
    });
    writeFileSync(
      path.join(f.worktrees.a, "file-a.ts"),
      "export const a = 1;\nexport function aFn() { return a; }\n",
    );
    await commitIn(f.worktrees.a, "task-a: add aFn");
    writeFileSync(
      path.join(f.worktrees.b, "file-b.ts"),
      "export const b = 2;\nexport function bFn() { return b; }\n",
    );
    await commitIn(f.worktrees.b, "task-b: add bFn");

    // Verify cmd: each worktree has 3 total exports, the union has 4.
    const verifyCmd =
      "sh -c 'test $(grep -c export file-a.ts file-b.ts 2>/dev/null | awk \"{s+=$1} END {print s}\") -lt 4'";
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${verifyCmd}\n`);
    let s = initialState(777, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-777",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreams: {
          a: { id: "a", scope: "add aFn", paths: [], outOfScope: [] },
          b: { id: "b", scope: "add bFn", paths: [], outOfScope: [] },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 777,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(!gate.ok, "#777 case 4: per-worktree passes, consolidated fails → NOT ok");
    // The failure must be classified as consolidation-created.
    const ccFailure = gate.failures.find((fl) => /\[consolidation-created\]/.test(fl));
    assert(
      ccFailure !== undefined,
      `#777 case 4: failure is classified consolidation-created (got: ${gate.failures.join("; ").slice(0, 200)})`,
    );
    // It must name BOTH workstream ids.
    assert(
      ccFailure !== undefined && /a.*b|b.*a/.test(ccFailure),
      `#777 case 4: failure names both workstreams (got: ${ccFailure?.slice(0, 200)})`,
    );
    // It must NOT be routed to the generic verify-failed:develop cap.
    // The classification label is in the failure text, which the topological
    // router uses to pick the new cap.
  }

  // --------------------------------------------------------------- #777
  // Case 5 — N=1 invariant: single-workstream cycle must NOT be
  // consolidation-created.
  {
    const f = await fixture(root, "777-n1-invariant", ["default"], {
      "single.ts": "export const x = 1;\n",
    });
    writeFileSync(
      path.join(f.worktrees.default, "single.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    await commitIn(f.worktrees.default, "task-default: add y");
    writeFileSync(
      path.join(f.repo, ".pi", "verify-cmd"),
      "sh -c 'test $(grep -c export single.ts 2>/dev/null) -le 1\n",
    );
    let s = initialState(777, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-777",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        workstreams: {
          default: { id: "default", scope: "add y", paths: [], outOfScope: [] },
        },
      },
    };
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 777,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(!gate.ok, "#777 case 5: N=1 consolidated verify fails → NOT ok");
    // Must NOT be classified as consolidation-created (N=1 invariant).
    const ccFailure = gate.failures.find((fl) => /\[consolidation-created\]/.test(fl));
    assert(
      ccFailure === undefined,
      `#777 case 5: N=1 must NOT be consolidation-created (got: ${gate.failures.join("; ").slice(0, 200)})`,
    );
    // Should be classified as per-workstream-defect (the per-worktree failure
    // matches the consolidated failure) or needs-human-decision.
    const pwsFailure = gate.failures.find((fl) => /\[per-workstream-defect\]/.test(fl));
    const nhdFailure = gate.failures.find((fl) => /\[needs-human-decision\]/.test(fl));
    assert(
      pwsFailure !== undefined || nhdFailure !== undefined,
      `#777 case 5: N=1 classified as per-workstream-defect or needs-human-decision (got: ${gate.failures.join("; ").slice(0, 200)})`,
    );
  }

  // --------------------------------------------------------------- #777
  // Case 6 — cap rendering: the new cap must render a distinct explanation.
  {
    let s = initialState(777, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        worktrees: { a: "/w/a", b: "/w/b" },
        branchName: "feature/issue-777",
      },
    };
    s.eventLog.push({
      kind: "cap-hit",
      at: 1,
      cap: "consolidated-verify-consolidation-created",
      reviewRound: 0,
      nextStep: "handoff",
      evidence:
        "[consolidation-created] verify command `tsc` failed — specific assertion: ✗ export already declared — workstream combination a + b",
    });
    const text = explainCap("consolidated-verify-consolidation-created", s);
    assert(
      /consolidation-created|NEITHER workstream tripped alone/.test(text),
      `#777 cap: explainCap names the classification (got: ${text.slice(0, 120)})`,
    );
    assert(
      /combination created the defect|combination does not build/.test(text),
      `#777 cap: explainCap names the combination (got: ${text.slice(0, 120)})`,
    );
  }

  // #750 regression 4 — a restore that CANNOT restore the root fails loudly.
  {
    const { verifiedRestoreRoot } = await import("../src/work-driver-restore.ts");
    const failingExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (/git reset --hard/.test(cmd)) {
        throw new Error("fatal: cannot update ref (refusing destructive reset)");
      }
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: "UU src/broken.ts\n?? note.txt\n" };
      }
      return { stdout: "" };
    };
    const r = await verifiedRestoreRoot(failingExec, {
      repoRoot: path.join(root, "nonexistent-repo"),
      originalRef: "main",
      scratchDir: path.join(root, "restore-loud-scratch"),
      label: "test-loud",
    });
    assert(
      r.restored === false,
      "#750 regression 4: a restore that cannot restore is restored:false, not a silent success",
    );
    assert(
      r.detail !== undefined && /broken\.ts/.test(r.detail),
      `#750 regression 4: the failure names the still-dirty path (detail: ${r.detail?.slice(0, 160)})`,
    );
    const claim = r.restored
      ? "the batch was aborted and repoRoot was verified restored"
      : `the batch was aborted but repoRoot was NOT restored: ${r.detail}`;
    assert(
      !/was verified restored/.test(claim),
      `#750 regression 4: a failed restore does not emit the restored claim (claim: ${claim.slice(0, 160)})`,
    );
    assert(
      /NOT restored/.test(claim),
      "#750 regression 4: the failed cleanup is louder — it explicitly says NOT restored",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ----------------------------------------------------------- cap rendering
{
  let s = initialState(669, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      branchName: "feature/issue-669",
    },
  };
  s.eventLog.push({
    kind: "cap-hit",
    at: 1,
    cap: "consolidated-verify-conflict",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: "patch-apply failed for workstream 'b': already exists",
  });
  const text = explainCap("consolidated-verify-conflict", s);
  assert(
    /decomposition is incoherent/.test(text),
    "#669 cap: explainCap names the decomposition error",
  );
  assert(/re-split|non-overlapping/.test(text), "#669 cap: the recovery names re-splitting");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
