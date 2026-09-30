import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dispatchDeck from "./dispatch-deck.ts";
import { writeLensLedgerEntry } from "./lens-ledger.ts";
import { capKillSummary } from "./lens-review-capkill.ts";
import { runLensChild } from "./lens-review-child.ts";
import {
  blockedReviewSummary,
  blockedRowsForRoster,
  resolveLensDiff,
  startPersistentBatch,
} from "./lens-review-diff.ts";
import {
  LENS_PREFIX,
  bySeverityCounts,
  dedupeFindings,
  renderSummary,
} from "./lens-review-format.ts";
import { runInstallBlock, skillsDirUsable } from "./lens-review-skills.ts";
import { CLAIM_SCAN, type RosterEntry, buildExpectedRoster } from "./lens-roster.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Six-pass code review — fan out to one `code-review-specialist` child per
 * lens, each pinned to its lens-specific skill. Synthesise findings via
 * (path, line, title) dedup + precedence merging, then map worst severity to
 * an overall verdict.
 *
 * Mirrors the Step 7 contract of the opencode `/work` command. Lens roster,
 * prompt construction, parsing, and rendering live in lens-review-format.ts;
 * this module owns spawning, retries, and the async-job/tool wiring.
 */

export { CLAIM_SCAN, LENS_PREFIX, dedupeFindings, renderSummary };
import { extractFindings } from "./lens-review-format.ts";
export { extractFindings };
import { aggregateLensUsage } from "./lens-review-usage.ts";
export type LensName = string; // deliberately unbounded — the roster is data-driven from SKILL.md frontmatter (#873)
/** One roster entry — the shape a lens child receives per dispatch (#873:
 * the roster is data, so `LensDef` is the parsed entry type). */
export type LensDef = RosterEntry;
export const LENS_REPORTER_PATH = path.join(__dirname, "lens-reporter.ts");

/**
 * #612 — the diff parameter's description, forge-agnostic on purpose.
 * The pre-#612 text told the operator `gh pr diff <N>`, which is GitHub
 * only (on GitLab the same operation is `glab mr diff <N>`). The driver
 * assembles the diff itself and passes it in, so the instruction to the
 * operator is to fetch it ONCE (however their forge spells it) and reuse.
 * Exported so the wording is assertable offline (the tool registration is
 * the only place it lives, and no test reached it before).
 * #859 — the description text itself now appends the base+head ref-range
 * alternative (see LENS_REVIEW_DIFF_DESCRIPTION).
 */
export const LENS_REVIEW_DIFF_DESCRIPTION =
  "The full PR/MR diff to review. Fetch it once (e.g. `gh pr diff <N>` or `glab mr diff <N>`) or `git diff main...feature/...` and reuse — do NOT re-fetch per lens. For large diffs, prefer the optional base + head refs (with cwd) so the tool computes `git diff <base>...<head>` itself; when both are given, the string wins.";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Verdict =
  | "APPROVED"
  | "ISSUES_FOUND"
  | "CRITICAL_ISSUES_FOUND"
  /** At least one lens failed all retry attempts — the review is incomplete
   * and the user/PM must decide whether to retry the whole pass, override,
   * or halt. Never silently downgrade a six-pass review to a five-pass one (#3). */
  | "REVIEW_INCOMPLETE";

/** Max attempts per lens — 1 initial + 3 retries on spawn failure or non-zero
 * exit. Matches the opencode contract. Aborted lenses (user cancel) don't
 * retry. */
const MAX_LENS_ATTEMPTS = 4;
export { MAX_LENS_ATTEMPTS };

/** Backoff between retries (ms). Small fixed delay — these failures are
 * usually transient (process spawn pressure, provider-side rate limits). */
const LENS_RETRY_BACKOFF_MS = 1000;

export interface RawFinding {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
  suggestion?: string;
}

/**
 * Where a finding came from. Not every finding comes from a lens: `CLAIM_SCAN`
 * is deterministic and model-free (see `claim-scan.ts`). Labelling its output
 * as a lens's would be a false attribution in the operator's summary — the
 * exact defect class this scan exists to catch.
 */
export type FindingSource = LensName | "CLAIM_SCAN";

export interface Finding extends RawFinding {
  severity: Severity;
  lens: FindingSource;
}

