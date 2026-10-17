/**
 * headless/agents-md — `pi-rukas-headless agents-md` (headless S6, #1021): the
 * agents-md verbs (agents-md/agents-md.ts) with a JSON result.
 *
 *   agents-md <create|update|check> [root] [file] [--deep] [--json]
 *
 * `root` defaults to the repository root. The verbs' human lines go to stderr
 * as NDJSON `log` lines; stdout carries only the JSON document
 * `{verb, status, exitCode, findings[], wouldWrite?}`.
 *
 * Exit codes, from the verb's own code:
 *   0 clean            → 0
 *   1 findings / drift → 10
 *   2 refuse / corrupt → 40 (`error` carries the reason)
 *   3 gated on a human → 10 with `"gated": true`
 */

import { runAgentsMdVerb } from "../agents-md/agents-md.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const AGENTS_MD_FLAGS = ["--deep", "--json"] as const;

const VERBS = ["create", "update", "check"] as const;

/** The verb's own code (0/1/2/3) as the process exit code and status. */
export function agentsMdExit(code: number): { exitCode: number; status: string } {
  switch (code) {
    case 0:
      return { exitCode: EXIT.merged, status: "clean" };
    case 1:
      return { exitCode: EXIT.handoff, status: "findings" };
    case 3:
      return { exitCode: EXIT.handoff, status: "gated" };
    default:
      return { exitCode: EXIT.refused, status: "refused" };
  }
}

export async function runAgentsMdHeadless(
  argv: readonly string[],
  ctx: VerbContext,
): Promise<VerbOutcome> {
  const p = parseFlags(argv, { bool: AGENTS_MD_FLAGS, value: [] });
  if ("error" in p) return badArguments(p.error);
  const [verb, root = ctx.repoRoot, file, ...extra] = p.positional;
  if (!verb || !(VERBS as readonly string[]).includes(verb)) {
    return badArguments(`agents-md needs a verb: ${VERBS.join(", ")}`);
  }
  if (extra.length > 0) return badArguments(`unexpected argument "${extra[0]}"`);
  const run = runAgentsMdVerb(
    [verb, root, ...(file ? [file] : []), ...(p.bool.has("--deep") ? ["--deep"] : [])],
    (line) => ctx.host.sendUserMessage(`agents-md: ${line}`, { deliverAs: "steer" }),
  );
  const { exitCode, status } = agentsMdExit(run.exitCode);
  const r = run.result;
  return {
    exitCode,
    doc: {
      subcommand: "agents-md",
      verb,
      status,
      exitCode,
      findings: r?.check?.findings ?? [],
      ...(r?.plan ? { wouldWrite: r.plan.wouldWrite } : {}),
      ...(status === "gated" ? { gated: true } : {}),
      ...(r?.error ? { error: { code: "agents-md-refused", message: r.error } } : {}),
    },
  };
}
