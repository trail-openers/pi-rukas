/**
 * work-driver-explore-dispatch — one explore dispatch attempt, plus the #1094
 * "no readable `## Spec`" resolver, retry predicate and retry preface.
 *
 * `dispatchExploreAttempt` is the write-ahead / completion sequence that
 * `runExplore` used to inline, lifted so the single retry runs the identical
 * sequence (#382 resume state, #573 transcript path). It takes no intent
 * policy: the caller clears the prior spec artifact (#594) before each attempt.
 * A FAILED dispatch returns no reply: the router owns it and the retry must
 * never fire on one (dispatch-failed tail, #686/#693).
 */
import { readMarker } from "./reply-markers.ts";
import { slowRecorder } from "./slow-events.ts";
import { exploreChildBoundMs } from "./spawn-child-bound.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { cycleDispatch } from "./work-driver-cycle-entry.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import {
  EXPLORE_REASK_SOURCE_TAG,
  exploreReaskBoundMs,
  exploreReaskPrompt,
  spawnExploreReaskChild,
} from "./work-driver-explore-reask.ts";
import { readSpecArtifact, resolveIntentVerdict } from "./work-driver-intent-artifact.ts";
import { recoverOffloadedSpec } from "./work-driver-intent-offload.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Result of one explore attempt. `reply` is set only for a completed dispatch. */
export interface ExploreAttempt {
  state: WorkState;
  /** The job id on the event that recorded this attempt's outcome (#1548). */
  jobId: string;
  reply?: DispatchResult;
}

/** A readable spec resolved from an explore reply, and which channel won. */
export interface ResolvedExploreSpec {
  spec: NormalisedSpec;
  source: "prose" | "artifact";
}

/**
 * #2611 — one same-session follow-up to an explore reply that carried neither a
 * verdict nor a spec. Returns the reply's own transcript (the session that must
 * be resumed), the re-ask's readable spec when it answered, and the fields the
 * caller records on the `explore-reasked` event.
 *
 * Returns `{ spec: undefined, answered: false }` — and the caller records the ask
 * but changes nothing else — when there is no session to name or the ask itself
 * threw: a step must not pretend an ask that never ran produced anything, and a
 * failed ask must land on today's fresh re-dispatch exactly as it did before this
 * existed. The answer is read by `resolveExploreSpec`, the SAME reader the
 * original reply went through, so prose or a fenced spec stays unreadable here as
 * it was there.
 *
 * The ask is `ctx.exploreReask` when the caller injected one (the offline suite)
 * and {@link spawnExploreReaskChild} otherwise.
 */
