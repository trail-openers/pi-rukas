import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import { runLensChild } from "./lens-review-child.ts";
import {
  LENSES,
  type LensName,
  bySeverityCounts,
  dedupeFindings,
  extractFindings,
  lensPromptFor,
  renderSummary,
} from "./lens-review-format.ts";
import { makeRunId } from "./spawn.ts";
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

export { LENSES, extractFindings, dedupeFindings, renderSummary };
export type { LensName };
export type LensDef = (typeof LENSES)[number];
export const LENS_REPORTER_PATH = path.join(__dirname, "lens-reporter.ts");

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
  diff: string;
  context?: string;
  cwd?: string;
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
  /** Blocking bar; defaults to MEDIUM. See `DEFAULT_REVIEW_THRESHOLD`. */
  threshold?: Severity;
}): Promise<LensReviewSummary> {
  const runId = makeRunId();
  const skillsDir = piSkillsDir();
  const context = opts.context ?? "";

  // Persistent batch summary row (#139). Lets the user see "X/6 done"
  // throughout the run even as fast lenses drop out at 0s linger. Registered
  // BEFORE the per-lens entries so its seq sorts first on Pi's footer.
  const batchKey = `${runId}/batch`;
  dispatchDeck.startBatchEntry(batchKey, {
    label: `code-review-specialist×${LENSES.length}`,
    size: LENSES.length,
  });
  let completedLenses = 0;
  const bumpBatch = () => {
    completedLenses += 1;
    dispatchDeck.updateBatchProgress(batchKey, completedLenses);
  };

  const promises = LENSES.map((lens) =>
    runLensChild({ lens, runId, skillsDir, context, opts, bumpBatch }),
  );

  const lensResults = await Promise.all(promises);
  dispatchDeck.clearBatchEntry(batchKey);
  // Deterministic findings are merged BEFORE dedup and verdict so they are
  // indistinguishable downstream from a lens's own — same precedence rules,
  // same threshold, same rendering. They are findings, not a side channel.
  const all = [...lensResults.flatMap((r) => r.findings), ...(opts.extraFindings ?? [])];
  const deduped = dedupeFindings(all);
  const verdict = computeVerdict(deduped, lensResults, opts.threshold);
  // #534 — raw sum across lenses (no dedup, matching the retry rule).
  // `turns` is not meaningful at the aggregate level; keep it as the sum
  // of the parts' turns since the cycle total is what gets rendered and
  // no consumer interprets the aggregate's turn count.
  const usageUsages = lensResults
    .map((r) => r.usage)
    .filter((u): u is DispatchUsage => u !== undefined);
  const usage =
    usageUsages.length > 0
      ? usageUsages.reduce(
          (acc, u) => ({
            input: acc.input + u.input,
            output: acc.output + u.output,
            cacheRead: acc.cacheRead + u.cacheRead,
            cacheWrite: acc.cacheWrite + u.cacheWrite,
            cost: acc.cost + u.cost,
            turns: acc.turns + u.turns,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        )
      : undefined;
  // #543 — a dispatch-cap kill on any lens child (loop detector / token
  // budget) is surfaced on the summary so the driver emits the fixed-literal
  // cap-hit (F4g) instead of a silent 1-of-6 loss.
  const capKill = capKillSummary(lensResults);
  return {
    verdict,
    totalFindings: deduped.length,
    bySeverity: bySeverityCounts(deduped),
    lenses: lensResults,
    findings: deduped,
    usage,
    ...capKill,
  };
}

/**
 * #543 — the cap-kill tail of the lens summary: which lens child was
 * killed (loop / token-budget) and its structured trigger evidence, so
 * the driver can persist `capEvidence`. Split from runLensReview
 * (AGENTS.md §12 file-size limit).
 */
function capKillSummary(
  lensResults: LensRunResult[],
): Pick<LensReviewSummary, "capKill" | "capKillEvidence"> {
  const capKillLens = lensResults.find(
    (r) => r.killCause === "loop" || r.killCause === "token-budget",
  );
  const capKill = capKillLens?.killCause;
  const capKillEvidence =
    capKillLens?.killCause === "loop" && capKillLens.loopEvidence
      ? capKillLens.loopEvidence
      : capKillLens?.killCause === "token-budget" && capKillLens.tokenBudget
        ? capKillLens.tokenBudget
        : undefined;
  return {
    ...(capKill ? { capKill } : {}),
    ...(capKillEvidence ? { capKillEvidence } : {}),
  };
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
          "The full PR diff to review. Fetch once with `gh pr diff <N>` or `git diff main...feature/...` and reuse — do NOT re-fetch per lens.",
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
          // ok is true when the review completed AND the verdict is neither
          // CRITICAL nor INCOMPLETE. INCOMPLETE means at least one lens
          // failed all retries (#3) — the review did NOT actually run six
          // passes, so PM/user must decide whether to retry or override.
          return {
            role: "lens-review",
            ok:
              summary.verdict !== "CRITICAL_ISSUES_FOUND" &&
              summary.verdict !== "REVIEW_INCOMPLETE",
            text: renderSummary(summary, MAX_LENS_ATTEMPTS),
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
