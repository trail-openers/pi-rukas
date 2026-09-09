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
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runResearchPipeline } from "./research-driver.ts";
import type { ResearchClaim, ResearchResult } from "./research-types.ts";
import { trace } from "./trace.ts";
import { resolveRepoRoot } from "./work-entry.ts";

export function registerResearchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_research_driver",
    label: "Start /research Driver",
    description:
      "Run the compiled /research pipeline: memory inventory → parallel angle retrieval (structured report_research_claim calls) → deterministic verification (URL liveness + commit-pinned code grounding) → a dated artifact + provenance sidecar under <repo>/outputs/ → a typed vipune row with supersession. Tiers: quick (1 angle, liveness only), standard (default; web + docs + codebase-if-code-named angles, full deterministic verification), deep (standard + ONE scoped LLM entailment pass annotating per-claim source support), adoption (OSS-adoption decision memo: signals/alternatives/integration-fit angles + a synthesis child whose recommendation embeds in the memo — use for 'should we adopt X' topics). Pass your own angle prompts via `angles` to override the derived set; the driver stops at the artifact — presenting, digging deeper and deciding plan-relevance stay with you in the conversation. Zero verified findings still writes an honest abstention artifact.",
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
      trace(
        `start_research_driver → topic="${params.topic.slice(0, 60)}" tier=${params.tier ?? "standard"} repoRoot=${repoRoot}`,
      );
      try {
        const result = await runResearchPipeline(pi, params, repoRoot);
        return {
          content: [{ type: "text", text: renderResearchResult(result) }],
          details: resultDetails(result),
        };
      } catch (err) {
        trace(`start_research_driver failed: ${(err as Error).message}`);
        return {
          content: [
            { type: "text", text: `start_research_driver failed: ${(err as Error).message}` },
          ],
          details: { started: false, error: (err as Error).message },
        };
      }
    },
  });
}

function claimLine(c: ResearchClaim): string {
  return `- [${c.confidence}] ${c.text} (${c.source})`;
}

function renderResearchResult(r: ResearchResult): string {
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

function resultDetails(r: ResearchResult): Record<string, unknown> {
  return {
    started: true,
    topic: r.topic,
    tier: r.tier,
    artifactPath: r.artifactPath,
    provenancePath: r.provenancePath,
    pinnedCommit: r.pinnedCommit,
    claimCount: r.claims.length,
    abstained: r.abstained,
    entailment: r.entailment,
    memory: r.memory,
    halt: r.halt,
    timings: r.timings,
  };
}
