#!/usr/bin/env bun
/**
 * #1137 — the fix pass keeps the pre-pass workstreams map (the overlay that
 * widens a fence for one pass never persists), and the plumb-question reader
 * ignores a plumb report carried over from an earlier pass.
 */

import { rmSync } from "node:fs";
import type { DispatchResult } from "../src/types.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { freshPlumbQuestion } from "../src/work-driver-adversarial-plumb.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { devCommit, fixState, repoWithFile, singleState } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

// (a) A fix pass whose findings name a path outside the declared fence widens
// the fence for that pass only: the workstreams map persisted afterwards is
// the pre-pass map, byte for byte.
{
  const dir = repoWithFile("fix-workstreams");
  try {
    const state = fixState(dir, ["b.txt"]);
    const before = JSON.stringify(state.pipelineState.workstreams);
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
      repoRoot: dir,
      issue: 1114,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") devCommit(dir, "a.txt", "two\n");
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as DispatchResult;
      },
    };
    const after = await runAdversarialFixPass(ctx, state, pendingFixes(state.eventLog), 1);
    assert(
      JSON.stringify(after.pipelineState.workstreams) === before,
      "a fix pass leaves pipelineState.workstreams equal to the pre-pass map",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (b) A plumb report whose body was already present before this pass is not
// this pass's question: freshPlumbQuestion returns null (generic evidence).
// A report new to the pass is still surfaced.
{
  const body = "[ensemble:plumb] scope-ambiguity: which file owns the fix?";
  const base = singleState("/unused");
  const state: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      plumbReports: [{ step: "develop", role: "driver", body, at: 1 }],
    },
  };
  assert(
    freshPlumbQuestion(state, new Set([body])) === null,
    "a plumb report already in the prior set is ignored (null)",
  );
  const fresh = freshPlumbQuestion(state, new Set());
  assert(
    typeof fresh === "string" && /scope-ambiguity/.test(fresh),
    "a plumb report new to this pass is surfaced as the question",
  );
}

process.exit(exit);
