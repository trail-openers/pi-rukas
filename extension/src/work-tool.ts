/**
 * work-tool — the two tools that let PM reach the compiled workflows.
 *
 * The incident these exist for: a PM killed a `/work` cycle over
 * `needs-human-attention` labels, found it had no way to start another, and
 * reimplemented the driver by hand. No state file, no queue, no handoff
 * artifact, no review-cap timer, and a branch the driver knew nothing about.
 * Every guarantee the compiled pipeline provides was silently absent, and
 * nothing in the transcript said so. Doctrine telling PM not to do that already
 * existed; what was missing was the thing to call instead.
 *
 * Two tools rather than five. Measured: `/research`, `/plan`, `/audit` and
 * `/review` are prose bodies sent to the main agent, and PM already owns every
 * tool those bodies orchestrate. A dedicated tool per command would be PM
 * prompting itself — a worse way to get text into context than simply returning
 * it. `load_workflow_doctrine` returns any command's body as a tool result, so
 * all of them are reachable without four redundant registrations.
 *
 * `start_work_driver` is the real gap, because `/work` is not prose: it is a
 * compiled state machine that must actually be invoked.
 *
 * **There is no `merge` parameter, deliberately.** `--merge` is one of two
 * `AuthoritySource`s and the only one bypassing the #406/#407 policy judge. An
 * LLM-settable boolean there is a cycle granting itself merge authority. Merge
 * authority stays operator-only: the slash command, or a grant in the project's
 * `AGENTS.md` that the judge verifies by citation.
 *
 * Tools receive an `ExtensionContext` as their fifth `execute` parameter — the
 * same object the command handler uses — so `ctx.cwd` is available and the
 * repo-root resolution is identical. (`ctx.isIdle()` is deliberately NOT
 * copied: a tool runs mid-turn by definition, so it would refuse always.)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type SlashCommand, expandArgs, loadPromptBody } from "./commands.ts";
import { armPmMode } from "./pm-mode.ts";
import { trace } from "./trace.ts";
import { launchWork, parseWorkArgs, resolveRepoRoot } from "./work-entry.ts";

/**
 * Commands whose body is prose for the main agent. `work` is excluded because
 * it is a compiled driver — handing PM its prose would invite exactly the
 * hand-rolling this module exists to stop.
 *
 * Written as an explicit tuple rather than `SLASH_COMMANDS.filter(...)`:
 * TypeBox needs literal types to build a discriminated union, and a mapped
 * array erases them. The assertion below keeps it honest if the command list
 * ever grows.
 */
const DOCTRINE_COMMANDS = ["start", "research", "plan", "review", "audit", "do"] as const;

// Fails to compile if a new slash command is added without deciding whether it
// belongs here. `work` is the sole deliberate omission.
const _doctrineCoversEveryProseCommand: Exclude<
  SlashCommand,
  (typeof DOCTRINE_COMMANDS)[number]
> extends "work"
  ? true
  : never = true;
void _doctrineCoversEveryProseCommand;

export function registerWorkTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_work_driver",
    label: "Start /work Cycle",
    description:
      "Start the compiled /work driver for one or more GitHub issues — the same pipeline the /work slash command runs (explore → plan → branch → develop → adversarial → commit-pr → lens-review → ci → merged/handoff), with its state file, queue, handoff artifact and review-cap timer. Returns immediately; the cycle runs in the background and reports progress on its own. Check outcomes with /work-status, not by polling. NEVER reconstruct these steps by hand with dispatch tools — a hand-rolled cycle has none of the above guarantees. Merge authority is operator-only and cannot be requested here.",
    parameters: Type.Object({
      issues: Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 1,
        description:
          "Issue numbers. More than one runs the grouping pass first: related issues share a PR, unrelated ones become separate cycles.",
      }),
      restart: Type.Optional(
        Type.Boolean({
          description:
            "Wipe prior state and start a clean cycle. Required to re-run an issue whose previous cycle ended terminally, or one labelled needs-human-attention — and only after the reason for that label has actually been addressed.",
        }),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as { issues: number[]; restart?: boolean };
      const parsed = parseWorkArgs(
        [...params.issues.map(String), params.restart ? "--restart" : ""].join(" "),
      );
      if ("error" in parsed) {
        return { content: [{ type: "text", text: parsed.error }], details: { started: false } };
      }
      // mergeGrant is forced off regardless of what parseWorkArgs derived —
      // nothing an LLM writes can reach it. See the module docstring.
      const invocation = { ...parsed, mergeGrant: false };

      armPmMode();
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      const lines: string[] = [];
      const launch = await launchWork(pi, {
        repoRoot,
        invocation,
        sink: { notify: (t) => lines.push(t) },
      });
      trace(`start_work_driver → ${launch.mode} for #${launch.issues.join(", #")}`);

      lines.push(
        "",
        "The cycle is running in the background. Do not re-dispatch its steps yourself:",
        "progress arrives on its own, and `/work-status` shows the state file at any time.",
        "Merge authority was NOT granted — the cycle will open its PR and park unless the",
        "project's AGENTS.md grants it.",
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { started: true, mode: launch.mode, issues: launch.issues, mergeGrant: false },
      };
    },
  });

  pi.registerTool({
    name: "load_workflow_doctrine",
    label: "Load Workflow Doctrine",
    description:
      "Return the full instructions for a pi-ensemble workflow command (research, plan, review, audit, start, do) as text, so you can follow them without the user having to type the slash command. Use this when you need to run one of these workflows yourself. For /work use start_work_driver instead — it is a compiled driver, not prose.",
    parameters: Type.Object({
      name: Type.Union(
        [
          Type.Literal("start"),
          Type.Literal("research"),
          Type.Literal("plan"),
          Type.Literal("review"),
          Type.Literal("audit"),
          Type.Literal("do"),
        ],
        { description: "Which workflow's instructions to load." },
      ),
      args: Type.Optional(
        Type.String({
          description:
            "Arguments the command would have received, substituted into $ARGUMENTS / $1 / $2 placeholders.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { name: SlashCommand; args?: string };
      let body: string;
      try {
        body = await loadPromptBody(params.name);
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Could not load /${params.name}: ${(err as Error).message}` },
          ],
          details: { loaded: false, name: params.name, chars: 0 },
        };
      }
      const expanded = expandArgs(body, params.args ?? "");
      armPmMode();
      trace(`load_workflow_doctrine(${params.name}) → ${expanded.length} chars`);
      return {
        content: [{ type: "text", text: expanded }],
        details: { loaded: true, name: params.name, chars: expanded.length },
      };
    },
  });
}
