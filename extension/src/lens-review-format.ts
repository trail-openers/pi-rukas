/**
 * Pure helpers for the code-review lens roster: the lens roster, prompt
 * construction, report_finding parsing, precedence-based dedup, the verdict
 * rule, the severity type, and the `LensReviewSummary` shape. No `ExtensionAPI`
 * coupling — orchestration (spawning, retries, job wiring) lives in
 * lens-review.ts, and the one function that turns a finished summary into the
 * text an operator reads lives in lens-review-render.ts (#1125 split): this
 * module declares what a summary CONTAINS, the render module decides how it
 * reads. AGENTS.md §12's file-size gate is why the two are separate files, not
 * why they are separate concerns — the seam is data versus presentation.
 */

import os from "node:os";
import path from "node:path";
import type { SuppressedFinding } from "./lens-residuals.ts";
import { isReviewIncomplete } from "./lens-review-incomplete.ts";
import type { Finding, FindingSource, LensRunResult } from "./lens-review-types.ts";
import { CLAIM_SCAN, CLAIM_SCAN_PRECEDENCE, type RosterEntry } from "./lens-roster.ts";
import type { ResolvedNotice, SetAsideNotice } from "./review-findings-file.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

/** The finding's severity level. Owned here (the pure leaf both the format
 * module and the lens-review module use), so the `lens-review-format.ts →
 * lens-review.ts` import no longer carries it (#980 — the cycle was left
 * type-only but the split that broke it is real now). */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/**
 * The one description line a finding renders with (#1130): never empty.
 *
 * A carried row is re-reported to the operator VERBATIM from the stored row, so
 * a row whose lens never filled `description` printed a blank line under its own
 * heading — the #1130 round-3 report that showed five open findings with nothing
 * to read. Rows recorded from now on store the prose; this is the fallback for a
 * row that has none, and it invents no claim: it names the evidence that does
 * exist (the file, the line and the row) and says the description was never
 * recorded.
 */
export function findingDescription(f: Finding): string {
  const text = f.description?.trim();
  if (text) return text;
  return `(no description was recorded for this finding — row ${f.path}:${f.line ?? "?"})`;
}

/**
 * The skills dir for the lens review (the installed `code-review-*` skills).
 * Moved here from lens-review.ts for the 500-line gate (AGENTS.md §12).
 */
