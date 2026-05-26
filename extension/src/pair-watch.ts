import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import { adapterFor } from "./model-adapters.ts";
import { type PiRpcEvent, type RpcClient, spawnRpcChild } from "./spawn-rpc.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

const execFile = promisify(execFileCb);

/**
 * pair_watch: asymmetric pair-coding gate.
 *
 *   developer (worker)  ←——— steer ←——— orchestrator ←——— tool_execution_start
 *       │                                      ↑                  (interrupt_developer)
 *       │ assistant text + tool calls         │                         │
 *       ↓                                      │                  adversarial (watcher)
 *   summariser (one-line per turn)  ────→  prompt ────→         (reads dev's stream,
 *                                                                emits interrupt/
 *                                                                approve/escalate)
 *
 * Asymmetry: developer just works; adversarial observes the summarised stream
 * and can interject. Verdict comes from adversarial's tool calls. Session
 * ends on approve, escalate, dev-finished + adversarial silent, or any cap.
 *
 * Both children are spawned in --mode rpc so the orchestrator can speak
 * JSON-RPC to each. The adversarial child loads pair-watch-tools.ts via
 * --extension so it has the interrupt/approve/escalate tools.
 *
 * Invariants (matching the async-dispatch story in #19/#20):
 *   1. Parent agent (PM) only sees the bounded final report — never the raw
 *      transcripts, never per-turn output from either child.
 *   2. Adversarial sees summarised dev turns (≤500 chars each), not raw events.
 *   3. Hard caps enforced in code, not prompts: wall-clock, tokens, interrupts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAIR_WATCH_TOOLS_PATH = path.join(__dirname, "pair-watch-tools.ts");

interface PairWatchParams {
  /** Issue or task description handed to the developer. */
  task: string;
  /** Context handed to the adversarial watcher. */
  context: string;
  /**
   * Full issue body (acceptance criteria, DoD, etc.) — passed verbatim to BOTH
   * developer AND adversarial. Adversarial uses it to verify each acceptance
   * criterion against the dev's actual diff; developer uses it to confirm scope.
   * If omitted, both subagents work from `task` + `context` only, which is
   * usually thinner — strongly recommended to populate when /work invokes pair_watch.
   */
  issueText?: string;
  /** Working directory. */
  cwd?: string;
  /** Model override for developer (falls back to /ensemble-model config). */
  developerModel?: string;
  /** Model override for adversarial. */
  adversarialModel?: string;
  /** Wall-clock cap in minutes (default 10; max 30). */
  wallClockMin?: number;
  /** Cap on cumulative input tokens across both children (default 1,000,000). */
  maxInputTokens?: number;
  /** Max adversarial interrupts (default 10). */
  maxInterrupts?: number;
}

export interface PairCaps {
  wallClockMs: number;
  /**
   * Cap on cumulative input tokens across both children. Default 1M is
   * conservative; Cerebras' all-inclusive plan permits 120M/day. Tokens
   * (specifically input) are the meaningful runaway-protection metric:
   * they reflect context size, are the binding constraint on flat-rate
   * plans, and translate to dollars directly on per-token billing.
   */
  maxInputTokens: number;
  /** Max adversarial interrupts allowed per session. */
  maxInterrupts: number;
}

const DEFAULT_CAPS: PairCaps = {
  // Raised from 5min after first live test: even a 1-file refactor with quality
  // gates (cargo fmt + clippy + test) easily fills 5min just for the dev work,
  // leaving no headroom for the adversarial to converge on a verdict.
  wallClockMs: 10 * 60_000,
  maxInputTokens: 1_000_000,
  maxInterrupts: 10,
};
const MAX_WALL_CLOCK_MIN = 30;

type Verdict = "APPROVED" | "ESCALATED" | "TIMEOUT" | "CAP_HIT" | "DEV_FINISHED_NO_VERDICT";

