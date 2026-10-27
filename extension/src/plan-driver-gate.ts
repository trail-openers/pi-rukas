import type { CorrectiveRedraftCtx } from "./plan-driver-redraft.ts";
import type { PlanDispatchFn } from "./plan-driver-seams.ts";
import { getPlanRedraftOverride } from "./plan-driver-seams.ts";
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
 * Which re-draft the gate actually runs. Production passes `correctiveRedraft`
 * from the orchestrator; the seam (plan-driver-seams.ts `setPlanRedraft`) lets a
 * test force the throw, because the real re-draft is not forceably throwable
 * through the dispatch stub — every `draftSpec` helper is defensive (see
 * test-plan-gap-writeback.ts's ERROR_HANDLING note), so the wide catch is a
 * guard for a future refactor rather than a reachable path. Same shape as the
 * dispatch/stat seams: the getter is read at the call, so the pipeline itself
 * (not just `runGate`) is what a test exercises.
 */
function redraftFor(fallback: GateRunArgs["correctiveRedraft"]): GateRunArgs["correctiveRedraft"] {
  return getPlanRedraftOverride() ?? fallback;
}

/**
 * What `runGate` hands the orchestrator: the loop's result, OR the halt to
 * return when the corrective re-draft threw. Discriminated so the driver cannot
 * read `loopResult` after a halt and cannot silently swallow the throw.
 */
export type GateRunResult =
  | { halted: false; loopResult: GapGateLoopResult }
  | { halted: true; error: unknown };

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
 *
 * The corrective re-draft's throw is CAUGHT here rather than allowed to escape:
 * `correctiveRedraft` rethrows its wide catch as `correctiveRedraftError`, and a
 * throw reaching `startJob`'s generic rejection path loses the plan-specific
 * halt rendering the operator needs (the disclosure of which carried decisions
 * were computed). The orchestrator turns the carried `error` into a capReason-
 * bearing halt, exactly as the sibling gate failure modes do.
 */
export async function runGate(args: GateRunArgs): Promise<GateRunResult> {
  // The carried CRITICAL decisions from the last corrective re-draft — what
  // round 2's SCOPED VERIFICATION verifies.
  let lastCarried: CarriedCritical[] = [];
  // Set when the corrective re-draft throws mid-loop, so the disclosure the
  // re-draft built travels with the halt instead of dying in a stack trace.
  let redraftThrow: { error: unknown } | undefined;
  const loopResult = await args.timed("gap-gate", () =>
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
        // The synthetic reply carries the declared `killCause: "abort"` (the
        // DispatchResult field every downstream classifier branches on first) —
        // a `killedBy` string is not on the type and no reader consumes it.
        if (args.signal?.aborted) {
          return Promise.resolve({
            ok: false,
            text: "",
            toolUses: [],
            killCause: "abort" as const,
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
      (blocking: PlanGap[]) => {
        try {
          redraftFor(args.correctiveRedraft)(blocking, {
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
          });
        } catch (err) {
          // Absorbed HERE (not rethrown) so the loop returns normally and its
          // timed() entry still lands; the driver sees `halted` and renders the
          // plan-specific halt from `error`.
          redraftThrow = { error: err };
        }
      },
      args.signal,
    ),
  );
  if (redraftThrow) return { halted: true, error: redraftThrow.error };
  return { halted: false, loopResult };
}
