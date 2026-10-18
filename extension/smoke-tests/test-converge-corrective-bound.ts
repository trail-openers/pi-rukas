#!/usr/bin/env bun
/**
 * #1350 + #1248 — the converge corrective round is bounded, and a failed round
 * is judged on the tree it left, not on the verdict from before it.
 *
 *   1. The corrective dispatch carries `childBoundMs` = 20 min per missing
 *      deliverable, at most 45 min.
 *   2. A round ended at its bound is named as such (not "child reported
 *      failure"), and the cap evidence re-checks converge on the round's tree
 *      and names the deliverables the round did produce.
 *   3. A killed round that left every deliverable on disk does not park on a
 *      stale "absent" verdict: it takes the success path (converge-redispatch).
 *   4. The corrective prompt no longer sends the child into full-gate runs.
 *
 * Offline: git is a stub over a mutable set of "present" files.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { correctiveChildBoundMs } from "../src/spawn-child-bound.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runConvergeGateHandler } from "../src/work-driver-converge-gate.ts";
import { buildConvergeCorrectivePrompt } from "../src/work-driver-converge.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_VERIFY = "0";
delete process.env.PI_ENSEMBLE_CORRECTIVE_BOUND_MS;

const MIN = 60_000;
assert(correctiveChildBoundMs(1) === 20 * MIN, "bound: 20 min for one missing deliverable");
assert(correctiveChildBoundMs(2) === 40 * MIN, "bound: 40 min for two");
assert(correctiveChildBoundMs(5) === 45 * MIN, "bound: at most 45 min");

const repoRoot = path.join(tmpdir(), "converge-bound-repo");
function stateWith(ids: string[]): WorkState {
  const base = initialState(1350, 1000);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      worktrees: { default: "repoRoot" },
      baseSha: "a".repeat(40),
      normalisedSpec: {
        intent: "x",
        deliverables: ids.map((id) => ({
          id,
          description: `do ${id}`,
          paths: [`src/${id}.ts`],
        })),
        acceptanceCriteria: ["x"],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "proceed",
        rationale: "",
      },
    },
  };
}

async function run(ids: string[], writes: string[]) {
  const present = new Set<string>();
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot,
    issue: 1350,
    verifyExecFn: async (cmd: string) => {
      if (cmd.startsWith("git diff --name-only")) return { stdout: [...present].join("\n") };
      if (cmd.startsWith("git rev-parse")) return { stdout: "b".repeat(40) };
      return { stdout: "" };
    },
  } as unknown as DriverContext;
  let bound: number | undefined;
  const dispatch = (async (_h: unknown, _s: unknown, opts: { childBoundMs?: number }) => {
    bound = opts.childBoundMs;
    for (const w of writes) present.add(w);
    return {
      role: "developer",
      ok: false,
      killCause: "child-bound",
      text: "",
      toolUses: [],
      ms: 1,
    };
  }) as unknown as NonNullable<DriverContext["dispatchFn"]>;
  const next = await runConvergeGateHandler(ctx, stateWith(ids), dispatch);
  const cap = next.eventLog.find((e) => e.kind === "cap-hit");
  return { next, bound, cap: cap?.kind === "cap-hit" ? cap : undefined };
}

// (1) + (2): two missing, the killed round produced one.
{
  const r = await run(["d1", "d2"], ["src/d1.ts"]);
  assert(
    r.bound === 40 * MIN,
    "the corrective dispatch carries a 40-min bound for two deliverables",
  );
  assert(r.cap?.cap === "develop-incomplete-deliverables", "a still-absent deliverable caps");
  const ev = r.cap?.evidence ?? "";
  assert(/ended at its 40-min run bound/.test(ev), "the evidence names the bound, not a failure");
  assert(!/child reported failure/.test(ev), "...and never says the child reported failure");
  assert(
    /re-checked on the tree the round left: missing deliverable\(s\): d2/.test(ev),
    "...re-checks converge on the round's tree",
  );
  assert(/the round did produce d1/.test(ev), "...and names what the round produced");
  const d1 = r.next.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "d1");
  assert(
    d1 !== undefined && d1.status !== "absent",
    "the recorded converge evidence is the fresh one",
  );
}

// (3): one missing, the killed round wrote it.
{
  const r = await run(["d1"], ["src/d1.ts"]);
  assert(
    !r.next.eventLog.some(
      (e) => e.kind === "cap-hit" && e.cap === "develop-incomplete-deliverables",
    ),
    "a killed round that left every deliverable on disk does not park on the stale verdict",
  );
  assert(
    r.next.eventLog.some((e) => e.kind === "converge-redispatch"),
    "...it takes the success path, so the gates judge its tree",
  );
}

// (4): the prompt.
{
  const s = stateWith(["d1"]);
  const verdict = { absent: [{ id: "d1", missing: ["src/d1.ts"] }] } as unknown as Parameters<
    typeof buildConvergeCorrectivePrompt
  >[1];
  const plain = buildConvergeCorrectivePrompt(s, verdict);
  assert(
    !/re-run the local quality gates/.test(plain),
    "prompt: no instruction to re-run the gates",
  );
  assert(
    /driver re-runs the full gate/.test(plain),
    "prompt: says the driver re-runs the full gate",
  );
  const fast = buildConvergeCorrectivePrompt(s, verdict, "bun run fast");
  assert(fast.includes("`bun run fast`"), "prompt: names .pi/verify-cmd-fast when present");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
