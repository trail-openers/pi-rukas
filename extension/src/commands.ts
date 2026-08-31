/**
 * Slash-command registration + PM doctrine injection.
 *
 * Three concerns:
 *
 *   1. Workflow slash commands — `/start`, `/research`, `/plan`, `/work`,
 *      `/review`, `/audit`. Each `registerCommand` handler reads the
 *      corresponding `pi-prompts/<name>.md` body, substitutes the user's
 *      arguments, and injects it via `pi.sendUserMessage` so the next
 *      assistant turn runs the workflow. Bodies live outside the extension
 *      (gitignored `dist/` for the built copy; source in `pi-prompts/`)
 *      and are loaded fresh per invocation so hot-edits during dev take
 *      effect without an extension reload.
 *
 *   2. `/ensemble-debug` — synchronous introspection: registered
 *      commands, registered tools, per-role model resolution, prompt-dir
 *      paths, recent-runs summary. Used by AGENTS.md §1 verification and
 *      by users debugging their setup.
 *
 *   3. PM doctrine injection — the `before_agent_start` handler injects
 *      project-manager.md doctrine the first time PM enters orchestrator
 *      mode (one-shot), then a short sticky preamble on every subsequent
 *      turn. The full-doctrine cost is paid once per session; the
 *      preamble keeps PM's mental model coherent without re-burning the
 *      40KB body each turn.
 *
 * Slash commands fire in interactive TUI mode. They do NOT resolve from
 * `pi -p "/cmd …"` invocations — see earendil-works/pi#5423.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { notifyAgent } from "./agent-message.ts";
import { buildMemoryPanel } from "./memory-panel.ts";
import { GLOBAL_KEY, getAllOverrides } from "./model-config.ts";
import { modelConfigSnapshot } from "./models.ts";
import { armPmMode, isPmModeActive, peekDoctrinePending, takeDoctrinePending } from "./pm-mode.ts";
import { transcriptsSummary } from "./runs.ts";
import { trace } from "./trace.ts";
import { groupIssues, resolvedParallelGroups } from "./work-driver-grouping.ts";
import { runWorkDriver } from "./work-driver.ts";
import { launchWork, parseWorkArgs, resolveRepoRoot } from "./work-entry.ts";
import { renderQueueSummary, runWorkQueue } from "./work-queue.ts";
import { registerWorkStatusCommand } from "./work-status.ts";
import { readState } from "./workflow-state.ts";

// Captured by /ensemble-debug so the operator can verify what setActiveTools
// removed from the PM's active set.
let _pmModeStripInfo: { total: number; removed: number; names: string[] } | null = null;

/**
 * Filter out write-capable tools from the active set.
 *
 * Called once when PM mode first arms (slash command or tool).  Uses
 * `setActiveTools` which has REPLACE semantics — must pass the FULL filtered
 * list from `getAllTools()` so extension tools survive.
 *
 * Only `edit` and `write` are stripped; all read-only builtins (read, bash,
 * grep, find, ls) and all extension tools remain active.
 *
 * Mechanism-layer enforcement (#13 — AGENTS.md §13 gotcha). If
 * `pi.setActiveTools()` throws or silently fails, PM retains write tools
 * — a complete bypass of this mechanism. The try/catch below traces the
 * failure so the operator sees the mechanism is broken. The error is NOT
 * suppressed: this IS the security boundary.
 */
export function stripPmTools(pi: ExtensionAPI): void {
  const FORBIDDEN = new Set(["edit", "write"]);

  let total = 0;
  let names: string[] = [];
  let allowed: string[] = [];
  let removed: string[] = [];

  try {
    const allTools = pi.getAllTools();
    total = allTools.length;
    names = allTools.map((t) => t.name);
    allowed = names.filter((n) => !FORBIDDEN.has(n));
    removed = names.filter((n) => FORBIDDEN.has(n));

    pi.setActiveTools(allowed);
  } catch (err) {
    // CRITICAL: do NOT suppress — this is the mechanism-layer security
    // boundary. If it fails, the operator must know.
    const msg = `PM mode: setActiveTools FAILED — strip did NOT take (PM still has write tools): ${(err as Error).message}`;
    trace(msg);
    // Leave _pmModeStripInfo as null so debug output reflects the failure.
    return;
  }

  if (removed.length > 0) {
    _pmModeStripInfo = { total, removed: removed.length, names: removed };
    trace(
      `PM mode: removed ${removed.length} tool(s) from ${total} active tools: ${removed.join(", ")}`,
    );
  } else {
    _pmModeStripInfo = { total, removed: 0, names: [] };
    trace(`PM mode: no write tools to remove from ${total} active tools`);
  }
}

