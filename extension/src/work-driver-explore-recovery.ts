/**
 * work-driver-explore-recovery — the two recoveries the explore step runs when a
 * COMPLETED reply carries neither an `INTENT-VERDICT:` line nor a `## Spec` block,
 * split out of `work-driver-explore-run.ts` for module-size hygiene (AGENTS.md
 * §12) so the step handler stays under the cap.
 *
 * Order is the whole design: the same session is asked ONCE first (#2611 — the
 * child already did the investigation and its context holds the evidence, where a
 * stranger repeats it), and only a reply that still has no readable spec is
 * followed by the fresh child (#1094). Each helper records its own event and
 * returns the state it recorded into, so a reader of the state file can
 * reconstruct which recovery produced the spec without reading a transcript.
 * Neither helper can loop: the step calls each at most once, and nothing here
 * returns to the caller's decision point.
 */
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext } from "./work-driver-context.ts";
import {
  EXPLORE_RETRY_PREFACE,
  type ResolvedExploreSpec,
  dispatchExploreAttempt,
  hasIntentVerdictToken,
  noSpecEvidence,
  reaskExploreSession,
  resolveExploreSpec,
  shouldRetryExplore,
} from "./work-driver-explore-dispatch.ts";
import { deleteSpecArtifact } from "./work-driver-intent-artifact.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Which path produced the spec the cycle routes on. */
export type ExploreSpecPath = "first-reply" | "reask" | "redispatch" | "artifact";

/** What the same-session ask did, for the cap evidence when nothing worked. */
export interface ExploreReaskTried {
  asked: boolean;
  answered: boolean;
}

/**
 * Ask the reply's OWN session once for the artefacts it owed (#2611). Returns the
 * caller's state unchanged — and no spec, and no `tried` record — when the reply
 * names no transcript or the ask could not reach a child: in every one of those
 * cases the caller's fresh re-dispatch is the only recovery that ran, and the log
 * says so rather than implying an ask that never happened.
 */
export async function askExploreSessionOnce(args: {
  ctx: CycleContext;
  state: WorkState;
  /** Whether this cycle is on the intent path (the only path with a spec contract). */
  useIntent: boolean;
  reply: DispatchResult;
  /**
   * The spec the reply already produced, when it produced one. Passing it in is
   * what makes "asked once, and only when nothing is readable" checkable here:
   * a caller that passed a resolved spec would otherwise pay for a second ask of
   * a reply that already satisfies its contract.
   */
  spec: ResolvedExploreSpec | undefined;
  jobId: string;
  /**
   * Whether the reply being asked about carried an `INTENT-VERDICT:` token.
   * The CALLER computes it once for its own retry decision, and the ask must
   * record that same value: a verdict that was read as present but recorded as
   * absent tells an operator a verdict-less reply was re-asked when it was not.
   */
  verdictParsed: boolean;
}): Promise<{
  state: WorkState;
  spec: ResolvedExploreSpec | undefined;
  tried: ExploreReaskTried | undefined;
  specPath?: ExploreSpecPath;
}> {
  const { ctx, state, useIntent, reply, spec, jobId, verdictParsed } = args;
  if (!shouldRetryExplore({ useIntent, spec: spec?.spec })) {
    return { state, spec: undefined, tried: undefined };
  }
  const asked = await reaskExploreSession({ ctx, reply, firstJobId: jobId, verdictParsed });
  if (!asked.asked) return { state, spec: undefined, tried: undefined };
  const next = appendEvent(state, {
    kind: "explore-reasked",
    step: "explore",
    at: Date.now(),
    verdictParsed,
    answered: asked.answered,
    ...(asked.reason === undefined ? {} : { reason: asked.reason }),
    firstJobId: jobId,
  });
  if (!(asked.answered && asked.spec !== undefined)) {
    return { state: next, spec: undefined, tried: { asked: true, answered: asked.answered } };
  }
  // The same child answered with the contract it owed: the cycle proceeds as if
  // the first reply had carried it, and no fresh child is dispatched.
  trace(`work-driver: explore ${jobId}: the same-session re-ask produced the spec (#2611)`);
  return {
    state: next,
    spec: asked.spec,
    tried: { asked: true, answered: asked.answered },
    specPath: "reask",
  };
}

/**
 * Pay for a fresh child (#1094) — the recovery that predates the same-session
 * ask and stays the fallback when the ask could not answer. At most one call per
 * cycle: the step calls this once and its reply is not re-checked, so control
 * flow cannot come back here.
 */
export async function redispatchExplore(args: {
  ctx: CycleContext;
  state: WorkState;
  prompt: string;
  useIntent: boolean;
  firstReplyText: string;
  firstJobId: string;
}): Promise<{
  state: WorkState;
  replyText: string;
  transcriptPath: string | undefined;
  spec: ResolvedExploreSpec | undefined;
  specPath?: ExploreSpecPath;
  completed: boolean;
}> {
  const { ctx, prompt, useIntent } = args;
  // #1548 — a verdict without its `## Spec` is not an accepted verdict: the event
  // names what the first reply lacked, so the re-dispatch reads as the deliberate
  // re-verdict it is.
  const missing = noSpecEvidence(args.firstReplyText, false);
  trace(
    `work-driver: explore ${args.firstJobId}: ${missing} — re-dispatching explore once (#1094)`,
  );
  let next = appendEvent(args.state, {
    kind: "explore-retried",
    step: "explore",
    at: Date.now(),
    verdictParsed: hasIntentVerdictToken(args.firstReplyText),
    missing,
    firstJobId: args.firstJobId,
  });
  if (useIntent) await deleteSpecArtifact(ctx.repoRoot, ctx.issue);
  const second = await dispatchExploreAttempt(ctx, next, `${EXPLORE_RETRY_PREFACE}${prompt}`);
  next = second.state;
  if (second.reply === undefined) {
    return {
      state: next,
      replyText: "",
      transcriptPath: undefined,
      spec: undefined,
      completed: false,
    };
  }
  const replyText = second.reply.text ?? "";
  const spec = useIntent ? await resolveExploreSpec(ctx, replyText) : undefined;
  return {
    state: next,
    replyText,
    transcriptPath: second.reply.transcriptPath,
    spec,
    specPath:
      spec === undefined ? undefined : spec.source === "artifact" ? "artifact" : "redispatch",
    completed: true,
  };
}
