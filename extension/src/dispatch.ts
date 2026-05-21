import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startBatch, startJob } from "./async-jobs.ts";
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
      "Spawn EXACTLY ONE specialist (developer, ops, explore, adversarial-developer, code-review-specialist) and return a job handle immediately. **Use this whenever you need a single subagent.** If you need TWO OR MORE subagents to run simultaneously, use `dispatch_parallel` instead — never use `dispatch_parallel` with a single spec. The final report arrives later as a user message starting with `[ensemble:async]`. End your turn after dispatching unless you have other independent work to do.",
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
      const { jobId } = startJob(pi, {
        label: spec.role,
        role: spec.role,
        work: (signal) => spawnSpecialist(spec, { signal }),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async [${spec.role}] job ${jobId}. Final report will arrive as a [ensemble:async] user message. End your turn or proceed with other parallel work.`,
          },
        ],
        details: { jobId, role: spec.role, async: true },
      };
    },
  });

  pi.registerTool({
    name: "dispatch_parallel",
    label: "Dispatch Parallel",
    description: `Fan out TWO OR MORE specialists in parallel (up to ${MAX_PARALLEL}). **Use ONLY when you have 2+ independent subagents to dispatch at the same time** — e.g., explore + developer, or developers across separate worktrees. For a single subagent, use \`dispatch_specialist\` instead; never pass a single-element specs array. Returns a batch handle immediately; ONE consolidated report (covering all members) arrives as a user message when every child has finished.`,
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
      if (specs.length < 2) {
        throw new Error(
          `dispatch_parallel requires 2+ specs; got ${specs.length}. Use dispatch_specialist for a single subagent.`,
        );
      }
      if (specs.length > MAX_PARALLEL) {
        throw new Error(`Max ${MAX_PARALLEL} parallel slots; got ${specs.length}`);
      }
      // Share a runId so all children in this batch sort together on disk.
      const runId = makeRunId();
      const { batchId } = startBatch(pi, {
        batchLabel: "dispatch_parallel",
        members: specs.map((spec, i) => ({
          label: spec.role,
          role: spec.role,
          work: (signal) => spawnSpecialist(spec, { runId, seq: i, signal }),
        })),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async batch of ${specs.length} specialist(s); batch ${batchId}. ONE consolidated report will arrive as a [ensemble:async] user message when ALL children finish. End your turn or proceed with other parallel work.`,
          },
        ],
        details: { batchId, size: specs.length, async: true },
      };
    },
  });
}
