/**
 * work-driver-explore — Step 1 (explore) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Dispatches
 * `@explore` with all requested issue bodies inlined, then routes on the
 * parsed verdict(s) via work-driver-plan.ts's parsers.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { forgeForCycle } from "./work-driver-forge-ctx.ts";
import {
  deleteSpecArtifact,
  persistSpecArtifact,
  readSpecArtifact,
  resolveIntentVerdict,
} from "./work-driver-intent-artifact.ts";
import {
  intentResolutionEnabled,
  parseNormalisedSpec,
  reconcileVerdict,
} from "./work-driver-intent.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan.ts";
import { inlineExplorePrompt } from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent, writeDispatchArtifact } from "./workflow-state.ts";

const execp = promisify(exec);

/** Per-attempt deadline for one `gh issue view` (45 s). */
export const ISSUE_BODY_TIMEOUT_MS = 45_000;
/** Attempts per issue body, including the first. */
const ISSUE_BODY_ATTEMPTS = 3;
type IssueBodyExec = (
  cmd: string,
  opts: { cwd: string; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

/**
 * The production issue-body fetch. `execFn` is injected by the smoke test so
 * the per-attempt deadline is asserted rather than assumed.
 *
 * Routed through the forge adapter (S4 of epic #608, #612): the adapter is
 * built on the SAME injected seam with the per-attempt deadline carried in
 * `execOpts`. On a GitHub remote the adapter runs `gh issue view N` through
 * that seam. The body is rendered as `"<title>\n\n<body>"` — the `gh issue
 * view` plain-text shape the grouping and handoff renderers consume.
 */
export function fetchIssueBodyViaGh(
  issue: number,
  cwd: string,
  execFn: IssueBodyExec = execp,
): Promise<{ stdout: string }> {
  const exec = (cmd: string, opts?: { cwd?: string; maxBuffer?: number; timeout?: number }) =>
    execFn(cmd, opts as { cwd: string; maxBuffer: number; timeout: number });
  return forgeForCycle({ repoRoot: cwd }, exec, new Map(), {
    execOpts: { timeout: ISSUE_BODY_TIMEOUT_MS, maxBuffer: 256 * 1024 },
  }).then(async (f) => {
    if (!f) {
      // Forge undetermined — fail closed: the retry loop treats a rejection
      // as a failed attempt and the empty-body cap still parks the cycle.
      throw new Error("forge undetermined — cannot fetch issue body");
    }
    const d = await f.issueView(issue);
    return { stdout: `${d.title}\n\n${d.body}` };
  });
}

/**
 * Fetch one issue body, retrying a transient failure.
 *
 * A live cycle for issue #700 died 56 ms after step-started —
 * cap-hit `explore-bodies-empty`, before any dispatch ran — because a single
 * `gh issue view` hit a connection reset. Nothing was wrong with the issue;
 * the operator had to `--restart` and clear a `needs-human-attention` label.
 *
 * The retry belongs HERE, around the fetch and before the cap is appended:
 * `work-driver-step-router.ts` gives a `cap-hit` tail zero retries (its retry
 * branches are gated on `dispatch-failed*`), so a cap-hit is terminal by
 * construction.
 *
 * Empty stdout is retried as well as a rejection — a severed or truncated
 * response yields empty output, indistinguishable from a genuinely empty issue
 * until we have asked again.
 *
 * The cap itself is unchanged and still fails closed: a body that is still
 * empty (or still failing) after the last attempt is returned/thrown as-is and
 * halts the cycle.
 */
export async function fetchIssueBodyWithRetry(
  fetchBody: (issue: number, cwd: string) => Promise<{ stdout: string }>,
  issue: number,
  cwd: string,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; rand?: () => number } = {},
): Promise<{ stdout: string }> {
  const attempts = transientRetryEnabled() ? (opts.attempts ?? ISSUE_BODY_ATTEMPTS) : 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  let lastEmpty: { stdout: string } | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchBody(issue, cwd);
      if (result.stdout.trim()) return result;
      lastEmpty = result;
      lastError = undefined;
      trace(`work-driver: gh issue view ${issue} returned empty stdout (${attempt}/${attempts})`);
    } catch (err) {
      lastError = err;
      lastEmpty = undefined;
      trace(
        `work-driver: gh issue view ${issue} failed (${attempt}/${attempts}): ${(err as Error).message?.slice(0, 200)}`,
      );
    }
    if (attempt < attempts) {
      await sleep(jitteredMs(transientRetryBackoffMs() * attempt, 0, opts.rand ?? Math.random));
    }
  }
  if (lastError !== undefined) throw lastError;
  return lastEmpty ?? { stdout: "" };
}

