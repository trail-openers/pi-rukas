import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { type RunningState, emptyRunningState, renderBatch } from "./progress.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { DispatchResult } from "./types.ts";

type ToolUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}) => void;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LENS_REPORTER_PATH = path.join(__dirname, "lens-reporter.ts");

/**
 * Six-pass code review — fan out to one `code-review-specialist` child per
 * lens, each pinned to its lens-specific skill. Synthesise findings via
 * (path, line, title) dedup + precedence merging, then map worst severity to
 * an overall verdict.
 *
 * Mirrors the Step 7 contract of the opencode `/work` command.
 */

export const LENSES = [
  { name: "SECURITY", skill: "code-review-security", precedence: 0 },
  { name: "ERROR_HANDLING", skill: "code-review-error-handling", precedence: 1 },
  { name: "TYPE_SAFETY", skill: "code-review-type-safety", precedence: 2 },
  { name: "PERFORMANCE", skill: "code-review-performance", precedence: 3 },
  { name: "ARCHITECTURE", skill: "code-review-architecture", precedence: 4 },
  { name: "SIMPLICITY", skill: "code-review-simplicity", precedence: 5 },
] as const;

export type LensName = (typeof LENSES)[number]["name"];
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Verdict = "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";

export interface RawFinding {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
  suggestion?: string;
}

export interface Finding extends RawFinding {
  severity: Severity;
  lens: LensName;
}

export interface LensRunResult {
  lens: LensName;
  ok: boolean;
  ms: number;
  findings: Finding[];
  model?: string;
  transcriptPath?: string;
  /** Set when the child failed to spawn or returned non-zero. */
  parseError?: string;
}

export interface LensReviewSummary {
  verdict: Verdict;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  lenses: LensRunResult[];
  /** Deduplicated, precedence-ordered list. */
  findings: Finding[];
}

function piSkillsDir(): string {
  return process.env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(os.homedir(), ".pi", "agent", "skills");
}

function lensPromptFor(lens: (typeof LENSES)[number], diff: string, context: string): string {
  return `You are running the **${lens.name}** review lens.

Scope discipline — only flag issues that belong to **${lens.name}**. Do NOT report findings that belong to other lenses (security / errors / types / perf / architecture / simplicity have separate reviewers; trust them with their own lanes).

Context for this PR: ${context || "(no extra context)"}

Diff to review:
\`\`\`diff
${diff}
\`\`\`

## How to report findings

For every issue you identify in your lane, call the \`report_finding\` tool ONCE with these fields:
  - severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  - path: file path relative to repo root
  - line: line number (omit for file-level findings)
  - title: short title (< 80 chars)
  - description: 1–3 sentence description of the issue
  - suggestion: short suggested fix

Do NOT batch multiple findings into a single call — one tool call per finding. Do NOT emit findings as JSON in your prose; only the \`report_finding\` tool calls count.

If you find nothing in your lane: do not call the tool. Conclude with a one-sentence summary explaining why the diff is clean from a ${lens.name} perspective.

When you have finished all findings, write a short prose summary as your final reply.`;
}

/**
 * Extract findings from the child's tool_use events. Each report_finding
 * invocation becomes one Finding. No text parsing involved — the schema is
 * validated by Pi inside the child process, so malformed calls never reach
 * this code.
 */
export function extractFindings(
  toolUses: unknown[],
  lens: LensName,
): { findings: Finding[]; skipped: number } {
  const out: Finding[] = [];
  let skipped = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_finding" || !t.arguments || typeof t.arguments !== "object") continue;
    const i = t.arguments as Record<string, unknown>;
    const severity = String(i.severity ?? "").toUpperCase();
    if (!["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(severity)) {
      skipped++;
      continue;
    }
    const filePath = typeof i.path === "string" ? i.path : "";
    const title = typeof i.title === "string" ? i.title : "";
    if (!filePath || !title) {
      skipped++;
      continue;
    }
    out.push({
      lens,
      severity: severity as Severity,
      path: normalisePath(filePath),
      line: typeof i.line === "number" ? i.line : 0,
      title,
      description: typeof i.description === "string" ? i.description : undefined,
      suggestion: typeof i.suggestion === "string" ? i.suggestion : undefined,
    });
  }
  return { findings: out, skipped };
}

function normalisePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Deduplicate findings by (normalised path, line, lowercased title). When
 * duplicates exist across lenses, keep the one from the highest-priority lens
 * (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY).
 */
export function dedupeFindings(input: Finding[]): Finding[] {
  const precedenceOf = new Map<LensName, number>(LENSES.map((l) => [l.name, l.precedence]));
  const bestByKey = new Map<string, Finding>();
  for (const f of input) {
    const key = `${f.path}::${f.line ?? 0}::${normaliseTitle(f.title)}`;
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, f);
      continue;
    }
    const a = precedenceOf.get(existing.lens) ?? 99;
    const b = precedenceOf.get(f.lens) ?? 99;
    if (b < a) bestByKey.set(key, f);
  }
  return Array.from(bestByKey.values()).sort(sortFindings);
}

function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[.!?;,]+$/, "")
    .trim();
}

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function sortFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (s !== 0) return s;
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return (a.line ?? 0) - (b.line ?? 0);
}

export function computeVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "CRITICAL")) return "CRITICAL_ISSUES_FOUND";
  if (findings.some((f) => f.severity === "HIGH" || f.severity === "MEDIUM")) return "ISSUES_FOUND";
  return "APPROVED";
}

function bySeverityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export async function runLensReview(opts: {
  diff: string;
  context?: string;
  cwd?: string;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateCallback;
}): Promise<LensReviewSummary> {
  const runId = makeRunId();
  const skillsDir = piSkillsDir();
  const context = opts.context ?? "";

  // Per-lens progress state, in fixed lens order so the rendered table is
  // stable as updates trickle in.
  const lensStates: RunningState[] = LENSES.map((l) =>
    emptyRunningState("code-review-specialist", l.name.toLowerCase().replaceAll("_", "-")),
  );
  const emitProgress = () => {
    opts.onUpdate?.({
      content: [{ type: "text", text: renderBatch("dispatch_lens_review", lensStates) }],
      details: { states: lensStates.map((s) => ({ ...s, usage: { ...s.usage } })) },
    });
  };

  const promises = LENSES.map(async (lens, lensIdx): Promise<LensRunResult> => {
    const skillPath = path.join(skillsDir, lens.skill);
    const prompt = lensPromptFor(lens, opts.diff, context);
    const tag = lens.name.toLowerCase().replaceAll("_", "-");
    // Per-lens deck key — orchestrator is `skipDeck: true`, so each lens
    // shows up as its own row in the dispatch deck (#117).
    const deckKey = `${runId}/${tag}`;
    dispatchDeck.startEntry(deckKey, {
      label: `code-review-specialist[${tag}]`,
      role: "code-review-specialist",
      tag,
    });
    let result: DispatchResult;
    try {
      result = await spawnSpecialist(
        { role: "code-review-specialist", prompt, cwd: opts.cwd },
        {
          runId,
          tag,
          // Pin to this lens's skill + load the report_finding tool. `--no-extensions`
          // (set in spawn.ts) disables auto-discovery; `--extension <path>` still
          // loads explicit paths, so the reporter is the only extension in the child.
          extraArgs: ["--no-skills", "--skill", skillPath, "--extension", LENS_REPORTER_PATH],
          // No timeoutMs override — inherits DEFAULT_SPAWN_TIMEOUT_MS (30 min, #114).
          signal: opts.signal,
          onProgress: (state) => {
            lensStates[lensIdx] = state;
            emitProgress();
            dispatchDeck.updateEntry(deckKey, state);
          },
        },
      );
    } catch (err) {
      dispatchDeck.clearEntry(deckKey);
      return {
        lens: lens.name,
        ok: false,
        ms: 0,
        findings: [],
        parseError: `spawn failed: ${(err as Error).message}`,
      };
    }
    dispatchDeck.clearEntry(deckKey);
    const { findings, skipped } = extractFindings(result.toolUses, lens.name);
    return {
      lens: lens.name,
      ok: result.ok,
      ms: result.ms,
      findings,
      model: result.model,
      transcriptPath: result.transcriptPath,
      parseError: skipped > 0 ? `${skipped} malformed report_finding call(s) skipped` : undefined,
    };
  });

  const lensResults = await Promise.all(promises);
  const all = lensResults.flatMap((r) => r.findings);
  const deduped = dedupeFindings(all);
  const verdict = computeVerdict(deduped);
  return {
    verdict,
    totalFindings: deduped.length,
    bySeverity: bySeverityCounts(deduped),
    lenses: lensResults,
    findings: deduped,
  };
}

