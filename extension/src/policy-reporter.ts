/**
 * Companion Pi extension loaded into the policy-judge child process (#407).
 *
 * Registers a single `report_policy` tool. The judge reads a project's
 * doctrine files, answers one yes/no policy question, and reports the answer
 * through this tool — never through prose.
 *
 * The reason this is a tool call rather than a marker line in the reply is the
 * whole point of #407. The gate it replaces was three regexes over `AGENTS.md`,
 * and they failed on real files: lantern's *"Agents may squash-merge **a** PR to
 * main"* missed because the pattern wanted `PRs` immediately after `merge`, and
 * this repo's own `does NOT merge to main` escaped the deny matcher because the
 * pattern wanted `do not`. A regex also silently assumes the operator writes
 * English. Pi validates this schema inside the child, so — as with
 * `report_finding` — malformed calls never reach the parent, and there is no
 * text-parsing failure class left to harden.
 *
 * The judge is NOT trusted. Its answer is a claim, and `work-driver-policy.ts`
 * verifies the `quote` appears verbatim in the file the judge named before any
 * permission is granted. See that module for why.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_policy",
    label: "Report Policy Answer",
    description:
      "Report your answer to the policy question. Call this EXACTLY ONCE. Your prose reply is ignored — this call is the only thing that counts.",
    parameters: Type.Object({
      verdict: Type.String({
        description:
          "One of: permitted (the documents explicitly allow the action), forbidden (they explicitly prohibit it), unstated (they do not address it). If you are unsure, answer 'unstated'.",
      }),
      quote: Type.Optional(
        Type.String({
          description:
            "The single sentence from the document that states the rule, copied WORD FOR WORD with no paraphrasing, translation or reformatting. Required for 'permitted' and 'forbidden'. If you cannot copy an exact sentence, the verdict is 'unstated'.",
        }),
      ),
      sourceFile: Type.Optional(
        Type.String({
          description: "Which of the supplied documents the quote came from, e.g. 'AGENTS.md'.",
        }),
      ),
      reasoning: Type.Optional(
        Type.String({ description: "One sentence on why that quote answers the question." }),
      ),
    }),
    async execute(_id, raw) {
      const p = raw as { verdict?: string; sourceFile?: string };
      return {
        content: [
          {
            type: "text",
            text: `recorded policy verdict: ${String(p.verdict ?? "?")}${
              p.sourceFile ? ` (from ${p.sourceFile})` : ""
            }`,
          },
        ],
        details: raw as Record<string, unknown>,
      };
    },
  });
}
