/**
 * work-driver-explore-intent-park — the `intent-park` cap-hit the explore step
 * fires when a reconciled spec parks the cycle, split out of
 * `work-driver-explore-run.ts` for module-size hygiene (AGENTS.md §12).
 *
 * #657 — the machine-readable `parkReason` rides on the cap-hit so the renderers
 * can show `intent-park (contradicted-by-code)`. #1561 — the decisive evidence is
 * looked up too, so the headless `failure.message` says WHY rather than naming the
 * cap alone: a spec that cites a PR is checked against the forge, because an open
 * PR is not the mainline having the work.
 */
import { execp } from "./exec.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import {
  awaitingReviewPr,
  parkEvidence,
  readCitedPrStates,
} from "./work-driver-intent-park-evidence.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** The park cap-hit, with the forge-read evidence and any awaiting-review PR. */
export async function parkOnIntent(
  ctx: CycleContext,
  state: WorkState,
  spec: NormalisedSpec,
): Promise<WorkState> {
  const prStates = await readCitedPrStates(
    spec,
    ctx.forge ??
      (await forgeForCycle(ctx, ctx.verifyExecFn ?? execp, new Map(), {
        execOpts: { timeout: 20_000 },
      })),
  );
  const openPr = awaitingReviewPr(spec, prStates);
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: "intent-park",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    ...(spec.parkReason ? { parkReason: spec.parkReason } : {}),
    evidence: parkEvidence(spec, ctx.issue, prStates),
    ...(openPr !== undefined ? { awaitingReviewPr: openPr } : {}),
  });
}