function renderSummary(s: LensReviewSummary): string {
  const lensLines = s.lenses.map((r) => {
    const tag = r.ok
      ? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`
      : (r.parseError ?? "fail");
    const model = r.model ? ` · ${r.model}` : "";
    return `  ${r.lens.padEnd(16)} ${(`${r.ms}ms`).padStart(7)}   ${tag}${model}`;
  });
  const findingLines = s.findings.map(
    (f) =>
      `  [${f.severity}] ${f.lens.padEnd(14)} ${f.path}:${f.line} — ${f.title}\n    ${f.description ?? ""}\n    suggest: ${f.suggestion ?? "(none)"}`,
  );
  const sevSummary = (Object.keys(s.bySeverity) as Severity[])
    .filter((k) => s.bySeverity[k] > 0)
    .map((k) => `${k}=${s.bySeverity[k]}`)
    .join(" ");
  const transcripts = s.lenses
    .filter((r) => r.transcriptPath)
    .map((r) => `  ${r.lens}: ${r.transcriptPath}`)
    .join("\n");
  return [
    `Six-pass code review verdict: ${s.verdict}`,
    `Total findings: ${s.totalFindings}  (${sevSummary || "none"})`,
    "",
    "Per-lens results:",
    ...lensLines,
    "",
    s.totalFindings > 0 ? "Findings (deduped, sorted by severity):" : "",
    ...findingLines,
    "",
    "Transcripts:",
    transcripts,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function registerLensReviewTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dispatch_lens_review",
    label: "Six-pass Code Review",
    description:
      "Fan out the six mandatory code-review lenses (SECURITY, ERROR_HANDLING, TYPE_SAFETY, PERFORMANCE, ARCHITECTURE, SIMPLICITY) in parallel as an async job. Returns a job handle immediately; ONE consolidated verdict + dedup'd findings arrives as a [ensemble:async] user message when all 6 lenses finish. End your turn after dispatching.",
    parameters: Type.Object({
      diff: Type.String({
        description:
          "The full PR diff to review. Fetch once with `gh pr diff <N>` or `git diff main...feature/...` and reuse — do not re-fetch per lens.",
      }),
      context: Type.Optional(
        Type.String({
          description: "1-3 sentence description of what changed and why; passed to every lens.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current." })),
    }),
    async execute(_id, raw) {
      const params = raw as { diff: string; context?: string; cwd?: string };
      const { jobId } = startJob(pi, {
        label: "lens_review",
        role: "lens-review",
        // Orchestrator-only — runLensReview opens one deck entry per lens
        // (6 rows) so the deck shows the real children, not a synthetic
        // umbrella row that masks them.
        skipDeck: true,
        work: async (signal): Promise<DispatchResult> => {
          const start = Date.now();
          const summary = await runLensReview({ ...params, signal });
          return {
            role: "lens-review",
            ok: summary.verdict !== "CRITICAL_ISSUES_FOUND",
            text: renderSummary(summary),
            toolUses: [],
            ms: Date.now() - start,
            exitCode: 0,
          };
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async six-pass lens review; job ${jobId}. Verdict + findings will arrive as a [ensemble:async] user message when all 6 lenses finish. End your turn.`,
          },
        ],
        details: { jobId, role: "lens-review", async: true },
      };
    },
  });
}
