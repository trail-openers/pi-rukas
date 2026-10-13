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
 *   5. raiseAcceptanceCoverageCap — the cap event + evidence
 *   6. the commit-pr gate sequence wiring (runCommitPrPostDispatchGates)
 *   7. the "scope unknown" degradation (no criteria / unreadable diff)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyCoverage,
  criterionPathsOf,
  raiseAcceptanceCoverageCap,
  readConsolidatedDiffFiles,
  runAcceptanceCoverageGate,
} from "../src/work-driver-acceptance-coverage.ts";
import { runCommitPrPostDispatchGates } from "../src/work-driver-commit-pr-events.ts";
import { type DriverContext, nextStep } from "../src/work-driver-context.ts";
import { appendEvent, initialState, type WorkState, writeState } from "../src/workflow-state.ts";

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

// ---------------------------------------------------------------- 1. paths
{
  assert(
    JSON.stringify(criterionPathsOf("Add hunk-identity subtraction (src/a.ts, src/b.ts)")) ===
      JSON.stringify(["src/a.ts", "src/b.ts"]),
    "criterionPathsOf: extracts multiple parenthetical paths",
  );
  assert(
    JSON.stringify(criterionPathsOf("The docs explain the new flag (extension/src/x.ts (new))")) ===
      JSON.stringify(["extension/src/x.ts"]),
    "criterionPathsOf: planner annotation inside the path is normalised away",
  );
  assert(
    JSON.stringify(criterionPathsOf("The CLI prints a helpful message (docs only)")) ===
      JSON.stringify([]),
    "criterionPathsOf: a prose parenthetical (no slash, no extension) is not a path",
  );
  assert(
    JSON.stringify(criterionPathsOf("No parens at all, just prose about behaviour")) ===
      JSON.stringify([]),
    "criterionPathsOf: prose without parens is unmeasurable",
  );
  assert(
    JSON.stringify(criterionPathsOf("Ships the module (extension/src)")) ===
      JSON.stringify(["extension/src"]),
    "criterionPathsOf: a directory declaration (slash, no extension) is a path",
  );
}