interface TokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionState {
  verdict?: Verdict;
  verdictReason?: string;
  interrupts: Array<{ at: number; message: string }>;
  devSummaries: Array<{ at: number; text: string }>;
  devTokens: TokenAccumulator;
  advTokens: TokenAccumulator;
  /** Cumulative model name observed for dev (set on first assistant turn). */
  devModel?: string;
  devProvider?: string;
  advModel?: string;
  advProvider?: string;
  devFinishedAt?: number;
  startedAt: number;
  /** Working directory (passed via params.cwd) — needed for per-turn `git diff --stat`. */
  workCwd?: string;
}

export function createSessionState(workCwd?: string): SessionState {
  return {
    interrupts: [],
    devSummaries: [],
    devTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    advTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    startedAt: Date.now(),
    workCwd,
  };
}

function resolveCaps(p: PairWatchParams): PairCaps {
  const min = Math.max(1, Math.min(MAX_WALL_CLOCK_MIN, p.wallClockMin ?? 10));
  return {
    wallClockMs: min * 60_000,
    maxInputTokens: Math.max(10_000, Math.floor(p.maxInputTokens ?? DEFAULT_CAPS.maxInputTokens)),
    maxInterrupts: Math.max(1, Math.floor(p.maxInterrupts ?? DEFAULT_CAPS.maxInterrupts)),
  };
}

