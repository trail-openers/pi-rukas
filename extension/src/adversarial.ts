import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import { writeAdversarialLedgerEntry } from "./adversarial-ledger.ts";
import { buildAdversarialPrompt, buildFixPrompt } from "./adversarial-prompts.ts";
import { infraFailureResult, runPhaseWithInfraRetry } from "./adversarial-retry.ts";
import { decideLoopAction, parseVerdict } from "./adversarial-verdict.ts";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import { markOrchestrator, setOrchestratorActiveChild, startJob } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { readEnumMarker } from "./reply-markers.ts";
import { type RangeDiff, computeRangeDiff } from "./review-diff.ts";
import { type OnSlowCallback, feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdict, DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES, isRateLimit429Msg } from "./types.ts";

const MAX_ROUNDS = 3;

/**
 * Wall-clock budget for all retry attempts in a single adversarial phase.
 * When elapsed time reaches this limit no further retries start, preventing
 * a repeated watchdog kill from consuming its full attempt budget.
 * Set 0 to disable. Override: PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS.
 * Default: 30 min.
 */
export function adversarialPhaseBudgetMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_ADVERSARIAL_PHASE_BUDGET_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return 30 * 60_000;
}

/**
 * Async adversarial gate.
 *
 * The orchestrator does sequential rounds internally (adversarial → developer
 * fix → re-adversarial, up to 3 rounds). From the PM's POV the whole saga is
 * one async dispatch: tool returns a job handle immediately, and one consolidated
 * report ("APPROVED after round N" or "REJECTED after 3 rounds") arrives as a
 * [ensemble:async] user message when the loop terminates.
 */
