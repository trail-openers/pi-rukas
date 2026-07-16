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
import { GLOBAL_KEY, getAllOverrides } from "./model-config.ts";
import { modelConfigSnapshot } from "./models.ts";
import { transcriptsSummary } from "./runs.ts";
import { trace } from "./trace.ts";
import { groupIssues, runWorkDriver } from "./work-driver.ts";
import { registerWorkStatusCommand } from "./work-status.ts";
import { readState } from "./workflow-state.ts";

const execp = promisify(exec);

/**
 * /work driver feature flag. Default ON in v1 — the compiled state-machine
 * driver owns /work transitions. Set PI_ENSEMBLE_WORK_DRIVER=0 to bypass
 * the driver and fall back to the legacy PM-driven flow (`sendUserMessage(work.md)`).
 *
 * Fallback is essential for two reasons:
 *  1. In-flight /work cycles started under older versions don't have a
 *     state file; the driver halts on missing schema vs. attempting to
 *     fabricate one.
 *  2. If a driver step body throws unexpectedly, the user can flip the
 *     env var and keep working without waiting for a fix.
 */
function isWorkDriverEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_WORK_DRIVER;
  // Default ON. Explicit "0" / "false" disables; everything else (including
  // unset) is on.
  return v !== "0" && v !== "false";
}

/**
 * Resolve the project repo root (the worktree containing the `.git` dir or
 * gitlink). The driver state file lives here so it survives `git worktree
 * remove` against any sub-worktree. Falls back to process.cwd() when not
 * inside a git repo (which would mean /work is being run in a non-git
 * directory — surface clearly rather than fabricate a path).
 */