export function registerPairWatchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pair_watch",
    label: "Pair-watch (developer + adversarial observer)",
    description:
      "EXPERIMENTAL: dispatch developer with adversarial as a live observer that can interrupt. Asymmetric: developer does the work, adversarial watches the summarised stream and may call interrupt_developer / approve_developer / escalate_to_user. Returns a job handle immediately; the final verdict + summary arrive as a [ensemble:async] user message when the session ends. Use INSTEAD OF adversarial_loop when you want earlier course-correction rather than discrete review rounds.",
    parameters: Type.Object({
      task: Type.String({
        description: "Issue or task description for the developer to implement.",
      }),
      context: Type.String({
        description: "1-3 sentence framing handed to the adversarial watcher.",
      }),
      issueText: Type.Optional(
        Type.String({
          description:
            "FULL issue body (acceptance criteria, definition of done, etc.) — paste verbatim from `gh issue view`. Passed to BOTH developer and adversarial so adversarial can verify each acceptance criterion against the actual diff. Strongly recommended.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current." })),
      developerModel: Type.Optional(Type.String({ description: "Model override for developer." })),
      adversarialModel: Type.Optional(
        Type.String({ description: "Model override for adversarial." }),
      ),
      wallClockMin: Type.Optional(
        Type.Number({
          description: `Wall-clock cap in minutes (default ${DEFAULT_CAPS.wallClockMs / 60_000}; max ${MAX_WALL_CLOCK_MIN}). Increase for larger tasks.`,
        }),
      ),
      maxInputTokens: Type.Optional(
        Type.Number({
          description: `Input-token cap across both children (default ${DEFAULT_CAPS.maxInputTokens.toLocaleString()}). Session ends with CAP_HIT if exceeded.`,
        }),
      ),
      maxInterrupts: Type.Optional(
        Type.Number({
          description: `Max adversarial interrupts before session ends with CAP_HIT (default ${DEFAULT_CAPS.maxInterrupts}).`,
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as PairWatchParams;
      const caps = resolveCaps(params);
      const { jobId } = startJob(pi, {
        label: "pair_watch",
        role: "pair-watch",
        work: (signal) => runPairWatchSession(params, caps, signal),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async pair_watch job ${jobId}. Verdict + summary will arrive as a [ensemble:async] user message when the session ends (wall-clock ${caps.wallClockMs / 60_000}min, ${(caps.maxInputTokens / 1000).toFixed(0)}k tokens, ${caps.maxInterrupts} interrupts). End your turn.`,
          },
        ],
        details: { jobId, role: "pair-watch", async: true },
      };
    },
  });
}

async function runPairWatchSession(
  params: PairWatchParams,
  caps: PairCaps,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const state = createSessionState(params.cwd);

  // Hard wall-clock cap — fires regardless of child state.
  let capHit = false;
  const wallTimeout = setTimeout(() => {
    capHit = true;
    state.verdict = "TIMEOUT";
    state.verdictReason = `wall-clock cap ${caps.wallClockMs / 60_000}min exceeded`;
    trace(`pair-watch: ${state.verdictReason}`);
  }, caps.wallClockMs);

  let developer: RpcClient | null = null;
  let adversarial: RpcClient | null = null;

  try {
    developer = await spawnRpcChild(
      { role: "developer", cwd: params.cwd, model: params.developerModel },
      { signal, tag: "pair-dev", timeoutMs: caps.wallClockMs + 30_000 },
    );
    adversarial = await spawnRpcChild(
      {
        role: "adversarial-developer",
        cwd: params.cwd,
        model: params.adversarialModel,
        extraArgs: ["--extension", PAIR_WATCH_TOOLS_PATH],
      },
      { signal, tag: "pair-adv", timeoutMs: caps.wallClockMs + 30_000 },
    );

    wireDeveloperEvents(developer, adversarial, state, caps);
    wireAdversarialEvents(adversarial, developer, state, caps);

    // Kick off both children with their initial prompts.
    await developer.prompt(buildDeveloperPrompt(params.task, params.issueText));
    await adversarial.prompt(buildAdversarialWatcherPrompt(params.context, params.issueText));

    // Track which children have exited so we can stop spinning early.
    let devExited = false;
    let advExited = false;
    developer.exited.then(() => {
      devExited = true;
    });
    adversarial.exited.then(() => {
      advExited = true;
    });

    // Spin until a verdict is decided, any cap fires, or both children exit.
    while (!state.verdict && !capHit) {
      if (signal.aborted) {
        state.verdict = "ESCALATED";
        state.verdictReason = "session aborted by orchestrator";
        break;
      }
      if (devExited && advExited) {
        // Both children gone without an explicit verdict — fall through to default below.
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!state.verdict) {
      state.verdict = state.devFinishedAt ? "DEV_FINISHED_NO_VERDICT" : "CAP_HIT";
    }
  } finally {
    clearTimeout(wallTimeout);
    developer?.dispose();
    adversarial?.dispose();
    // Allow children up to 2s to flush their last events.
    await Promise.race([
      Promise.all([developer?.exited, adversarial?.exited]),
      new Promise((r) => setTimeout(r, 2000)),
    ]).catch(() => undefined);
  }

  const ms = Date.now() - state.startedAt;
  return synthesise(state, ms, developer, adversarial);
}

export function wireDeveloperEvents(
  developer: RpcClient,
  adversarial: RpcClient,
  state: SessionState,
  caps: PairCaps,
) {
  developer.on("message_end", (event: PiRpcEvent) => {
    const msg = (event.message ?? {}) as {
      role?: string;
      content?: unknown[];
      usage?: TokenAccumulator;
      model?: string;
      provider?: string;
    };
    if (msg.role !== "assistant") return;
    accumulateTokens(state.devTokens, msg.usage);
    if (msg.model && !state.devModel) state.devModel = msg.model;
    if (msg.provider && !state.devProvider) state.devProvider = msg.provider;
    if (totalInputTokens(state) > caps.maxInputTokens) {
      state.verdict ??= "CAP_HIT";
      state.verdictReason = `input-token cap ${caps.maxInputTokens.toLocaleString()} exceeded`;
      return;
    }
    const summary = summariseAssistantMessage(msg);
    if (!summary) return;
    state.devSummaries.push({ at: Date.now(), text: summary });
    // Fire-and-forget: build the full update (summary + diff stat) and push
    // to adversarial. Diff lookup is async because git execFile is async; we
    // don't block message_end handling on it.
    void buildDevTurnUpdate(state, summary).then((text) => {
      // Push the summary to the adversarial watcher. We use `prompt` with
      // streamingBehavior "steer" rather than the raw `steer` command because
      // raw `steer` only works while the agent is streaming — and the watcher
      // spends most of its time idle between dev-turn updates. `prompt` with
      // streamingBehavior "steer" works in both states: idle → processed as a
      // new user turn; streaming → queued for after the current tool calls.
      adversarial.prompt(text, "steer").catch((err) => {
        trace(`pair-watch: failed to update adversarial: ${(err as Error).message}`);
      });
    });
  });

  developer.on("agent_end", () => {
    state.devFinishedAt = Date.now();
    trace("pair-watch: developer agent_end");
    // Let the adversarial know developer is done; it should decide a verdict.
    adversarial
      .prompt(
        "[pair:developer-finished] The developer has emitted their final assistant turn. Inspect the summarised stream above and either call approve_developer (if satisfied), interrupt_developer (one last critique), or escalate_to_user (if unsafe to merge).",
        "steer",
      )
      .catch(() => undefined);
  });
}

export function wireAdversarialEvents(
  adversarial: RpcClient,
  developer: RpcClient,
  state: SessionState,
  caps: PairCaps,
) {
  adversarial.on("message_end", (event: PiRpcEvent) => {
    const msg = (event.message ?? {}) as {
      role?: string;
      usage?: TokenAccumulator;
      model?: string;
      provider?: string;
    };
    if (msg.role !== "assistant") return;
    accumulateTokens(state.advTokens, msg.usage);
    if (msg.model && !state.advModel) state.advModel = msg.model;
    if (msg.provider && !state.advProvider) state.advProvider = msg.provider;
    if (totalInputTokens(state) > caps.maxInputTokens) {
      state.verdict ??= "CAP_HIT";
      state.verdictReason = `input-token cap ${caps.maxInputTokens.toLocaleString()} exceeded`;
    }
  });

  adversarial.on("tool_execution_start", (event: PiRpcEvent) => {
    const toolName = event.toolName as string | undefined;
    const args = (event.args ?? {}) as Record<string, unknown>;
    if (toolName === "interrupt_developer") {
      const message = typeof args.message === "string" ? args.message : "";
      if (!message) return;
      if (state.interrupts.length >= caps.maxInterrupts) {
        state.verdict ??= "CAP_HIT";
        state.verdictReason = `interrupt cap ${caps.maxInterrupts} exceeded`;
        return;
      }
      state.interrupts.push({ at: Date.now(), message });
      trace(`pair-watch: routing interrupt #${state.interrupts.length} to developer`);
      // See sibling comment in wireDeveloperEvents — prompt+steer works
      // whether developer is currently streaming or idle.
      developer
        .prompt(`[pair:adversarial] ${message}`, "steer")
        .catch((err) => trace(`pair-watch: developer update failed: ${(err as Error).message}`));
    } else if (toolName === "approve_developer") {
      state.verdict = "APPROVED";
      state.verdictReason =
        typeof args.summary === "string" ? args.summary : "Adversarial approved.";
    } else if (toolName === "escalate_to_user") {
      state.verdict = "ESCALATED";
      state.verdictReason =
        typeof args.reason === "string" ? args.reason : "Adversarial escalated without reason.";
    }
  });
}

function accumulateTokens(acc: TokenAccumulator, u?: Partial<TokenAccumulator>) {
  if (!u) return;
  acc.input += u.input ?? 0;
  acc.output += u.output ?? 0;
  acc.cacheRead += u.cacheRead ?? 0;
  acc.cacheWrite += u.cacheWrite ?? 0;
}

function totalInputTokens(state: SessionState): number {
  return state.devTokens.input + state.advTokens.input;
}

function totalTokens(t: TokenAccumulator): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Best-effort `git diff --stat` for the working directory. Returns an empty
 * string if git isn't available, the dir isn't a repo, or nothing's changed
 * — adversarial sees no extra noise on no-op turns. Output capped at 600 chars.
 */
async function gitDiffStat(workCwd: string | undefined): Promise<string> {
  if (!workCwd) return "";
  try {
    const { stdout } = await execFile("git", ["-C", workCwd, "diff", "--stat"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return "";
    return trimmed.length > 600 ? `${trimmed.slice(0, 597)}...` : trimmed;
  } catch (err) {
    trace(`pair-watch: git diff --stat failed: ${(err as Error).message}`);
    return "";
  }
}

async function buildDevTurnUpdate(state: SessionState, summary: string): Promise<string> {
  const diffStat = await gitDiffStat(state.workCwd);
  const head = `[pair:developer-turn ${state.devSummaries.length}]\n${summary}`;
  if (!diffStat) return head;
  return `${head}\n\n[diff so far]\n${diffStat}`;
}

/**
 * Compact summary of a dev assistant turn for the watcher:
 * - up to 500 chars of assistant text
 * - tool calls with truncated arguments — instead of "[tools: bash, read]"
 *   we emit "[bash: cargo test] [read: src/foo.rs]" so the watcher knows
 *   which file/command the dev touched
 */
function summariseAssistantMessage(msg: {
  content?: unknown[];
  model?: string;
  provider?: string;
}): string | null {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const textParts: string[] = [];
  const toolTags: string[] = [];
  // Resolve the per-message model adapter so we can drop family-specific text
  // artifacts (e.g. GLM-4.x's "None" placeholders) without branching on
  // model strings here. See extension/src/model-adapters.ts.
  const adapter = adapterFor(msg.model, msg.provider);
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; name?: string; arguments?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      if (adapter.isArtifactText?.(b.text)) continue;
      textParts.push(b.text);
    }
    if (b.type === "toolCall" && typeof b.name === "string") {
      toolTags.push(fmtToolTag(b.name, b.arguments));
    }
  }
  const text = textParts.join("").trim();
  if (!text && !toolTags.length) return null;
  const truncated = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  const toolsLine = toolTags.length ? ` ${toolTags.join(" ")}` : "";
  return `${truncated}${toolsLine}`;
}

function fmtToolTag(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return `[${name}]`;
  const a = args as Record<string, unknown>;
  // Pick the most informative arg per tool. Fall back to first string value.
  const interesting =
    pickStringArg(a, ["command", "path", "filePath", "file_path", "file", "url", "query"]) ??
    firstStringArg(a);
  if (!interesting) return `[${name}]`;
  const truncated = interesting.length > 100 ? `${interesting.slice(0, 97)}...` : interesting;
  return `[${name}: ${truncated.replace(/\s+/g, " ")}]`;
}

function pickStringArg(args: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function firstStringArg(args: Record<string, unknown>): string | null {
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function buildDeveloperPrompt(task: string, issueText?: string): string {
  const issueBlock = issueText
    ? `\n\n## Issue text (authoritative — meet every acceptance criterion)\n${issueText}`
    : "";
  return `Implement the following task. You are paired with an adversarial reviewer who observes your stream and may steer you mid-task. Treat any [pair:adversarial] user message you receive as IMPORTANT steering input — incorporate the critique before continuing.

## Task
${task}${issueBlock}`;
}

function buildAdversarialWatcherPrompt(context: string, issueText?: string): string {
  return `You are the adversarial reviewer in a pair_watch session. You are NOT a passive observer — you are an ACTIVE INVESTIGATOR. Verify what the developer is doing against the actual code.

# Why you exist (the cost model)

Your job is to catch problems BEFORE they leave this session. After pair_watch returns APPROVED, the diff goes through a six-pass code review (six lens specialists in parallel). Every problem that escapes you and lands in the six-pass review costs ~500k tokens for that round plus a full developer fix cycle plus another six-pass — easily 1M+ tokens per issue.

By contrast, **\`interrupt_developer\` costs one short message** and prevents the dev from going further down a wrong path. Restraint is false economy. If you spot a probable bug, interrupt now. If you wait to see whether the developer catches it themselves, you have wasted both the dev's next turn AND your own attention.

The watchword is **early intervention**, not silent vigilance.

# How the session works

You receive summarised updates of the developer's turns as [pair:developer-turn N] user messages. Each summary includes:
- The developer's narration text (may be empty for tool-only turns)
- Tool calls with their key arguments — e.g. \`[bash: cargo test]\`, \`[read: src/foo.rs]\`, \`[edit: src/foo.rs]\`
- A \`[diff so far]\` block showing \`git diff --stat\` for the working tree (only present when there are changes)

# Tools available to you

- \`read(file)\` — read any file the developer has touched. USE LIBERALLY. When dev edits \`src/foo.rs\`, you read it. When dev mentions a design decision, you read the relevant file to verify.
- \`view_current_diff()\` — pull the full current \`git diff\` for the working tree. Use when the stat shows a change you want to inspect line-by-line.
  - **Verification gating**: if you are about to write "verifying X" / "checking Y" / "ensuring Z" in your narration AND the dev has edited a file you have not pulled the diff for since their last edit, call \`view_current_diff\` FIRST. Saying you verified something without having pulled the diff to verify is filler.
  - **Anti-thrashing**: do not call \`view_current_diff\` again if the diff hasn't materially changed since your last call. If you need to dig deeper into something specific, use \`read\` on the file or \`bash\` to run a command — not another full-diff dump.
- \`interrupt_developer(message)\` — send a steering message to the developer mid-task. **Use it whenever you can prevent a wrong turn.** Cheap. The bar is "I can predict a concrete failure mode the dev hasn't addressed", not "this is unsafe to merge". Don't interrupt for style or naming, but DO interrupt for: scope drift, wrong API, wrong path, missing test for non-trivial logic, foreseeable runtime errors (path resolution, type mismatches, race conditions). Predicting a likely bug and waiting to see whether the dev hits it themselves is the failure mode this whole role exists to prevent.
- \`approve_developer(summary?)\` — end the session APPROVED. Use ONLY after [pair:developer-finished] AND only after you have actively verified the implementation against the issue's acceptance criteria.
- \`escalate_to_user(reason)\` — end the session ESCALATED. Use when the developer is stuck, off-track, or producing unsafe output you cannot correct via interrupt.

# Your behaviour on each dev turn

1. **INVESTIGATE.** If the dev edited a file, read it. If they ran a command, consider what its output means. If they made a design decision, verify it against the project conventions and the issue requirements.
2. **BUILD A MENTAL MODEL.** Track what the dev is trying to do, where they are in the implementation, what could go wrong.
3. **DECIDE.** Either: (a) call \`interrupt_developer\` with a concrete concern, (b) emit ≤ 30 words noting what you checked and what you're still uncertain about, or (c) stay silent on this turn.

❌ DO NOT write filler like "Observing. Continue watching." — that wastes a turn. Either investigate concretely or stay silent.

# When to interrupt

**Default: if you can predict a failure mode the dev hasn't addressed, interrupt.** A short steering message is cheap; a wrong-direction dev turn is not. Bias toward intervention.

DO interrupt for:
- Scope drift (dev touching files outside the issue, expanding the work)
- Wrong API / deprecated usage / wrong file location
- Wrong path resolution, wrong CWD assumption, wrong relative-vs-absolute path
- Type mismatches, signature mismatches against project conventions
- Missing test for a non-trivial change
- Security holes, race conditions, edge cases the dev hasn't addressed
- Documented-spec drift (e.g. dev's path/format doesn't match docs/data-storage.md or similar)
- **Foreseeable runtime failures** — if you can see the test/command they're about to run will fail in a predictable way, say so BEFORE they run it

DO NOT interrupt for:
- Style or formatting
- Naming preferences
- "Nice to have" suggestions / refactoring opportunities
- Acknowledging progress

❌ **Anti-pattern (forbidden)**: predicting a bug, deciding to "wait and see if the dev figures it out", then watching them hit the failure. If you can predict the failure mode concretely, you must surface it BEFORE the dev hits it. Watching the dev waste a turn discovering a bug you already saw is the failure mode this role exists to prevent.

# When to approve

\`approve_developer\` is ONLY appropriate when, after [pair:developer-finished]:
1. You have called \`view_current_diff\` AT LEAST ONCE AFTER [pair:developer-finished] to see the final state of the diff — not just intermediate snapshots from earlier turns
2. You have READ the changed files (not just received summaries)
3. You have traced each acceptance criterion from the issue context to evidence in the diff
4. You have considered at least 2 edge cases or attack vectors and found them adequately handled
5. There are no remaining concerns that would warrant an interrupt

If you can't justify all five, prefer \`escalate_to_user\` over rubber-stamping. Your \`summary\` argument to \`approve_developer\` MUST cite the specific evidence (file path, line ref, test name, command output) — not generic phrases like "looks good" or "all criteria met".

# Context for this PR

${context || "(no extra context)"}

${
  issueText
    ? `# Issue text (authoritative — every acceptance criterion must be evidence-verified before approve_developer)\n\n${issueText}\n`
    : "# Issue text\n\n(not provided — work from context only; raise the absence of an issue body in your final verdict if relevant)\n"
}
# Start

Wait for [pair:developer-turn 1], then begin active investigation. Read files. Verify claims. Question assumptions.`;
}

function synthesise(
  state: SessionState,
  ms: number,
  developer: RpcClient | null,
  adversarial: RpcClient | null,
): DispatchResult {
  const verdict = state.verdict ?? "DEV_FINISHED_NO_VERDICT";
  const ok = verdict === "APPROVED";
  const devTotal = totalTokens(state.devTokens);
  const advTotal = totalTokens(state.advTokens);
  const devTag = `${state.devProvider ? `${state.devProvider}/` : ""}${state.devModel ?? "(unknown)"}`;
  const advTag = `${state.advProvider ? `${state.advProvider}/` : ""}${state.advModel ?? "(unknown)"}`;
  const lines = [
    `Pair-watch verdict: ${verdict}`,
    `Reason: ${state.verdictReason ?? "(none)"}`,
    `Wall-clock: ${Math.round(ms / 1000)}s`,
    `Developer: ${state.devSummaries.length} turns · ${fmtTokens(devTotal)} tokens (in ${fmtTokens(state.devTokens.input)}, out ${fmtTokens(state.devTokens.output)}) · ${devTag}`,
    `Adversarial: ${state.interrupts.length} interrupts · ${fmtTokens(advTotal)} tokens (in ${fmtTokens(state.advTokens.input)}, out ${fmtTokens(state.advTokens.output)}) · ${advTag}`,
    "",
    "Recent developer activity (summaries):",
    ...state.devSummaries.slice(-5).map((s, i) => `  ${i + 1}. ${s.text.slice(0, 200)}`),
    "",
    "Adversarial interrupts:",
    ...state.interrupts.map((i, idx) => `  ${idx + 1}. ${i.message.slice(0, 200)}`),
  ];
  if (developer?.transcriptPath)
    lines.push("", `developer transcript: ${developer.transcriptPath}`);
  if (adversarial?.transcriptPath)
    lines.push(`adversarial transcript: ${adversarial.transcriptPath}`);

  return {
    role: "pair-watch",
    ok,
    text: lines.join("\n"),
    toolUses: [],
    ms,
    exitCode: ok ? 0 : 1,
    usage: {
      input: state.devTokens.input + state.advTokens.input,
      output: state.devTokens.output + state.advTokens.output,
      cacheRead: state.devTokens.cacheRead + state.advTokens.cacheRead,
      cacheWrite: state.devTokens.cacheWrite + state.advTokens.cacheWrite,
      cost: 0,
      turns: state.devSummaries.length + state.interrupts.length,
    },
    model: state.devModel,
    provider: state.devProvider,
    transcriptPath: developer?.transcriptPath,
  };
}
