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

const SLASH_COMMANDS = ["start", "research", "plan", "work", "review"] as const;
type SlashCommand = (typeof SLASH_COMMANDS)[number];

// Session-scoped flag — set when a registered slash command activates, read &
// cleared by the before_agent_start hook to inject PM doctrine for that single
// turn. Avoids file writes or global APPEND_SYSTEM.md changes.
let pmDoctrineActive = false;

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
        pmDoctrineActive = true;
        trace(`/${name} → sendUserMessage (${expanded.length} chars); PM doctrine armed`);
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
        `pmDoctrineActive: ${pmDoctrineActive}`,
        "commands:         /start /research /plan /work /review /runs /ensemble-model /ensemble-debug",
        "tools:            dispatch_specialist, dispatch_parallel, adversarial_loop, dispatch_lens_review",
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
      if (!pmDoctrineActive) return undefined;
      pmDoctrineActive = false; // one-shot per slash command
      try {
        const pmPrompt = await fs.readFile(PM_PROMPT_FILE, "utf8");
        const base = event.systemPrompt ?? "";
        trace(`before_agent_start: appending PM doctrine (${pmPrompt.length} chars)`);
        return { systemPrompt: `${base}\n\n${pmPrompt}` };
      } catch (err) {
        trace(`before_agent_start: PM doctrine load FAILED: ${(err as Error).message}`);
        return undefined;
      }
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