export function registerAdversarialTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Run the mandatory adversarial gate as an async job: adversarial review → developer fix → re-review, up to 3 rounds. Returns a job handle immediately. The final verdict (APPROVED or REJECTED + findings) arrives as a [ensemble:async] user message. End your turn after dispatching.",
    parameters: Type.Object({
      diff: Type.Optional(
        Type.String({
          description:
            "Current diff to review (git diff output). Optional when base+head are given — then the diff is computed from the ref range; when both are given, this string wins (traced).",
        }),
      ),
      context: Type.String({
        description: "Brief description of what changed and why; passed to adversarial.",
      }),
      base: Type.Optional(
        Type.String({
          description:
            "With head: ref for the diff the tool computes itself as `git diff <base>...<head>` (three-dot, merge-base) in workCwd — preferred over pasting a large diff.",
        }),
      ),
      head: Type.Optional(
        Type.String({
          description:
            "Ref for the diff the tool computes itself (see base). Recomputed before every review round, so rounds 2+ see fixes.",
        }),
      ),
      workCwd: Type.Optional(
        Type.String({
          description:
            "Worktree or repo path where developer should apply fixes; also the cwd for `git diff <base>...<head>` (defaults to the process cwd).",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as {
        diff?: string;
        context: string;
        base?: string;
        head?: string;
        workCwd?: string;
      };
      const { jobId } = startJob(pi, {
        label: "adversarial_loop",
        role: "adversarial-loop",
        // Each round spawns its own deck entry (adversarial review → developer
        // fix → re-review). A single umbrella row would just flicker between
        // sub-states; per-round entries show the actual child running now.
        skipDeck: true,
        work: (signal, hooks) =>
          runAdversarialLoop({ ...params, pi }, signal, hooks.jobId, computeRangeDiff),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async adversarial_loop job ${jobId}. Verdict will arrive as a [ensemble:async] user message. End your turn.`,
          },
        ],
        details: { jobId, role: "adversarial-loop", async: true },
      };
    },
  });
}

/**
 * Run the 3-round adversarial loop directly. Exported so the work-driver can
 * call it without going through the tool-registration layer (PR1 of the
 * workflow-graph compilation). The legacy `adversarial_loop` tool wraps this
 * with `startJob` + steer-back for PM-driven flows; the driver wraps it with
 * `startJob({ ownerKind: "driver", skipDeck: true })` so the result resolves
 * via promise instead of as an [ensemble:async] steer.
 *
 * `orchestratorJobId` should be the jobId of the wrapping job that hosts this
 * loop — used to publish active-child state for dispatch_peek / dispatch_steer
 * to resolve into the currently-running inner spawn.
 */
export async function runAdversarialLoop(
  params: {
    /** Optional when `base` + `head` are present (computed from the ref
     * range). When both `diff` and base/head are given, the string wins. */
    diff?: string;
    /** #859 — the base ref the tool computes the diff from (with head). */
    base?: string;
    /** #859 — the head ref the tool computes the diff from (with base). */
    head?: string;
    context: string;
    workCwd?: string;
    /** Recompute the diff before each review. Without it rounds 2+ see pre-fix material. */
    getDiff?: () => Promise<string>;
    /** The issue this diff is meant to satisfy (#278). Optional: older state files have none. */
    issueBody?: string;
    /** #799 — the slow-run recorder for this loop's inner children (each
     * threshold crossing of a review / fix round appends dispatch-slow). */
    onSlow?: OnSlowCallback;
    /** #799 — the parent pi for the inner children's slow-run watch (the PM
     * notice half; the watch site has no pi of its own). */
    pi?: ExtensionAPI;
    /** #912 — caller-supplied branch for the review-ledger write (the driver
     * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
     * recover it). When absent the writer recovers the branch from `HEAD`
     * and skips (traces) on a detached head. */
    branch?: string;
  },
  signal: AbortSignal,
  orchestratorJobId: string,
  /** #859 — the ref-range diff computation (injectable for tests). Used when
   * `diff` is absent and base/head are present. */
  rangeDiffFn: (cwd: string, base: string, head: string) => Promise<RangeDiff> = computeRangeDiff,
): Promise<DispatchResult> {
  const start = Date.now();
  const runId = makeRunId();
  const rounds: Array<{ round: number; verdict: AdversarialVerdict; ms: number }> = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let lastTranscript: string | undefined;
  let lastModel: string | undefined;

  const ledgerWrite = (result: DispatchResult) => writeAdversarialLedgerEntry(result, params);

  // #859 — resolve the diff: a pasted string wins over a ref range (traced);
  // with no string, base+head compute the range in workCwd (else the process
  // cwd). An error (invalid ref naming the ref, confirmed-empty range, cap
  // overflow) is returned AS the result — never a fallback to an empty
  // string, which the loop would review as "nothing to change" and approve.
  const range = params.base && params.head ? { base: params.base, head: params.head } : null;
  let diff: string;
  let getDiff = params.getDiff;
  if (params.diff && range) {
    trace(
      `adversarial: diff string supplied alongside base=${range.base} head=${range.head} — the diff string wins`,
    );
    diff = params.diff;
  } else if (params.diff) {
    diff = params.diff;
  } else if (range) {
    const cwd = params.workCwd ?? process.cwd();
    // Round 1 uses the diff computed once here at tool entry.
    const initial = await rangeDiffFn(cwd, range.base, range.head);
    if (!initial.ok) {
      const r = synthesizeResult({
        ok: false,
        loopOutcome: "rejected",
        text: `Adversarial loop could not compute the diff for ${range.base}...${range.head}: ${initial.reason}`,
        ms: Date.now() - start,
        usage,
        transcriptPath: lastTranscript,
        model: lastModel,
      });
      ledgerWrite(r);
      return r;
    }
    diff = initial.diff;
    // Rounds 2+ re-compute the SAME range, so a fix round's changes are
    // reviewed (same rule as the driver's per-round getDiff re-read).
    getDiff = () => rangeDiffFn(cwd, range.base, range.head).then((r) => (r.ok ? r.diff : ""));
  } else {
    const r = synthesizeResult({
      ok: false,
      loopOutcome: "rejected",
      text: "Adversarial loop: provide `diff`, or both `base` and `head` (with `workCwd`) — nothing to review was supplied.",
      ms: Date.now() - start,
      usage,
      transcriptPath: lastTranscript,
      model: lastModel,
    });
    ledgerWrite(r);
    return r;
  }

  // Mark this job as orchestrator-shaped so dispatch_peek / dispatch_steer
  // can resolve the orchestrator jobId to its active inner child instead of
  // returning "no such job". Active child is updated below in runPhase.
  markOrchestrator(orchestratorJobId);
  const accumulate = (r: DispatchResult) => {
    if (r.usage) {
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.cacheRead += r.usage.cacheRead;
      usage.cacheWrite += r.usage.cacheWrite;
      usage.cost += r.usage.cost;
      usage.turns += r.usage.turns;
    }
    if (r.transcriptPath) lastTranscript = r.transcriptPath;
    if (r.model && !lastModel) lastModel = r.model;
  };

  /**
   * Run one phase (adversarial review or developer fix), threading dispatch-deck
   * lifecycle and onProgress so the deck shows whichever phase is running now.
   * Also registers the inner spawn as the orchestrator's `activeChild` so PM
   * can `dispatch_peek` / `dispatch_steer` against the loop's jobId and reach
   * the currently-running inner child transparently.
   */
  const runPhase = async (
    role: "adversarial-developer" | "developer",
    tag: string,
    prompt: string,
    cwd?: string,
  ): Promise<DispatchResult> => {
    const deckKey = `${runId}/${tag}`;
    const label = `${role}[${tag}]`;
    dispatchDeck.startEntry(deckKey, { label, role, tag });
    // #799 — the slow-run watch for this inner child: the deck key is the id
    // dispatch_peek shows, and it is what the PM notice names. The parent pi
    // is threaded so the notice reaches the PM (the watch site has no pi).
    // #907 — the CI-wait span feed for this inner child: the watch chains
    // its span tracker in front of the raw-event hook the spawn receives.
    const slowRaw: (event: PiJsonEvent) => void = () => {};
    const stopSlow = watchSlowDispatch({
      id: deckKey,
      role,
      label,
      ...(params.onSlow ? { onSlow: params.onSlow } : {}),
      ...(params.pi ? { pi: params.pi } : {}),
      onRawEvent: slowRaw,
    });
    try {
      return await spawnSpecialist(
        { role, prompt, cwd },
        {
          signal,
          runId,
          tag,
          onProgress: (state) => {
            dispatchDeck.updateEntry(deckKey, state);
            feedSlowProgress(deckKey, state);
          },
          onRawEvent: stopSlow.onRawEvent ?? slowRaw,
          onStdin: (stdin) => {
            // Publish this inner spawn as the orchestrator's active child so
            // PM's peek/steer calls against the orchestrator jobId resolve
            // to this stdin. Updated on each round; cleared in the finally.
            setOrchestratorActiveChild(orchestratorJobId, { role, label, deckKey, stdin });
            // #799 — also registered under the deck key (steer from the peek id).
            registerChildHandle(deckKey, stdin, label, role);
          },
        },
      );
    } finally {
      stopSlow.stop();
      dispatchDeck.clearEntry(deckKey);
      childHandles.delete(deckKey);
      setOrchestratorActiveChild(orchestratorJobId, null);
    }
  };

  // Re-read before every review. `fetchDiff` used to run once, before the loop,
  // so rounds 2 and 3 were prompted with pre-fix material and the reviewer had
  // to notice the staleness itself.
  const priorFindings: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    if (round > 1 && getDiff) {
      try {
        const fresh = await getDiff();
        if (fresh.trim()) diff = fresh;
      } catch (err) {
        // A failed re-read is not a reason to abandon the round; the previous
        // diff plus the live worktree is what the reviewer had before this.
        trace(`adversarial: diff re-read failed for round ${round}: ${(err as Error).message}`);
      }
    }
    const adv = await runPhaseWithInfraRetry(
      "adversarial-developer",
      `round${round}-review`,
      buildAdversarialPrompt({
        diff,
        context: params.context,
        round,
        maxRounds: MAX_ROUNDS,
        issueBody: params.issueBody,
      }),
      params.workCwd,
      { runPhase, accumulate, signal },
    );
    const advCls = classifyDispatchOutcome(adv);
    if (advCls.cause !== "success") {
      const r = infraFailureResult(round, "review", adv, advCls, {
        start,
        usage,
        lastTranscript,
        lastModel,
        toRoundRecords,
      });
      ledgerWrite(r);
      return r;
    }

    const verdict = parseVerdict(adv.text);
    rounds.push({ round, verdict, ms: adv.ms });

    const action = decideLoopAction(verdict.status, round, MAX_ROUNDS, verdict.verdictParsed);
    if (action === "incomplete") {
      // Out of rounds with no readable verdict on the last one. Nothing was
      // reviewed, so this is not an approval and not a rejection — it is the
      // same "no verdict exists" case the infra path already reports, and the
      // step router already knows to retry it once.
      const r = infraFailureResult(
        round,
        "review",
        adv,
        {
          ...advCls,
          headline: "produced no readable VERDICT marker on the final round",
        },
        { start, usage, lastTranscript, lastModel, toRoundRecords },
      );
      ledgerWrite(r);
      return r;
    }
    if (action === "pass") {
      // `PASSED WITH FINDINGS` rather than `APPROVED` when something is still
      // outstanding: the operator (and the lens gate) must be able to tell the
      // two apart, and `commit-pr` carries the findings into the PR body.
      const clean = verdict.status === "APPROVED";
      const r = synthesizeResult({
        ok: true,
        loopOutcome: "approved",
        text: clean
          ? `Adversarial APPROVED after round ${round}.\n\n${verdict.findings}`
          : `Adversarial PASSED WITH FINDINGS after round ${round} (verdict: ${verdict.status} — non-blocking per agents-base/adversarial-developer.md). These findings are unresolved and travel to the PR body and the lens review; they did not block the commit.\n\n${verdict.findings}`,
        ms: Date.now() - start,
        usage,
        transcriptPath: lastTranscript,
        model: lastModel,
        adversarialRounds: toRoundRecords(rounds),
      });
      ledgerWrite(r);
      return r;
    }
    if (action === "reject") break;

    const fix = await runPhaseWithInfraRetry(
      "developer",
      `round${round}-fix`,
      buildFixPrompt({
        findings: verdict.findings,
        context: params.context,
        diff,
        round,
        issueBody: params.issueBody,
        priorFindings: [...priorFindings],
      }),
      params.workCwd,
      { runPhase, accumulate, signal },
    );
    // Record what this round asked for, so the next fixer does not undo it.
    priorFindings.push(
      `Round ${round} (${verdict.status}): ${summariseFindings(verdict.findings)}`,
    );
    const fixCls = classifyDispatchOutcome(fix);
    if (fixCls.cause !== "success") {
      const r = infraFailureResult(round, "fix", fix, fixCls, {
        start,
        usage,
        lastTranscript,
        lastModel,
        toRoundRecords,
      });
      ledgerWrite(r);
      return r;
    }
  }

  const last = rounds[rounds.length - 1];
  const r = synthesizeResult({
    ok: false,
    loopOutcome: "rejected",
    text: [
      `❌ Adversarial REJECTED after ${MAX_ROUNDS} rounds. Last verdict: ${last?.verdict.status}`,
      "",
      last?.verdict.findings ?? "",
      "",
      "Surface the following options to the user verbatim and wait for their choice — do not pick on their behalf:",
      "",
      "  (a) Authorise another adversarial_loop pass (3 more rounds against the current diff).",
      "  (b) Accept the current state and proceed to @ops commit. Record the override in vipune.",
      "  (c) Abandon and rework the approach — return to issue scoping or developer redesign.",
      "  (d) Take over manually — user steps in to address findings directly.",
    ].join("\n"),
    ms: Date.now() - start,
    usage,
    transcriptPath: lastTranscript,
    model: lastModel,
    adversarialRounds: toRoundRecords(rounds),
  });
  ledgerWrite(r);
  return r;
}

interface SynthesizeInput {
  ok: boolean;
  text: string;
  ms: number;
  usage: DispatchResult["usage"];
  transcriptPath?: string;
  model?: string;
  /** #298 — how the loop ended; see DispatchResult.loopOutcome. */
  loopOutcome?: DispatchResult["loopOutcome"];
  /** #485 — per-round verdict records, threaded from the loop as data. */
  adversarialRounds?: DispatchResult["adversarialRounds"];
  /** #485 — total rounds executed when the loop exited with no verdict. */
  roundsExecuted?: number;
  /** #543 — a loop / token-budget self-kill, threaded so the cap path can distinguish it. */
  killCause?: DispatchResult["killCause"];
}

function toRoundRecords(
  rounds: Array<{ round: number; verdict: AdversarialVerdict; ms: number }>,
): DispatchResult["adversarialRounds"] {
  return rounds.map((r) => ({
    round: r.round,
    status: r.verdict.status,
    verdictParsed: r.verdict.verdictParsed !== false,
  }));
}

function synthesizeResult(i: SynthesizeInput): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: i.ok,
    text: i.text,
    toolUses: [],
    ms: i.ms,
    exitCode: i.ok ? 0 : 1,
    usage: i.usage,
    model: i.model,
    transcriptPath: i.transcriptPath,
    loopOutcome: i.loopOutcome,
    adversarialRounds: i.adversarialRounds,
    roundsExecuted: i.roundsExecuted,
    ...(i.killCause ? { killCause: i.killCause } : {}),
  };
}

/**
 * One line of what a round objected to, for the next round's fixer.
 *
 * The full text is the reviewer's entire reply — narration included — and
 * replaying all of it every round would crowd out the round's actual findings.
 */
function summariseFindings(findings: string): string {
  const line = findings
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(?:[-*\d]|###?\s)/.test(l) && l.length > 12);
  return (line ?? findings.trim().split("\n")[0] ?? "(no detail)").slice(0, 200);
}
