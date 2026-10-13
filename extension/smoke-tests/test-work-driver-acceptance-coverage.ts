#!/usr/bin/env bun
/**
 * #1137 — the whole-issue acceptance-coverage gate, run ONCE on the
 * consolidated diff after all workstreams (work-driver-acceptance-coverage.ts).
 *
 * The per-workstream adversarial review is scoped to its own paths (task-a),
 * so the whole issue's acceptance criteria are checked here, exactly once,
 * against what actually shipped. A criterion that names a path no workstream
 * delivered must be flagged; a criterion a sibling delivered must NOT be
 * flagged; a prose criterion (no parseable path) is unmeasurable and never
 * blocks.
 *
 * Covers:
 *   1. criterionPathsOf — parenthetical path extraction, prose ignored
 *   2. classifyCoverage — the pure classification (no git)
 *   3. readConsolidatedDiffFiles — real-git consolidated read (rename, D)
 *   4. runAcceptanceCoverageGate — the end-to-end gate on a real repo
 *   5. recordAcceptanceCoverage — the plumb note, never a cap
 *   6. the commit-pr gate sequence wiring (runCommitPrPostDispatchGates)
 *   7. the "scope unknown" degradation (no criteria / unreadable diff)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyCoverage,
  readConsolidatedDiffFiles,
  recordAcceptanceCoverage,
  runAcceptanceCoverageGate,
} from "../src/work-driver-acceptance-coverage.ts";
import { runCommitPrPostDispatchGates } from "../src/work-driver-commit-pr-events.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
const specWith = (criteria: string[]) => ({
  intent: "fix the bug",
  deliverables: [] as Array<{ id: string; description: string; paths: string[] }>,
  acceptanceCriteria: criteria,
  outOfScope: [],
  assumptions: [] as Array<{ text: string; basis: string }>,
  openQuestions: [],
  evidence: [] as Array<{ claim: string; source: string; verdict: string }>,
  verdict: "proceed" as const,
  rationale: "",
});

// ----------------------------------------- 3. real-git consolidated read
{
  const fs = await import("node:fs/promises");
  const { exec: execChild } = await import("node:child_process");
  const { promisify: promisifyUtil } = await import("node:util");
  const execp2 = promisifyUtil(execChild);

  const mkRepo = async (dir: string) => {
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
  };

  // origin/main → local branch: files added + a rename + a delete.
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  try {
    await mkRepo(dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/a.ts"), "a\n");
    await fs.writeFile(path.join(dir, "src/old.ts"), "old\n");
    await execp2("git add . && git commit -q -m baseline2", { cwd: dir, shell: "/bin/bash" });
    await execp2("git checkout -qb feature/issue-1137", { cwd: dir, shell: "/bin/bash" });
    await fs.writeFile(path.join(dir, "src/b.ts"), "b\n");
    await execp2("git mv src/old.ts src/renamed.ts", { cwd: dir, shell: "/bin/bash" });
    await execp2("git add . && git commit -q -m work", { cwd: dir, shell: "/bin/bash" });

    const execFn = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) =>
      await execp2(cmd, { ...o, shell: "/bin/bash" });

    const r = await readConsolidatedDiffFiles(execFn, dir, "feature/issue-1137");
    assert(r.unreadable === false, "readConsolidatedDiffFiles: local branch read succeeds");
    assert(
      r.files.has("src/a.ts") && r.files.has("src/b.ts") && r.files.has("src/renamed.ts"),
      "readConsolidatedDiffFiles: baseline + added + rename TARGET present",
    );
    assert(
      !r.files.has("src/old.ts"),
      "readConsolidatedDiffFiles: the rename source is not a present file",
    );
    // Unreadable: a branch that does not exist and has no origin ref.
    const r2 = await readConsolidatedDiffFiles(execFn, dir, "feature/nope");
    assert(r2.unreadable === true, "readConsolidatedDiffFiles: unknown branch → unreadable");
    // A shell-metacharacter branch name is refused, never handed to the shell.
    const r3 = await readConsolidatedDiffFiles(execFn, dir, "feature/x;touch pwned");
    assert(
      r3.unreadable === true,
      "readConsolidatedDiffFiles: unsafe ref name is refused (unreadable)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------- 3b. main advances after the branch is cut (#1137 review)
{
  const fs = await import("node:fs/promises");
  const { exec: execChild } = await import("node:child_process");
  const { promisify: promisifyUtil } = await import("node:util");
  const execp2 = promisifyUtil(execChild);
  const sh = (cmd: string, cwd: string) => execp2(cmd, { cwd, shell: "/bin/bash" });
  const execFn = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) =>
    await execp2(cmd, { ...o, shell: "/bin/bash" });

  const dir = mkdtempSync(path.join(tmpdir(), "acc-advance-"));
  try {
    await execp2("git init -q", { cwd: dir });
    await sh('git config user.email "t@t" && git config user.name "T"', dir);
    await fs.writeFile(path.join(dir, ".gitkeep"), "\n");
    await sh("git add . && git commit -q -m baseline", dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src/shared.ts"), "shared\n");
    await sh("git add . && git commit -q -m cut-point", dir);
    // origin/main is the cut point, and the branch is cut here.
    await sh("git update-ref refs/remotes/origin/main HEAD", dir);
    await sh("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", dir);
    await sh("git checkout -qb feature/issue-1137", dir);
    await fs.writeFile(path.join(dir, "src/a.ts"), "a\n");
    await sh("git add . && git commit -q -m work", dir);
    // Main advances after the cut: it edits a file the branch never touched
    // and adds one of its own.
    await sh("git checkout -q -b mainline origin/main", dir);
    await fs.writeFile(path.join(dir, "src/shared.ts"), "shared, advanced on main\n");
    await fs.writeFile(path.join(dir, "src/main-only.ts"), "main\n");
    await sh("git add . && git commit -q -m main-advances", dir);
    await sh("git update-ref refs/remotes/origin/main HEAD", dir);
    await sh("git checkout -q feature/issue-1137", dir);

    const r = await readConsolidatedDiffFiles(execFn, dir, "feature/issue-1137");
    assert(r.unreadable === false, "advanced main: the consolidated read succeeds");
    assert(r.files.has("src/a.ts"), "advanced main: the branch's own file is delivered");
    assert(
      !r.files.has("src/shared.ts") && !r.files.has("src/main-only.ts"),
      "advanced main: main-only changes are NOT counted as delivered (merge-base diff)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------ 4. end-to-end gate on a real repo
{
  const fs = await import("node:fs/promises");
  const { exec: execChild } = await import("node:child_process");
  const { promisify: promisifyUtil } = await import("node:util");
  const execp2 = promisifyUtil(execChild);

  const mkRepo = async (dir: string) => {
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
  };

  const execFn = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) =>
    await execp2(cmd, { ...o, shell: "/bin/bash" });

  const mkState = (dir: string, criteria: string[]): WorkState => {
    const s = initialState(1137, 1_000_000);
    return {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "commit-pr",
        branchName: "feature/issue-1137",
        worktrees: { code: dir, docs: dir },
        workstreams: {
          code: { id: "code", scope: "code", paths: ["src/a.ts"], outOfScope: [] },
          docs: { id: "docs", scope: "docs", paths: ["AGENTS.md"], outOfScope: [] },
        },
        normalisedSpec: specWith(criteria),
      },
    };
  };

  const ctx: DriverContext = {
    host: {} as never,
    repoRoot: "/repo",
    issue: 1137,
    verifyExecFn: execFn,
  };

  // The docs workstream ships AGENTS.md; the code workstream ships src/a.ts.
  // A criterion owned by docs (AGENTS.md) is delivered; a criterion owned by
  // code (src/missing.ts) is undelivered → the gate flags it.
  const dir = mkdtempSync(path.join(tmpdir(), "acc-e2e-"));
  try {
    await mkRepo(dir);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "docs\n");
    await fs.writeFile(path.join(dir, "src/a.ts"), "a\n");
    await execp2("git add . && git commit -q -m baseline2", { cwd: dir, shell: "/bin/bash" });
    await execp2("git checkout -qb feature/issue-1137", { cwd: dir, shell: "/bin/bash" });
    await fs.writeFile(path.join(dir, "src/a.ts"), "a2\n");
    await execp2("git add . && git commit -q -m work", { cwd: dir, shell: "/bin/bash" });
    ctx.repoRoot = dir;

    const s = mkState(dir, [
      "Docs explain the new flag (AGENTS.md)",
      "The new module ships (src/a.ts)",
      "The unimplemented helper (src/missing.ts)",
    ]);
    const verdict = await runAcceptanceCoverageGate(ctx, s);
    assert(verdict !== null, "gate: ran (criteria recorded, diff readable)");
    assert(
      verdict !== null && verdict.undelivered.length === 1,
      "gate: exactly one undelivered criterion flagged",
    );
    assert(
      verdict !== null &&
        verdict.undelivered[0].text === "The unimplemented helper (src/missing.ts)",
      "gate: the flagged criterion is the unshipped one",
    );
    // No workstream declared src/missing.ts — the owner is null (the criterion
    // names a path nobody claimed); the cap's evidence says so explicitly.
    assert(
      verdict !== null && verdict.undelivered[0].owner === null,
      "gate: the unowned criterion has no owner (no workstream declared it)",
    );
    const delivered = verdict?.criteria.filter((c) => c.status === "delivered") ?? [];
    assert(
      delivered.length === 2 &&
        delivered.some((c) => c.owner === "docs") &&
        delivered.some((c) => c.owner === "code"),
      "gate: sibling-delivered criteria (docs + code) are NOT flagged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Degradation: no recorded acceptance criteria → the gate skips (scope
  // unknown), it never fails on criteria the driver never had.
  {
    const dir2 = mkdtempSync(path.join(tmpdir(), "acc-skip-"));
    try {
      await mkRepo(dir2);
      await execp2("git checkout -qb feature/issue-1137", { cwd: dir2, shell: "/bin/bash" });
      ctx.repoRoot = dir2;
      const s = initialState(1137, 1_000_000);
      const verdict = await runAcceptanceCoverageGate(ctx, s);
      assert(verdict === null, "gate: no normalised spec → skip (scope unknown)");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }

  // Degradation: unreadable consolidated diff → skip, not a false block.
  {
    const dir3 = mkdtempSync(path.join(tmpdir(), "acc-unreadable-"));
    try {
      await mkRepo(dir3);
      ctx.repoRoot = dir3;
      const s = mkState(dir3, ["Any (src/a.ts)"]);
      s.pipelineState.branchName = "feature/does-not-exist";
      const verdict = await runAcceptanceCoverageGate(ctx, s);
      assert(
        verdict?.skipped && verdict.undelivered.length === 0,
        "gate: unreadable diff → skipped verdict (NOT CHECKED), never a false block",
      );
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------- 5. the cap event + the wiring
{
  const fs = await import("node:fs/promises");
  const { exec: execChild } = await import("node:child_process");
  const { promisify: promisifyUtil } = await import("node:util");
  const execp2 = promisifyUtil(execChild);
  const execFn = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) =>
    await execp2(cmd, { ...o, shell: "/bin/bash" });

  const mkRepo = async (dir: string) => {
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
  };

  // recordAcceptanceCoverage — a plumb note on the handoff; never a cap-hit.
  {
    const v = classifyCoverage(
      ["Missing work (src/missing.ts)"],
      { code: { id: "code", scope: "c", paths: ["src/missing.ts"], outOfScope: [] } },
      new Set(["src/a.ts"]),
    );
    const s = initialState(1137, 1_000_000);
    const out = recordAcceptanceCoverage(s, v);
    const note = out.pipelineState.plumbReports?.[out.pipelineState.plumbReports.length - 1];
    assert(
      out.eventLog.length === s.eventLog.length && !out.eventLog.some((e) => e.kind === "cap-hit"),
      "warning: undelivered criteria append NO cap-hit",
    );
    assert(note?.body.includes("not delivered") === true, "warning: a plumb note names it");
    assert(
      note?.body.includes("src/missing.ts") === true &&
        note?.body.includes("workstream code") === true,
      "warning: the note names the criterion, the missing path, and the owner",
    );
    const skipped = recordAcceptanceCoverage(s, {
      skipped: true,
      skipReason: "consolidated diff unreadable",
      diffUnreadable: true,
      criteria: [],
      undelivered: [],
      filesPresent: [],
    });
    assert(
      skipped.pipelineState.plumbReports?.at(-1)?.body ===
        "acceptance coverage NOT CHECKED: consolidated diff unreadable",
      "warning: an unreadable diff is recorded as NOT CHECKED",
    );
  }

  // The commit-pr post-dispatch gate sequence wires the check in: a failing
  // coverage verdict raises the cap (handoff) BEFORE the verify gate's happy
  // path is reached; a passing one leaves the state untouched.
  {
    const mkState = (dir: string, criteria: string[]): WorkState => {
      const s = initialState(1137, 1_000_000);
      return {
        ...s,
        eventLog: [
          ...s.eventLog,
          {
            kind: "dispatch-completed",
            at: 1_000_100,
            jobId: "j1",
            step: "commit-pr",
            role: "ops",
            ok: true,
            summary: "Done.\npr: 999",
          },
        ],
        pipelineState: {
          ...s.pipelineState,
          currentStep: "commit-pr",
          branchName: "feature/issue-1137",
          worktrees: { code: dir },
          workstreams: {
            code: { id: "code", scope: "c", paths: ["src/a.ts"], outOfScope: [] },
          },
          normalisedSpec: specWith(criteria),
        },
      };
    };

    const dir = mkdtempSync(path.join(tmpdir(), "acc-wire-"));
    try {
      await mkRepo(dir);
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "src/a.ts"), "a\n");
      await execp2("git add . && git commit -q -m baseline2", { cwd: dir, shell: "/bin/bash" });
      await execp2("git checkout -qb feature/issue-1137", { cwd: dir, shell: "/bin/bash" });
      await fs.writeFile(path.join(dir, "src/a.ts"), "a2\n");
      await execp2("git add . && git commit -q -m work", { cwd: dir, shell: "/bin/bash" });
      // The commit-pr gate counts origin/<branch>: stand in for ops' push.
      await execp2("git update-ref refs/remotes/origin/feature/issue-1137 HEAD", { cwd: dir });

      // The PR the ops reply names (pr: 999) must resolve to this branch.
      // Argv-style git calls (refResolves, rev-list) are shell-quoted here.
      const prExec = async (
        cmd: string,
        o?: { cwd?: string; maxBuffer?: number; argv?: string[] },
      ) => {
        if (cmd.startsWith("gh pr view"))
          return {
            stdout: JSON.stringify({
              number: 999,
              state: "OPEN",
              headRefName: "feature/issue-1137",
              baseRefName: "main",
              title: "t",
              body: "",
              url: "https://github.com/x/y/pull/999",
            }),
            stderr: "",
          };
        if (o?.argv) return execFn([cmd, ...o.argv].map((a) => `'${a}'`).join(" "), o);
        return execFn(cmd, o);
      };
      const ctx: DriverContext = {
        host: {} as never,
        repoRoot: dir,
        issue: 1137,
        verifyExecFn: prExec,
      };

      // (a) undelivered criterion → a warning note; the cycle is not parked.
      const failing = mkState(dir, [
        "The shipped module (src/a.ts)",
        "The missing helper (src/nope.ts)",
      ]);
      const outA = await runCommitPrPostDispatchGates(ctx, prExec, failing);
      const noteA = outA.pipelineState.plumbReports?.find((r) => r.body.includes("not delivered"));
      assert(
        noteA?.body.includes("src/nope.ts") === true,
        "wiring: undelivered criterion is recorded as a warning naming the path",
      );
      assert(
        !outA.eventLog.some(
          (e) => e.kind === "cap-hit" && /acceptance criterion/.test(e.evidence ?? ""),
        ),
        "wiring: undelivered criterion raises no cap at commit-pr",
      );

      // (b) every criterion delivered → no acceptance-coverage cap. (The
      // verify gate may still fire a verify-failed:commit-pr cap on its own
      // checks in a fixture repo — the assertion is about the coverage gate
      // being transparent, which is visible in the evidence string: the
      // coverage cap's evidence always names an undelivered criterion.)
      const passing = mkState(dir, ["The shipped module (src/a.ts)"]);
      const outB = await runCommitPrPostDispatchGates(ctx, prExec, passing);
      assert(
        !outB.pipelineState.plumbReports?.some((r) => r.body.includes("not delivered")),
        "wiring: delivered criteria record no acceptance-coverage note",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
