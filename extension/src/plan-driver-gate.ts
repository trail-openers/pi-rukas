import type { CorrectiveRedraftCtx } from "./plan-driver-redraft.ts";
import type { PlanDispatchFn } from "./plan-driver-seams.ts";
import { settledGapsSection } from "./plan-gap-disclosure.ts";
import type { GapGateLoopResult } from "./plan-gaps.ts";
import { runGapGateLoop } from "./plan-gaps.ts";
/**
 * plan-driver-gate — the Phase-4 wiring: the arguments `runGapGateLoop` is
 * called with, extracted from plan-driver.ts at the AGENTS.md §12 size cap.
 *
 * The loop itself (rounds, terminal rule, residual union, cap reasons) lives in
 * plan-gaps.ts. What lives here is the *assembly* the orchestrator owes it: the
 * bounded child dispatch, the round-1-vs-round-2 prompt choice, and the
 * corrective re-draft callback that mutates the run's draft in place. Keeping
 * the three together means a change to how the gate is driven touches one file
 * rather than reaching into the middle of the orchestrator's body.
 */
import { gapGatePrompt, gapGateVerifyPrompt } from "./plan-gate-prompt.ts";
import type { CarriedCritical } from "./plan-gate-prompt.ts";
import { PLAN_DISPATCH_TIMEOUT_MS, PLAN_MARKER_CHILD_ARGS } from "./plan-investigate.ts";
import type { PlanGap, PlanType } from "./plan-types.ts";
import type { DriverHost } from "./work-driver-host.ts";

/** The bound runGapGateLoop iterates to. */
export const GAP_GATE_MAX_ITERATIONS = 2;

export interface GateRunArgs {
  dispatch: PlanDispatchFn;
  /** The host the children spawn on — the same handle the orchestrator holds; the
   *  gate threads it to the dispatch seam and never inspects it. */
  pi: DriverHost;
  repoRoot: string;
  /** The job's signal — checked per round inside the loop (see below). */
  signal?: AbortSignal;
  type: PlanType;
  descriptor: string;
  /** The draft under review; the corrective re-draft replaces it in place. */
  getBody: () => string;
  setTitleBody: (title: string, body: string) => void;
  findings: CorrectiveRedraftCtx["findings"];
  inventoryContext: CorrectiveRedraftCtx["inventoryContext"];
  directives: CorrectiveRedraftCtx["directives"];
  openQuestions: string[];
  outOfScope: string[];
  depth: number;
  chosenBudget: CorrectiveRedraftCtx["chosenBudget"];
  priorContext: { source: string; fact: string }[];
  /** Gaps the operator already settled — appended to round 1's prompt. */
  settled: PlanGap[];
  timed: <T>(phase: string, fn: () => Promise<T>) => Promise<T>;
  /** The corrective re-draft (plan-driver-redraft.ts) — mutates the draft in place. */
  correctiveRedraft: (blocking: PlanGap[], args: CorrectiveRedraftCtx) => void;
}

/**
 * The chore/spike exemption is deliberate and has no env knob (operator
 * decision 2026-09-09): low blast radius, and the deterministic validation
 * above is their gate. Removing the knob also removes run-to-run gate variance
 * for those types.
 */
export function gapGateApplies(type: PlanType): boolean {
  return type !== "chore" && type !== "spike";
}

/**
 * Run the gate. The job's `signal` is threaded into BOTH places it has to be:
 * the live child dispatch (so `dispatch_kill` SIGTERMs the reviewer rather than
 * only refusing the next phase) and the loop's own per-round check — which is
 * load-bearing, because the investigation barrier dispatches its children in
 * one tick, so a kill that lands mid-barrier is observed only after every leg
 * is already handed off, and the orchestrator's boundary check then races the
 * loop's first dispatch.
 */
export async function runGate(args: GateRunArgs): Promise<GapGateLoopResult> {
  // The carried CRITICAL decisions from the last corrective re-draft — what
  // round 2's SCOPED VERIFICATION verifies.
  let lastCarried: CarriedCritical[] = [];
  return args.timed("gap-gate", () =>
    runGapGateLoop(
      // Same bounds as every plan child: cwd pinned, 30-min timeout,
      // --no-skills (marker-line reviewer, no reporter).
      (spec, opts) => {
        // #1541 — checked IMMEDIATELY before the call, not merely at the round
        // top. The corrective re-draft's draftSpec() is synchronous, so a kill
        // that lands mid-investment-barrier flows through the loop's top-of-round
        // check and into this dispatch within one microtask chain; the seam
        // guard in dispatchCore is a second line, and the stubbed dispatch a
        // smoke test installs bypasses it. This is the last place both paths pass.
        if (args.signal?.aborted) {
          return Promise.resolve({
            ok: false,
            text: "",
            toolUses: [],
            killedBy: "dispatch_kill (or session shutdown)",
          });
        }
        return args.dispatch(
          args.pi,
          { ...spec, cwd: args.repoRoot },
          {
            ...opts,
            timeoutMs: PLAN_DISPATCH_TIMEOUT_MS,
            ...(args.signal ? { signal: args.signal } : {}),
            extraArgs: PLAN_MARKER_CHILD_ARGS,
          },
        );
      },
      // Round 1: full GAP DETECTION review. Round 2 (fires only after a
      // CRITICAL corrective re-draft): SCOPED VERIFICATION of the carried
      // resolutions — not a second full review (plan-gate-prompt.ts).
      (iteration) =>
        iteration <= 1 || lastCarried.length === 0
          ? gapGatePrompt(
              args.getBody(),
              args.findings,
              args.priorContext,
              args.directives.neverClaim,
            ) + settledGapsSection(args.settled)
          : gapGateVerifyPrompt(args.getBody(), lastCarried),
      GAP_GATE_MAX_ITERATIONS,
      (blocking: PlanGap[]) =>
        args.correctiveRedraft(blocking, {
          type: args.type,
          descriptor: args.descriptor,
          findings: args.findings,
          inventoryContext: args.inventoryContext,
          openQuestions: args.openQuestions,
          outOfScope: args.outOfScope,
          depth: args.depth,
          directives: args.directives,
          chosenBudget: args.chosenBudget,
          setCarried: (c) => {
            lastCarried = c;
          },
          setTitleBody: args.setTitleBody,
        }),
      args.signal,
    ),
  );
}