/** Test-only accessor for the strip result. */
export function getPmModeStripInfo(): typeof _pmModeStripInfo {
  return _pmModeStripInfo;
}

const execp = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PI_PROMPTS_DIR = path.resolve(
  process.env.PI_ENSEMBLE_PI_PROMPTS_DIR ?? path.join(__dirname, "..", "..", "pi-prompts"),
);

const PM_PROMPT_FILE = path.resolve(
  process.env.PI_ENSEMBLE_PM_PROMPT ??
    path.join(__dirname, "..", "..", "dist", "prompts", "standard", "project-manager.md"),
);

export const SLASH_COMMANDS = [
  "start",
  "research",
  "plan",
  "work",
  "review",
  "audit",
  "do",
  "agents-md",
] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

// The PM-mode session flags moved to `pm-mode.ts` so a tool can arm them too.

const PM_STICKY_PREAMBLE = `# PM mode — orchestration only

You are running inside a pi-ensemble workflow (/start, /research, /plan, /work, /review, /audit, /do). Even though Pi has read, edit, write, and bash tools registered, you MUST NOT use edit, write, or non-vipune/git-read-only bash for implementation work. Implementation, tests, debugging, commits, deployment — ALL of it belongs to subagents:

- Implementation, tests, debugging, file edits → \`dispatch_specialist\` with role \`developer\` (then \`adversarial_loop\` to gate the diff)
- Git ops, commits, PRs, branch creation, deployment → \`dispatch_specialist\` with role \`ops\`
- Research, file reading, vipune searches, web → \`dispatch_specialist\` with role \`explore\`

If you catch yourself about to call \`edit\`, \`write\`, or \`bash\` for anything beyond \`vipune\` / \`gh issue view\` / read-only \`git status|diff|log|branch\` / \`oo recall\`, STOP and dispatch instead. Touching files yourself is a doctrine violation.

\`/work\` is a COMPILED DRIVER, not a sequence of dispatches. Never reconstruct its steps by hand — a hand-rolled cycle has no state file, no queue, no handoff artifact, no review-cap timer, and produces a branch the driver knows nothing about, with nothing in the transcript saying any of that is missing. To start or restart one, call \`start_work_driver\`. \`/plan\` is compiled too: issue creation is gated behind \`start_plan_driver\` — call it with dryRun:true, show the spec to the operator, re-call without dryRun on confirmation. Direct \`gh issue create\` (and \`gh api\` POST to the issues collection) is refused for every role in every mode; the refusal names the tool to use instead. To run any other workflow yourself, call \`load_workflow_doctrine\` and follow what it returns. \`/agents-md\` is executed by the \`agents_md_run\` tool (the compiled core, in-process) — never by a host-relative \`bun\` path. Merge authority is operator-only: neither driver can grant it.
`;

