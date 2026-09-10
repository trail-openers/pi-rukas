#!/usr/bin/env bun
/**
 * #669 — the develop gate must see the COMBINED tree.
 *
 * Every gate upstream of the develop verify runs in a SINGLE worktree, so a
 * test in workstream X that asserts on a file owned by workstream Y cannot
 * pass in X's tree — the shape #645/#649 confirmed 5 times in one live
 * session (and the mirror: two workstreams touching the same file, where a
 * line-cap overflow is only visible in the COMBINED state — #659/#664).
 *
 * This test pins the fix with REAL git worktrees:
 *
 *   1. Per-worktree verify PASSES but consolidated verify FAILS (one
 *      workstream deletes a helper, the other adds a caller; each tree
 *      builds, the union does not — the #645 mirror). The develop gate
 *      must be NOT ok, and the failure must cite the consolidated tree.
 *
 *   2. Per-worktree verify FAILS but consolidated verify PASSES (one
 *      workstream's test reads a file only a sibling's commit supplies —
 *      the #645 shape). The develop gate must be OK — a fanout must not be
 *      rejected solely because per-worktree verification couldn't see the
 *      whole picture, when the actually-consolidated result passes.
 *
 *   3. A cherry-pick conflict (two workstreams edit the same lines) routes
 *      to the distinguishable cap, not verify-failed:develop.
 *
 * Reuses the fixture shape of test-integration-verify.ts (bare origin +
 * clone + worktrees).
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
  // Per-worktree verify PASSES, consolidated verify FAILS.
  // A deletes helper.sh; B's main.sh calls it. Each tree passes `test -f
  // main.sh`; the union fails `test -f helper.sh && test -f main.sh`... no —
  // the union must FAIL, each must PASS. A's tree: helper.sh deleted,
  // main.sh untouched → `test -f helper.sh` fails in A. We need the opposite:
  // each passes alone, union fails.
  //
  // The #645 mirror: A renames helper.sh → helper2.sh (deletes old, adds new).
  // B adds main.sh that calls helper2.sh. A's tree: helper2.sh exists,
  // helper.sh gone. B's tree: helper.sh exists (unchanged), helper2.sh
  // absent, main.sh added. Verify cmd: `test -f helper2.sh && test -f
  // main.sh`. A's tree: helper2.sh present, main.sh ABSENT → fails. No.
  //
  // Simpler: verify cmd = `sh -c 'test ! -f helper.sh || test -f main.sh'`.
  // A's tree: helper.sh gone → `! -f helper.sh` true → PASS. B's tree:
  // helper.sh present, main.sh present → PASS. Union: helper.sh gone,
  // main.sh present → PASS. Still passes.
  //
  // Use the exact shape from test-integration-verify.ts: A DELETES
  // helper.sh, B ADDS a caller (main.sh). Verify cmd: `test -f helper.sh`.
  // A's tree: helper.sh gone → FAILS. That's the wrong direction.
  //
  // The correct #645 mirror (each passes, union fails): verify cmd checks
  // that a file B depends on still exists. A DELETES helper.sh. B adds
  // main.sh that references helper.sh. Verify cmd: `test -f helper.sh ||
  // [ ! -f main.sh ]` — "either the helper exists, or the caller doesn't".
  // A's tree: helper gone, no caller → `! -f main.sh` true → PASS.
  // B's tree: helper present (unchanged in B), caller present →
  // `-f helper.sh` true → PASS. Union: helper gone, caller present →
  // both false → FAIL.
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
  // B's test (new file) asserts on a file only A's commit supplies. B's
  // per-worktree verify fails because the file isn't in B's tree. The
  // consolidated tree has both → passes. The gate must be OK.
  {
    const f = await fixture("cross-dep", ["a", "b"], {
      "lib.sh": "echo lib\n",
    });
    // A: adds util.sh (a new file B's test will read).
    writeFileSync(path.join(f.worktrees.a, "util.sh"), "echo util\n");
    await commitIn(f.worktrees.a, "task-a: add util");
    // B: adds a test that reads util.sh (which only exists in A's tree).
    writeFileSync(path.join(f.worktrees.b, "test-util.sh"), "cat util.sh\n");
    await commitIn(f.worktrees.b, "task-b: test reads util");

    // Verify cmd: `test -f util.sh` — fails in B's tree (util.sh absent),
    // passes in A's tree, passes in the union.
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
    assert(gate.ok, `#669 case 2: per-worktree fails but consolidated passes → OK (got failures: ${gate.failures.join("; ")})`);
    assert(
      gate.notes.some((n) => /consolidated verify passed/.test(n)),
      "#669 case 2: the passing consolidated run is recorded in notes as the verdict",
    );
  }

  // --------------------------------------------------------------- case 3
  // Cherry-pick conflict: both workstreams edit the SAME line of the SAME
  // file. The consolidation cannot combine them → distinct cap.
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
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ----------------------------------------------------------- cap rendering
// The new cap must render a distinct explanation, not fall through to the
// generic "step failed" fallback.
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
    "#669 cap: explainCap names the decomposition error, not a verify failure",
  );
  assert(
    /re-split|non-overlapping/.test(text),
    "#669 cap: the recovery names re-splitting the work, not retrying verify",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
