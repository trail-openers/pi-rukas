import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import {
  LENSES,
  type LensName,
  bySeverityCounts,
  dedupeFindings,
  extractFindings,
  lensPromptFor,
  renderSummary,
} from "./lens-review-format.ts";
import { makeRunId, spawnSpecialist } from "./spawn.ts";
import type { DispatchResult } from "./types.ts";
import { jitteredMs } from "./work-driver-failure-taxonomy.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LENS_REPORTER_PATH = path.join(__dirname, "lens-reporter.ts");

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
  findings: Finding[];
  model?: string;
  transcriptPath?: string;
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

  const promises = LENSES.map(async (lens): Promise<LensRunResult> => {
    const skillPath = path.join(skillsDir, lens.skill);
    const prompt = lensPromptFor(lens, opts.diff, context, opts.evidence);
    const tag = lens.name.toLowerCase().replaceAll("_", "-");
    // Per-lens deck key. The dispatch deck (#117) is now the single live
    // surface — there used to be a parallel onUpdate callback rendering an
    // inline tool block, but the deck displays the same data so the inline
    // path was duplicative (#119).
    const deckKey = `${runId}/${tag}`;
    dispatchDeck.startEntry(deckKey, {
      label: `code-review-specialist[${tag}]`,
      role: "code-review-specialist",
      tag,
      batchKey,
    });

    // Retry loop (#3). Up to MAX_LENS_ATTEMPTS attempts on transient
    // failure (spawn error OR non-zero exit). User abort (opts.signal)
    // breaks out immediately — that's the operator saying stop, not a
    // transient failure. Backoff between retries gives the provider /
    // local process spawner room to recover.
    let attempts = 0;
    let result: DispatchResult | undefined;
    let lastError: string | undefined;
    while (attempts < MAX_LENS_ATTEMPTS) {
      attempts++;
      if (opts.signal?.aborted) {
        lastError = "aborted by user";
        break;
      }
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
            // No timeoutMs override — inherits per-role default from
            // spawn.ts:roleTimeoutMs(spec.role). For code-review-specialist
            // that's 15 min (PR5 — was a 30 min global pre-PR5).
            signal: opts.signal,
            onProgress: (state) => dispatchDeck.updateEntry(deckKey, state),
          },
        );
        if (result.ok) {
          lastError = undefined;
          break; // success
        }
        lastError = `attempt ${attempts}/${MAX_LENS_ATTEMPTS}: exit ${result.exitCode ?? "?"}`;
      } catch (err) {
        lastError = `attempt ${attempts}/${MAX_LENS_ATTEMPTS}: spawn failed: ${(err as Error).message}`;
      }
      // Backoff before next retry (skipped on last attempt to keep total
      // wall-clock bounded).
      if (attempts < MAX_LENS_ATTEMPTS) {
        // Jittered, not flat. Six lenses fail in lockstep whenever the cause
        // is a provider blip — which is the common case — so a fixed delay
        // retries all six at the same instant, i.e. a self-inflicted
        // thundering herd against the endpoint that just rate-limited us.
        // Reuses the driver's canonical jitter (#366) rather than adding a
        // second formula.
        await new Promise((r) => setTimeout(r, jitteredMs(LENS_RETRY_BACKOFF_MS)));
      }
    }

    dispatchDeck.clearEntry(deckKey);
    bumpBatch();

    // All attempts failed (or user aborted) — lens is blocked, no findings.
    if (!result || !result.ok) {
      return {
        lens: lens.name,
        ok: false,
        ms: result?.ms ?? 0,
        findings: [],
        attempts,
        blocked: true,
        parseError: lastError ?? "unknown failure",
      };
    }

    const { findings, skipped } = extractFindings(result.toolUses, lens.name);
    return {
      lens: lens.name,
      ok: result.ok,
      ms: result.ms,
      findings,
      attempts,
      blocked: false,
      // The prompt asks for a closing summary. Keeping it is what lets a
      // silent lens be told apart from a clean one.
      summary: result.text?.trim() || undefined,
      model: result.model,
      transcriptPath: result.transcriptPath,
      parseError: skipped > 0 ? `${skipped} malformed report_finding call(s) skipped` : undefined,
    };
  });

  const lensResults = await Promise.all(promises);
  dispatchDeck.clearBatchEntry(batchKey);
  // Deterministic findings are merged BEFORE dedup and verdict so they are
  // indistinguishable downstream from a lens's own — same precedence rules,
  // same threshold, same rendering. They are findings, not a side channel.
  const all = [...lensResults.flatMap((r) => r.findings), ...(opts.extraFindings ?? [])];
  const deduped = dedupeFindings(all);
  const verdict = computeVerdict(deduped, lensResults, opts.threshold);
  return {
    verdict,
    totalFindings: deduped.length,
    bySeverity: bySeverityCounts(deduped),
    lenses: lensResults,
    findings: deduped,
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