async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execp("git rev-parse --show-toplevel", { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PI_PROMPTS_DIR = path.resolve(
  process.env.PI_ENSEMBLE_PI_PROMPTS_DIR ?? path.join(__dirname, "..", "..", "pi-prompts"),
);

const PM_PROMPT_FILE = path.resolve(
  process.env.PI_ENSEMBLE_PM_PROMPT ??
    path.join(__dirname, "..", "..", "dist", "prompts", "standard", "project-manager.md"),
);

const SLASH_COMMANDS = ["start", "research", "plan", "work", "review", "audit", "do"] as const;
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

You are running inside a pi-ensemble workflow (/start, /research, /plan, /work, /review, /audit, /do). Even though Pi has read, edit, write, and bash tools registered, you MUST NOT use edit, write, or non-vipune/git-read-only bash for implementation work. Implementation, tests, debugging, commits, deployment — ALL of it belongs to subagents:

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

        // /work has a code-driven execution path (work-driver.ts) when the
        // PI_ENSEMBLE_WORK_DRIVER flag is on (default). The driver runs in
        // the background — the handler kicks it off and returns immediately
        // so the user can interact with the chat while it works. Other
        // commands stay on the legacy sendUserMessage(prompt-body) path.
        if (name === "work" && isWorkDriverEnabled()) {
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
          const tokens = args.trim().split(/\s+/).filter(Boolean);
          const restart = tokens.includes("--restart");
          const issues = tokens
            .filter((t) => !t.startsWith("--"))
            .map((t) => Number.parseInt(t, 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (issues.length === 0 || issues[0] === undefined) {
            ctx.ui.notify(
              "pi-ensemble: /work needs at least one issue number (e.g., /work 547, or /work 561 562 to analyze + group multi-issue). " +
                "Set PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy PM-driven flow.",
              "warning",
            );
            return;
          }
          if (!ctx.isIdle()) {
            ctx.ui.notify(
              "pi-ensemble: agent is busy — try /work again when idle, or use /steer for an inline nudge",
              "warning",
            );
            return;
          }
          const cwd = process.cwd();
          const repoRoot = await resolveRepoRoot(cwd);
          const restartTag = restart ? " (restart — prior state wiped)" : "";
          trace(
            `/work → driver loop for ${issues.length === 1 ? `issue #${issues[0]}` : `${issues.length} issues (#${issues.join(", #")})`}${restartTag} (repoRoot=${repoRoot})`,
          );
          // PM stays in reporter mode so user-visible progress messages
          // emitted by the driver via sendUserMessage land cleanly.
          pmDoctrineFirstTurnPending = true;
          pmModeActive = true;

          // Single-issue path — no grouping needed.
          if (issues.length === 1) {
            const soleIssue = issues[0];
            if (soleIssue === undefined) return;
            ctx.ui.notify(
              `pi-ensemble: /work driver running for issue #${soleIssue}${restartTag}. State in .pi/work-state/${soleIssue}.json. Set PI_ENSEMBLE_WORK_DRIVER=0 to use legacy PM flow.`,
              "info",
            );
            void (async () => {
              try {
                await runWorkDriver({ pi, repoRoot, issue: soleIssue, restart });
              } catch (err) {
                trace(`work-driver: unexpected throw for #${soleIssue}: ${(err as Error).message}`);
                try {
                  pi.sendUserMessage(
                    `pi-ensemble: /work driver crashed on issue #${soleIssue}: ${(err as Error).message}. ` +
                      `Inspect .pi/work-state/${soleIssue}.json or run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy flow.`,
                  );
                } catch {
                  /* nothing we can do */
                }
              }
            })();
            return;
          }

          // Multi-issue path — analyze + group + iterate. Fire-and-forget
          // so the handler returns immediately; grouping analysis + K
          // cycles all run in the background.
          ctx.ui.notify(
            `pi-ensemble: analyzing ${issues.length} issues (#${issues.join(", #")}) for grouping…`,
            "info",
          );
          void (async () => {
            // Fetch each issue body in parallel via `gh issue view`. The
            // grouping rules read the body to detect link markers, file
            // paths, subsystem tags. Empty body on failure → grouping
            // falls back to R5 (separate groups) for that issue.
            const bodiesByIssue: Record<number, string> = {};
            const fetches = await Promise.allSettled(
              issues.map(
                (n) =>
                  new Promise<{ n: number; body: string }>((resolve, reject) => {
                    exec(
                      `gh issue view ${n} --json title,body,labels`,
                      { cwd: repoRoot, maxBuffer: 2 * 1024 * 1024 },
                      (err, stdout) => {
                        if (err) reject(err);
                        else resolve({ n, body: stdout });
                      },
                    );
                  }),
              ),
            );
            for (let i = 0; i < issues.length; i++) {
              const n = issues[i];
              if (n === undefined) continue;
              const r = fetches[i];
              bodiesByIssue[n] = r?.status === "fulfilled" ? r.value.body : "";
            }

            const { groups, notes } = groupIssues(issues, bodiesByIssue);
            const groupList = Object.values(groups);
            const summary = groupList.map((g) => `${g.id}: #${g.issues.join(", #")}`).join(" | ");
            const notesLine = notes.length > 0 ? `\n  rules fired: ${notes.join("; ")}` : "";
            try {
              pi.sendUserMessage(
                `pi-ensemble: /work grouping decided K=${groupList.length} group(s) — ${summary}${notesLine}\nRunning cycles sequentially${restartTag}; halt-on-non-merged between groups.`,
              );
            } catch {
              /* nothing we can do */
            }

            // Iterate groups sequentially with halt-on-non-merged.
            for (let gi = 0; gi < groupList.length; gi++) {
              const g = groupList[gi];
              if (!g) continue;
              const primary = g.issues[0];
              if (primary === undefined) continue;
              const groupIssueList = g.issues;
              try {
                await runWorkDriver({
                  pi,
                  repoRoot,
                  issue: primary,
                  issues: groupIssueList.length > 1 ? groupIssueList : undefined,
                  restart,
                });
              } catch (err) {
                trace(
                  `work-driver: unexpected throw for ${g.id} (#${groupIssueList.join(", #")}): ${(err as Error).message}`,
                );
                try {
                  pi.sendUserMessage(
                    `pi-ensemble: /work driver crashed on ${g.id} (#${groupIssueList.join(", #")}): ${(err as Error).message}. Queue halted. ` +
                      `Inspect .pi/work-state/${primary}.json or run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy flow.`,
                  );
                } catch {
                  /* nothing we can do */
                }
                return;
              }
              const state = await readState(repoRoot, primary);
              const status = state?.pipelineState.status;
              if (status !== "merged" && gi + 1 < groupList.length) {
                const remaining = groupList
                  .slice(gi + 1)
                  .map((r) => `${r.id} (#${r.issues.join(", #")})`);
                try {
                  pi.sendUserMessage(
                    `pi-ensemble: /work ${g.id} (#${groupIssueList.join(", #")}) terminated as ${status ?? "unknown"}; queue halted. ` +
                      `Remaining groups (${remaining.join(", ")}) were NOT started. ` +
                      `Fix / abandon ${g.id}, then re-run /work with the remaining issues.`,
                  );
                } catch {
                  /* nothing we can do */
                }
                return;
              }
            }
            try {
              pi.sendUserMessage(
                `pi-ensemble: /work queue complete — ${groupList.length} group(s) merged: ${groupList.map((g) => `${g.id} (#${g.issues.join(", #")})`).join(", ")}`,
              );
            } catch {
              /* nothing we can do */
            }
          })();
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
    case "do":
      return "<description> — Orchestrate free-form work via PM (no GitHub issue required; counterpart to /work)";
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
