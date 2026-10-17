/**
 * research-tool — the compiled `start_research_driver` tool.
 *
 * /research used to be a 57-line prose body that left PM to improvise the
 * whole flow: 2–4 parallel explores → prose synthesis → one undated vipune
 * line. The landscape review (outputs/research-driver-landscape.md) found
 * that every serious research harness runs plan → budgeted retrieval →
 * verification → durable cited artifact + provenance; this tool compiles
 * exactly that deterministic spine (research-driver.ts) and leaves
 * judgement — angle choice, and the conversation after the artifact — with
 * PM. The /research slash-command body now instructs PM to call this tool.
 *
 * #1044 — the tool LAUNCHES and returns; it does not wait. The pipeline runs
 * in a background job (`startJob`, `reportKind: "driver"`) and the full
 * rendered result — the exact text this tool used to return — arrives later as
 * one `[ensemble:async]` steer naming the jobId, the same contract
 * `start_work_driver` has. A blocking research run locked the operator out of
 * the PM for the whole run, which is what they actually complained about.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import { noticeSubject } from "./plan-tool.ts";
import { runResearchPipeline } from "./research-driver.ts";
import type { ResearchClaim, ResearchResult } from "./research-types.ts";
import { trace } from "./trace.ts";
import { piSessionHost } from "./work-driver-host.ts";
import { resolveRepoRoot } from "./work-entry.ts";

export interface RegisteredResearchTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  // The five execute() arguments are NAMED so the async test
  // (test-plan-research-async.ts) can pass the ExtensionContext positionally.
  // The job's report reaches the registered `pi`, not this object — the test
  // registers a stub whose `sendUserMessage` records the delivery.
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;
}

/**
 * #1044 — the launch notice (see `launchNotice` in plan-tool.ts for the same
 * reasoning: a tool result arrives in seconds, the run takes minutes, so the
 * notice may only assert what every run does whatever it ends up doing).
 *
 * #1541 review (MEDIUM): this used to promise "it says RESEARCH COMPLETE ... and
 * names the artifact, the provenance sidecar and the verified-finding counts".
 * Three of those four outcomes never happen on a halt, an abstention or a kill,
 * so the notice promised content the run may never produce — and a PM that
 * quoted it had asserted an artifact path that does not exist. The notice now
 * states both branches: the report says COMPLETE *if* the run completes, and
 * FAILED/CANCELLED/HALTED if it does not.
 */
export function researchLaunchNotice(o: {
  jobId: string;
  topic: string;
  tier: string;
  repoRoot: string;
}): string {
  return `pi-rukas: /research driver started for "${noticeSubject(o.topic)}" (jobId: ${o.jobId}, tier: ${o.tier}, repo: ${o.repoRoot}). The report says one of two things: RESEARCH COMPLETE with the artifact, provenance sidecar and verified-finding counts — if the run finished; or RESEARCH HALTED / RESEARCH CANCELLED / a FAILED report naming the cause, with no artifact. Until it arrives you have neither verdict nor paths: quote neither. The run takes minutes; end your turn — the [ensemble:async] steer carrying the jobId is the result, not this notice. Do not poll, and do not re-call to check progress.`;
}

