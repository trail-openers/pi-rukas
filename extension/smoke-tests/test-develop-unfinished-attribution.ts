#!/usr/bin/env bun
/**
 * #1768 (2/2) — a develop pass that exits 0 mid-step is not "done": what the
 * driver DOES about it, and every surface that has to say so.
 *
 * The rule and its commit attribution are pinned by
 * `test-develop-unfinished.ts`; this file covers the consequences:
 *  (5) the corrective round runs exactly once per unfinished workstream, is
 *      handed the paths and the no-reset instruction, and never calls reset
 *  (6) a round that finishes → no park; a round that quits again → park on
 *      `develop-incomplete-uncommitted` with the paths in evidence; a clean
 *      no-commit pass never parks here; an unreadable tree does
 *  (7) the cap is known to every registry (validator, headless caps, cause
 *      table) and the explanation names the paths
 *  (8) a normal pass that committed its own work is untouched: no fragment, no
 *      park, and the safety net still reports its leftovers rather than
 *      committing a pass the driver cannot certify
 *
 * Each of the two files runs alone (`bun extension/smoke-tests/<file>.ts`).
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { decideGreenFromTree } from "../src/work-develop-unfinished-facts.ts";
import { runUnfinishedCorrectiveRound } from "../src/work-develop-unfinished-round.ts";
import {
  developUnfinished,
  parkOnDevelopUnfinished,
  unfinishedBranchCompleted,
  unfinishedCorrectivePrompt,
} from "../src/work-develop-unfinished.ts";
import { FIXED_CAP_CAUSE } from "../src/work-driver-cause-table.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { applySafetyNet } from "../src/work-driver-safety-net.ts";
// The net's default executor, used where the test wants the net's real
// behaviour rather than a fake's.
import { execp } from "../src/work-driver-verify.ts";
import { CAP_HIT_FIXED_LITERALS, isKnownCap } from "../src/workflow-state-validate-caps.ts";
import { type WorkEvent, type WorkState, appendEvent } from "../src/workflow-state.ts";
import {
  childCommitPaths,
  makeAssert,
  mkRepo,
  stateWith,
} from "./lib/develop-unfinished-fixture.ts";
import { realExec } from "./lib/exec-fake.ts";

const { assert, failed } = makeAssert();

// -------------------------------------------------- (5) the round: once, resumed
async function caseFive() {
  const calls: { id: string; cwd: string; prompt: string; label: string }[] = [];
  const unfinished = [
    {
      id: "default",
      cwd: "/tmp/wt-a",
      base: "abc",
      paths: ["src/a.ts", "docs/b.md"],
      reason: "r",
    },
  ];
  const ctx = { issue: 1768 } as never;
  // The live holder the fan-out closures write through, exactly as the step
  // hands it over.
  const stateRef = { current: stateWith(1768, []) };
  stateRef.current = appendEvent(
    stateRef.current,
    unfinishedBranchCompleted({
      id: "default",
      ms: 1,
      reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts", "docs/b.md"]),
    }),
  );
  const out = await runUnfinishedCorrectiveRound({
    ctx,
    stateRef,
    unfinished,
    multi: false,
    scopeFor: () => "implement the gate",
    pathsFor: () => ["src/a.ts"],
    runPass: async (id, cwd, corrective) => {
      calls.push({ id, cwd, ...corrective });
      // The round's own record: still unfinished (another `agent done` over a
      // dirty tree), appended through the live ref as the real closure does.
      stateRef.current = appendEvent(
        stateRef.current,
        unfinishedBranchCompleted({
          id,
          ms: 1,
          reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts", "docs/b.md"]),
        }),
      );
      return { id, ok: false };
    },
  });
  assert(calls.length === 1, "(5) exactly ONE corrective dispatch per unfinished workstream");
  assert(calls[0]?.id === "default", "(5) the round targets the unfinished workstream");
  assert(calls[0]?.cwd === "/tmp/wt-a", "(5) the round runs IN the quitting child's worktree");
  assert(
    calls[0]?.prompt.includes("src/a.ts") && calls[0]?.prompt.includes("docs/b.md"),
    "(5) the prompt names the paths the child left uncommitted",
  );
  assert(
    calls[0]?.prompt.includes("NOT been reset") &&
      calls[0]?.prompt.includes("git reset --hard") &&
      calls[0]?.prompt.includes("git clean"),
    "(5) the prompt forbids discarding the work and says the tree was not reset",
  );
  assert(
    calls[0]?.prompt.includes("git commit") && calls[0]?.prompt.includes("Do NOT push"),
    "(5) the prompt ends in the commit the quitting child never made, and forbids pushing",
  );
  assert(
    calls[0]?.label.includes("unfinished-corrective"),
    "(5) the dispatch is labelled as the corrective round",
  );
  assert(out.blocked.join() === "default" && out.parked === true, "(5) still unfinished → park");

  // A closure that throws (dispatch failure) is recorded by the closure itself;
  // the round must not crash and must still judge from the tree.
  const ref2 = { current: stateWith(1768, []) };
  ref2.current = appendEvent(
    ref2.current,
    unfinishedBranchCompleted({
      id: "ws",
      ms: 1,
      reading: decideGreenFromTree({ commits: 0 }, ["x.ts"]),
    }),
  );
  const out2 = await runUnfinishedCorrectiveRound({
    ctx,
    stateRef: ref2,
    unfinished: [{ id: "ws", cwd: "/tmp/wt", base: "b", paths: ["x.ts"], reason: "r" }],
    multi: false,
    scopeFor: () => undefined,
    pathsFor: () => [],
    runPass: async () => {
      throw new Error("dispatch blew up");
    },
  });
  assert(
    out2.parked === true,
    "(5) a throwing corrective dispatch still parks, never green-lights",
  );

  const prompt = unfinishedCorrectivePrompt({
    issue: 1768,
    workstreamId: "ws-1",
    parallel: true,
    scope: "the scope",
    paths: ["src/x.ts"],
    uncommitted: [],
  });
  assert(
    prompt.includes("workstream `ws-1`") &&
      prompt.includes("the scope") &&
      prompt.includes("src/x.ts"),
    "(5) the parallel prompt carries the workstream id, scope and declared paths",
  );
  assert(
    prompt.includes("could not read the tree"),
    "(5) an unreadable tree is told to the developer, not hidden",
  );
}

/** A `branch-completed` for a workstream the driver CERTIFIED as done — the
 *  ordinary green, and the record that CLEARS an earlier unfinished one. The
 *  round's fake closures emit exactly what `classifyDevelopPass` emits for a
 *  pass with its own commits: `ok: true`, no `unfinished` fragment. Leftovers
 *  are NOT a fragment (a green pass may have them; the net notes them), so a
 *  reader must key on the reading being `done`, never on the dirt list. */