export function piSkillsDir(): string {
  return process.env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(os.homedir(), ".pi", "agent", "skills");
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
  deltaReview?: { since: string; head: string; auto?: boolean; fallback?: string };
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
  /**
   * #1176 "carried" no-review outcome: the delta was empty and the branch's
   * patch-id was unchanged, so the recorded verdict (`verdict`, `round`) was
   * carried onto the head. `renderSummary` says so; it is still `noReview`.
   */
  carriedFrom?: { sha: string; verdict: Verdict; round: number };
  /**
   * #1105 — findings the round dropped as already known: `suppressed-unchanged`
   * (a delta round, cited code untouched) or `suppressed-accepted` (an operator
   * accepted it). They are not in `findings` and do not decide the verdict; the
   * residual disclosure lists them with their row ids and reasons.
   */
  suppressed?: SuppressedFinding[];
  /**
   * #1105 "findings memory unavailable: <reason>" — the round could not be
   * recorded (fail open: every finding is reported). Shown in the summary and
   * the residual comment.
   */
  memoryNote?: string;
  /** #1125 — rows this round resolved because their cited code is gone, with the reason. */
  resolved?: ResolvedNotice[];
  /**
   * #1125 — rows this round set aside: a malformed row, or an operator acceptance
   * that lapsed because its cited code changed. Either way a suppression is gone,
   * so the summary and the residual disclosure name the row rather than leaving
   * its return to look like a new finding.
   */
  setAside?: SetAsideNotice[];
  /** #1140 (#1125, at LINE level) — reported findings whose cited code is outside
   * the PR's changed lines: listed under the advisory heading, never counted
   * toward the verdict, `bySeverity` or the ledger's `hasCritical`. */
  advisory?: Finding[];
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
 *
 * #1127 — `ROUND_CAP_REACHED` and `REVIEW_INCOMPLETE_STREAK` are produced only
 * by the tool-side round budget (lens-round-cap.ts): no lens ran, nothing was
 * recorded. The streak refusal is distinct so an operator can tell a stalled
 * infrastructure outage from a spent round budget.
 */
export type Verdict =
  | "APPROVED"
  | "ISSUES_FOUND"
  | "CRITICAL_ISSUES_FOUND"
  | "REVIEW_INCOMPLETE"
  | "ROUND_CAP_REACHED"
  | "REVIEW_INCOMPLETE_STREAK";

export const LENS_PREFIX = "code-review-";

/** Characters that end a markdown code fence or an angle-bracket tag, and so
 * end the skill path's backticks and start being prompt text instead of a
 * path. `lensPromptFor` omits its read instruction rather than interpolating
 * a path carrying any of them (see the call site). */
const UNSAFE_PATH_CHARS = /[\n`<>]/;

/** True when `skillPath` is safe to interpolate into the lens prompt.
 *
 * Module-private: the ONLY decision this guards is `lensPromptFor`'s own
 * interpolation, and an exported predicate invites a caller to reuse it as
 * though "safe to interpolate" meant "safe to open" — it does not.
 */
function isPromptSafePath(skillPath: string): boolean {
  return !UNSAFE_PATH_CHARS.test(skillPath);
}

export function lensPromptFor(
  lens: RosterEntry,
  diff: string,
  context: string,
  evidence?: string,
  roster: RosterEntry[] = [],
  prior = "",
  skillPath?: string,
): string {
  // The other-lenses list is derived from the FULL roster — every other
  // lens in the configured roster, including blocked ones (a blocked lens
  // still has a separate reviewer row, so the claim reflects what the
  // review actually runs); the lens's own name is excluded. A seventh lens
  // that is configuration, not code, appears here without a code change.
  const others = roster.filter((e) => e.name !== lens.name).map((e) => e.name.toLowerCase());
  const laneList =
    others.length > 0 ? others.join(" / ") : "the other review lenses (each has its own reviewer)";
  // #995 — the skill file is advertised by Pi's --skill flag but NOT inlined
  // into the child's context; the child must explicitly `read` it. When
  // skillPath is provided (the production path in lens-review-child.ts), the
  // prompt carries an absolute-path instruction and the #882 Skill Load
  // Status semantics (SUCCESS = read returned content, FAILED = read
  // failed). When absent (pure-function tests) the section is omitted so
  // the prompt stays byte-identical to pre-#995 output.
  //
  // PR #1530 lens finding (LOW) — the path lands inside backticks in a
  // prompt that is about to be read by a model, so a path carrying a newline
  // or a backtick/angle-bracket escapes its fence and becomes prompt text.
  // Production builds it from `path.join(skillsDir, lens.skill)` and the
  // roster's skill-name check, so this is a wall rather than a live bug; the
  // wall is to omit the section and trace, never to interpolate it anyway.
  const unsafe = skillPath !== undefined && skillPath !== "" && !isPromptSafePath(skillPath);
  if (unsafe) {
    // The rejected value is deliberately NOT echoed. It is untrusted text that
    // already proved it can carry fence-breaking characters, and a trace line
    // is a transport for exactly those characters — the newline it rejected
    // would split the log entry, and a path carrying a crafted `\x1b[` would
    // write terminal escapes into the operator's stderr. The shape of the
    // rejection is the actionable part; the content is not.
    trace(
      `lens prompt: skillPath rejected (contains newline, backtick, '<' or '>') — read instruction omitted`,
    );
  }
  const skillInstruction =
    skillPath && !unsafe
      ? `
Before you begin reviewing, use the \`read\` tool to load your assigned skill file:

  \`${skillPath}\`

The skill file is NOT inlined in your context — you must read it explicitly. If the read succeeds (you see the skill's content), set \`Skill Load Status: SUCCESS\` in your final reply. If the read fails for any reason (file not found, permission error), set \`Skill Load Status: FAILED\` in your final reply and do NOT proceed with the review — a blocked lens is better than an unguided one.
`
      : "";
  return `You are running the **${lens.name}** review lens.${skillInstruction}
Scope discipline — only flag issues that belong to **${lens.name}**. Do NOT report findings that belong to other lenses (${laneList} have separate reviewers; trust them with their own lanes).

Context for this PR: ${context || "(no extra context)"}

Diff to review:
\`\`\`diff
${diff}
\`\`\`
${evidence ? `\n${evidence}\n` : ""}${prior ? `\n${prior}\n` : ""}
## Your working directory is NOT the branch

Read the supplied content above rather than opening files. Your filesystem is checked out at the **base commit** — the state before this PR — so a file you open yourself shows the code as it was, not as this diff leaves it. Reviewing the diff against a stale file produces contradictions that do not exist. If you need a changed file in full and it is not supplied, say so in your summary instead of guessing.

## How to report findings

For every issue you identify in your lane, call the \`report_finding\` tool ONCE with these fields:
  - severity (required): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  - path (required): file path relative to repo root
  - line: line number (omit for file-level findings)
  - title (required): short title (< 80 chars)
  - description: 1–3 sentence description of the issue
  - suggestion: short suggested fix

A call missing any required field is rejected and records nothing — repeat it with every field, not only the one the error names.

Do NOT batch multiple findings into a single call — one tool call per finding. Do NOT emit findings as JSON in your prose; only the \`report_finding\` tool calls count.

If you find nothing in your lane: do not call the tool. Conclude with a one-sentence summary explaining why the diff is clean from a ${lens.name} perspective.

When you have finished all findings, write a short prose summary as your final reply.

After writing your summary, STOP — no further tool calls. Do not re-read files, re-run commands or re-scan the diff; the summary is your terminal output.`;
}

/**
 * Deduplicate findings by (normalised path, line, lowercased title). When
 * duplicates exist across lenses, keep the one from the highest-priority lens
 * (roster precedence ascending: the lowest declared value wins). `lens`
 * takes the roster parsed from the skills dir; lenses the roster does not
 * know (e.g. stale findings from an older pass) fall back to 99.
 */
export function dedupeFindings(input: Finding[], lens: RosterEntry[]): Finding[] {
  // Deterministic under the advisory split (#1125): `bestByKey` is a Map, so
  // without this sort the emitted order is the input order — which is the lens
  // fan-in's completion order plus the store's row order, neither of them
  // stable. The summary, the residual disclosure and every test that reads
  // "the" reported finding then depend on which of two findings that dedup into
  // one row survived. Sort first, so the SAME finding survives and is listed
  // first whatever the input order.
  const ordered = [...input].sort(sortFindings);
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
  for (const f of ordered) {
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
  // A lens that returned in silence has not reviewed the diff, whatever its
  // exit code said. Six of those used to add up to APPROVED.
  // A blocked lens, or one that returned in silence, has not reviewed the diff
  // whatever its exit code said — the one rule lives in isReviewIncomplete.
  if (isReviewIncomplete(lensResults)) return "REVIEW_INCOMPLETE";
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
