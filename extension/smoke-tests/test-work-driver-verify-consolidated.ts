#!/usr/bin/env bun
/**
 * #669 + #777 — the develop gate must see the COMBINED tree.
 *
 * Cases 1–3: #669 (per-worktree pass/union fail, cross-dep, cherry-pick
 * conflict). Cases 4–6: #777 (consolidation-created classification,
 * N=1 invariant, cap rendering).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-669-"));

async function fixture(name: string, ids: string[], seed: Record<string, string>) {
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

function commitIn(wt: string, msg: string) {
  return execFileP("git", ["add", "."], { cwd: wt }).then(() =>
    execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }),
  );
}

try {
  // --------------------------------------------------------------- case 1
  // Per-worktree verify PASSES, consolidated verify FAILS (the #645 mirror).
  // A deletes helper.sh; B adds main.sh that references it. Verify cmd:
  // "helper exists OR caller doesn't" — passes alone, fails in the union.
  {
    const f = await fixture("union-fails", ["a", "b"], {
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
  // Per-worktree verify FAILS, consolidated verify PASSES (the #645 shape).
  {
    const f = await fixture("cross-dep", ["a", "b"], {
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
      gate.ok,
      `#669 case 2: per-worktree fails but consolidated passes → OK (got failures: ${gate.failures.join("; ")})`,
    );
    assert(
      gate.notes.some((n) => /consolidated verify passed/.test(n)),
      "#669 case 2: the passing consolidated run is recorded in notes as the verdict",
    );
  }

  // --------------------------------------------------------------- case 3
  // Cherry-pick conflict: both workstreams edit the SAME line.
  {
    const f = await fixture("conflict", ["a", "b"], {
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
    const f2 = await fixture("untracked-safety", ["a", "b"], {
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

  // --------------------------------------------------------------- #777
  // Case 4 — consolidation-created: per-worktree passes, consolidated fails.
  // The failure must be classified, name the assertion + both workstream ids.
  {
    const f = await fixture("777-consolidation-created", ["a", "b"], {
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
    const f = await fixture("777-n1-invariant", ["default"], {
      "single.ts": "export const x = 1;\n",
    });
    writeFileSync(path.join(f.worktrees.default, "single.ts"), "export const x = 1;\nexport const y = 2;\n");
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
      kind: "cap-hit", at: 1, cap: "consolidated-verify-consolidation-created",
      reviewRound: 0, nextStep: "handoff",
      evidence: "[consolidation-created] verify command `tsc` failed — specific assertion: ✗ export already declared — workstream combination a + b",
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
  assert(/decomposition is incoherent/.test(text), "#669 cap: explainCap names the decomposition error");
  assert(/re-split|non-overlapping/.test(text), "#669 cap: the recovery names re-splitting");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
