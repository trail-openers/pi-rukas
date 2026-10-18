import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { DispatchHost } from "./async-jobs-lifecycle.ts";
import { startBatch, startJob } from "./async-jobs.ts";
import { type RetryNotice, withProviderBackoff } from "./dispatch-retry.ts";
import { steerChild } from "./dispatch-steer.ts";
import { excludeToolsFor } from "./role-tools.ts";
import { ROLE_NAMES } from "./roles.ts";
import type { OnSlowCallback } from "./slow-notice.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";
import { liveCycleIssues, liveCycleOwning } from "./work-driver-registry.ts";

/**
 * #838 — the per-cycle deck option a driver dispatch threads through
 * `dispatchCore`: `cycleKey` is the batch key the member rows group under
 * (the driver's "/work #N" header, see work-driver-deck-header.ts); `label`
 * is the row label ("#N develop · default"). The job's event label stays
 * `opts.label ?? role` — the driver's cap checkpoint parses `developer[<id>]`
 * out of it — while the deck row shows `label` (display only; `deckLabel`
 * overrides when the row label must differ from the job label). When present
 * the job is registered in the deck exactly like a PM job (skipDeck false)
 * while the PM steer-back stays gated on ownerKind "driver" — a deck row is
 * display/steer-only, never a report.
 */
export interface DriverDeckOpts {
  cycleKey: string;
  label: string;
  /** Display label for the deck entry (and its batch key row); absent means
   *  the deck row shows the job label as-is. */
  deckLabel?: string;
}

const MAX_PARALLEL = 10;

// Issue #92: the agent must not pick subagent provider/model per dispatch —
// that's a data-residency / jurisdiction-routing decision and belongs to the
// user, via `/ensemble-model` or PI_ENSEMBLE_* env vars. The tool schemas no
// longer declare a `model` field, but a misaligned client could still pass
// one; strip it explicitly before the spec reaches spawnSpecialist. `lens`
// (#1348) selects the per-lens model tier, so it is stripped too: only the
// lens fan-out, which calls spawnSpecialist directly, may set it.
export function stripModelOverride(spec: DispatchSpec): DispatchSpec {
  if ("model" in spec || "lens" in spec) {
    const {
      model: _m,
      lens: _l,
      ...rest
    } = spec as DispatchSpec & {
      model?: unknown;
      lens?: unknown;
    };
    return rest as DispatchSpec;
  }
  return spec;
}

/**
 * Refuse a PM dispatch of a WRITING role into the worktree of a live /work
 * cycle. That tree has one writer, the driver's own child; a PM that put a
 * second developer there had the two revert and overwrite each other's files
 * for twenty minutes, and the driver's later gates each read a different
 * tree. Read-only roles (explore, the reviewers) may look — a PM that cannot
 * see the tree is how the mistake started. The driver dispatches through
 * `dispatchCore`, never through the tools, so it is not affected.
 */
export function assertNotDriverWorktree(spec: DispatchSpec): void {
  if (excludeToolsFor(spec.role) !== undefined) return;
  const cwd = spec.cwd ?? process.cwd();
  const cycle = liveCycleOwning(cwd);
  if (cycle === undefined) return;
  throw new Error(
    `Refused: ${cwd} is the worktree of the running /work driver cycle for #${cycle}. The driver's own child is the only writer there, and a second ${spec.role} corrupts the tree the driver verifies and commits from. Do not hand-dispatch into a live cycle — the driver retries and parks on its own (/work-status ${cycle}). To inspect the tree, dispatch explore.`,
  );
}

/** "issue #37", "issues 37", "issue-37" (worktree / branch), "task-37", "gh issue view 37". */
const ISSUE_REF = /\bissues?[-_ ]?#?(\d+)|\btask-(\d+)|\bgh issue \w+ #?(\d+)/gi;

const hashList = (ns: Iterable<number>) => [...ns].map((n) => `#${n}`).join(", ");

/**
 * Refuse a PM dispatch of a WRITING role whose prompt or cwd names an issue
 * the live /work cycle does not own (#1361) — in a session with no terminal
 * only. There nobody asked the PM for other work: it exists to report on the
 * cycle, and the one time it wrote for another issue it had invented that
 * issue from a slow-run notice, made a worktree and branch for it in the
 * cycle's repository and spent 1.1M tokens before noticing. In the TUI the
 * operator may well ask for other work while a cycle runs, so it is let
 * through. Read-only roles may look anywhere.
 */