export interface LensRunResult {
  lens: LensName;
  ok: boolean;
  ms: number;
  /**
   * #456 — wall-clock when this lens's dispatch began. Persisted via
   * `dispatch-completed.lensTimings`; sequential startMs across a pass are
   * the fingerprint of spawn-semaphore queueing (cap 1), distinct from a
   * slow-by-contamination pass.
   */
  startMs: number;
  findings: Finding[];
  model?: string;
  transcriptPath?: string;
  /** #543 — the dispatch-cap kill cause when the lens child was cap-killed
   * (loop detector / token budget). A cap-killed lens is NOT retried: an
   * SIGTERM'd looped child is a non-zero exit, and without this guard the
   * retry below would undo the kill up to MAX_LENS_ATTEMPTS times. */
  killCause?: DispatchResult["killCause"];
  /** #543 — the F1 streak evidence at a loop kill, threaded so the
   * driver's capEvidence write has the tool + count to render. */
  loopEvidence?: { tool: string; count: number };
  /** #543 — the F6 budget + used tokens at a token-budget kill, threaded
   * for the same reason. */
  tokenBudget?: { budget: number; used: number };
  /** Set when the child failed to spawn or returned non-zero. */
  parseError?: string;
  /** Number of spawn attempts made for this lens (1 = no retries; up to
   * MAX_LENS_ATTEMPTS on transient failures). #3. */
  attempts: number;
  /** True when ALL attempts failed — the lens contributes no findings and
   * the overall verdict is REVIEW_INCOMPLETE. #3. */
  blocked: boolean;
  /**
   * The child's closing prose. The lens prompt asks for it explicitly, and it
   * is the only evidence that a lens which reported no findings actually
   * looked — see `lensProducedEvidence`.
   */
  summary?: string;
  /**
   * #534 — the child's tokens/cost. Previously discarded (the per-lens
   * `result.usage` was dropped here); carried so the driver can fold the
   * six-lens pass's spend into the cycle total at the emission point.
   */
  usage?: DispatchUsage;
}

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
}

function piSkillsDir(): string {
  return process.env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(os.homedir(), ".pi", "agent", "skills");
}

/** The ONE exit path: writes the ledger entry and returns the summary. */
function finish(
  summary: LensReviewSummary,
  threshold: Severity,
  cwd: string | undefined,
  branch: string | undefined,
): LensReviewSummary {
  void writeLensLedgerEntry(summary.verdict, threshold, cwd, branch);
  return summary;
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
  if (r.findings.length > 0) return true;
  const summary = r.summary?.trim();
  if (!summary) return false;
  // `collapseEvents` substitutes this literal when a child produced only
  // thinking blocks. It is a placeholder describing the absence of output, not
  // output — counting it as a summary would let the exact silence this guards
  // against slip through wearing the right shape.
  return summary !== NO_TEXT_PLACEHOLDER;
}

/** What `spawn-collapse-events.ts` substitutes for a reply that was all thinking. */
const NO_TEXT_PLACEHOLDER = "(thinking content only - no text output)";

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

export function isSeverity(s: string): s is Severity {
  return s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW";
}

