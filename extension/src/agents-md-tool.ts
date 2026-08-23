/**
 * agents-md-tool — the in-process delivery for the `/agents-md` command.
 *
 * #524 shipped the TS core under `src/agents-md/` and a prose command body
 * that told PM to shell out to `bun extension/src/agents-md/agents-md.ts` —
 * a path relative to the HOST repo, which has no `extension/` directory.
 * Every host invocation died with "No such file or directory" before doing
 * anything.
 *
 * The fix replicates `/work`'s delivery (work-tool.ts house doctrine: prose =
 * WHAT, tool = HOW): a registered tool that imports the verbs and calls them
 * in-process. Pi loads every `src/*.ts` at startup via jiti, so the core is
 * always reachable; `resolveRepoRoot(ctx.cwd)` — never `process.cwd()` —
 * keeps the repo-root resolution identical to the driver (#360).
 *
 * The verbs are called DIRECTLY, never `runAgentsMd`: that CLI wrapper
 * `process.exit()`s when run as a script, and a tool call must not kill the
 * parent process.
 *
 * Result shape (the contract `pi-prompts/agents-md.md` branches on):
 *   content[0].text — the CLI-style summary PLUS, for create/update, a
 *                     unified diff of oldBytes → newBytes (200-line cap);
 *   details         — `{ verb, exitCode }` and, per verb, `plan` or `check`
 *                     (plus `error` when the verb refused).
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type AgentsMdFs,
  type Verb,
  type VerbResult,
  checkAgent,
  createAgent,
  updateAgent,
} from "./agents-md/agents-md.ts";
import { trace } from "./trace.ts";
import { resolveRepoRoot } from "./work-entry.ts";

const DIFF_MAX_LINES = 200;

export function registerAgentsMdTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agents_md_run",
    label: "Run /agents-md Core",
    description:
      "Run the compiled /agents-md core (create / update / check) against the repository's AGENTS.md. The tool resolves the repo root from the session cwd and calls the verb in-process; it never shells out. The exit code is the contract: 0 clean, 1 findings/drift, 2 refuse/corrupt. For create/update the result carries a unified diff of the change — show it to the operator before any ask-case write. `deep` is valid for `check` ONLY (it executes the gate commands, each with a 60s timeout, so the call can be slow) and is rejected with a structured error on create/update.",
    parameters: Type.Object({
      verb: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("check")], {
        description: "Which /agents-md verb to run.",
      }),
      deep: Type.Optional(
        Type.Boolean({
          description:
            "check only: actually execute the gate commands (potentially long-running — 60s timeout each). Rejected on create/update.",
        }),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as { verb: Verb; deep?: boolean };
      const verb = params.verb;
      if (verb !== "check" && params.deep === true) {
        return {
          content: [
            {
              type: "text",
              text: `error: deep is only valid for the check verb (it executes the gate commands); ${verb} does not accept it`,
            },
          ],
          details: { verb, exitCode: 2, error: "deep is only valid for check" },
        };
      }
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      const file = `${repoRoot}/AGENTS.md`;
      const result: VerbResult =
        verb === "create"
          ? createAgent(repoRoot, file, defaultRepoFs())
          : verb === "update"
            ? updateAgent(repoRoot, file, defaultRepoFs())
            : checkAgent(repoRoot, file, { deep: params.deep ?? false }, defaultRepoFs());
      trace(`agents_md_run(${verb}${params.deep ? " --deep" : ""}) → exit ${result.exitCode}`);
      const details: Record<string, unknown> = { verb, exitCode: result.exitCode };
      if (result.plan) details.plan = result.plan;
      if (result.check) details.check = result.check;
      if (result.error) details.error = result.error;
      return { content: [{ type: "text", text: renderReport(result, file) }], details };
    },
  });
}

/**
 * The live filesystem — the verbs' DEFAULT_FS equivalent, defined here so the
 * tool (not the core's script-mode default) is the module that owns its I/O.
 * Tests reach the verbs through the same signature with a stubbed FsOps.
 */
function defaultRepoFs(): AgentsMdFs {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, b) => writeFileSync(p, b),
    stat: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    today: () => new Date().toISOString().slice(0, 10),
  };
}

/**
 * The tool result's text: the CLI-style report the prompt body used to read
 * from stdout, plus the unified diff for create/update.
 */
