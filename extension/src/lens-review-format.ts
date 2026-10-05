/**
 * Pure formatting/parsing helpers for the code-review lens roster: the lens
 * roster, prompt construction, report_finding parsing, precedence-based
 * dedup, and the human-readable summary renderer. No `ExtensionAPI`
 * coupling — orchestration (spawning, retries, job wiring) lives in
 * lens-review.ts.
 */

import os from "node:os";
import path from "node:path";
import type { Finding, FindingSource, LensRunResult, Severity } from "./lens-review.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

/**
 * The skills dir for the lens review (the installed `code-review-*` skills).
 * Moved here from lens-review.ts for the 500-line gate (AGENTS.md §12).
 */
export function piSkillsDir(): string {
  return process.env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(os.homedir(), ".pi", "agent", "skills");
}

/** Severity type guard. Moved here from lens-review.ts for the 500-line gate. */
export function isSeverity(s: string): s is Severity {
  return s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW";
}

/** The lens review's summary. Moved here from lens-review.ts for the 500-line gate. */
export interface LensReviewSummary {
  verdict: Verdict;
  totalFindings: number;
  bySeverity: Record<Severity, number>;
  lenses: LensRunResult[];
  /** #543 — a dispatch-cap kill (loop / token-budget) hit one of the lens
   * children; the driver emits the fixed-literal cap-hit from this. */
  capKill?: DispatchResult["killCause"];
  /** #543 — the structured trigger evidence for the cap kill, carried
   * from the killed lens's DispatchResult so the driver can persist it
   * on `pipelineState.capEvidence` (F4(j)). */
  capKillEvidence?: { tool: string; count: number } | { budget: number; used: number };
  /** Deduplicated, precedence-ordered list. */
  findings: Finding[];
  /**
   * #534 — raw sum of `usage` across all six lenses, summed as-is with no
   * per-lens dedup (matching the retry-double-count-is-accepted rule the
   * rest of the driver uses). Undefined when every lens was blocked, so
   * the emission site can distinguish "the review spent nothing" from
   * "the review spent zero tokens".
   */
  usage?: DispatchUsage;
  /**
   * #973 — a residual-findings disclosure note, set when the run's verdict is
   * ISSUES_FOUND and the post of the disclosure to the PR/MR failed (fail
   * closed — the merge guard then refuses until the disclosure is posted).
   * Empty/undefined on success; the tool appends it to the summary text.
   */
  note?: string;
  /**
   * #973 — this review ran against a delta (`git diff <since>..<head>`) rather
   * than the full branch diff. `auto` marks the automatic delta base (design
   * decision 6 — `since` defaulted to the latest lens ledger entry's `headSha`)
   * as distinct from an operator-supplied `since`. The findings it produced are
   * findings on the DELTA; a later full review still owns the rest of the branch.
   */
  deltaReview?: { since: string; head: string; auto?: boolean };
  /**
   * #973 — the no-review outcome (decision 4): the delta was empty (nothing
   * changed since the last recorded lens run), so no review ran at all. The
   * verdict is kept as APPROVED (the Verdict union is unchanged — it is not a
   * review outcome) but every consumer MUST branch on this flag: this is NOT
   * an approval. `renderSummary` renders "NO REVIEW — …" (never "APPROVED"),
   * the tool result's `ok`/text says so, and the /work driver's
   * `applyLensVerdict` must not append a `lens-approved` event for it.
   */
  noReview?: boolean;
}

/**
 * The overall verdict of a lens review. #966 — the type lives with
 * `computeVerdict` below; lens-review.ts re-exports it for existing consumers.
 *
 * `APPROVED` — only sub-threshold (or no) findings AND all lenses completed
 * with evidence. `ISSUES_FOUND` — a finding at or above the threshold.
 * `CRITICAL_ISSUES_FOUND` — any CRITICAL finding; it blocks regardless of the
 * threshold. `REVIEW_INCOMPLETE` — at least one lens failed all retry attempts
 * or was aborted without evidence: the review is incomplete and the user/PM
 * must decide whether to retry the whole pass, override, or halt — never
 * silently downgrade a six-pass review to a five-pass one (#3).
 */