export function registerCommands(pi: ExtensionAPI) {
  for (const name of SLASH_COMMANDS) {
    pi.registerCommand(name, {
      description: descriptionFor(name),
      getArgumentCompletions:
        name === "plan"
          ? (prefix: string) => {
              const types = ["bug", "feature", "epic", "chore", "spike"];
              const matches = types.filter((t) => t.startsWith(prefix.toLowerCase()));
              return matches.length > 0 ? matches.map((t) => ({ value: t, label: t })) : null;
            }
          : undefined,
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        trace(`/${name} fired (args: ${args ? `"${args.slice(0, 40)}"` : "<none>"})`);

        // /work runs the compiled state-machine driver (work-driver.ts) in the
        // background — the handler kicks it off and returns immediately so the
        // user can interact with the chat while it works. Every other command
        // is prompt-orchestrated and takes the sendUserMessage path below.
        // #598 — /plan is a thin alias, not a prose body. The 473-line body is
        // gone; the pipeline is compiled into start_plan_driver (plan-tool.ts)
        // and issue creation is structurally gated behind it. Pointing PM at the
        // tool here is the only thing left for the command to do.
        if (name === "plan") {
          armPmMode();
          stripPmTools(pi);
          const alias = `/plan is now a thin alias for the compiled plan driver. To create a GitHub issue, call the \`start_plan_driver\` tool with the descriptor${args ? ` ("${args}")` : ""}. Call it with dryRun:true first, show the spec + gap dispositions to the operator, and on their confirmation re-call with dryRun omitted to file. Direct \`gh issue create\` is structurally refused — the refusal will name this tool.`;
          trace(`/plan → alias message (${alias.length} chars); PM doctrine armed`);
          notifyAgent(pi, alias);
          return;
        }
        // #393 deleted the flag that used to bypass the driver: it fell back
        // to a prose flow with no state file and none of the verification
        // gates, which is the whole class of failure the driver replaced.
        if (name === "work") {
          // Parse N issue tokens — `/work 547` (single) or `/work 561 562`
          // (multi-issue).
          //
          // PR16 — multi-issue shape now runs a DETERMINISTIC GROUPING
          // pass at the entry point (groupIssues in work-driver.ts) that
          // partitions the issues into K groups using explicit rules
          // (link markers, path-overlap Jaccard ≥ 0.5, SPLIT markers,
          // subsystem-tag prefixes). Related issues share ONE PR (via the
          // PR10 bundled driver-level API); unrelated issues run as
          // separate cycles. This restores the old PM-driven /work's
          // "analyze first, decide the plan" shape but in pure code.
          //
          // Pre-PR16 (v0.12.15/PR15): `/work N M P` = strictly sequential
          // one-PR-per-issue. That was safe but ignored the fact that
          // related issues genuinely belong together. PR16 keeps the
          // sequential cycle boundary (halt-on-non-merged between
          // groups) but uses grouping to decide what a "cycle" is.
          //
          // Also accept `--restart` (order-independent) — applied to
          // every cycle in the queue.
          const parsed = parseWorkArgs(args);
          if ("error" in parsed) {
            ctx.ui.notify(parsed.error, "warning");
            return;
          }
          if (!ctx.isIdle()) {
            ctx.ui.notify(
              "pi-ensemble: agent is busy — try /work again when idle, or use /steer for an inline nudge",
              "warning",
            );
            return;
          }
          // PM stays in reporter mode so user-visible progress messages
          // emitted by the driver via notifyAgent land cleanly.
          armPmMode();
          stripPmTools(pi);
          await launchWork(pi, {
            repoRoot: await resolveRepoRoot(ctx.cwd),
            invocation: parsed,
            sink: { notify: (t) => ctx.ui.notify(t, "info") },
          });
          return;
        }

        let body: string;
        try {
          body = await loadPromptBody(name);
        } catch (err) {
          trace(`/${name} FAILED to load body: ${(err as Error).message}`);
          ctx.ui.notify(`pi-ensemble: ${(err as Error).message}`, "error");
          return;
        }
        let expanded = expandArgs(body, args);
        // #422 — /audit gains a memory section. `memory-stats.ts` shipped in
        // v0.12.32 with no caller; this is it. Appended, never substituted: a
        // repo with no memory store gets a byte-identical message.
        if (name === "audit") {
          const panel = await buildMemoryPanel(await resolveRepoRoot(ctx.cwd));
          if (panel) expanded = `${expanded}\n\n---\n\n${panel}`;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify(
            `pi-ensemble: agent is busy — try /${name} again when idle, or use /steer for an inline nudge`,
            "warning",
          );
          return;
        }
        armPmMode();
        stripPmTools(pi);
        trace(
          `/${name} → sendUserMessage (${expanded.length} chars); PM doctrine armed + PM mode sticky`,
        );
        notifyAgent(pi, expanded);
      },
    });
  }

  pi.registerCommand("ensemble-debug", {
    description: "pi-ensemble introspection: registered commands, prompts, and model config",
    handler: async (_args, ctx) => {
      const overrides = getAllOverrides();
      const globalOverride = overrides[GLOBAL_KEY];
      const runsLine = await transcriptsSummary().catch(() => "");
      const modelLines = modelConfigSnapshot().map(({ role, choice }) => {
        const m = choice.model
          ? choice.provider
            ? `${choice.provider} · ${choice.model}`
            : choice.model
          : "(Pi default)";
        const src =
          choice.source === "spec"
            ? "/ensemble-model spec"
            : choice.source === "config"
              ? "/ensemble-model (role)"
              : choice.source === "config-default"
                ? "/ensemble-model (all)"
                : choice.source === "role-env"
                  ? `${choice.envVar}`
                  : choice.source === "subagent-env"
                    ? `${choice.envVar}`
                    : "Pi default";
        return `  ${role.padEnd(24)} ← ${m}   [${src}]`;
      });
      const stripInfo = _pmModeStripInfo;
      const pmModeLine = isPmModeActive()
        ? stripInfo
          ? `active (sticky preamble injected every turn; removed ${stripInfo.removed} tool(s): ${stripInfo.names.join(", ") || "none"})`
          : "active (sticky preamble injected every turn; strip not yet performed)"
        : "idle";
      const lines = [
        `prompts dir:      ${PI_PROMPTS_DIR}`,
        `PM prompt file:   ${PM_PROMPT_FILE}`,
        `PM mode:          ${pmModeLine}`,
        `PM first-turn doctrine pending: ${peekDoctrinePending()}`,
        ...(stripInfo
          ? [
              `PM tools stripped:  ${stripInfo.removed} from ${stripInfo.total} active: ${stripInfo.names.join(", ") || "(none)"}`,
            ]
          : []),
        "commands:         /start /research /plan /work /review /audit /runs /ensemble-model /ensemble-debug",
        "tools:            dispatch_specialist, dispatch_parallel, adversarial_loop, dispatch_lens_review (all async),",
        "                  dispatch_status, dispatch_kill, dispatch_peek, dispatch_steer, check_review_cap",
        ...(runsLine ? [`transcripts:      ${runsLine}`] : []),
        "",
        "subagent models  (change via /ensemble-model — saved to ~/.pi/agent/ensemble-models.json)",
        ...(globalOverride
          ? [
              `  default for all   ← ${globalOverride.provider ? `${globalOverride.provider} · ${globalOverride.model}` : globalOverride.model}   [/ensemble-model (all)]`,
            ]
          : []),
        ...modelLines,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /work-status — inspect work-driver state for a given (or auto-resolved)
  // issue. PR2 O4: gives the user a "where are we" snapshot without having
  // to open the .pi/work-state/<issue>.json file. Restate-style "no progress
  // in last hour" query semantics scoped to a single session.
  registerWorkStatusCommand(pi);

  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
      // Two-layer doctrine: full PM doctrine on turn 1 (heavy, one-shot to
      // amortise cost), short PM_STICKY_PREAMBLE on every turn while in PM
      // mode (light, closes the "PM forgets the doctrine on turn 2+" gap that
      // let it self-code on issue #580).
      if (!isPmModeActive()) return undefined;
      const base = event.systemPrompt ?? "";
      const pieces: string[] = [base, PM_STICKY_PREAMBLE];
      if (takeDoctrinePending()) {
        try {
          const pmPrompt = await fs.readFile(PM_PROMPT_FILE, "utf8");
          pieces.push(pmPrompt);
          trace(
            `before_agent_start: appended PM sticky preamble + full doctrine (${pmPrompt.length} chars)`,
          );
        } catch (err) {
          trace(`before_agent_start: PM doctrine load FAILED: ${(err as Error).message}`);
        }
      } else {
        trace("before_agent_start: appended PM sticky preamble only (doctrine already loaded)");
      }
      return { systemPrompt: pieces.join("\n\n") };
    },
  );
}

// Fold the argument hint into the description so the autocomplete shows it
// inline. Pi's RegisteredCommand has no separate argumentHint field — only
// file-based prompt templates support the `argument-hint:` frontmatter.
function descriptionFor(name: SlashCommand): string {
  switch (name) {
    case "start":
      return "Initialise session: load project memory, check git state, report what's open";
    case "research":
      return "<topic> — Multi-pronged research using web, codebase, and memory in parallel";
    case "plan":
      return "<bug|feature|epic|chore|spike description> — Create a well-structured GitHub issue";
    case "work":
      return "<issue-number> — Execute a GitHub issue end-to-end: branch → implement → adversarial → PR → review → CI → merge";
    case "review":
      return "[#PR | path | latest N | empty=full] — On-demand six-pass code review (SECURITY/ERROR/TYPES/PERF/ARCH/SIMPLICITY)";
    case "audit":
      return "[<path> | <path>=<scope> ...] — Audit repo/path against its own standards (derive from docs/config/examples, not hard-coded)";
    case "do":
      return "<description> — Orchestrate free-form work via PM (no GitHub issue required; counterpart to /work)";
    case "agents-md":
      return "<create|update|check> [--deep] — Idempotently manage the marker-managed sections of this repo's AGENTS.md (pure renderer, byte-preserving outside markers)";
  }
}

export async function loadPromptBody(name: SlashCommand): Promise<string> {
  const file = path.join(PI_PROMPTS_DIR, `${name}.md`);
  return fs.readFile(file, "utf8");
}

export function expandArgs(body: string, args: string) {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  let out = body.replaceAll("$ARGUMENTS", args.trim()).replaceAll("$@", args.trim());
  for (let i = 0; i < tokens.length; i++) {
    out = out.replaceAll(`$${i + 1}`, tokens[i] ?? "");
  }
  return out;
}
