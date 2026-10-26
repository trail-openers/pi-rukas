#!/usr/bin/env bun
/**
 * #1137 — the fan-out's review set is the `ids` the caller passes (one review
 * per id, each in its own worktree). The workstream map supplies only the
 * sibling list each reviewer is told about and the N>1 test. A phantom `ids`
 * entry is reviewed (at repoRoot, as on main); a map key absent from `ids` is
 * NOT reviewed, but is still named as a sibling of the reviewed workstreams.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readWorktreeDiff } from "../src/work-driver-diff-read.ts";
import { fanOutAdversarial } from "../src/work-driver-adversarial-fanout.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import { git, tmpDir } from "./lib/adversarial-fix-fixtures.ts";
import { initCleanRepo } from "./lib/clean-repo-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Zero the in-step retry backoff; the diff is empty in these non-git trees, so
// disable the empty-diff skip (the same settings the other adversarial tests use).
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
// No live spawn: a reviewer child this file does not stub must not be waited on
// (the fixture's own `adversarialLoopFn` stubs answer immediately).
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
// Transient provider backoff off — the retry ladder must not wait 60 s floors.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";

type Ws = { id: string; scope: string; paths: string[]; outOfScope: string[] };

/**
 * One real clean repo per workstream id, under `<dir>/.worktrees/<id>` (#1634).
 *
 * The adversarial diff read REFUSES a directory that is not its OWN worktree
 * root, so the old fixture shape — every id mapped at the bare temp dir, plus
 * `git init` on that dir — now reads as "could not tell" for any id whose path
 * sits below it, and the pass never reaches the reviewer loop these
 * assertions script. `stateWith` cannot create the repos itself, because the
 * reviewed set (`ids`) is passed to `fanOutAdversarial` at the call site, so
 * each block calls this for the ids it reviews.
 */
async function ensureWorktrees(dir: string, ids: string[]): Promise<Record<string, string>> {
  const created: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, ".worktrees", id);
    // The fixture's `.git/info/exclude` is written by `tmpDir` BEFORE the repo
    // exists, so a bare `.git` directory would make `git init` refuse (and a
    // real cycle's worktree never has one). Drop it, init, then PROVE the
    // gate's read answers before handing the path back — the same read the
    // fan-out makes, so a fixture git cannot read fails here, loudly, with
    // git's reason, rather than parking a pass the assertions never reach.
    rmSync(path.join(wt, ".git"), { recursive: true, force: true });
    initCleanRepo(wt);
    const read = await readWorktreeDiff(wt);
    if (!read.ok) throw new Error(`fixture worktree ${wt} is unreadable: ${read.reason}`);
    created[id] = wt;
  }
  return created;
}

/** `dir`'s own `.git` came from `tmpDir`'s pre-`git init` scaffold, which
 *  makes `git init` refuse there; drop it the same way before initialising. */
function initFixtureRepo(dir: string): void {
  rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  initCleanRepo(dir);
}

/** A state whose worktrees cover the map's keys, with the map as declared.
 *  Every path points at the fixture dir; `ensureWorktrees` makes each reviewed
 *  id its own repository, and the shared dir is what an id with no repo falls
 *  back to. */
function stateWith(dir: string, workstreams: Record<string, Ws>): WorkState {
  const s = initialState(1137, 1_000_000);
  const ids = Object.keys(workstreams);
  return {
    ...s,
    eventLog: [],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      worktrees: Object.fromEntries(ids.map((id) => [id, path.join(dir, ".worktrees", id)])),
      workstreams,
    },
  };
}

const APPROVED = {
  role: "adversarial-loop",
  ok: true,
  exitCode: 0,
  text: "ok",
  toolUses: [],
  ms: 1,
  loopOutcome: "approved",
  adversarialRounds: [{ round: 1, status: "APPROVED" as const, verdictParsed: true }],
};

const WS = {
  docs: { id: "docs", scope: "document", paths: ["b.txt"], outOfScope: ["a.txt"] },
  code: { id: "code", scope: "implement", paths: ["a.txt"], outOfScope: ["b.txt"] },
  extra: { id: "extra", scope: "test", paths: ["c.txt"], outOfScope: [] },
};

