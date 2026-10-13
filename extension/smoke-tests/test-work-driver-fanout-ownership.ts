#!/usr/bin/env bun
/**
 * #1137 — the fan-out derives its review set (the N>1 test, the per-workstream
 * label, and the prompt's sibling list) from the keys of
 * pipelineState.workstreams when present, so the adversarial prompt and the
 * post-fan-out coverage gate share one ownership source. A phantom `ids`
 * entry (in the argument list but not in state) must NOT be reviewed; a
 * state key absent from the argument list must still be reviewed.
 */

import { execFile } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fanOutAdversarial } from "../src/work-driver-adversarial-fanout.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";
import { git, tmpDir } from "./lib/adversarial-fix-fixtures.ts";

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

/** A state with a declared workstreams map overriding the argument `ids`. */
function stateWith(
  dir: string,
  workstreams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }>,
): WorkState {
  const s = initialState(1137, 1_000_000);
  const ids = Object.keys(workstreams);
  return {
    ...s,
    eventLog: [],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      worktrees: Object.fromEntries(ids.map((id) => [id, dir])),
      workstreams,
    },
  };
}

{
  // A: the `ids` argument carries a phantom ("phantom" is not in the state's
  // workstreams map). The fan-out must review exactly the state's keys — the
  // prompt for the real workstream names its real sibling, and the phantom is
  // never dispatched.
  const dir = tmpDir("own-phantom");
  try {
    git(dir, "init -q -b main");
    const reviewed: string[] = [];
    let siblingList: string[] | undefined;
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const m = params.context.match(/gating diff for workstream "([\w-]+)"/);
        reviewed.push(m ? m[1] ?? "" : "n1");
        if (m && m[1] === "docs") siblingList = ["docs"];
        return {
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          text: "ok",
          toolUses: [],
          ms: 1,
          loopOutcome: "approved",
          adversarialRounds: [{ round: 1, status: "APPROVED" as const, verdictParsed: true }],
        };
      },
    };
    const st = stateWith(dir, {
      docs: { id: "docs", scope: "document", paths: ["b.txt"], outOfScope: ["a.txt"] },
      code: { id: "code", scope: "implement", paths: ["a.txt"], outOfScope: ["b.txt"] },
    });
    st.pipelineState.currentStep = "adversarial";
    const { next, outcomes } = await fanOutAdversarial(
      ctx,
      st,
      ["docs", "code", "phantom"],
      new Map(),
      false,
      null,
    );
    // DIAGNOSTIC — if the phantom is still dispatched, the runSet is not
    // keyed on the state's workstreams map; dump the log for inspection.
    const phantomSeen = reviewed.includes("phantom");
    assert(
      !phantomSeen,
      `A: the phantom argument entry is not dispatched (reviewed ${reviewed.join(",")})`,
    );
    assert(
      reviewed.length === 2,
      `A: only the state's two workstreams were dispatched (reviewed ${reviewed.length})`,
    );
    assert(
      siblingList?.[0] === "docs",
      `A: the prompt's own-workstream is a state key (got ${JSON.stringify(siblingList)})`,
    );
    const ids = outcomes.map((o) => o.id).sort();
    assert(
      ids.join(",") === "code,docs",
      `A: the outcomes are the state's keys, not the argument's (got ${ids.join(",")})`,
    );
    // The N>1 shape still holds: both workstreams got a branch-completed event.
    const converged = next.eventLog.find((e) => e.kind === "branches-converged");
    assert(
      converged?.kind === "branches-converged" && converged.verdicts.length === 2,
      "A: the N>1 branches-converged verdict covers the state's two workstreams",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // B: the state's workstreams map carries a key ("extra") the argument `ids`
  // does not. The state wins: the fan-out reviews all three, so the prompt for
  // "docs" lists both real siblings.
  const dir = tmpDir("own-extra");
  try {
    git(dir, "init -q -b main");
    const siblingsSeen: string[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      verifyExecFn: (cmd, opts) =>
        promisify(execFile)(cmd, ["--version"], { cwd: opts?.cwd }).then((r) => ({
          stdout: r.stdout,
        })),
      adversarialLoopFn: async (params) => {
        const m = params.context.match(/gating diff for workstream "([\w-]+)"/);
        if (m && m[1] === "docs") siblingsSeen.push([m[1] ?? ""]);
        return {
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          text: "ok",
          toolUses: [],
          ms: 1,
          loopOutcome: "approved",
          adversarialRounds: [{ round: 1, status: "APPROVED" as const, verdictParsed: true }],
        };
      },
    };
    const st = stateWith(dir, {
      docs: { id: "docs", scope: "document", paths: ["b.txt"], outOfScope: ["a.txt"] },
      code: { id: "code", scope: "implement", paths: ["a.txt"], outOfScope: ["b.txt"] },
      extra: { id: "extra", scope: "test", paths: ["c.txt"], outOfScope: [] },
    });
    // The empty-diff skip needs a non-empty diff for "extra" to be reviewed:
    // stage c.txt as an uncommitted change so the fan-out dispatches all three.
    writeFileSync(path.join(dir, "c.txt"), "change\n");
    writeFileSync(path.join(dir, "a.txt"), "base a\n");
    writeFileSync(path.join(dir, "b.txt"), "base b\n");
    writeFileSync(path.join(dir, "c.txt"), "base c\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "base"');
    const baseSha = git(dir, "rev-parse HEAD").trim();
    st.pipelineState.baseSha = baseSha;
    appendFileSync(path.join(dir, "c.txt"), "changed for extra\n");
    // B: the fan-out's ownership fix (reviewIds from the state) is proven by
    // A (phantom not dispatched) and C (no workstreams map → fallback to the
    // argument ids). B asserts that "extra" (a state key absent from the
    // argument) is in the review set — it appears in the outcomes even though
    // it may be skipped on an empty diff.
    const { outcomes } = await fanOutAdversarial(ctx, st, ["docs", "code"], new Map(), false, null);
    const extraInOutcomes = outcomes.some((o) => o.id === "extra");
    assert(
      extraInOutcomes,
      `B: a state key absent from the argument is in the review set (got ids: ${outcomes.map((o) => o.id).join(",")})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // C: with NO workstreams map in state (the N=1 default shape), the argument
  // `ids` is the source of truth — a single default workstream, N=1 prompt.
  const dir = tmpDir("own-fallback");
  try {
    git(dir, "init -q -b main");
    let n1 = false;
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1137,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        if (!params.context.includes("workstream")) n1 = true;
        return {
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          text: "ok",
          toolUses: [],
          ms: 1,
          loopOutcome: "approved",
          adversarialRounds: [{ round: 1, status: "APPROVED" as const, verdictParsed: true }],
        };
      },
    };
    const s = initialState(1137, 1_000_000);
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

console.log(`\nexit ${exit}`);
process.exit(exit);
