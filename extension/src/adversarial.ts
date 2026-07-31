import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { markOrchestrator, setOrchestratorActiveChild, startJob } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { AdversarialVerdict, DispatchFailureCause, DispatchResult } from "./types.ts";
import { ADVERSARIAL_TRANSIENT_MAX_RETRIES, isRateLimit429Msg } from "./types.ts";

const MAX_ROUNDS = 3;

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
      diff: Type.String({ description: "Current diff to review (git diff output)." }),
      context: Type.String({
        description: "Brief description of what changed and why; passed to adversarial.",
      }),
      workCwd: Type.Optional(
        Type.String({
          description: "Worktree or repo path where developer should apply fixes.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { diff: string; context: string; workCwd?: string };
      const { jobId } = startJob(pi, {
        label: "adversarial_loop",
        role: "adversarial-loop",
        // Each round spawns its own deck entry (adversarial review → developer
        // fix → re-review). A single umbrella row would just flicker between
        // sub-states; per-round entries show the actual child running now.
        skipDeck: true,
        work: (signal, hooks) => runAdversarialLoop(params, signal, hooks.jobId),
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
  params: { diff: string; context: string; workCwd?: string },
  signal: AbortSignal,
  orchestratorJobId: string,
): Promise<DispatchResult> {
  const start = Date.now();
  const runId = makeRunId();
  const rounds: Array<{ round: number; verdict: AdversarialVerdict; ms: number }> = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let lastTranscript: string | undefined;
  let lastModel: string | undefined;
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
    try {
      return await spawnSpecialist(
        { role, prompt, cwd },
        {
          signal,
          runId,
          tag,
          onProgress: (state) => dispatchDeck.updateEntry(deckKey, state),
          onStdin: (stdin) => {
            // Publish this inner spawn as the orchestrator's active child so
            // PM's peek/steer calls against the orchestrator jobId resolve
            // to this stdin. Updated on each round; cleared in the finally.
            setOrchestratorActiveChild(orchestratorJobId, { role, label, deckKey, stdin });
          },
        },
      );
    } finally {
      dispatchDeck.clearEntry(deckKey);
      setOrchestratorActiveChild(orchestratorJobId, null);
    }
  };

  /**
   * #309/#314 — classify a dispatch result by its ROOT CAUSE so the adversarial
   * loop can branch on structure (self-kill / 429 / provider-severed) instead
   * of collapsing everything into a boolean. Uses shared RATE_LIMIT_429_PATTERN
   * from types.ts. Infra-failure is derived: cause !== "success".
   */
  const classifyDispatchOutcome = (
    r: DispatchResult,
  ): {
    cause: DispatchFailureCause;
    shouldRetry: boolean;
    maxRetries: number;
    headline: string;
  } => {
    // killCause (#296) — pi-ensemble itself ended the child. Must check first.
    if (r.killCause === "timeout") {
      return {
        cause: "self-killed:timeout",
        shouldRetry: false,
        maxRetries: 0,
        headline:
          "killed by pi-ensemble (wall-clock timeout) — budget exhausted, retrying cannot help",
      };
    }
    if (r.killCause === "inactivity") {
      return {
        cause: "self-killed:inactivity",
        shouldRetry: true,
        maxRetries: 1,
        headline: "killed by pi-ensemble (inactivity watchdog)",
      };
    }
    if (r.killCause === "abort") {
      return {
        cause: "self-killed:abort",
        shouldRetry: false,
        maxRetries: 0,
        headline: "cancelled (abort signal)",
      };
    }

    // 429 rate-limit — detected from errorStop.message.
    if (r.errorStop && isRateLimit429Msg(r.errorStop.message)) {
      return {
        cause: "rate-limited:429",
        shouldRetry: false,
        maxRetries: 0,
        headline: `provider rate-limited (429) — retrying cannot help (${r.errorStop.message ?? "retry delay requested"})`,
      };
    }

    // Provider error-stop (transport severance, provider timeout, etc).
    if (r.errorStop) {
      return {
        cause: "provider-severed",
        shouldRetry: true,
        maxRetries: ADVERSARIAL_TRANSIENT_MAX_RETRIES,
        headline: `provider/transport error: ${r.errorStop.message ?? r.errorStop.reason}`,
      };
    }

    // Non-zero exit with no structured signal — generic crash.
    if (!r.ok) {
      return {
        cause: "crashed",
        shouldRetry: true,
        maxRetries: 1,
        headline: `crashed (exit ${r.exitCode ?? "?"}), no verdict produced`,
      };
    }

    // Success.
    return {
      cause: "success",
      shouldRetry: false,
      maxRetries: 0,
      headline: "",
    };
  };

  /**
   * #308 — retry loop that respects cause-specific depth.
   * Provider severances get deeper retries (up to maxRetries).
   * Self-kills and 429 get no retries. Inactivity gets one.
   */
  const runPhaseWithInfraRetry = async (
    role: "adversarial-developer" | "developer",
    tag: string,
    prompt: string,
    cwd?: string,
  ): Promise<DispatchResult> => {
    let current = await runPhase(role, tag, prompt, cwd);
    accumulate(current);
    let cls = classifyDispatchOutcome(current);
    if (cls.cause === "success" || signal.aborted) return current;
    if (!cls.shouldRetry || cls.maxRetries === 0) return current;

    // Retry up to maxRetries for this cause.
    for (let attempt = 1; attempt <= cls.maxRetries; attempt++) {
      if (signal.aborted) return current;
      const retry = await runPhase(
        role,
        `${tag}-retry${attempt > 1 ? `-${attempt}` : ""}`,
        prompt,
        cwd,
      );
      accumulate(retry);
      cls = classifyDispatchOutcome(retry);
      if (cls.cause === "success") return retry;
      if (!cls.shouldRetry) return retry; // cause changed (e.g. severance → self-kill)
      current = retry;
    }
    return current;
  };

  const infraFailureResult = (
    round: number,
    phase: string,
    r: DispatchResult,
    cls: ReturnType<typeof classifyDispatchOutcome>,
  ): DispatchResult => {
    return synthesizeResult({
      ok: false,
      loopOutcome: "infra-failure",
      text: `Adversarial loop infrastructure failure: round ${round} ${phase} dispatch ${cls.headline}. No verdict was produced — this is NOT a review rejection.`,
      ms: Date.now() - start,
      usage,
      transcriptPath: lastTranscript,
      model: lastModel,
    });
  };

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal.aborted) break;
    const adv = await runPhaseWithInfraRetry(
      "adversarial-developer",
      `round${round}-review`,
      buildAdversarialPrompt(params.diff, params.context, round),
      params.workCwd,
    );
    const advCls = classifyDispatchOutcome(adv);
    if (advCls.cause !== "success") return infraFailureResult(round, "review", adv, advCls);

    const verdict = parseVerdict(adv.text);
    rounds.push({ round, verdict, ms: adv.ms });

    if (verdict.status === "APPROVED") {
      return synthesizeResult({
        ok: true,
        loopOutcome: "approved",
        text: `Adversarial APPROVED after round ${round}.\n\n${verdict.findings}`,
        ms: Date.now() - start,
        usage,
        transcriptPath: lastTranscript,
        model: lastModel,
      });
    }

    if (round === MAX_ROUNDS) break;

    const fix = await runPhaseWithInfraRetry(
      "developer",
      `round${round}-fix`,
      buildFixPrompt(verdict.findings, params.context),
      params.workCwd,
    );
    const fixCls = classifyDispatchOutcome(fix);
    if (fixCls.cause !== "success") return infraFailureResult(round, "fix", fix, fixCls);
  }

  const last = rounds[rounds.length - 1];
  return synthesizeResult({
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
  });
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
  };
}

function buildAdversarialPrompt(diff: string, context: string, round: number): string {
  return `You are reviewing the diff below. Context: ${context}\nRound: ${round} of ${MAX_ROUNDS}.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. Run lint/type/test if any. Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Diff:
\`\`\`diff
${diff}
\`\`\``;
}

function buildFixPrompt(findings: string, context: string): string {
  return `Fix the following adversarial review findings. Original context: ${context}\n\nFindings:\n${findings}\n\nMake the minimal changes needed to address every finding. Run local quality gates before returning.`;
}

function parseVerdict(text: string): AdversarialVerdict {
  const m = text.match(/VERDICT:\s*(APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND)/);
  const status = (m?.[1] ?? "ISSUES_FOUND") as AdversarialVerdict["status"];
  return { status, findings: text, raw: text };
}
