import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startBatch, startJob } from "./async-jobs.ts";
import { ROLE_NAMES } from "./roles.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";

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

/**
 * Single-call dispatch surface for in-process orchestrators (the
 * work-driver — see workflow-state.ts / work-driver.ts).
 *
 * Wraps the same `startJob` + `spawnSpecialist` plumbing the PM-facing
 * dispatch tools use, but flagged as `ownerKind: "driver"` so async-jobs
 * skips the `pi.sendUserMessage(report, deliverAs:"steer")` step — the
 * caller awaits the returned promise instead. PM never sees an
 * `[ensemble:async]` it didn't initiate.
 *
 * Why this lives in dispatch.ts: the dispatch tools and the driver both
 * need the same spawn → progress → completion plumbing. Factoring this
 * one entry point keeps the spawn/abort/lifecycle semantics in one place
 * — adding a tool surface in the future means "register a new tool that
 * calls dispatchCore," not "build a parallel plumbing chain."
 *
 * Failure semantics: the promise resolves for ok/failed/errorStop
 * dispatches (failure is encoded in `result.ok` / `result.errorStop`). It
 * REJECTS only if the work function (spawnSpecialist) throws before any
 * DispatchResult is produced — i.e. spawn-level transport errors. The
 * work-driver routes both flavours through its state machine; callers
 * should catch the rejection and emit a `dispatch-failed-provider`
 * (or similar) event into the state file.
 */
export function dispatchCore(
  pi: ExtensionAPI,
  spec: DispatchSpec,
  opts: { label?: string; skipDeck?: boolean; timeoutMs?: number } = {},
): Promise<DispatchResult> {
  const stripped = stripModelOverride(spec);
  const label = opts.label ?? stripped.role;
  const handle = startJob(pi, {
    label,
    role: stripped.role,
    ownerKind: "driver",
    skipDeck: opts.skipDeck,
    work: (signal, hooks) =>
      spawnSpecialist(stripped, {
        signal,
        onProgress: hooks.onProgress,
        onStdin: hooks.onStdin,
        // PR5: per-call timeout override. Used by runHandoff to cap the
        // gh-comment ops dispatch at 3 min (the body file is on disk; ops
        // just runs two CLI invocations — the ops 10-min role default
        // would be too generous).
        timeoutMs: opts.timeoutMs,
      }),
  });
  return handle.completion;
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
        work: (signal, hooks) =>
          spawnSpecialist(spec, {
            signal,
            onProgress: hooks.onProgress,
            onStdin: hooks.onStdin,
          }),
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
    description: `Fan out TWO OR MORE specialists in parallel (up to ${MAX_PARALLEL}). **Use ONLY when you have 2+ independent subagents to dispatch at the same time** — e.g., explore + developer, or developers across separate worktrees. For a single subagent, use \`dispatch_specialist\` instead; never pass a single-element specs array. Returns a batch handle immediately; ONE consolidated report (covering all members) arrives as a user message when every child has finished. When fanning out same-role specs (e.g., 3 developers across worktrees), pass a short \`label\` per spec — the live deck uses it to disambiguate rows (\`developer[task-A]\` vs \`developer[task-B]\`).`,
    parameters: Type.Object({
      specs: Type.Array(
        Type.Object({
          role: Type.String({ description: roleDesc }),
          prompt: Type.String(),
          cwd: Type.Optional(Type.String()),
          label: Type.Optional(
            Type.String({
              description:
                "Short tag (≤16 chars) disambiguating this member in the live deck. Especially useful when multiple specs share the same role — mirror the worktree name where possible (e.g., 'task-A', 'worktree-1', 'refactor-auth'). Falls back to '<role>#<index>' when omitted.",
            }),
          ),
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
        members: specs.map((spec, i) => {
          // Resolve display tag: PM-supplied label takes priority, else index.
          // The deck row shows `<role>[<tag>]` so the user can tell members apart.
          const tag = spec.label?.trim() || `#${i + 1}`;
          const displayLabel = `${spec.role}[${tag}]`;
          return {
            label: displayLabel,
            role: spec.role,
            work: (signal, hooks) =>
              spawnSpecialist(spec, {
                runId,
                seq: i,
                tag,
                signal,
                onProgress: hooks.onProgress,
                onStdin: hooks.onStdin,
              }),
          };
        }),
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