function greenBranchCompleted(id: string): WorkEvent {
  return {
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok: true,
    ms: 1,
    at: Date.now(),
  };
}

// ------------------------------------------ (6) recovery vs park, end to end
async function caseSix() {
  const { root, wt, baseSha } = await mkRepo();
  try {
    writeFileSync(path.join(wt, "wip.ts"), "wip\n");
    const exec = realExec;
    const ctx = { issue: 1768 } as never;

    // (6a) the round commits its own work → no park, and the net still recovers
    // the leftovers it earned. The tree is put back to the state a green pass
    // leaves: the corrective commit landed, and one path is still uncommitted.
    writeFileSync(path.join(wt, "done.ts"), "feat(x): finished the step\n");
    await childCommitPaths(wt, "feat(x): finished the step", ["done.ts"]);
    writeFileSync(path.join(wt, "leftover.ts"), "still uncommitted\n");
    const ref1 = { current: stateWith(1768, []) };
    ref1.current = appendEvent(
      ref1.current,
      unfinishedBranchCompleted({
        id: "default",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, ["wip.ts"]),
      }),
    );
    const out1 = await runUnfinishedCorrectiveRound({
      ctx,
      stateRef: ref1,
      unfinished: [{ id: "default", cwd: wt, base: baseSha, paths: ["wip.ts"], reason: "r" }],
      multi: false,
      scopeFor: () => undefined,
      pathsFor: () => [],
      runPass: async (id) => {
        ref1.current = appendEvent(ref1.current, greenBranchCompleted(id));
        return { id, ok: true };
      },
    });
    assert(out1.parked === false, "(6a) a corrective round that commits → no park");
    assert(out1.recovered.join() === "default", "(6a) the workstream is reported recovered");
    // The net is handed the worktree map and the base the step holds (without
    // the map it has no worktree to visit), and the REAL executor: the fake
    // above resolves every git call successfully, which would make the net's
    // `mergeInProgress` probe answer "yes" and skip for a reason unrelated to
    // the product.
    const netState: WorkState = {
      ...ref1.current,
      pipelineState: {
        ...ref1.current.pipelineState,
        worktrees: { default: wt },
        baseSha,
      },
    };
    const afterNet = await applySafetyNet(
      { host: {}, repoRoot: root, verifyExecFn: execp } as never,
      netState,
    );
    // #1768 keeps the net's AC2 as it was: a pass WITH its own commits is not
    // the net's to rescue, so its leftover dirt is reported, not committed onto
    // the branch under a commit the review never saw. The consequence this issue
    // needs is the asymmetry — the net creates no commit that could certify a
    // pass, and for a pass without its own commits the phases never reach it.
    assert(
      !afterNet.eventLog.some((e) => e.kind === "safety-net-commit"),
      "(6a) the net creates no commit for a pass that already has its own (AC2 preserved)",
    );
    assert(
      afterNet.pipelineState.plumbReports.some(
        (r) => r.body.includes("left over") || r.body.includes("left out of the PR"),
      ),
      "(6a) the leftover is REPORTED to the operator rather than silently committed",
    );

    // (6b) the round quits the same way → park on the named cap with the paths.
    const ref2 = { current: stateWith(1768, []) };
    ref2.current = appendEvent(
      ref2.current,
      unfinishedBranchCompleted({
        id: "ws-1",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts"]),
      }),
    );
    const out2 = await runUnfinishedCorrectiveRound({
      ctx,
      stateRef: ref2,
      unfinished: [{ id: "ws-1", cwd: wt, base: baseSha, paths: ["src/a.ts"], reason: "r" }],
      multi: true,
      scopeFor: () => undefined,
      pathsFor: () => [],
      runPass: async (id) => {
        ref2.current = appendEvent(
          ref2.current,
          unfinishedBranchCompleted({
            id,
            ms: 1,
            reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts"]),
          }),
        );
        return { id, ok: false };
      },
    });
    assert(out2.parked === true, "(6b) a second unfinished pass parks");
    const parked = parkOnDevelopUnfinished(ref2.current, 1768);
    const tail = parked?.eventLog[parked.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "develop-incomplete-uncommitted",
      "(6b) the cap is the event-log tail",
    );
    assert(
      tail?.kind === "cap-hit" && tail.nextStep === "handoff",
      "(6b) the park routes to handoff, not to the verify gate",
    );
    assert(
      tail?.kind === "cap-hit" && (tail.evidence ?? "").includes("src/a.ts"),
      "(6b) the cap's evidence names the unfinished path",
    );
    assert(
      parkOnDevelopUnfinished(stateWith(1768, []), 1768) === undefined,
      "(6b) nothing to park when no pass is unfinished",
    );

    // (6c) a clean no-commit pass is NOT this cap's finding.
    const s3 = stateWith(1768, [
      unfinishedBranchCompleted({
        id: "d",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, []),
      }),
    ]);
    assert(
      parkOnDevelopUnfinished(s3, 1768) === undefined,
      "(6c) a clean pass with no own commits stays the existing GREEN_DOWNGRADE",
    );

    // (6d) unreadable tree parks (the driver cannot certify a pass it cannot read).
    const s4 = stateWith(1768, [
      unfinishedBranchCompleted({
        id: "d",
        ms: 1,
        reading: decideGreenFromTree({ unreadable: "x" }, []),
      }),
    ]);
    assert(parkOnDevelopUnfinished(s4, 1768) !== undefined, "(6d) an unreadable tree parks");

    // (7) registries + explanation.
    assert(
      isKnownCap("develop-incomplete-uncommitted") &&
        CAP_HIT_FIXED_LITERALS.includes("develop-incomplete-uncommitted"),
      "(7) the state validator knows the cap",
    );
    assert(
      FIXED_CAPS.includes("develop-incomplete-uncommitted"),
      "(7) the headless cap list knows it",
    );
    assert(
      FIXED_CAP_CAUSE["develop-incomplete-uncommitted"] !== undefined,
      "(7) the cause table has a row",
    );
    assert(
      FIXED_CAP_CAUSE["develop-incomplete-uncommitted"]?.cls === "change",
      "(7) it is a change problem, not an environment one — the work is on disk",
    );
    const capEv = parked?.eventLog[parked.eventLog.length - 1];
    const explained =
      capEv?.kind === "cap-hit" ? explainCap(capEv.cap, parked!) : "(no cap to explain)";
    assert(
      explained.includes("src/a.ts") && explained.includes("--restart"),
      "(7) the handoff explanation names the path and the recovery command",
    );
    assert(
      explainCap("develop-incomplete-uncommitted", stateWith(1768, [])).includes("git -C"),
      "(7) with no record to read, the explanation still tells the operator where to look",
    );

    // (8) ordinary passes are untouched.
    const s5 = stateWith(1768, [
      { kind: "branch-completed", step: "develop", workstreamId: "d", ok: true, ms: 1, at: 1 },
    ]);
    assert(
      developUnfinished(s5.eventLog).length === 0,
      "(8) an ordinary green carries no fragment",
    );
    assert(
      parkOnDevelopUnfinished(s5, 1768) === undefined,
      "(8) an ordinary green never parks here",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await caseFive();
await caseSix();

if (failed()) {
  console.error("\nFAILED");
  process.exit(1);
}
console.log("\nall pass");