export type Verdict = "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND" | "REVIEW_INCOMPLETE";
import { CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE, type RosterEntry } from "./lens-roster.ts";

export const LENS_PREFIX = "code-review-";

export function lensPromptFor(
  lens: RosterEntry,
  diff: string,
  context: string,
  evidence?: string,
  roster: RosterEntry[] = [],
): string {
  // The other-lenses list is derived from the FULL roster — every other
  // lens in the configured roster, including blocked ones (a blocked lens
  // still has a separate reviewer row, so the claim reflects what the
  // review actually runs); the lens's own name is excluded. A seventh lens
  // that is configuration, not code, appears here without a code change.
  const others = roster.filter((e) => e.name !== lens.name).map((e) => e.name.toLowerCase());
  const laneList =
    others.length > 0 ? others.join(" / ") : "the other review lenses (each has its own reviewer)";
  return `You are running the **${lens.name}** review lens.

Scope discipline — only flag issues that belong to **${lens.name}**. Do NOT report findings that belong to other lenses (${laneList} have separate reviewers; trust them with their own lanes).

Context for this PR: ${context || "(no extra context)"}

Diff to review:
\`\`\`diff
${diff}
\`\`\`
${evidence ? `\n${evidence}\n` : ""}
## Your working directory is NOT the branch

Read the supplied content above rather than opening files. Your filesystem is checked out at the **base commit** — the state before this PR — so a file you open yourself shows the code as it was, not as this diff leaves it. Reviewing the diff against a stale file produces contradictions that do not exist. If you need a changed file in full and it is not supplied, say so in your summary instead of guessing.

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

When you have finished all findings, write a short prose summary as your final reply.

After writing your summary, STOP — no further tool calls. Do not re-read files, re-run commands or re-scan the diff; the summary is your terminal output.`;
}

/**
 * Extract findings from the child's tool_use events. Each report_finding
 * invocation becomes one Finding. No text parsing involved — the schema is
 * validated by Pi inside the child process, so malformed calls never reach
 * this code.
 */