export function registerResearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_research_driver",
    label: "Start /research Driver",
    description:
      "Launch the compiled /research pipeline in the BACKGROUND: memory inventory → parallel angle retrieval (structured report_research_claim calls) → deterministic verification (URL liveness + commit-pinned code grounding) → a dated artifact + provenance sidecar under <repo>/outputs/ → a typed vipune row with supersession. RETURNS IMMEDIATELY with a jobId and a launch notice — it does NOT return the findings. The run takes minutes; end your turn and the full result arrives later as one `[ensemble:async]` steer message naming this job (also when you are idle). Never poll or re-call to find out whether it finished. Concurrent launches are allowed; each result names its own topic. Tiers: quick (1 angle, liveness only), standard (default; web + docs + codebase-if-code-named angles, full deterministic verification), deep (standard + ONE scoped LLM entailment pass annotating per-claim source support), adoption (OSS-adoption decision memo: signals/alternatives/integration-fit angles + a synthesis child whose recommendation embeds in the memo — use for 'should we adopt X' topics). Pass your own angle prompts via `angles` to override the derived set; the driver stops at the artifact — presenting, digging deeper and deciding plan-relevance stay with you in the conversation. Zero verified findings still writes an honest abstention artifact.",
    parameters: Type.Object({
      topic: Type.String({ description: "The research topic — one or two sentences." }),
      tier: Type.Optional(
        Type.Union(
          [
            Type.Literal("quick"),
            Type.Literal("standard"),
            Type.Literal("deep"),
            Type.Literal("adoption"),
          ],
          {
            description:
              "Depth tier (default standard). quick = 1 angle + liveness only; deep = + one entailment reviewer pass; adoption = OSS-adoption decision memo.",
          },
        ),
      ),
      angles: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional angle prompts of your own (max 4). When given they replace the derived angle set verbatim (each is framed and dispatched to one explore child).",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Session facts to treat as established (not re-investigated) — briefed to every angle child.",
        }),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        topic: string;
        tier?: "quick" | "standard" | "deep" | "adoption";
        angles?: string[];
        context?: string;
      };
      if (!params.topic || params.topic.trim().length === 0) {
        return {
          content: [{ type: "text", text: "start_research_driver requires a non-empty topic." }],
          details: { started: false },
        };
      }
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      const tier = params.tier ?? "standard";
      trace(
        `start_research_driver → topic="${params.topic.slice(0, 60)}" tier=${tier} repoRoot=${repoRoot}`,
      );
      const runResearchJob = async (signal: AbortSignal) => {
        const result = await runResearchPipeline(
          piSessionHost(pi),
          params,
          repoRoot,
          {},
          {
            signal,
          },
        );
        return {
          role: "research-driver",
          ok: !result.cancelled,
          // A killed run still owes its report: a silent kill leaves PM waiting
          // for a steer that never comes.
          text: renderResearchResult(result),
          toolUses: [],
          ms: 0,
          exitCode: result.cancelled ? 143 : 0,
          ...(result.cancelled ? { killCause: "abort" as const } : {}),
        };
      };
      // #1044 — launch, don't wait (see plan-tool.ts for the full reasoning).
      // The pipeline runs inside the job so a throw anywhere in it reaches the
      // job's rejection path and is delivered as a bounded fail report. The
      // deck entry STAYS (skipDeck is not set) for the SAME reason plan-tool.ts
      // gives for omitting its own, applied to the opposite shape: the deck
      // shows the real children and no umbrella row that masks them. Here the
      // angle children register their own rows through dispatchCore, and this
      // job makes no dispatch of its own — so its row is the only handle the
      // operator has on a 20-minute run, not a mask over rows that already
      // exist. (plan-tool.ts sets skipDeck because its own job row would sit
      // over its investigation/gap-gate rows; a research job has no such row.)
      // The job delivers to `pi` — the same host every report-delivering tool
      // uses (work-tool.ts); see plan-tool.ts for the mid-turn delivery note.
      let jobId: string;
      try {
        jobId = startJob(pi, {
          label: "research-driver",
          role: "research-driver",
          subject: params.topic,
          reportKind: "driver",
          // #1541 review (MEDIUM) — the job's OWN AbortSignal (not the tool's
          // exec signal, which Pi drops when execute() returns) threaded into
          // the pipeline, so dispatch_kill and session shutdown stop a run at
          // its phase boundaries instead of waiting out the 30-minute child
          // bound. A cancelled run is still delivered — see runResearchJob.
          work: (signal) => runResearchJob(signal),
        }).jobId;
      } catch (err) {
        // #1541 review (LOW) — startJob throws at its MAX_JOBS cap; hand the
        // caller a named refusal rather than the registry's raw Error.
        return jobSaturation(err);
      }
      return {
        content: [
          {
            type: "text",
            text: researchLaunchNotice({ jobId, topic: params.topic, tier, repoRoot }),
          },
        ],
        // #1295 — the async-result contract every report-delivering tool keeps.
        details: { started: true, async: true, jobId, tier, topic: noticeSubject(params.topic) },
      };
    },
  });
}

