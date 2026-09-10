import { type DetectedFacts, detectFacts } from "./detect.ts";
import type { LedgerRow } from "./ledger.ts";
import { codeStyleBody, commandsBody, environmentBody, gatesBody } from "./renderer.ts";
import type { AgentOverride } from "./scaffold.ts";
import { managedSectionBody } from "./section-detect.ts";

/**
 * Build the per-section bodies for the fact-section update path.
 *
 * When `agentOverride.facts` is supplied, the three fact-section bodies
 * (quality-gates / commands / environment) are rendered from the override
 * facts INSTEAD of a fresh `detectFacts()`. This is the B1↔B2 seam: the
 * pre-pass (explore role) detects facts once, serialises them into
 * `AgentFacts`, and the update pass (developer role) re-uses them so the
 * body is byte-identical across the two passes.
 *
 * Returns a `Map<id, body>` for the fact ids that have a body, plus the
 * code-style body (agent-derived bullets) when supplied. The caller
 * (update-agent.ts) splices each body into its heading-delimited section
 * (or inserts it when absent).
 */
export function buildFactSectionBodies(
  root: string,
  agentOverride: AgentOverride | undefined,
): {
  bodies: Map<string, string>;
  facts: DetectedFacts;
  codeStyleOut: string | undefined;
} {
  const useOverride = agentOverride?.facts !== undefined;
  const facts = useOverride ? (agentOverride.facts as DetectedFacts) : detectFacts(root);
  const bodies = new Map<string, string>();
  const qg = gatesBody(facts);
  if (typeof qg === "string") bodies.set("quality-gates", qg);
  const cmds = commandsBody(facts);
  if (typeof cmds === "string") bodies.set("commands", cmds);
  const env = environmentBody(facts);
  if (typeof env === "string") bodies.set("environment", env);
  const codeStyleOut = agentOverride?.codeStyleBullets
    ? codeStyleBody(agentOverride.codeStyleBullets)
    : undefined;
  return { bodies, facts, codeStyleOut };
}

/**
 * The B1↔B2 seam: when `agentOverride.facts` is supplied, the three fact
 * section bodies (quality-gates / commands / environment) are rendered from
 * the override facts INSTEAD of a fresh detectFacts(). The resulting
 * section bodies are byte-identical to what detectFacts(root) would
 * produce when the facts are the same (idempotency contract).
 *
 * Returns the splice-form body (trailing newline normalised) for each fact
 * id, or `undefined` when the section is omitted (no commands, no CI, etc.).
 */
export function factSectionSpliceForms(bodies: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, body] of bodies) {
    const spliceForm = body.endsWith("\n") ? body : `${body}\n`;
    out.set(id, spliceForm);
  }
  return out;
}