/**
 * Step 1 — Read the issue and project context.
 *
 * Dispatches `@explore` with a prompt that:
 *   1. runs `gh issue view N` to get the issue body,
 *   2. discovers vipune memory types and searches relevant context,
 *   3. runs codebase_memory_search_code on key concepts,
 *   4. returns a structured summary the driver stores in the event log.
 *
 * The template file lives at `pi-prompts/work/explore.md` (added in the
 * step-template commit). For the skeleton, we inline a minimal prompt so
 * the smoke test can exercise the runStep path.
 */
export async function runExplore(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // Mark the step start in the log before dispatch (resume-safety).
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "explore" } },
    { kind: "step-started", step: "explore", at: now },
  );

  // PR10 — multi-issue: fetch + present all N issue bodies. For N=1
  // this collapses to the existing single-issue shape.
  const issues = ctx.issues ?? state.issues ?? [ctx.issue];
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();

  // PR13 — fetch bodies as a BARRIER before the explore dispatch (was
  // a fan-out in PR3 Pattern 1; the race caused false NEEDS_CLARIFICATION
  // cap-hits on issues with substantive bodies because the agent's
  // verdict committed before the gh fetch settled and the prompt never
  // pointed at the cached artifact path). The bodies are then inlined
  // into the explore prompt — agent has the body content directly and
  // doesn't need to read files or trust the "driver is fetching in
  // parallel" instruction. Wall-clock impact: ~1-2 s on the happy path
  // (the parallel-fetch dispatch overlap was never that large), and up to
  // ~150 s per issue when every attempt fails — three 45 s deadlines plus
  // backoff — before the halt below fires. That worst case is bounded on
  // purpose: pre-fix the fetch carried NO deadline at all and could block
  // the step indefinitely.
  //
  // PR11 §C empty-body halt also moves above the dispatch — if any
  // fetch returns empty stdout, we halt BEFORE wasting tokens on the
  // explore dispatch. That halt is terminal, so each fetch gets a bounded
  // retry with a per-attempt deadline first (see fetchIssueBodyWithRetry).
  const fetchBody = ctx.issueBodyFetcherFn ?? fetchIssueBodyViaGh;
  const bodySettled = await Promise.allSettled(
    issues.map((n) => fetchIssueBodyWithRetry(fetchBody, n, ctx.repoRoot)),
  );

  // PR11 — track per-issue fetch outcome. A body still empty or still
  // failing AFTER the retries is a pre-condition failure: explore can't
  // reliably classify
  // work that hasn't been read. Live evidence (v10r 2026-06-25 / PR #483):
  // 4 of 5 empty bodies cascaded silently into wrong-issue work landing
  // on main. Strict halt — operator gets a clear remediation message and
  // can fix gh auth / version / network before re-running.
  const emptyBodyIssues: Array<{ issue: number; reason: string }> = [];

  // PR13 — per-issue body content for inlining in the explore prompt.
  // Capped at 16 KiB per body — covers virtually every real-world issue
  // body. Larger bodies get a truncation marker pointing at the cached
  // artifact so the agent can `cat` for the rest if needed.
  const INLINE_BODY_CAP = 16 * 1024;
  const bodiesForPrompt: Array<{ issue: number; body: string; truncated: boolean }> = [];

  // Persist each issue body as a claim-check artifact (best-effort).
  // For single-issue cycles, the first body is stored under the legacy
  // "issue-body" name so back-compat readers still find it; additional
  // bodies use "issue-body-<N>" naming.
  for (let i = 0; i < issues.length; i++) {
    const n = issues[i];
    if (n === undefined) continue;
    const result = bodySettled[i];
    if (result?.status === "fulfilled") {
      const body = result.value.stdout;
      if (!body.trim()) {
        emptyBodyIssues.push({
          issue: n,
          reason:
            "gh issue view returned empty stdout on every attempt (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
        });
        continue;
      }
      let artifactPath: string | undefined;
      try {
        const artifactName = issues.length === 1 ? "issue-body" : `issue-body-${n}`;
        artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, artifactName, body);
        // Only set issueBodyArtifact for the PRIMARY issue (back-compat
        // path readers look for `state.pipelineState.issueBodyArtifact`).
        if (n === ctx.issue) {
          next = {
            ...next,
            pipelineState: { ...next.pipelineState, issueBodyArtifact: artifactPath },
          };
        }
      } catch (err) {
        trace(
          `work-driver: failed to persist issue-body artifact for #${n}: ${(err as Error).message}`,
        );
      }
      const truncated = body.length > INLINE_BODY_CAP;
      const inlineBody = truncated
        ? `${body.slice(0, INLINE_BODY_CAP)}\n[... truncated; full body at ${artifactPath ?? "(artifact write failed)"}]`
        : body;
      bodiesForPrompt.push({ issue: n, body: inlineBody, truncated });
    } else if (result?.status === "rejected") {
      const reason = (result.reason as Error).message?.slice(0, 200) ?? "(no error message)";
      trace(`work-driver: gh issue view ${n} failed after every attempt: ${reason}`);
      emptyBodyIssues.push({
        issue: n,
        reason: `gh issue view rejected on every attempt: ${reason}`,
      });
    }
  }

  // PR11 — halt the cycle if ANY issue body failed to fetch. Pre-condition
  // failure; the operator fixes gh and re-runs. PR13 moves this check
  // above the dispatch so we don't spend tokens on an explore that's
  // bound to halt anyway. Same routing as before.
  if (emptyBodyIssues.length > 0) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, emptyBodyIssues },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "explore-bodies-empty",
      reviewRound: 0,
      nextStep: "handoff",
    });
    return next;
  }

  // PR13 — now dispatch with bodies embedded in the prompt. Verdict can
  // be sound from a single turn — no race, no agency-dependence.
  // #397 — ask for exactly one verdict protocol, and read the one we asked
  // for. Multi-issue is legacy-only: intent resolution yields ONE spec, so a
  // `## Spec` block in a multi-issue reply used to take the intent path and
  // return without setting activeIssues/droppedIssues at all — silently
  // dropping per-issue routing so every requested issue proceeded.
  const useIntent = intentResolutionEnabled() && issues.length === 1;
  const prompt = inlineExplorePrompt(
    issues,
    scratchDir(ctx.repoRoot, ctx.issue),
    bodiesForPrompt,
    useIntent,
  );
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const exploreRunId = `explore:explore:${process.pid}:${startedAt}`;
  const exploreTranscript = transcriptPathFor("explore", exploreRunId);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "explore",
    "explore",
    "explore",
    startedAt,
    exploreTranscript,
  );
  next = begun.state;
  // #594 — delete the prior cycle's spec artifact before dispatch (best-effort,
  // trace on failure). Gated on useIntent: the artifact is only used on the
  // intent path, so on the legacy path (PI_ENSEMBLE_INTENT=0 or N>1) leave it.
  if (useIntent) {
    await deleteSpecArtifact(ctx.repoRoot, ctx.issue);
  }
  const dispatchSettled = await Promise.allSettled([
    dispatch(ctx.pi, { role: "explore", prompt }, { label: "explore" }),
  ]).then((arr) => arr[0]);

  if (dispatchSettled?.status === "rejected") {
    return appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: begun.jobId,
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (dispatchSettled.reason as Error).message?.slice(-200),
    });
  }
  if (!dispatchSettled || dispatchSettled.status !== "fulfilled") {
    // Defensive — Promise.allSettled returns either fulfilled or rejected;
    // this branch unreachable. Synthesise a dispatch-failed so the driver
    // can route normally.
    return appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: begun.jobId,
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: "explore dispatch settled in an unexpected state",
    });
  }

  // dispatchSettled.value is the explore role's dispatch result
  // (single-dispatch — explore returns one report covering all issues).
  const exploreDispatch = dispatchSettled.value as DispatchResult;
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  next = appendEvent(clearDispatch(next, begun.jobId), event);

  // A dispatch that FAILED has no reply to route on (nessie #686/#693).
  if (event.kind !== "dispatch-completed") return next;

  const responseText = exploreDispatch.text ?? "";

  // #378 + #594 — intent resolution. Route on the resolved spec; when the
  // prose does not parse (or only to the parser's default park), the
  // persisted spec artifact wins. An explicit prose park always wins.
  // See work-driver-intent-artifact.ts for the full precedence rule.
  if (useIntent) {
    const parsed = parseNormalisedSpec(responseText);
    // Always read the artifact and let `resolveIntentVerdict` apply the
    // precedence rule — the "explicit prose park wins" invariant lives in
    // one place (work-driver-intent-artifact.ts), not in an inline guard.
    const artifact = await readSpecArtifact(ctx.repoRoot, ctx.issue);
    const { spec, source } = resolveIntentVerdict(parsed, artifact);
    // Reconcile the chosen spec: a `proceed` with contradictions is
    // parked, a `proceed` with assumptions is promoted, an `underspecified`
    // park may be refuted by a complete spec. This runs on the WINNER
    // (prose or artifact), so the reconciliation logic is identical
    // regardless of which channel won the precedence rule.
    const finalSpec = spec ? reconcileVerdict(spec) : undefined;
    if (finalSpec !== undefined) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, normalisedSpec: finalSpec },
      };
      await persistSpecArtifact(ctx.repoRoot, ctx.issue, finalSpec);
      trace(
        `work-driver: intent verdict=${finalSpec.verdict}${finalSpec.parkReason ? ` (${finalSpec.parkReason})` : ""}, ${finalSpec.deliverables.length} deliverable(s) (source: ${source})`,
      );
      if (finalSpec.verdict === "park") {
        return appendEvent(next, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "intent-park",
          reviewRound: next.pipelineState.reviewRound,
          nextStep: "handoff",
        });
      }
      return next;
    }
    // spec === undefined: no parse AND no valid artifact. Fall through to
    // the legacy router below (fires the no-signal cap-hit on the intent path).
    trace("work-driver: no `## Spec` block and no valid artifact — legacy verdict router");
  }

  if (issues.length === 1) {
    const verdict = parseExploreVerdict(responseText);
    if (verdict) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, exploreVerdict: verdict },
      };
    }
    // No `## Spec` block AND no legacy verdict is no signal at all, and the
    // driver used to read that as "proceed": it fell through to `return next`
    // and advanced to plan on an explore reply it could not parse a single
    // decision out of.
    //
    // The documented degradation stays intact — an older prompt or a drifting
    // agent that still emits the legacy token is honoured above. This only
    // catches the case where neither channel said anything, which on the
    // single-issue intent path is the likely one, because the prompt suppresses
    // the legacy token it would fall back to (`useLegacyVerdict` is false
    // there, `work-driver-prompts-early.ts:46-47`).
    if (exploreProducedNoSignal(useIntent, verdict)) {
      trace("work-driver: explore returned neither a `## Spec` block nor a verdict — parking");
      return appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "explore-needs-clarification",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
    if (verdict === "ALREADY_COMPLETE" || verdict === "NEEDS_CLARIFICATION") {
      const cap =
        verdict === "ALREADY_COMPLETE" ? "explore-already-complete" : "explore-needs-clarification";
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
    return next;
  }

  // N>1 path — per-issue verdicts.
  const perIssue = parsePerIssueVerdicts(responseText, issues);
  const activeIssues = perIssue.filter((p) => p.verdict === "NEEDS_WORK").map((p) => p.issue);
  const droppedIssues = perIssue.filter((p) => p.verdict !== "NEEDS_WORK");
  // Aggregate verdict for back-compat surfacing: NEEDS_WORK if any
  // active; else ALREADY_COMPLETE if every dropped is already-complete;
  // else NEEDS_CLARIFICATION.
  const aggregateVerdict: ExploreVerdict =
    activeIssues.length > 0
      ? "NEEDS_WORK"
      : droppedIssues.every((d) => d.verdict === "ALREADY_COMPLETE")
        ? "ALREADY_COMPLETE"
        : "NEEDS_CLARIFICATION";
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      exploreVerdict: aggregateVerdict,
      activeIssues,
      droppedIssues,
    },
  };
  if (activeIssues.length === 0) {
    // Every issue dropped → handoff with the aggregate cap. Existing
    // PR6 routing handles both cap shapes through nextStep().
    const cap =
      aggregateVerdict === "ALREADY_COMPLETE"
        ? "explore-already-complete"
        : "explore-needs-clarification";
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return next;
}

/**
 * Did explore say anything the driver can act on?
 *
 * Two channels can carry a decision: the `## Spec` block (intent path) and the
 * legacy `EXPLORE-VERDICT` token. Reaching this point means the spec block did
 * not parse; if the legacy token is absent too, explore produced no decision at
 * all — and the driver used to treat that as permission to proceed, planning
 * and building against a reply it could not read.
 *
 * A single-issue intent cycle is the case that matters, because there the
 * prompt does not ask for the legacy token (`useLegacyVerdict` is false), so
 * the fallback it degrades to cannot fire by construction.
 */
export function exploreProducedNoSignal(
  intentPathActive: boolean,
  legacyVerdict: string | null | undefined,
): boolean {
  return intentPathActive && !legacyVerdict;
}