/**
 * #1541 review (LOW): the named refusal when `startJob` is at its MAX_JOBS cap
 * (the plan tool has the identical guard; the registry's raw throw is the
 * shape the other startJob callers depend on).
 */
function jobSaturation(err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  trace(`start_research_driver refused: ${detail}`);
  return {
    content: [{ type: "text" as const, text: `start_research_driver refused: ${detail}` }],
    details: { started: false, error: "jobs-saturated" },
  };
}

function claimLine(c: ResearchClaim): string {
  return `- [${c.confidence}] ${c.text} (${c.source})`;
}

function renderResearchResult(r: ResearchResult): string {
  // #1541 review (MEDIUM) — a cancelled run reports the kill, not an outcome it
  // never reached. Without this branch a kill mid-retrieval renders the
  // all-angles-failed halt ("RESEARCH HALTED — reporter-silent"), which points
  // the operator at a reporter extension that was never the problem.
  if (r.cancelled) {
    return `RESEARCH CANCELLED — killed by ${r.cancelled.by}${r.cancelled.phase ? ` during the ${r.cancelled.phase} phase` : ""}. No artifact was written. Re-call start_research_driver to run it again.`;
  }
  if (r.halt) {
    return `RESEARCH HALTED — ${r.halt.reason}: ${r.halt.detail}\n\nAngles: ${r.angles.map((a) => `${a.name} (${a.ok ? "ok" : "failed"})`).join(", ") || "(none)"}${timingsLine(r)}`;
  }
  const findings = r.claims.filter((c) => c.kind === "finding");
  const contradictions = r.claims.filter((c) => c.kind === "contradiction");
  const gaps = r.claims.filter((c) => c.kind === "gap");
  const head = r.abstained
    ? `RESEARCH COMPLETE — NO RELIABLY VERIFIED FINDINGS. An honest abstention artifact records what was checked: ${r.artifactPath}`
    : `RESEARCH COMPLETE — artifact: ${r.artifactPath}`;
  const entailNote =
    r.entailment === "unavailable"
      ? "\nNOTE: the deep-tier entailment pass was UNAVAILABLE (reviewer dispatch failed) — support annotations are absent, not clean."
      : "";
  const contra =
    contradictions.length > 0
      ? `\n\n=== CONTRADICTIONS (surface these to the operator) ===\n${contradictions.map(claimLine).join("\n")}`
      : "";
  const gapText =
    gaps.length > 0 ? `\n\n=== GAPS / UNANSWERED ===\n${gaps.map(claimLine).join("\n")}` : "";
  const mem =
    r.memory.outcome === "written" || r.memory.outcome === "superseded"
      ? `memory: ${r.memory.outcome} (candidate row${r.memory.id ? ` ${r.memory.id}` : ""})`
      : `memory: ${r.memory.outcome}${r.memory.detail ? ` — ${r.memory.detail}` : ""}`;
  return `${head}${entailNote}
Provenance: ${r.provenancePath} · pinned commit: ${r.pinnedCommit}

=== SUMMARY ===
${r.angles.map((a) => `- ${a.name} (${a.ok ? "ok" : "failed"}): ${a.summary.split("\n")[0] ?? ""}`).join("\n")}

Findings: ${findings.length} (${r.claims.filter((c) => c.verification.status === "dead" || c.verification.status === "ungrounded").length} failed verification — see provenance) · contradictions: ${contradictions.length} · gaps: ${gaps.length} · ${mem}${contra}${gapText}

Present the artifact to the operator and stay in conversation — offer to dig deeper (another driver call with sharper angles) rather than re-running blindly.${timingsLine(r)}`;
}

function timingsLine(r: ResearchResult): string {
  if (!r.timings || r.timings.length === 0) return "";
  return `\n\n=== TIMINGS ===\n${r.timings.map((t) => `${t.phase} ${fmtMs(t.ms)}`).join(" · ")}`;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
}
