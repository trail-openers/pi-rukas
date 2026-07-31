/**
 * Pure formatting/parsing helpers for the six-pass lens review: the lens
 * roster, prompt construction, report_finding parsing, precedence-based
 * dedup, and the human-readable summary renderer. No `ExtensionAPI`
 * coupling — orchestration (spawning, retries, job wiring) lives in
 * lens-review.ts.
 */

import type { Finding, LensReviewSummary, LensRunResult, Severity } from "./lens-review.ts";

export const LENSES = [
  { name: "SECURITY", skill: "code-review-security", precedence: 0 },
  { name: "ERROR_HANDLING", skill: "code-review-error-handling", precedence: 1 },
  { name: "TYPE_SAFETY", skill: "code-review-type-safety", precedence: 2 },
  { name: "PERFORMANCE", skill: "code-review-performance", precedence: 3 },
  { name: "ARCHITECTURE", skill: "code-review-architecture", precedence: 4 },
  { name: "SIMPLICITY", skill: "code-review-simplicity", precedence: 5 },
] as const;

export type LensName = (typeof LENSES)[number]["name"];

export function lensPromptFor(
  lens: (typeof LENSES)[number],
  diff: string,
  context: string,
): string {
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
  // `bestByKey` is bounded by the lens fan-in (≤6 children × finite findings
  // per pass) — at most a few hundred entries per invocation, and the whole
  // map goes out of scope when this function returns. No explicit cap needed.
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

export function bySeverityCounts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export function renderSummary(s: LensReviewSummary, maxLensAttempts: number): string {
  const blockedLenses = s.lenses.filter((r) => r.blocked);
  const retriedLenses = s.lenses.filter((r) => !r.blocked && r.attempts > 1);

  const lensLines = s.lenses.map((r: LensRunResult) => {
    let tag: string;
    if (r.blocked) {
      tag = `BLOCKED after ${r.attempts} attempts — ${r.parseError ?? "fail"}`;
    } else if (r.ok) {
      const findingCount = `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`;
      const retryNote =
        r.attempts > 1 ? ` (succeeded on attempt ${r.attempts}/${maxLensAttempts})` : "";
      tag = `${findingCount}${retryNote}`;
    } else {
      tag = r.parseError ?? "fail";
    }
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

  // Blocked-lens banner — prominent because verdict=REVIEW_INCOMPLETE means
  // the six-pass review did NOT actually complete six lenses. PM/user MUST
  // decide whether to retry, override, or halt; never silently downgrade (#3).
  const blockedBanner =
    blockedLenses.length > 0
      ? [
          "",
          `⛔ REVIEW INCOMPLETE: ${blockedLenses.length}/${s.lenses.length} lens(es) failed all ${maxLensAttempts} attempts:`,
          ...blockedLenses.map((r) => `  - ${r.lens}: ${r.parseError ?? "unknown failure"}`),
          "",
          "The verdict above is computed from the lenses that DID complete; the failed lens(es) contributed zero findings — they did not approve, they did not run. Re-dispatch dispatch_lens_review to retry, or surface this to the user for an override decision per AGENTS.md Step 7 doctrine.",
        ]
      : [];

  const retryNote =
    retriedLenses.length > 0
      ? [
          "",
          `ℹ Retry note: ${retriedLenses.length} lens(es) needed retries but eventually succeeded — ${retriedLenses
            .map((r) => `${r.lens}(×${r.attempts})`)
            .join(", ")}.`,
        ]
      : [];

  return [
    `Six-pass code review verdict: ${s.verdict}`,
    `Total findings: ${s.totalFindings}  (${sevSummary || "none"})`,
    ...blockedBanner,
    ...retryNote,
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
