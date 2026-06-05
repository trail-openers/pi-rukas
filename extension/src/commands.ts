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

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { GLOBAL_KEY, getAllOverrides } from "./model-config.ts";
import { modelConfigSnapshot } from "./models.ts";
import { transcriptsSummary } from "./runs.ts";
import { trace } from "./trace.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PI_PROMPTS_DIR = path.resolve(
  process.env.PI_ENSEMBLE_PI_PROMPTS_DIR ?? path.join(__dirname, "..", "..", "pi-prompts"),
);

const PM_PROMPT_FILE = path.resolve(
  process.env.PI_ENSEMBLE_PM_PROMPT ??
    path.join(__dirname, "..", "..", "dist", "prompts", "standard", "project-manager.md"),
);

const SLASH_COMMANDS = ["start", "research", "plan", "work", "review", "audit"] as const;
type SlashCommand = (typeof SLASH_COMMANDS)[number];

// Session-scoped flags.
//
// `pmDoctrineFirstTurnPending` — one-shot for injecting the FULL project-manager
// doctrine on the first turn after a workflow slash command fires. Cleared
// after the first agent_start so we don't re-inject the 53K-char doctrine on
// every PM turn.
//
// `pmModeActive` — sticky from the first slash command for the rest of the
// session. While true, every PM agent_start gets a SHORT preamble (~200
// chars) reminding the model that it MUST NOT edit/write/code itself. This
// closes the live-test bug where PM had the doctrine only on turn 1, then
// happily reached for the edit tool on turns 2+ once the doctrine was gone
// from context.
let pmDoctrineFirstTurnPending = false;
let pmModeActive = false;

const PM_STICKY_PREAMBLE = `# PM mode — orchestration only

You are running inside a pi-ensemble workflow (/start, /research, /plan, /work, /review). Even though Pi has read, edit, write, and bash tools registered, you MUST NOT use edit, write, or non-vipune/git-read-only bash for implementation work. Implementation, tests, debugging, commits, deployment — ALL of it belongs to subagents:

- Implementation, tests, debugging, file edits → \`dispatch_specialist\` with role \`developer\` (then \`adversarial_loop\` to gate the diff)
- Git ops, commits, PRs, branch creation, deployment → \`dispatch_specialist\` with role \`ops\`
- Research, file reading, vipune searches, web → \`dispatch_specialist\` with role \`explore\`

If you catch yourself about to call \`edit\`, \`write\`, or \`bash\` for anything beyond \`vipune\` / \`gh issue view\` / read-only \`git status|diff|log|branch\` / \`oo recall\`, STOP and dispatch instead. Touching files yourself is a doctrine violation.
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
        let body: string;
        try {
          body = await loadPromptBody(name);
        } catch (err) {
          trace(`/${name} FAILED to load body: ${(err as Error).message}`);
          ctx.ui.notify(`pi-ensemble: ${(err as Error).message}`, "error");
          return;
        }
        const expanded = expandArgs(body, args);
        if (!ctx.isIdle()) {
          ctx.ui.notify(
            `pi-ensemble: agent is busy — try /${name} again when idle, or use /steer for an inline nudge`,
            "warning",
          );
          return;
        }
        pmDoctrineFirstTurnPending = true;
        pmModeActive = true;
        trace(
          `/${name} → sendUserMessage (${expanded.length} chars); PM doctrine armed + PM mode sticky`,
        );
        pi.sendUserMessage(expanded);
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
        const m = choice.model ?? "(Pi default)";
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
      const lines = [
        `prompts dir:      ${PI_PROMPTS_DIR}`,
        `PM prompt file:   ${PM_PROMPT_FILE}`,
        `PM mode:          ${pmModeActive ? "active (sticky preamble injected every turn)" : "idle"}`,
        `PM first-turn doctrine pending: ${pmDoctrineFirstTurnPending}`,
        "commands:         /start /research /plan /work /review /audit /runs /ensemble-model /ensemble-debug",
        "tools:            dispatch_specialist, dispatch_parallel, adversarial_loop, dispatch_lens_review (all async),",
        "                  dispatch_status, dispatch_kill, dispatch_peek, dispatch_steer, check_review_cap",
        ...(runsLine ? [`transcripts:      ${runsLine}`] : []),
        "",
        "subagent models  (change via /ensemble-model — saved to ~/.pi/agent/ensemble-models.json)",
        ...(globalOverride
          ? [`  default for all   ← ${globalOverride}   [/ensemble-model (all)]`]
          : []),
        ...modelLines,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
      // Two-layer doctrine: full PM doctrine on turn 1 (heavy, one-shot to
      // amortise cost), short PM_STICKY_PREAMBLE on every turn while in PM
      // mode (light, closes the "PM forgets the doctrine on turn 2+" gap that
      // let it self-code on issue #580).
      if (!pmModeActive) return undefined;
      const base = event.systemPrompt ?? "";
      const pieces: string[] = [base, PM_STICKY_PREAMBLE];
      if (pmDoctrineFirstTurnPending) {
        pmDoctrineFirstTurnPending = false;
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
  }
}

async function loadPromptBody(name: SlashCommand): Promise<string> {
  const file = path.join(PI_PROMPTS_DIR, `${name}.md`);
  return fs.readFile(file, "utf8");
}

function expandArgs(body: string, args: string) {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);
  let out = body.replaceAll("$ARGUMENTS", args.trim()).replaceAll("$@", args.trim());
  for (let i = 0; i < tokens.length; i++) {
    out = out.replaceAll(`$${i + 1}`, tokens[i] ?? "");
  }
  return out;
}
