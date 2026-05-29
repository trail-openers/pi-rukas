import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startBatch, startJob } from "./async-jobs.ts";
import { ROLE_NAMES } from "./roles.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { DispatchSpec } from "./types.ts";

const MAX_PARALLEL = 10;

// Issue #92: the agent must not pick subagent provider/model per dispatch —
// that's a data-residency / jurisdiction-routing decision and belongs to the
// user, via `/ensemble-model` or PI_ENSEMBLE_* env vars. The tool schemas no
// longer declare a `model` field, but a misaligned client could still pass
// one; strip it explicitly before the spec reaches spawnSpecialist.
export function stripModelOverride(spec: DispatchSpec): DispatchSpec {
  if ("model" in spec) {
    const { model: _discarded, ...rest } = spec as DispatchSpec & { model?: unknown };
    return rest as DispatchSpec;
  }
  return spec;
}

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
    }),
    async execute(_id, params) {
      // Defence in depth: TypeBox may not strict-strip undeclared fields, so
      // we discard any agent-supplied `model` before constructing the spec.
      // Model choice is user-authority-only (see issue #92).
      const spec = stripModelOverride(params as DispatchSpec);
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
        }),
        { maxItems: MAX_PARALLEL },
      ),
    }),
    async execute(_id, params) {
      const rawSpecs = (params as { specs: DispatchSpec[] }).specs;
      if (rawSpecs.length < 2) {
        throw new Error(
          `dispatch_parallel requires 2+ specs; got ${rawSpecs.length}. Use dispatch_specialist for a single subagent.`,
        );
      }
      if (rawSpecs.length > MAX_PARALLEL) {
        throw new Error(`Max ${MAX_PARALLEL} parallel slots; got ${rawSpecs.length}`);
      }
      // Defence in depth: drop any agent-supplied `model` from every spec.
      // Model choice is user-authority-only (see issue #92).
      const specs = rawSpecs.map(stripModelOverride);
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
