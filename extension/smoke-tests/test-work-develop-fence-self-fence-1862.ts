/**
 * #1862 round 1 — a fence the develop merge removed REACHES THE STATE FILE.
 *
 * `runMergePrep` collected the self-fence drops its folds made onto
 * `MergePrepOutcome` and read them back to nobody: neither `runMergeRetryFlow`
 * nor `runSymbolMergeRetry` looked at the field, so a merge that deleted a
 * workstream's fence over its own files left no trace in the persisted state —
 * not in `planQuality`, not in a note, not in the handoff. An operator reading
 * the state file after such a cycle could not tell that a fence in the plan was
 * gone.
 *
 * Driven through `runMergeRetryFlow` (the entry the develop step calls) over a
 * real two-worktree repo, with the fence the merge must remove already recorded
 * on the workstreams. The assertion is on `pipelineState` — the record the
 * driver persists — not on `trace()`.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-work-develop-fence-self-fence-1862.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMergeRetryFlow } from "../src/work-develop-fence-merge-retry.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import type { DispatchResult } from "../src/types.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm } from "./lib/argv-shell.ts";
import { withEnv } from "./lib/env-scope.ts";
import { git, sh } from "./lib/gate-hang-helpers.ts";

process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1862f-"));
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

/**
 * The field shape: `b` wrote `a.txt`, which `a` declared, so the develop gate
 * recorded a `sibling-declared` violation and the driver merges b into a. The
 * fence the merge must remove lives on the SURVIVING half: `a` fences `b.txt`,
 * which is b's own declared file — after the merge that file is the merged
 * workstream's own scope, so the fold drops the entry and records why.
 */
async function repo() {
  const dir = path.join(root, "r");
  const r = path.join(dir, "repo");
  mkdirSync(r, { recursive: true });
  writeFileSync(path.join(r, "tracked.txt"), "base\n");
  mkdirSync(path.join(r, ".pi"), { recursive: true });
  writeFileSync(path.join(r, ".pi", "verify-cmd"), "true\n");
  await git(r, ["init", "--initial-branch=main", r]);
  await git(r, ["config", "user.email", "t@example.com"]);
  await git(r, ["config", "user.name", "T"]);
  await git(r, ["add", "."]);
  await git(r, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(r, ["rev-parse", "HEAD"])).stdout.trim();
  const wtA = path.join(dir, "wt-a");
  const wtB = path.join(dir, "wt-b");
  await git(r, ["worktree", "add", "--detach", wtA, baseSha]);
  await git(r, ["worktree", "add", "--detach", wtB, baseSha]);
  writeFileSync(path.join(wtA, "a.txt"), "a\n");
  await git(wtA, ["add", "."]);
  await git(wtA, ["commit", "-q", "-m", "a"]);
  writeFileSync(path.join(wtB, "b.txt"), "b\n");
  await git(wtB, ["add", "."]);
  await git(wtB, ["commit", "-q", "-m", "b"]);
  return { dir, repo: r, baseSha, wtA, wtB };
}

const f = await repo();
/** The git plumbing runs for real; the project's verify command is `true`. */
const verifyExecFn = asShellForm(async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
  const { stdout } = await sh(o?.cwd ?? f.repo, cmd);
  return { stdout };
});

let state = initialState(1862, 1_000_000);
state = {
  ...state,
  pipelineState: {
    ...state.pipelineState,
    branchName: "feature/issue-1862",
    baseSha: f.baseSha,
    worktrees: { a: f.wtA, b: f.wtB },
    workstreams: {
      a: { id: "a", scope: "owner", paths: ["a.txt"], outOfScope: ["b.txt"] },
      b: { id: "b", scope: "violator", paths: ["b.txt"], outOfScope: [] },
    },
    verifyEvidence: {
      step: "develop",
      failures: [],
      at: Date.now(),
      fenceViolations: [
        { kind: "sibling-declared" as const, workstreamId: "b", file: "a.txt", declaredById: "a" },
      ],
    },
  },
};

const ctx: CycleContext = {
  host: {} as unknown as DriverContext["host"],
  repoRoot: f.repo,
  issue: 1862,
  verifyExecFn,
  emitSink: { emit: () => undefined, fingerprints: [] },
};

const dispatch = async (): Promise<DispatchResult> => ({
  role: "developer",
  ok: true,
  exitCode: 0,
  text: "done",
  toolUses: [],
  ms: 10,
});

// The merge's re-dispatch is a developer-shaped dispatch and this fixture has
// no frontend-only configuration, so the frontend skip must be off. Pinned for
// the duration and restored — a bare `process.env.X = ""` at module scope leaks
// the empty string into every later file in the verify loop, and the plan
// unfence pass reads that same variable as "configured", so its docs/tests rule
// then fires on paths the suites beside this one never expected.
await withEnv({ PI_ENSEMBLE_FRONTEND_ONLY_GLOBS: "" }, async () => {
  const out = await runMergeRetryFlow(
    ctx,
    state,
    { current: state },
    ["a", "b"],
    [
      { id: "a", ok: true },
      { id: "b", ok: true },
    ],
    verifyExecFn,
    dispatch,
  );

  const merged = out.pipelineState.workstreams?.["a"];
  assert(
    merged !== undefined && !merged.outOfScope.includes("b.txt"),
    `the merge dropped the fence over the merged workstream's own file (got ${JSON.stringify(merged?.outOfScope)})`,
  );
  const notes = out.pipelineState.plumbReports.map((r) => r.body);
  assert(
    notes.some(
      (n) =>
        n.startsWith("self-fence dropped: ") &&
        n.includes("b.txt") &&
        n.includes("(merged workstream)"),
    ),
    `the removal is PERSISTED — a note in the state file names the dropped entry (got ${JSON.stringify(notes)})`,
  );

  rmSync(root, { recursive: true, force: true });
  process.exit(exit);
});