export async function runLensReview(opts: {
  diff?: string;
  context?: string;
  cwd?: string;
  /** #859 — base ref for the tool-computed `git diff <base>...<head>` (with head). */
  base?: string;
  /** #859 — head ref for the tool-computed diff (with base). */
  head?: string;
  signal?: AbortSignal;
  /**
   * Post-change content of files the diff touches, rendered for the prompt.
   * Supplied by the caller because only it knows the branch ref; see
   * `readFileAtBranch`.
   */
  evidence?: string;
  /**
   * Deterministic findings produced without a model — currently `claim-scan`.
   * They join the lens findings before dedup and verdict, so they reach both
   * `/work` and `/review` through this one path.
   */
  extraFindings?: Finding[];
  /** #799 — the parent pi for the inner children's slow-run watch (the PM
   * notice half; the watch site has no pi of its own). */
  pi?: Pick<import("@earendil-works/pi-coding-agent").ExtensionAPI, "sendUserMessage">;
  /** Blocking bar; defaults to MEDIUM. See `DEFAULT_REVIEW_THRESHOLD`. */
  threshold?: Severity;
  /**
   * #912 — caller-supplied branch for the review-ledger write (the driver
   * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
   * recover it). When absent the writer recovers the branch from `HEAD`
   * and skips (traces) on a detached head.
   */
  branch?: string;
}): Promise<LensReviewSummary> {
  const runId = makeRunId();
  const skillsDir = piSkillsDir();
  const context = opts.context ?? "";
  // The RESOLVED threshold (computed once; both the verdict and the ledger
  // write apply the same bar).
  const threshold = opts.threshold ?? DEFAULT_REVIEW_THRESHOLD;
  // #873 — the roster is data: the INSTALLED skills dir's `code-review-*`
  // SKILL.md files (precedence in frontmatter), PLUS a blocked entry for
  // every expected lens (the BUNDLED skill/ dir) that is absent from the
  // installed dir or has a dangling skill — a lens must never silently
  // disappear from a six-pass review (five lenses + APPROVED). Blocked
  // entries (missing/duplicate precedence, unparseable SKILL.md, `name:` ≠
  // dir, skill not installed) become blocked lens results below →
  // REVIEW_INCOMPLETE; the review never runs a silently reduced or reordered
  // roster.
  const roster = buildExpectedRoster(skillsDir);
  // #859 — ref-range diffs: when `diff` is absent and base+head are present,
  // the diff is computed ONCE and fed to every lens. An error (invalid ref,
  // confirmed-empty range, cap overflow, nothing supplied) blocks the whole
  // review — a computed diff is never silently empty, never an approval
  // (same rule as #384). Blocked rows use the EXPECTED roster above.
  const resolution = await resolveLensDiff(opts);
  if (resolution.problem) {
    const blockRows = blockedRowsForRoster(roster, resolution.problem);
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    return finish(blocked, threshold, opts.cwd, opts.branch);
  }
  const diff = resolution.diff ?? "";
  if (skillsDirUsable(skillsDir) !== undefined) {
    // #872 — ONE skills-dir check before the fan-out (not per-lens checks):
    // a missing, empty, or no-`code-review-*`-skill dir blocks ALL lenses
    // with a single install message and no spawn is ever called. The roster
    // is empty exactly in those cases, so the two are one check now (#873
    // moved the "any lens skill present" test onto the parsed roster).
    // SINGLE EXIT PATH (item 5): the early return is the same `finish(...)`
    // (the deck bookkeeping lives in `runInstallBlock`, moved to
    // lens-review-skills.ts for the 500-line cap).
    const { lensResults, findings } = runInstallBlock(
      runId,
      skillsDirUsable(skillsDir) ?? `skills dir ${skillsDir} missing or empty — run ./install.sh`,
      opts.extraFindings ?? [],
    );
    const deduped = dedupeFindings(findings, []);
    return finish(
      {
        verdict: computeVerdict(deduped, lensResults, threshold),
        totalFindings: deduped.length,
        bySeverity: bySeverityCounts(deduped),
        lenses: lensResults,
        findings: deduped,
        usage: undefined,
      },
      threshold,
      opts.cwd,
      opts.branch,
    );
  }
  // Persistent batch summary row (#139). Lets the user see "X/6 done"
  // throughout the run even as fast lenses drop out at 0s linger. Registered
  // BEFORE the per-lens entries so its seq sorts first on Pi's footer.
  const { batchKey, bumpBatch } = startPersistentBatch(runId, roster.length);
  // #873 — blocked roster entries become blocked lens results (no spawn,
  // the named error as parseError) and feed REVIEW_INCOMPLETE via
  // computeVerdict; healthy entries fan out as before.
  const blocked = roster.filter((e) => e.error !== undefined);
  const healthy = roster.filter((e) => e.error === undefined);
  const blockedResults: LensRunResult[] = blocked.map((e) => ({
    lens: e.name,
    ok: false,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    attempts: 0,
    blocked: true,
    parseError: e.error,
  }));
  const promises = healthy.map((lens) =>
    runLensChild({
      lens,
      runId,
      skillsDir,
      context,
      roster,
      opts: { ...opts, diff: diff ?? "" },
      bumpBatch,
      ...(opts.pi ? { pi: opts.pi } : {}),
    }),
  );
  const lensResults = [...(await Promise.all(promises)), ...blockedResults];
  dispatchDeck.clearBatchEntry(batchKey);
  // Deterministic findings are merged BEFORE dedup and verdict so they are
  // indistinguishable downstream from a lens's own — same precedence rules,
  // same threshold, same rendering. They are findings, not a side channel.
  const all = [...lensResults.flatMap((r) => r.findings), ...(opts.extraFindings ?? [])];
  const deduped = dedupeFindings(all, roster);
  const verdict = computeVerdict(deduped, lensResults, threshold);
  return finish(
    {
      verdict,
      totalFindings: deduped.length,
      bySeverity: bySeverityCounts(deduped),
      lenses: lensResults,
      findings: deduped,
      usage: aggregateLensUsage(lensResults),
      // #543 — a dispatch-cap kill on any lens child (loop detector / token
      // budget) is surfaced on the summary so the driver emits the fixed-literal
      // cap-hit (F4g) instead of a silent 1-of-6 loss.
      ...capKillSummary(lensResults),
    },
    threshold,
    opts.cwd,
    opts.branch,
  );
}

