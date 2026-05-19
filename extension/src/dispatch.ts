import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ROLE_NAMES } from "./roles.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { DispatchSpec } from "./types.ts";

const MAX_PARALLEL = 10;

export function registerDispatchTools(pi: ExtensionAPI) {
  const roleDesc = `One of: ${ROLE_NAMES.join(", ")}`;

  pi.registerTool({
    name: "dispatch_specialist",
    label: "Dispatch Specialist",
    description:
      "Spawn one specialist agent (developer, ops, explore, adversarial-developer, code-review-specialist) and wait for its result.",
    parameters: Type.Object({
      role: Type.String({ description: roleDesc }),
      prompt: Type.String({ description: "Task description for the specialist." }),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory; defaults to current cwd.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Override the model for this spawn ('<provider>/<model>' — see `pi --list-models`). Falls back to /ensemble-model config, then PI_ENSEMBLE_MODEL_<ROLE>, then PI_ENSEMBLE_SUBAGENT_MODEL, then Pi default.",
        }),
      ),
    }),
    async execute(_id, params) {
      const spec = params as DispatchSpec;
      const result = await spawnSpecialist(spec);
      return {
        content: [
          {
            type: "text",
            text: formatSingleResult(result),
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "dispatch_parallel",
    label: "Dispatch Parallel",
    description: `Fan out up to ${MAX_PARALLEL} specialists; resolves when all return. Use for independent work (research angles, parallel implementation tasks, code-review lenses).`,
    parameters: Type.Object({
      specs: Type.Array(
        Type.Object({
          role: Type.String({ description: roleDesc }),
          prompt: Type.String(),
          cwd: Type.Optional(Type.String()),
          model: Type.Optional(
            Type.String({
              description:
                "Per-spec model override ('<provider>/<model>'). Falls back to /ensemble-model config or env vars; final fallback is Pi default.",
            }),
          ),
        }),
        { maxItems: MAX_PARALLEL },
      ),
    }),
    async execute(_id, params) {
      const specs = (params as { specs: DispatchSpec[] }).specs;
      if (specs.length > MAX_PARALLEL) {
        throw new Error(`Max ${MAX_PARALLEL} parallel slots; got ${specs.length}`);
      }
      // Share a runId so all children in this batch sort together on disk.
      const runId = makeRunId();
      const results = await Promise.all(specs.map((s, i) => spawnSpecialist(s, { runId, seq: i })));
      const summary = results
        .map((r) => {
          const modelTag = r.model ? ` · ${r.model}` : "";
          const transcript = r.transcriptPath ? ` · transcript: ${r.transcriptPath}` : "";
          return `[${r.role}] ${r.ok ? "ok" : "fail"} (${r.ms}ms)${modelTag}${transcript}`;
        })
        .join("\n");
      const detail = results.map((r) => `=== ${r.role} ===\n${r.text}`).join("\n\n");
      return {
        content: [{ type: "text", text: `${summary}\n\n${detail}` }],
        details: { results, runId },
      };
    },
  });
}

function formatSingleResult(r: import("./types.ts").DispatchResult): string {
  const modelTag = r.model ? ` · ${r.model}` : "";
  const transcript = r.transcriptPath ? `\ntranscript: ${r.transcriptPath}` : "";
  return `[${r.role}] ${r.ok ? "ok" : "fail"} (${r.ms}ms)${modelTag}${transcript}\n\n${r.text}`;
}