{
  // A: `ids` carries a phantom with no map entry. The review set is `ids`, so
  // the phantom is reviewed (at repoRoot, as on main). The docs prompt names
  // its real sibling and no one else.
  const dir = tmpDir("own-phantom");
  try {
    initCleanRepo(dir);
    const reviewed: string[] = [];
    const siblingsSeen: Record<string, string[]> = {};
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const m = params.context.match(/gating diff for workstream "([\w-]+)"/);
        reviewed.push(m?.[1] ?? "n1");
        siblingsSeen[m?.[1] ?? "n1"] = (params.scope?.siblings ?? []).map((s) => s.id);
        return APPROVED;
      },
    };
    const st = stateWith(dir, { docs: WS.docs, code: WS.code });
    // The phantom (an id with no map entry) is reviewed AT repoRoot, as on
    // main: that is the behaviour this assertion exists to pin, so it keeps
    // the fixture's own repo rather than a per-worktree path (#1634 makes a
    // non-repository path a refusal, which would park the pass before the
    // loop the assertion reads) — so it keeps the fixture's own repo, which IS
    // one (git init ran on it above), exactly as on main. The reviewed ids get
    // their own repositories, because #1634 turned "git could not tell" into a
    // refusal and a path nested inside another repo is not its own root.
    st.pipelineState.worktrees = {
      ...st.pipelineState.worktrees,
      ...(await ensureWorktrees(dir, ["docs", "code"])),
      phantom: dir,
    };
    const { outcomes } = await fanOutAdversarial(
      ctx,
      st,
      ["docs", "code", "phantom"],
      new Map(),
      false,
      null,
    );
    assert(
      reviewed.sort().join(",") === "code,docs,phantom",
      `A: the review set is the ids passed in (reviewed ${reviewed.join(",")})`,
    );
    assert(
      outcomes
        .map((o) => o.id)
        .sort()
        .join(",") === "code,docs,phantom",
      "A: one outcome per id passed in",
    );
    assert(
      JSON.stringify(siblingsSeen.docs) === JSON.stringify(["code"]),
      `A: docs' sibling list comes from the map (got ${JSON.stringify(siblingsSeen.docs)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // B: the map has a key ("extra") the `ids` argument does not. It is not
  // reviewed, but the docs prompt still names it as a sibling.
  const dir = tmpDir("own-extra");
  try {
    initCleanRepo(dir);
    const reviewed: string[] = [];
    const siblingsSeen: Record<string, string[]> = {};
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const m = params.context.match(/gating diff for workstream "([\w-]+)"/);
        reviewed.push(m?.[1] ?? "n1");
        siblingsSeen[m?.[1] ?? "n1"] = (params.scope?.siblings ?? []).map((s) => s.id);
        return APPROVED;
      },
    };
    const st = stateWith(dir, WS);
    // Every reviewed id reads the fixture dir itself, which `initCleanRepo`
    // made a real repository above — the pre-#1634 shape, kept, because it was
    // always a repository (a BARE dir is what #1634 turned into a refusal).
    st.pipelineState.worktrees = Object.fromEntries(Object.keys(WS).map((k) => [k, dir]));
    // A real base commit, so the per-workstream diff reads cleanly.
    writeFileSync(path.join(dir, "a.txt"), "base a\n");
    writeFileSync(path.join(dir, "b.txt"), "base b\n");
    writeFileSync(path.join(dir, "c.txt"), "base c\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "base content"');
    st.pipelineState.baseSha = git(dir, "rev-parse HEAD").trim();
    const { outcomes } = await fanOutAdversarial(ctx, st, ["docs", "code"], new Map(), false, null);
    assert(
      outcomes
        .map((o) => o.id)
        .sort()
        .join(",") === "code,docs" && !reviewed.includes("extra"),
      `B: a map key absent from ids is not reviewed (reviewed ${reviewed.join(",")})`,
    );
    assert(
      JSON.stringify(siblingsSeen.docs?.slice().sort()) === JSON.stringify(["code", "extra"]),
      `B: docs' sibling list includes the map's extra key (got ${JSON.stringify(siblingsSeen.docs)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // C: with NO workstreams map (the N=1 default shape), `ids` is the source of
  // truth — a single default workstream, N=1 prompt, no sibling scope.
  const dir = tmpDir("own-fallback");
  try {
    initFixtureRepo(dir);
    let n1 = false;
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        if (!params.context.includes("workstream") && params.scope === undefined) n1 = true;
        return APPROVED;
      },
    };
    const s = initialState(1137, 1_000_000);
    // The default workstream is the directory itself, which `git(dir, "init")`
    // above already made a repository.
    const st: WorkState = {
      ...s,
      eventLog: [],
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        worktrees: { default: dir },
      },
    };
    const { outcomes } = await fanOutAdversarial(ctx, st, ["default"], new Map(), false, null);
    assert(
      outcomes.length === 1 && n1,
      "C: no workstreams map falls back to the argument ids (N=1 prompt)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // D: the map has three keys but `ids` names ONE of them. N>1 follows the
  // map (not the id count), so the single review is still a multi-workstream
  // review: its own branch-completed + branches-converged events are written.
  // This is deliberate — the map is the cycle's workstream count.
  const dir = tmpDir("own-subset");
  try {
    initCleanRepo(dir);
    const reviewed: string[] = [];
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const m = params.context.match(/gating diff for workstream "([\w-]+)"/);
        reviewed.push(m?.[1] ?? "n1");
        return APPROVED;
      },
    };
    const st = stateWith(dir, WS);
    // As in B: the reviewed ids read the fixture dir, which is a real repo.
    st.pipelineState.worktrees = Object.fromEntries(Object.keys(WS).map((k) => [k, dir]));
    writeFileSync(path.join(dir, "b.txt"), "base b\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "base content"');
    st.pipelineState.baseSha = git(dir, "rev-parse HEAD").trim();
    const { next, outcomes } = await fanOutAdversarial(ctx, st, ["docs"], new Map(), false, null);
    assert(
      reviewed.join(",") === "docs" && outcomes.length === 1,
      `D: only the id passed in is reviewed (reviewed ${reviewed.join(",")})`,
    );
    assert(
      next.eventLog.some((e) => e.kind === "branches-converged") &&
        next.eventLog.some((e) => e.kind === "branch-completed" && e.workstreamId === "docs"),
      "D: the map's N>1 shape writes the fan-out events for the one reviewed id",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
