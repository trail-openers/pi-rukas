/**
 * headless/research — `pi-rukas-headless research` (headless S6, #1021): one
 * run of the compiled /research pipeline (runResearchPipeline) on the
 * headless DriverHost.
 *
 *   research <topic> [--tier quick|standard|deep|adoption] [--context <text>] [--json]
 *
 * Exit codes:
 *   0   artifact written, abstention included (`"abstained": true` — zero
 *       verified findings is an honest result, not a failure). A deep run whose
 *       entailment pass could not run carries `"entailment": "unavailable"`.
 *  30   the pipeline halted without an artifact (`halt.reason` / `detail`)
 *  40   bad arguments; an unknown tier is `error.code: "unknown-tier"`
 */

import { type ResearchDeps, runResearchPipeline } from "../research-driver.ts";
import { RESEARCH_TIERS, type ResearchTier } from "../research-types.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const RESEARCH_FLAGS = ["--tier", "--context", "--json"] as const;

export async function runResearchVerb(
  argv: readonly string[],
  ctx: VerbContext,
  deps: ResearchDeps = {},
): Promise<VerbOutcome> {
  const p = parseFlags(argv, { bool: ["--json"], value: ["--tier", "--context"] });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length !== 1 || (p.positional[0] as string).trim() === "") {
    return badArguments("research needs exactly one non-empty topic argument");
  }
  const topic = (p.positional[0] as string).trim();
  const tier = p.value.get("--tier") ?? "standard";
  // The pipeline falls back to `standard` on an unknown tier; a caller that
  // asked for one it did not get is refused instead.
  if (!(RESEARCH_TIERS as readonly string[]).includes(tier)) {
    return {
      exitCode: EXIT.refused,
      doc: {
        error: {
          code: "unknown-tier",
          message: `unknown tier "${tier}" (one of ${RESEARCH_TIERS.join(", ")})`,
        },
      },
    };
  }
  ctx.host.sendUserMessage(`research: ${tier} — ${topic}`, { deliverAs: "steer" });
  const result = await runResearchPipeline(
    ctx.host,
    { topic, tier: tier as ResearchTier, context: p.value.get("--context") },
    ctx.repoRoot,
    deps,
  );
  const status = result.halt ? "halted" : result.abstained ? "abstained" : "completed";
  const exitCode = result.halt ? EXIT.crash : EXIT.merged;
  ctx.host.sendUserMessage(`research: ${status} (exit ${exitCode})`, { deliverAs: "steer" });
  return { exitCode, doc: { subcommand: "research", exitCode, status, ...result } };
}