function renderReport(result: VerbResult, file: string): string {
  if (result.error) {
    return `error (${result.exitCode}): ${result.error}`;
  }
  if (result.verb === "check") {
    const c = result.check;
    if (!c) return "error: no check result";
    if (c.findings.length === 0) return "clean";
    return c.findings.map((f) => `${f.kind}: ${f.message}`).join("\n");
  }
  const p = result.plan;
  if (!p) return "error: no plan result";
  const lines: string[] = [
    p.wouldWrite ? "would write" : "no-op (already current)",
    `managed: ${p.managedIds.join(", ")}`,
    `target: ${file}`,
  ];
  if (p.omitted.length) {
    lines.push(`omitted: ${p.omitted.map((o) => `${o.id} (${o.reason})`).join(", ")}`);
  }
  if (p.drift) lines.push(`drift: ${p.drift}`);
  const diff = unifiedDiff(p.oldBytes, p.newBytes);
  if (diff.length) lines.push("", diff);
  return lines.join("\n");
}

/**
 * Hand-rolled line diff (LCS over lines) in unified style: unchanged context
 * collapses to one line around each change block. Truncated to the first
 * DIFF_MAX_LINES rendered lines with a `… K more lines` marker — a wrapped
 * brownfield file can be hundreds of insertion lines, and this text is what
 * the operator sees before a write.
 *
 * Both inputs are small (the rendered AGENTS.md sections, well under the 32
 * KiB cap the size test enforces), so the O(n·m) LCS table is fine.
 */
function unifiedDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const cell = (dp: number[][], i: number, j: number): number => {
    const row = dp[i];
    if (row === undefined) return 0;
    const v = row[j];
    return typeof v === "number" ? v : 0;
  };
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = m - 1; j >= 0; j--) {
      const ai = a[i];
      const bj = b[j];
      if (ai !== undefined && bj !== undefined) {
        row[j] =
          ai === bj ? cell(dp, i + 1, j + 1) + 1 : Math.max(cell(dp, i + 1, j), cell(dp, i, j + 1));
      }
    }
  }
  type Op = { kind: "ctx" | "del" | "add"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      ops.push({ kind: "ctx", line: ai });
      i++;
      j++;
    } else if (cell(dp, i + 1, j) >= cell(dp, i, j + 1)) {
      ops.push({ kind: "del", line: ai });
      i++;
    } else {
      ops.push({ kind: "add", line: bj });
      j++;
    }
  }
  while (i < n) {
    const ai = a[i] ?? "";
    ops.push({ kind: "del", line: ai });
    i++;
  }
  while (j < m) {
    const bj = b[j] ?? "";
    ops.push({ kind: "add", line: bj });
    j++;
  }
  if (!ops.some((o) => o.kind !== "ctx")) return "";

  // Each hunk: one context line before, the change block, one after. Truncate
  // mid-hunk at DIFF_MAX_LINES rendered lines; `consumed` tracks ops already
  // covered so the `… K more lines` marker counts every op not yet rendered.
  const out: string[] = [];
  let k = 0;
  let consumed = 0;
  while (k < ops.length) {
    const ok = ops[k];
    if (ok === undefined) break;
    if (ok.kind === "ctx") {
      k++;
      consumed++;
      continue;
    }
    let start = k;
    while (start > 0) {
      const prev = ops[start - 1];
      if (prev === undefined || prev.kind !== "ctx") break;
      start--;
    }
    let end = k;
    while (end + 1 < ops.length) {
      const next = ops[end + 1];
      if (next === undefined || next.kind !== "ctx") break;
      end++;
    }
    const hunkStart = Math.max(0, start - 1);
    const hunkEnd = Math.min(ops.length - 1, end + 1);
    for (let t = hunkStart; t <= hunkEnd && out.length < DIFF_MAX_LINES; t++) {
      const o = ops[t];
      if (o === undefined) break;
      const prefix = o.kind === "ctx" ? " " : o.kind === "del" ? "-" : "+";
      out.push(`${prefix}${o.line}`);
      consumed++;
    }
    k = end + 1;
    if (out.length >= DIFF_MAX_LINES) {
      const remaining = ops.length - consumed;
      if (remaining > 0) out.push(`… ${remaining} more lines`);
      break;
    }
  }
  return out.join("\n");
}
