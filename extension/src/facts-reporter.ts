/**
 * Companion Pi extension loaded into the /agents-md pre-pass child (#660, B2).
 *
 * Registers a single `report_facts` tool with a TypeBox-validated schema that
 * IS the `AgentFacts` wire-format type. The pre-pass is a read-only explore-role
 * dispatch that inspects a repository whose manifest the deterministic
 * `detectFacts()` cannot recognise (Ruby/Gemfile, true greenfield,
 * unrecognised ecosystems), or whose Code Style section is still missing, and
 * reports the facts it finds through this tool — never through prose.
 *
 * The reason this is a tool call rather than a prose list mirrors the three
 * sibling reporters (`report_policy` / `report_finding` / `report_plan_item`):
 * Pi validates the schema inside the child, so a malformed call never reaches
 * the caller and there is no text-parsing failure class left to harden.
 *
 * No execution logic: the tool exists so the model has a structured way to
 * emit the facts. Acknowledging the call is enough — the caller (the PM,
 * orchestrating the dispatch) reads the `tool_use` blocks afterward, converts
 * the `AgentFacts` with `agentFactsToDetectedFacts`, and feeds the result into
 * B1's `agentOverride` parameter. If the child calls the tool at all, the
 * caller proceeds; a missing or malformed call means "no agentOverride at all"
 * (the graceful-failure contract), never a guess.
 *
 * Loaded via `--no-skills --extension <path-to-this-file>` at dispatch time —
 * never auto-discovered from `~/.pi/agent/extensions/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Command } from "./agents-md/detect.ts";

/**
 * The companion-extension load seam for the pre-pass dispatch — the exact
 * shape of PLAN_REPORTER_PATH / PLAN_EXTRA_ARGS (plan-investigate.ts): pin
 * the child to the report_facts tool via `--no-skills --extension <path>`.
 * The child is an explore-role dispatch (structurally denied write/edit via
 * role-tools.ts); the caller converts the wire format with
 * `agentFactsToDetectedFacts` (agents-md/detect.ts), never here.
 */
export const FACTS_REPORTER_PATH = `${__dirname}/facts-reporter.ts`;
export const FACTS_EXTRA_ARGS = ["--no-skills", "--extension", FACTS_REPORTER_PATH];

/**
 * The 5-value kind union for `AgentFacts` commands, matching
 * `detect.ts`'s `Command.kind` exactly. Kept as a const array (not an inline
 * union literal) so the schema and the TS type cannot drift apart — a 6th kind
 * (e.g. "deploy") is rejected by TypeBox validation inside the child.
 */
export const AGENT_FACTS_COMMAND_KINDS = ["test", "lint", "format", "typecheck", "build"] as const;

/**
 * The `AgentFacts` wire format — the shape the `report_facts` tool returns to
 * the caller. This is deliberately the *wire* type, not B1's `DetectedFacts`:
 *
 * - It carries NO `runner` (neither top-level nor per-command). The child has
 *   no need to name a runner; `agentFactsToDetectedFacts` emits `runner:
 *   undefined`, which is what a `[detected:agent,...]` section means — the
 *   commands come from the agent, not from a manifest-derived runner.
 * - `ciWorkflows` carries RAW FILENAMES ONLY (e.g. "ci.yml"). The
 *   `.github/workflows/` prefix is applied by `environmentBody` in
 *   `renderer.ts` at render time — the conversion must never add it, or a
 *   child that reports "ci.yml" would render as
 *   `.github/workflows/.github/workflows/ci.yml`.
 *
 * Every field is optional: a partial reply (e.g. `codeStyleBullets` present,
 * `commands` absent) is partial *information*, not a failure — each field is
 * applied only if the child populated it.
 */
export interface AgentFacts {
  language?: string;
  packageManager?: string;
  /** The manifest file the agent found, e.g. "Gemfile" — or the root file. */
  manifest?: string;
  commands?: { name: string; command: string; kind: (typeof AGENT_FACTS_COMMAND_KINDS)[number] }[];
  /** Dense, specific bullets (exact shell lines / named rules), NOT prose. */
  codeStyleBullets?: string[];
  /** RAW workflow FILENAMES only (e.g. "ci.yml") — no `.github/workflows/` prefix. */
  ciWorkflows?: string[];
}

const FACTS_PARAMETERS = Type.Object({
  language: Type.Optional(
    Type.String({
      description: "The primary language, e.g. 'ruby', 'go', 'python'. Omit if unknown.",
    }),
  ),
  packageManager: Type.Optional(
    Type.String({
      description:
        "The package manager, e.g. 'bundler' (Gemfile), 'bun', 'cargo'. Omit if unknown.",
    }),
  ),
  manifest: Type.Optional(
    Type.String({
      description:
        "The root manifest file the agent found, e.g. 'Gemfile', 'Makefile'. Omit if there is none.",
    }),
  ),
  commands: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String({ description: "A short human label for the command." }),
        command: Type.String({
          description:
            "The EXACT shell line that should go into AGENTS.md (e.g. 'bundle exec rspec'). No narrative.",
        }),
        kind: Type.Union(
          AGENT_FACTS_COMMAND_KINDS.map((k) => Type.Literal(k)),
          {
            description:
              "One of: test, lint, format, typecheck, build — matches detect.ts Command.kind exactly.",
          },
        ),
      }),
      { description: "The quality-gate commands. Omit if none are known." },
    ),
  ),
  codeStyleBullets: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "One dense, specific bullet each (exact shell lines, named linters, concrete rules). No prose, no filler — match the density of a hand-written AGENTS.md §Pre-Push Quality Gates.",
      }),
      { description: "Code-style rules as a dense bullet list. Omit if none are known." },
    ),
  ),
  ciWorkflows: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "RAW workflow FILENAMES only, e.g. 'ci.yml'. Do NOT include the '.github/workflows/' prefix — the renderer applies it.",
      }),
      {
        description:
          "CI workflow file names, raw (no .github/workflows/ prefix). Omit if none exist.",
      },
    ),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_facts",
    label: "Report Agent Facts",
    description:
      "Report the project facts you discovered about this repository. Call this EXACTLY ONCE. Your prose reply is ignored — this call is the only thing that counts. Report ONLY what you actually verified by reading files; leave a field absent rather than guessing it. For `ciWorkflows` give RAW file names only (e.g. 'ci.yml'), never the full path.",
    parameters: FACTS_PARAMETERS,
    async execute(_id, raw) {
      const a = (raw ?? {}) as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof a.manifest === "string") parts.push(`manifest: ${a.manifest}`);
      if (typeof a.language === "string") parts.push(`language: ${a.language}`);
      if (typeof a.packageManager === "string") parts.push(`package manager: ${a.packageManager}`);
      const cmds = Array.isArray(a.commands) ? a.commands.length : 0;
      if (cmds) parts.push(`${cmds} command(s)`);
      const bullets = Array.isArray(a.codeStyleBullets) ? a.codeStyleBullets.length : 0;
      if (bullets) parts.push(`${bullets} code-style bullet(s)`);
      const flows = Array.isArray(a.ciWorkflows) ? a.ciWorkflows.length : 0;
      if (flows) parts.push(`${flows} CI workflow(s)`);
      return {
        content: [
          {
            type: "text",
            text: `recorded agent facts${parts.length ? ` (${parts.join(", ")})` : " (none populated)"}`,
          },
        ],
        details: raw as Record<string, unknown>,
      };
    },
  });
}