export function extractFindings(
  toolUses: unknown[],
  lens: string,
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
 * (roster precedence ascending: the lowest declared value wins). `lens`
 * takes the roster parsed from the skills dir; lenses the roster does not
 * know (e.g. stale findings from an older pass) fall back to 99.
 */
export function dedupeFindings(input: Finding[], lens: RosterEntry[]): Finding[] {
  const precedenceOf = new Map<FindingSource, number>();
  for (const l of lens) {
    if (l.precedence !== undefined) precedenceOf.set(l.name, l.precedence);
  }
  // CLAIM_SCAN outranks every lens on a collision. Its findings are lookups,
  // not judgments — if a lens and the scan land on the same line, the one that
  // can point at a grep result is the one worth keeping. NEGATIVE_INFINITY so
  // it outranks any declared value, whatever the skill authors renumber to.
  precedenceOf.set(CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE);
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

/**
 * Did this lens actually review anything?
 *
 * A lens that reported a finding plainly did. A lens that reported none is
 * only credible if it also wrote the closing summary the prompt asks for.
 * Neither means the child produced nothing at all — wrong model, dropped
 * reporter extension, exhausted context, or a bare "ok" — and that is
 * indistinguishable from a careful review right up until it is treated as one.
 *
 * `blocked` covers the lens that FAILED. This covers the lens that succeeded
 * at saying nothing, which is the harder case because it looks like success.
 */
export function lensProducedEvidence(r: LensRunResult): boolean {
  return hasReviewEvidence(r.findings, r.summary);
}

/**
 * Did a (possibly cap-killed) child produce ANY review evidence — findings
 * or a non-placeholder closing summary. Shared by `lensProducedEvidence`
 * and the cap-kill branch in lens-review-child.ts, so a `(thinking content
 * only - no text output)` placeholder never counts as a summary in either
 * path.
 */
// `collapseEvents` substitutes NO_TEXT_PLACEHOLDER when a child produced only
// thinking blocks. It is a placeholder describing the absence of output, not
// output — counting it as a summary would let the exact silence this guards
// against slip through wearing the right shape.
export function hasReviewEvidence(findings: unknown[], summary?: string): boolean {
  if (findings.length > 0) return true;
  const s = summary?.trim();
  if (!s) return false;
  return s !== NO_TEXT_PLACEHOLDER;
}

/** What `spawn-collapse-events.ts` substitutes for a reply that was all thinking. */
export const NO_TEXT_PLACEHOLDER = "(thinking content only - no text output)";

/**
 * Map (findings × lens completion state) to a single verdict.
 *
 * Precedence (first match wins):
 *   1. REVIEW_INCOMPLETE — at least one lens hit max retries (#3); the
 *      six-pass review degenerated to a five-or-fewer-pass review. Never
 *      silently downgrade — surface explicitly.
 *   2. CRITICAL_ISSUES_FOUND — any CRITICAL finding from any completed lens.
 *   3. ISSUES_FOUND — any finding at or above `threshold` (default MEDIUM).
 *   4. APPROVED — only sub-threshold (or no) findings AND all lenses completed.
 *
 * CRITICAL blocks regardless of `threshold`. A project may decide that MEDIUM
 * findings are advisory; none gets to decide that a CRITICAL one is.
 *
 * lensResults is optional for backwards compat with pure-function tests
 * that only care about finding-driven verdicts. When omitted, blocked
 * lenses can't be detected and the verdict logic falls back to pre-#3
 * behaviour.
 */
export function computeVerdict(
  findings: Finding[],
  lensResults?: LensRunResult[],
  threshold: Severity = DEFAULT_REVIEW_THRESHOLD,
): Verdict {
  if (lensResults?.some((r) => r.blocked)) return "REVIEW_INCOMPLETE";
  // A lens that returned in silence has not reviewed the diff, whatever its
  // exit code said. Six of those used to add up to APPROVED.
  if (lensResults?.some((r) => !lensProducedEvidence(r))) return "REVIEW_INCOMPLETE";
  if (findings.some((f) => f.severity === "CRITICAL")) return "CRITICAL_ISSUES_FOUND";
  // The threshold check: any finding at or above the project's bar.
  const bar = SEVERITY_RANK[threshold];
  if (findings.some((f) => SEVERITY_RANK[f.severity] <= bar)) return "ISSUES_FOUND";
  return "APPROVED";
}

/**
 * How serious a finding must be before it blocks.
 *
 * The lens decides a finding's severity — that is its judgment and this module
 * does not second-guess it. Which severity is serious *enough to stop a merge*
 * is a different question, and it belongs to the project, not to this code.
 * `AGENTS.md §1` in this repo has always said "blocking at MEDIUM severity and
 * above"; until now nothing read that sentence, so it was decorative and a
 * project wanting a different bar had no way to say so.
 *
 * MEDIUM stays the default, so a project that says nothing — or has no
 * AGENTS.md at all — gets exactly today's behaviour. See
 * `work-driver-policy.ts` for how a project loosens it.
 */
export const DEFAULT_REVIEW_THRESHOLD: Severity = "MEDIUM";

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/**
 * #878 — the suffix that names WHY a blocked lens was stopped, read from
 * `killCause` (plus the loop/token-budget evidence threaded alongside it).
 * Returns "" when no killCause is present so the tag/banner stay
 * byte-identical to pre-#878 output for plain crashes (the #327 regression
 * guard). "not retried: self-inflicted cap, #543" attaches only to the two
 * cap kills that break the retry loop in lens-review-child.ts.
 */
function killCauseSuffix(r: LensRunResult): string {
  const cause = r.killCause;
  if (!cause) return "";
  if (cause === "loop") {
    const evidence = r.loopEvidence ? ` — ${r.loopEvidence.tool} ×${r.loopEvidence.count}` : "";
    return ` (killed: loop${evidence}; not retried: self-inflicted cap, #543)`;
  }
  if (cause === "token-budget") {
    const evidence = r.tokenBudget ? ` — ${r.tokenBudget.used}/${r.tokenBudget.budget} tokens` : "";
    return ` (killed: token-budget${evidence}; not retried: self-inflicted cap, #543)`;
  }
  if (cause === "abort") return " (aborted)";
  return ` (killed: ${cause})`;
}

export function renderSummary(s: LensReviewSummary, maxLensAttempts: number): string {
  // #973 — the no-review outcome (decision 4): the delta was empty, so no
  // review ran. This is NOT an approval — the summary must say "NO REVIEW",
  // never "APPROVED" (a no-review outcome looking like an approval is the
  // #384 silent-approval class in a new shape).
  if (s.noReview) {
    return [
      `NO REVIEW — no changes since the last lens review (${s.deltaReview?.since.slice(0, 8)} at ${s.deltaReview?.head.slice(0, 8)}) — nothing to review, no verdict rendered.`,
      "",
      "The branch is unchanged since the last recorded lens run; re-run dispatch_lens_review with `full: true` (or after a new commit) to review the full branch diff.",
    ].join("\n");
  }
  const blockedLenses = s.lenses.filter((r) => r.blocked);
  const retriedLenses = s.lenses.filter((r) => !r.blocked && r.attempts > 1);

  const lensLines = s.lenses.map((r: LensRunResult) => {
    let tag: string;
    if (r.blocked) {
      tag = `BLOCKED after ${r.attempts} attempts — ${r.parseError ?? "fail"}${killCauseSuffix(r)}`;
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
  // #878 — the header wording depends on whether the blocked lenses were
  // stopped by a self-inflicted dispatch cap (loop / token-budget), by a
  // mix of causes, or by none of those (plain failure — byte-identical to
  // pre-#878, so the #327 test keeps passing unchanged).
  const capKilledCauses = new Set<"loop" | "token-budget">(["loop", "token-budget"]);
  const capKilledCount = blockedLenses.filter((r) =>
    r.killCause ? capKilledCauses.has(r.killCause as "loop" | "token-budget") : false,
  ).length;
  const blockedHeader =
    capKilledCount === blockedLenses.length
      ? "was stopped by a self-inflicted cap (not retried)"
      : capKilledCount > 0
        ? "did not complete (see each lens)"
        : `failed all ${maxLensAttempts} attempts`;
  const blockedBanner =
    blockedLenses.length > 0
      ? [
          "",
          `⛔ REVIEW INCOMPLETE: ${blockedLenses.length}/${s.lenses.length} lens(es) ${blockedHeader}:`,
          ...blockedLenses.map(
            (r) => `  - ${r.lens}: ${r.parseError ?? "unknown failure"}${killCauseSuffix(r)}`,
          ),
          "",
          "The verdict above is computed from the lenses that DID complete; the failed lens(es) contributed zero findings — they did not approve, they did not run. Re-dispatch dispatch_lens_review to retry, or override and proceed despite the incomplete review.",
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
    `Code review verdict (${s.lenses.length} lenses): ${s.verdict}`,
    ...(s.deltaReview
      ? [
          `Mode: delta review since ${s.deltaReview.since.slice(0, 8)}${s.deltaReview.auto ? " (automatic — the last recorded lens run)" : ""} — findings below cover only \`git diff ${s.deltaReview.since}..${s.deltaReview.head}\` since the last recorded lens run, not the full branch diff.`,
        ]
      : ["Mode: full review (the whole branch diff)"]),
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