export function assertWithinCycleIssues(
  spec: DispatchSpec,
  mode: ExtensionContext["mode"] | undefined,
): void {
  if (mode === undefined || mode === "tui") return;
  if (excludeToolsFor(spec.role) !== undefined) return;
  const owned = new Set(liveCycleIssues());
  if (owned.size === 0) return;
  const named = new Set<number>();
  for (const m of `${spec.cwd ?? ""}\n${spec.prompt}`.matchAll(ISSUE_REF)) {
    named.add(Number(m[1] ?? m[2] ?? m[3]));
  }
  const foreign = [...named].filter((n) => !owned.has(n));
  if (foreign.length === 0) return;
  throw new Error(
    `Refused: this ${spec.role} dispatch names ${hashList(foreign)}, but the /work cycle in this session owns ${hashList(owned)} and no other issue. Its children are the driver's (dispatch_status marks them), and the driver develops, commits and parks on its own (/work-status ${[...owned][0]}). Do not start work on an issue the cycle was not given; to look something up, dispatch explore.`,
  );
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
  pi: DispatchHost,
  spec: DispatchSpec,
  opts: {
    label?: string;
    skipDeck?: boolean;
    /** #838 — the driver's per-cycle deck option (batch key + row label;
     *  see DriverDeckOpts above). When present the deck entry is created
     *  (skipDeck false, exactly like a PM job); the PM steer-back stays
     *  gated on ownerKind "driver" — a deck row is display/steer only,
     *  never a report steer-back to the PM. */
    deck?: DriverDeckOpts;
    timeoutMs?: number;
    /** #1560 — the per-child run bound (SpawnOptions.childBoundMs). */
    childBoundMs?: number;
    extraArgs?: readonly string[];
    onSlow?: OnSlowCallback;
    /**
     * Headless S4 (#1024) — the cycle's AbortSignal. Aborting it kills the
     * child (spawn's abort handler sends SIGTERM, then SIGKILL after 5s), so a
     * SIGTERM to the runner leaves no developer process running.
     */
    signal?: AbortSignal;
    /** Headless S4 (#1024): the child leads its own process group (spawn-kill.ts). */
    processGroup?: boolean;
  } = {},
): Promise<DispatchResult> {
  const stripped = stripModelOverride(spec);
  // #1541 — an already-aborted job never gets a child. The pipeline's
  // phase-boundary checks catch a kill between awaits, but a barrier's legs
  // dispatch CONCURRENTLY: a kill that lands while leg A is in flight has
  // already queued leg B's dispatch, and microtask ordering decides whether the
  // boundary check runs first. Refusing here makes "no child spawns after a
  // kill" a property of the seam rather than a race — the child that is never
  // started is the one that cannot cost tokens, write a transcript, or file
  // anything. A synthetic reply, shaped exactly like a killed child: the
  // declared `killCause: "abort"` is what every downstream reader branches on
  // first (work-driver-completion-event.ts, work-driver-failure-taxonomy.ts),
  // so a self-kill is never mistaken for a provider fault.
  if (opts.signal?.aborted) {
    return Promise.resolve({
      role: stripped.role,
      ok: false,
      text: "",
      toolUses: [],
      ms: 0,
      exitCode: 137,
      killCause: "abort",
    });
  }
  // #573 — derive the transcript path BEFORE dispatch so crash-resume can
  // locate the surviving session file. The driver calls beginDispatch with
  // this path; the spawn-side runId (from spec.runId or freshly minted) is
  // what actually determines the file that Pi writes.
  const runId = stripped.runId ?? makeRunId();
  const transcriptPath = transcriptPathFor(stripped.role, runId);
  // #838 lens fix — the JOB label stays `opts.label ?? role`: the driver's
  // events (dispatch-started/completed/failed/slow) and the cap checkpoint's
  // `workstreamIdFromLabel(/^developer\[(.+)\]$/)` parse depend on it. The
  // deck row is display-only and gets its own label separately.
  const label = opts.label ?? stripped.role;
  // #799 — the driver's dispatch-slow record: the watch (owned by startJob)
  // fires it on each threshold crossing; the caller appends the event to the
  // cycle state and persists (see the runX call sites). Absent for PM jobs.
  const onSlow = opts.onSlow;
  const handle = startJob(pi, {
    label,
    role: stripped.role,
    ownerKind: "driver",
    // #838 — deck implies skipDeck=false: a deck-tagged driver job is
    // registered exactly like a PM job (the deck row is display/steer-only).
    skipDeck: opts.deck ? false : opts.skipDeck,
    batchKey: opts.deck?.cycleKey,
    deckLabel: opts.deck?.deckLabel ?? opts.deck?.label ?? label,
    onSlow,
    work: (signal, hooks) =>
      spawnSpecialist(stripped, {
        signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
        onProgress: hooks.onProgress,
        onRawEvent: hooks.onRawEvent,
        onStdin: hooks.onStdin,
        // #543 F6 — the driver's token-budget cap steers the child through
        // steerChild (the F2 seam) so the lifecycle 'steered' entry is tagged
        // "driver-budget". The job id is known here (hooks.jobId), so the
        // steer resolves to this child's stdin handle.
        onSteer: (message, source) => {
          steerChild(hooks.jobId, message, source);
        },
        // Per-call override of the runaway backstop, for a dispatch whose work
        // is enumerable enough to bound. Two live callers, each with its
        // rationale at the definition: `ciWatchTimeoutMs`
        // (work-driver-stepback-ci.ts — `gh run watch` blocks for a real CI
        // run) and `handoffDispatchTimeoutMs` (work-driver-handoff.ts — a park
        // comment is a few gh calls and a markdown render).
        timeoutMs: opts.timeoutMs,
        childBoundMs: opts.childBoundMs,
        // Companion-extension plumbing (lens-reporter / policy-reporter /
        // plan-reporter precedent): the plan driver pins its Phase-2 children
        // to the report_plan_item tool via `--no-skills --extension <path>`.
        extraArgs: opts.extraArgs,
        processGroup: opts.processGroup,
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Defence in depth: TypeBox may not strict-strip undeclared fields, so
      // we discard any agent-supplied `model` before constructing the spec.
      // Model choice is user-authority-only (see issue #92).
      const spec = stripModelOverride(params as DispatchSpec);
      assertNotDriverWorktree(spec);
      assertWithinCycleIssues(spec, ctx?.mode);
      // #1015 — the report's git-state line runs here; the child still gets spec unchanged.
      const cwd = spec.cwd ?? process.cwd();
      const { jobId } = startJob(pi, {
        label: spec.role,
        role: spec.role,
        cwd,
        work: (signal, hooks) =>
          withProviderBackoff(
            (sig) =>
              spawnSpecialist(spec, {
                signal: sig,
                onProgress: hooks.onProgress,
                onRawEvent: hooks.onRawEvent,
                onStdin: hooks.onStdin,
              }),
            { signal, onRetry: (n) => traceRetry(spec.role, n) },
          ),
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
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
      for (const spec of specs) {
        assertNotDriverWorktree(spec);
        assertWithinCycleIssues(spec, ctx?.mode);
      }
      // Share a runId so all children in this batch sort together on disk.
      const runId = makeRunId();
      const { batchId } = startBatch(pi, {
        batchLabel: "dispatch_parallel",
        members: specs.map((spec, i) => {
          // Resolve display tag: PM-supplied label takes priority, else index.
          // The deck row shows `<role>[<tag>]` so the user can tell members apart.
          const tag = spec.label?.trim() || `#${i + 1}`;
          const displayLabel = `${spec.role}[${tag}]`;
          // #1015 — per-member resolved cwd for the report's git-state line.
          const cwd = spec.cwd ?? process.cwd();
          return {
            label: displayLabel,
            role: spec.role,
            cwd,
            work: (signal, hooks) =>
              withProviderBackoff(
                (sig) =>
                  spawnSpecialist(spec, {
                    runId,
                    seq: i,
                    tag,
                    signal: sig,
                    onProgress: hooks.onProgress,
                    onRawEvent: hooks.onRawEvent,
                    onStdin: hooks.onStdin,
                  }),
                { signal, onRetry: (n) => traceRetry(displayLabel, n) },
              ),
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

/**
 * Say out loud that we are waiting rather than failing.
 *
 * Silence here would reproduce the original confusion in a new shape: a child
 * that appears to hang for a minute reads as a stall unless the reason is
 * visible.
 */
function traceRetry(label: string, n: RetryNotice): void {
  trace(
    `dispatch: ${label} hit ${n.cause}; waiting ${Math.round(n.waitMs / 1000)}s before attempt ${n.attempt + 1} (the provider asked for it)`,
  );
}
