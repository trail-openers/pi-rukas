/**
 * #1862 round 3 — a merge that PARKS after a fold still carries that fold's
 * self-fence notes.
 *
 * `runMergePrep` persisted each fold's removals only once the whole iteration had
 * succeeded, so a fold whose notes had been handed out but not yet written was
 * followed by a `park()` that built its state from `next` — the pre-note state —
 * and the removal vanished: not in the state file, not in the handoff. That is
 * the same disclosure failure as never recording the drop, on the one path where
 * a merge is most likely to stop (a worktree or a git read that fails right
 * after the fold).
 *
 * The fold here is real (a `b` that wrote `a`'s declared file, so the merge
 * absorbs `b` and drops `b`'s fence over its own `b.txt`); the park is provoked
 * by the very next step — `git rev-parse HEAD` in the owner's worktree fails on a
 * path that no longer exists. The assertion is on the parked state's persisted
 * notes.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-work-develop-fence-park-note-1862.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMergePrep } from "../src/work-develop-fence-merge.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import type { DispatchResult } from "../src/types.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm } from "./lib/argv-shell.ts";
import { withEnv } from "./lib/env-scope.ts";
import { git, sh } from "./lib/gate-hang-helpers.ts";

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1862p-"));
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

/** A two-worktree repo; `a` fences `b.txt`, which `b` declares — the fence the
 * fold must remove, and the removal the park must still disclose. */
async function repo(tag: string) {
  const dir = path.join(root, tag);
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

const f = await repo("main");
const realGit = asShellForm(async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
  const { stdout } = await sh(o?.cwd ?? f.repo, cmd);
  return { stdout };
});

const ctx: CycleContext = {
  host: {} as unknown as DriverContext["host"],
  repoRoot: f.repo,
  issue: 1862,
  verifyExecFn: realGit,
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

/** The state the develop gate leaves behind: a `sibling-declared` violation by
 * `b` on `a`'s file, so the merge folds `b` into `a`. */
function baseState(wtA: string, wtB: string, baseSha: string) {
  const s = initialState(1862, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: "feature/issue-1862",
      baseSha,
      worktrees: { a: wtA, b: wtB },
      workstreams: {
        a: { id: "a", scope: "owner", paths: ["a.txt"], outOfScope: ["b.txt"] },
        b: { id: "b", scope: "violator", paths: ["b.txt"], outOfScope: [] },
      },
      verifyEvidence: {
        step: "develop",
        failures: [],
        at: Date.now(),
        fenceViolations: [
          {
            kind: "sibling-declared" as const,
            workstreamId: "b",
            file: "a.txt",
            declaredById: "a",
          },
        ],
      },
    },
  };
}

await withEnv({ PI_ENSEMBLE_FRONTEND_ONLY_GLOBS: "" }, async () => {
  // ── 1. a park AFTER the fold keeps the fold's note ────────────────────────
  {
    const f1 = await repo("p1");
    const state = baseState(f1.wtA, f1.wtB, f1.baseSha);
    // The OWNER's worktree path is missing: the fold runs first and its notes are
    // already on `next`, then the worktree-type check parks the run — BEFORE the
    // map write, which is the very next statement. So the parked state still shows
    // the pre-fold map, and asserting on it would judge the fold by a write this
    // park legitimately never reached. The note is the assertion: a fence the
    // merge deleted that the state file does not name is the failure here.
    state.pipelineState.worktrees = { a: `${f1.wtA}-gone`, b: f1.wtB };
    const ref = { current: state };
    const out = await runMergePrep(
      ctx,
      state,
      ref,
      ["a", "b"],
      async (cmd, o) => ({ stdout: (await realGit(cmd, o)).stdout }),
      dispatch,
    );
    assert(out.outcome.parked === true, "the run parked on the git failure");
    const notes = out.state.pipelineState.plumbReports.map((r) => r.body);
    assert(
      notes.some(
        (n) =>
          n.startsWith("self-fence dropped: ") &&
          n.includes("b.txt") &&
          n.includes("(merged workstream)"),
      ),
      `the fold's note survives the park — the state file names the fence the merge removed (got ${JSON.stringify(notes)})`,
    );

    // ── 1b. the park shape where the map write HAS happened: note and map must
    // agree — the absorbed half gone and its fence opened, not just noted.
    {
      const f1b = await repo("p1b");
      const s = baseState(f1b.wtA, f1b.wtB, f1b.baseSha);
      // Both worktrees are live and the reset succeeds, so the run gets past the
      // maps write (the statement that persists the fold's map) and parks in the
      // re-dispatch, where this dispatch throws. That is the park that happens
      // AFTER every durable write the iteration makes.
      const ref = { current: s };
      const out = await runMergePrep(
        ctx,
        s,
        ref,
        ["a", "b"],
        async (cmd, o) => realGit(cmd, o),
        // The re-dispatch itself fails — the last park the merge can take.
        async (): Promise<DispatchResult> => {
          throw new Error("simulated: re-dispatch dispatch failed");
        },
      );
      assert(
        out.outcome.parked === true,
        "the re-dispatch park is the shape this block judges (every durable write had happened)",
      );
      const st = out.state.pipelineState;
      const n2 = st.plumbReports.map((r) => r.body);
      assert(
        n2.some((n) => n.startsWith("self-fence dropped: ") && n.includes("b.txt")) &&
          st.workstreams?.["b"] === undefined &&
          st.workstreams?.["a"]?.outOfScope.every((e) => e !== "b.txt") === true,
        `a park after the map write keeps note and map consistent — absorbed half gone, fence opened (got ${JSON.stringify([st.workstreams?.["a"]?.outOfScope, n2.length])})`,
      );
    }
  }

  // ── 2. the overflow count survives the park too ───────────────────────────
  {
    const f2 = await repo("p2");
    const s = baseState(f2.wtA, f2.wtB, f2.baseSha);
    // A fence list long enough to exceed the run's note budget: every entry
    // fences a file the merged workstream will own after the fold, so all of
    // them drop and only `UNFENCE_NOTES_CAP` can be named.
    s.pipelineState.workstreams = {
      a: {
        id: "a",
        scope: "owner",
        paths: ["a.txt"],
        outOfScope: Array.from({ length: 40 }, (_, i) => `dropped-${i}.txt`),
      },
      b: {
        id: "b",
        scope: "violator",
        paths: Array.from({ length: 40 }, (_, i) => `dropped-${i}.txt`),
        outOfScope: [],
      },
    };
    s.pipelineState.worktrees = { a: f2.wtA, b: `${f2.wtB}-gone` };
    const ref = { current: s };
    const out = await runMergePrep(
      ctx,
      s,
      ref,
      ["a", "b"],
      async (cmd, o) => ({ stdout: (await realGit(cmd, o)).stdout }),
      dispatch,
    );
    assert(out.outcome.parked === true, "the second run parked as well");
    const notes = out.state.pipelineState.plumbReports.map((r) => r.body);
    assert(
      notes.some((n) => n.startsWith("self-fence dropped: +") && n.includes("more (cap")),
      `the park discloses the count it could not name, not just the notes it could (got ${notes.filter((n) => n.includes("more (cap")).length} overflow line(s))`,
    );
    assert(
      notes.filter((n) => n.startsWith('self-fence dropped: "')).length > 0,
      "and it still names the removals the budget could hold",
    );
  }

  rmSync(root, { recursive: true, force: true });
  process.exit(exit);
});