export async function reaskExploreSession(args: {
  ctx: CycleContext;
  reply: DispatchResult;
  /** The job id the reply being asked about was recorded under. */
  firstJobId: string;
  /** Whether the reply being asked about carried an `INTENT-VERDICT:` token. */
  verdictParsed: boolean;
}): Promise<{
  spec: ResolvedExploreSpec | undefined;
  /** Whether a child (or the injected seam) was actually reached. */
  asked: boolean;
  answered: boolean;
  reason?: string;
}> {
  const transcriptPath = args.reply.transcriptPath;
  if (transcriptPath === undefined || transcriptPath === "") {
    // No session, nothing to ask: the caller's fresh re-dispatch is the only path.
    return { spec: undefined, asked: false, answered: false, reason: "no-session" };
  }
  const ask = args.ctx.exploreReask ?? spawnExploreReaskChild;
  const boundMs = exploreReaskBoundMs();
  const prompt = exploreReaskPrompt();
  let out: Awaited<ReturnType<typeof ask>>;
  try {
    out = await ask({ transcriptPath, role: "explore", cwd: args.ctx.repoRoot, boundMs, prompt });
  } catch (err) {
    trace(
      `${EXPLORE_REASK_SOURCE_TAG}: the ask threw for ${transcriptPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { spec: undefined, asked: false, answered: false, reason: "spawn-failed" };
  }
  if (out === null || typeof out !== "object" || typeof out.ok !== "boolean") {
    // The seam is an injected function, and a promise that fulfils something this
    // reader cannot read IS a no-answer — the arm the caller already handles.
    trace(`${EXPLORE_REASK_SOURCE_TAG}: the ask returned a non-outcome for ${transcriptPath}`);
    return { spec: undefined, asked: false, answered: false, reason: "no-answer" };
  }
  if (out.ok !== true) {
    // Narrowed through the union's own discriminant, so the reason is read only
    // where the type says one exists. A seam that says it was never reached
    // (`asked: false` — the test shape for "the ask could not run") is not an
    // ask that ran, and the caller must not record one.
    return {
      spec: undefined,
      asked: !("asked" in out && out.asked === false),
      answered: false,
      reason: out.reason,
    };
  }
  if (typeof out.text !== "string") {
    return { spec: undefined, asked: true, answered: false, reason: "no-answer" };
  }
  const spec = await resolveExploreSpec(args.ctx, out.text);
  return {
    spec,
    asked: true,
    answered: spec !== undefined,
    ...(spec === undefined ? { reason: "answered-without-a-readable-spec" } : {}),
  };
}

/** The preface the single retry prepends to the original explore prompt (#1094). */
export const EXPLORE_RETRY_PREFACE = [
  "RETRY — your previous reply had no `## Spec` heading, so the work-driver could not read it and cannot proceed on it.",
  "Re-emit the whole reply this time: the `INTENT-VERDICT:` line and a `## Spec` block with its subsections, exactly as specified below. Do not substitute any other section name for `## Spec`.",
  "",
  "",
].join("\n");

/** Did the reply carry an `INTENT-VERDICT:` token (bold-wrapped forms included)? */
export function hasIntentVerdictToken(text: string): boolean {
  return (
    readMarker(text, "INTENT-VERDICT", /(proceed-with-assumptions|proceed|park)/) !== undefined
  );
}

/**
 * #1094 — the ONE definition of a readable spec. An inline `## Spec` block,
 * an offloaded spec file, or a valid persisted artifact counts; a verdict
 * token alone does not, because the `## Spec` body is what the cycle routes
 * on. Both the retry decision and the routing call this, so the reply is read
 * once and the two can never disagree.
 */
export async function resolveExploreSpec(
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  text: string,
): Promise<ResolvedExploreSpec | undefined> {
  const prose = await recoverOffloadedSpec(text, scratchDir(ctx.repoRoot, ctx.issue));
  const artifact = await readSpecArtifact(ctx.repoRoot, ctx.issue);
  const { spec, source } = resolveIntentVerdict(prose, artifact);
  if (spec === undefined) return undefined;
  if (source === "prose") return { spec, source };
  // This reply's own verdict did not parse, so the restored spec carries none: its
  // verdict comes from the artifact, and the rule says so.
  const { resolverVerdict: _rv, ...restored } = spec;
  return { spec: { ...restored, verdictRule: "spec-artifact-restore" }, source };
}

/**
 * #1094 — the explore re-dispatch decision, as a pure function. The caller
 * only asks after a COMPLETED dispatch (a failed one returns before any reply
 * is read), so the predicate is just: intent path and no readable spec.
 */
export function shouldRetryExplore(input: {
  useIntent: boolean;
  spec: NormalisedSpec | undefined;
}): boolean {
  return input.useIntent && input.spec === undefined;
}

/**
 * The cap evidence for an explore reply with no readable spec (#1094, #2611).
 * The no-verdict wording is the long-standing string (#830); the verdict-present
 * wording says the decision was made but its body was not written, which is a
 * different fault for the operator to act on. `retried` says a fresh child was
 * already paid for; `reask` says what the same-session ask did first, so the
 * handoff names everything the driver tried before it parked.
 */
export function noSpecEvidence(
  text: string,
  retried: boolean,
  /** #2611 — whether the same-session re-ask ran, whether it answered, and what
   * the ask itself reported. `reason` is what separates the two readings the
   * operator acts on differently: an ask that got NO reply at all, and one whose
   * child replied but whose reply the reader could not parse. */
  reask?: { asked: boolean; answered: boolean; reason?: string },
): string {
  const base = hasIntentVerdictToken(text)
    ? "INTENT-VERDICT present but no `## Spec` heading parsed"
    : "no verdict and no spec parsed";
  const tried: string[] = [];
  if (reask !== undefined) {
    tried.push(reaskPhrase(reask));
  }
  if (retried) tried.push("explore re-dispatched once");
  return tried.length === 0 ? base : `${base} (${tried.join("; ")})`;
}

/**
 * What the same-session ask did, in the handoff's words.
 *
 * "got no answer" is only true of an ask that received nothing; a child that
 * replied in prose, inside a fence, or with a description of a spec DID answer,
 * and telling the operator it did not sends them looking for a wedged provider
 * when the fault is the reply's form. The reason is the one the ask itself
 * carried on the `explore-reasked` event — this function invents no new state.
 */
function reaskPhrase(reask: { asked: boolean; answered: boolean; reason?: string }): string {
  if (reask.answered) return "the same-session re-ask answered without a readable spec";
  if (reask.reason === "answered-without-a-readable-spec") {
    return "the same-session re-ask answered but its reply held no readable spec";
  }
  return reask.reason === undefined
    ? "the same-session re-ask got no answer"
    : `the same-session re-ask got no answer (${reask.reason})`;
}

/**
 * Run one explore dispatch: write-ahead (#382), dispatch, then append the
 * completion or failure event and clear the in-flight marker.
 */
export async function dispatchExploreAttempt(
  ctx: CycleContext,
  state: WorkState,
  prompt: string,
): Promise<ExploreAttempt> {
  const dispatch = cycleDispatch(ctx);
  const startedAt = Date.now();
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const exploreRunId = `explore:explore:${process.pid}:${startedAt}`;
  const exploreTranscript = transcriptPathFor("explore", exploreRunId);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(
    ctx,
    state,
    "explore",
    "explore",
    "explore",
    startedAt,
    exploreTranscript,
  );
  const next = begun.state;
  let exploreDispatch: DispatchResult;
  try {
    exploreDispatch = await dispatch(
      ctx.host,
      { role: "explore", prompt },
      // #799 — the slow recorder collects into the driver's pending buffer;
      // the step boundary (routeStepOutcome) drains it — this step folds
      // nothing.
      {
        label: "explore",
        onSlow: slowRecorder(ctx.issue, "explore"),
        // #1560 — the per-child run bound (policy: explore 30 min).
        childBoundMs: exploreChildBoundMs(),
        deck: { ...driverDeckOpts(ctx.issue, "explore", "explore"), label: "explore" },
      },
    );
  } catch (err) {
    // A dispatch that did not fulfil is recorded as dispatch-failed with the
    // real error. A crossing recorded before the failure survives in the
    // pending buffer and is drained at the step boundary (#799).
    const errorTail = (err instanceof Error ? err.message : String(err)).slice(-200);
    return {
      state: appendEvent(clearDispatch(next, begun.jobId), {
        kind: "dispatch-failed",
        step: "explore",
        role: "explore",
        jobId: begun.jobId,
        label: "explore",
        ms: Date.now() - startedAt,
        at: Date.now(),
        errorTail,
      }),
      jobId: begun.jobId,
    };
  }

  // The explore role returns one report covering all issues (single dispatch).
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  const after = appendEvent(clearDispatch(next, begun.jobId), event);
  // A dispatch that FAILED has no reply to route on (two failed downstream dispatches).
  return {
    state: after,
    jobId: event.jobId,
    reply: event.kind === "dispatch-completed" ? exploreDispatch : undefined,
  };
}