// --------------------------------------------- 2. classifyCoverage (pure)
{
  const workstreams = {
    code: { id: "code", scope: "the code", paths: ["src/a.ts", "src/b.ts"], outOfScope: [] },
    docs: { id: "docs", scope: "the docs", paths: ["AGENTS.md"], outOfScope: [] },
  };
  const diff = new Set(["src/a.ts", "AGENTS.md", "other/c.ts"]);

  // Sibling-delivered: the docs workstream's criterion is satisfied by a file
  // the docs workstream ships — the docs workstream's reviewer is never asked
  // for it (task-a), but the whole-issue check here must see it as delivered.
  const v = classifyCoverage(
    [
      "Docs explain the flag (AGENTS.md)",
      "Subtraction lands (src/a.ts)",
      "Undelivered work (src/b.ts)",
      "Prose criterion with no paths at all",
    ],
    workstreams,
    diff,
  );
  assert(v.skipped === false, "classifyCoverage: ran (not skipped)");
  assert(v.filesPresent.length === 3, "classifyCoverage: filesPresent records the diff name-set");
  assert(
    v.criteria[0].status === "delivered" && v.criteria[0].owner === "docs",
    "classifyCoverage: sibling-delivered criterion is delivered, owner = docs",
  );
  assert(
    v.criteria[1].status === "delivered" && v.criteria[1].owner === "code",
    "classifyCoverage: delivered criterion owned by code",
  );
  assert(
    v.criteria[2].status === "undelivered" && v.criteria[2].owner === "code",
    "classifyCoverage: undelivered criterion named, owner = code",
  );
  assert(v.criteria[2].missing.join(",") === "src/b.ts", "classifyCoverage: missing path recorded");
  assert(
    v.criteria[3].status === "unmeasurable",
    "classifyCoverage: prose criterion is unmeasurable, never undelivered",
  );
  assert(
    v.undelivered.length === 1 && v.undelivered[0].text === "Undelivered work (src/b.ts)",
    "classifyCoverage: the blocking set is exactly the undelivered criterion",
  );

  // Partial presence: some of the criterion's paths shipped, some did not.
  // Not a block (the converge gate parks only on fully-absent deliverables).
  const v2 = classifyCoverage(["Both (src/a.ts, src/b.ts)"], workstreams, diff);
  assert(
    v2.criteria[0].status === "delivered" && v2.criteria[0].missing.length === 1,
    "classifyCoverage: partially-present criterion is not a block (missing recorded)",
  );
  assert(v2.undelivered.length === 0, "classifyCoverage: partial presence → no undelivered set");

  // Prose that looks like a path never blocks (#1137 review): a slash-only
  // token counts only if the diff has files under it; a path after prose counts.
  const vProse = classifyCoverage(
    ["Errors (read/write)", "Docs (see docs/x.md)", "Covered (e.g. src/a.ts)", "Gone (see docs/gone.md)"],
    workstreams,
    new Set(["docs/x.md", "src/a.ts"]),
  );
  assert(vProse.criteria[0].status === "unmeasurable", "classifyCoverage: '(read/write)' is prose");
  assert(
    vProse.criteria[1].status === "delivered" && vProse.criteria[2].status === "delivered",
    "classifyCoverage: paths after prose ('see docs/x.md', 'e.g. src/a.ts') are found and shipped",
  );
  assert(vProse.undelivered.length === 1, "classifyCoverage: only the unshipped prose-wrapped path blocks");

  // Explicit skip: "scope unknown" shapes degrade to a recorded skip.
  const vs = classifyCoverage(["Any (src/a.ts)"], workstreams, diff, {
    skipReason: "no recorded acceptance criteria",
  });
  assert(
    vs.skipped === true && vs.skipReason !== undefined && vs.undelivered.length === 0,
    "classifyCoverage: explicit skip carries the reason and never blocks",
  );
}

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
    assert(r3.unreadable === true, "readConsolidatedDiffFiles: unsafe ref name is refused (unreadable)");
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
    let s = initialState(1137, 1_000_000);
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
    pi: {} as never,
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
      assert(verdict === null, "gate: unreadable diff → skip (scope unknown), never a false block");
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

  // raiseAcceptanceCoverageCap — the cap event shape + the evidence string.
  {
    const v = classifyCoverage(
      ["Missing work (src/missing.ts)"],
      { code: { id: "code", scope: "c", paths: ["src/missing.ts"], outOfScope: [] } },
      new Set(["src/a.ts"]),
    );
    const s = initialState(1137, 1_000_000);
    const out = raiseAcceptanceCoverageCap(s, v);
    const capHit = out.eventLog[out.eventLog.length - 1];
    assert(capHit.kind === "cap-hit", "cap: a cap-hit event was appended");
    assert(
      capHit.kind === "cap-hit" && capHit.cap === "verify-failed:commit-pr",
      "cap: uses the verify-failed:commit-pr literal (known to the validator)",
    );
    assert(capHit.kind === "cap-hit" && capHit.nextStep === "handoff", "cap: routes to handoff");
    assert(
      capHit.kind === "cap-hit" &&
        (capHit.evidence ?? "").includes("src/missing.ts") &&
        (capHit.evidence ?? "").includes("workstream code"),
      "cap: evidence names the criterion, the missing path, and the owner",
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

      const ctx: DriverContext = {
        pi: {} as never,
        repoRoot: dir,
        issue: 1137,
        verifyExecFn: execFn,
      };

      // (a) undelivered criterion → the gate raises the cap and routes to
      // handoff (nextStep on the cap), not to lens-review.
      const failing = mkState(dir, [
        "The shipped module (src/a.ts)",
        "The missing helper (src/nope.ts)",
      ]);
      const outA = await runCommitPrPostDispatchGates(ctx, execFn, failing);
      const lastA = outA.eventLog[outA.eventLog.length - 1];
      assert(
        lastA.kind === "cap-hit" && lastA.cap === "verify-failed:commit-pr",
        "wiring: undelivered criterion raises the cap at commit-pr",
      );
      assert(
        lastA.kind === "cap-hit" && lastA.nextStep === "handoff",
        "wiring: the cap routes to handoff (not lens-review)",
      );
      const decisionA = nextStep({
        ...outA,
        pipelineState: { ...outA.pipelineState, status: "running" },
      });
      assert(
        decisionA.kind === "step" && decisionA.step === "handoff",
        "wiring: nextStep follows the cap's nextStep to handoff",
      );

      // (b) every criterion delivered → no acceptance-coverage cap. (The
      // verify gate may still fire a verify-failed:commit-pr cap on its own
      // checks in a fixture repo — the assertion is about the coverage gate
      // being transparent, which is visible in the evidence string: the
      // coverage cap's evidence always names an undelivered criterion.)
      const passing = mkState(dir, ["The shipped module (src/a.ts)"]);
      const outB = await runCommitPrPostDispatchGates(ctx, execFn, passing);
      const coverageCap = outB.eventLog.find(
        (e) =>
          e.kind === "cap-hit" &&
          e.cap === "verify-failed:commit-pr" &&
          /acceptance criterion undelivered/.test(e.evidence ?? ""),
      );
      assert(
        coverageCap === undefined,
        "wiring: delivered criteria raise no acceptance-coverage cap",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
