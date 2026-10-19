#!/usr/bin/env bun
/**
 * #1667 — the converge check after a corrective develop round. The check still
 * RUNS (a corrected cycle may not skip a check a first-time pass gets), but its
 * corrective re-dispatch is suppressed: an incomplete result parks at
 * develop-incomplete-deliverables with the converge evidence, and a complete
 * result continues. Driven through recordDevelopVerdict (the one verdict seam)
 * with a fake git read that reports which files the diff holds.
 *
 *   (a) after a corrective round, an incomplete converge result parks with no
 *       developer dispatch and the converge evidence on the state.
 *   (b) after a corrective round, a complete converge result continues.
 *   (c) a first-pass incomplete result still dispatches its corrective developer.
 */

import { initialState, type WorkState } from "../src/workflow-state.ts";
import type { DevelopGate } from "../src/work-driver-develop-verdict.ts";
import { recordDevelopVerdict } from "../src/work-driver-develop-verdict.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

delete process.env.PI_ENSEMBLE_CONVERGE;

const ISSUE = 1667;
const BASE = "a".repeat(40);
const REPO = "/tmp/pi-ens-1667-converge-repo";
const WT = `${REPO}/.worktrees/issue-1667-a`;

/** A state with two declared deliverables, both owned by workstream a. */
function stateWithSpec(): WorkState {
  const s = initialState(ISSUE);
  s.pipelineState.baseSha = BASE;
  s.pipelineState.worktrees = { a: WT };
  s.pipelineState.workstreamBaseShas = { a: BASE };
  s.pipelineState.workstreams = {
    a: {
      id: "a",
      scope: "alpha and beta",
      paths: ["extension/src/alpha.ts", "extension/src/beta.ts"],
      outOfScope: [],
    },
  };
  s.pipelineState.normalisedSpec = {
    intent: "add alpha and beta",
    deliverables: [
      { id: "d1", description: "alpha", paths: ["extension/src/alpha.ts"] },
      { id: "d2", description: "beta", paths: ["extension/src/beta.ts"] },
    ],
    acceptanceCriteria: ["alpha exists", "beta exists"],
  } as unknown as WorkState["pipelineState"]["normalisedSpec"];
  return s;
}

/** A fake git read: the committed diff and the worktree status both report `files`. */
function execWith(files: string[]) {
  return async (cmd: string) => {
    if (cmd.startsWith("git diff --name-only")) return { stdout: `${files.join("\n")}\n` };
    return { stdout: "" };
  };
}

const okGate = { ok: true, failures: [] } as unknown as DevelopGate;

async function verdict(
  files: string[],
  opts: { afterCorrectiveRound?: true; dispatchResult?: unknown },
) {
  const state = stateWithSpec();
  let dispatches = 0;
  const dispatch = (async () => {
    dispatches += 1;
    return (
      opts.dispatchResult ?? {
        role: "developer",
        ok: false,
        text: "gave up",
        toolUses: [],
        ms: 1,
        exitCode: 1,
        transcriptPath: "/tmp/x.json",
      }
    );
  }) as unknown as NonNullable<DriverContext["dispatchFn"]>;
  const ctx = {
    host: {},
    repoRoot: REPO,
    issue: ISSUE,
    verifyExecFn: execWith(files),
  } as unknown as CycleContext;
  const after = await recordDevelopVerdict({
    ctx,
    state,
    stateRef: { current: state },
    ids: ["a"],
    verdicts: [{ id: "a", ok: true }],
    gate: okGate,
    execFn: execWith(files) as never,
    dispatch,
    afterCorrectiveRound: opts.afterCorrectiveRound,
    onVerifyFailed: async (s) => s,
  });
  return { after, dispatches };
}

const lastEvent = (s: WorkState) => s.eventLog[s.eventLog.length - 1];

// ── (a) after a corrective round, an incomplete result parks, no dispatch ──
{
  const { after, dispatches } = await verdict(["extension/src/alpha.ts"], {
    afterCorrectiveRound: true,
  });
  const last = lastEvent(after);
  assert(
    dispatches === 0,
    `(a) no developer is dispatched after the corrective round (got ${dispatches})`,
  );
  assert(
    last?.kind === "cap-hit" &&
      last.cap === "develop-incomplete-deliverables" &&
      last.nextStep === "handoff",
    `(a) parks at develop-incomplete-deliverables (got ${last?.kind === "cap-hit" ? last.cap : last?.kind})`,
  );
  assert(
    last?.kind === "cap-hit" && (last.evidence ?? "").includes("d2 (extension/src/beta.ts)"),
    "(a) the cap evidence names the missing deliverable and its path",
  );
  const d2 = after.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "d2");
  assert(d2?.status === "absent", "(a) the converge evidence is recorded on the state (d2 absent)");
  assert(
    !after.eventLog.some((e) => e.kind === "converge-redispatch"),
    "(a) no converge-redispatch event is written",
  );
}

// ── (b) after a corrective round, a complete result continues ─────────────
{
  const { after, dispatches } = await verdict(["extension/src/alpha.ts", "extension/src/beta.ts"], {
    afterCorrectiveRound: true,
  });
  assert(dispatches === 0, `(b) a complete result dispatches nothing (got ${dispatches})`);
  assert(lastEvent(after)?.kind !== "cap-hit", "(b) a complete result raises no cap-hit");
  const d2 = after.pipelineState.convergeEvidence?.deliverables.find((d) => d.id === "d2");
  assert(d2?.status === "implemented", "(b) the converge check ran and recorded d2 implemented");
}

// ── (c) a first-pass incomplete result still dispatches its corrective ────
{
  const { after, dispatches } = await verdict(["extension/src/alpha.ts"], {});
  assert(
    dispatches === 1,
    `(c) a first-pass incomplete result dispatches one corrective developer (got ${dispatches})`,
  );
  const last = lastEvent(after);
  assert(
    last?.kind === "cap-hit" && (last.evidence ?? "").includes("corrective re-dispatch FAILED"),
    "(c) with the corrective child failing, the first pass parks with the never-ran evidence",
  );
}

if (exit !== 0) process.exit(exit);
console.log("all corrective-converge assertions passed");
