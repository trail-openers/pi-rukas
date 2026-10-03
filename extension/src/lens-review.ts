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
  DEFAULT_REVIEW_THRESHOLD,
  LENS_PREFIX,
  type Verdict,
  bySeverityCounts,
  computeVerdict,
  dedupeFindings,
  extractFindings,
  lensProducedEvidence,
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

export {
  CLAIM_SCAN,
  LENS_PREFIX,
  DEFAULT_REVIEW_THRESHOLD,
  computeVerdict,
  dedupeFindings,
  extractFindings,
  lensProducedEvidence,
  renderSummary,
};
import { aggregateLensUsage } from "./lens-review-usage.ts";
export type LensName = string; // deliberately unbounded — the roster is data-driven from SKILL.md frontmatter (#873)
/** One roster entry — the shape a lens child receives per dispatch (#873:
 * the roster is data, so `LensDef` is the parsed entry type). */
export type LensDef = RosterEntry;
/** Re-exported so consumers of this module name the verdict here; the
 * definition lives in lens-review-format.ts. */
export type { Verdict } from "./lens-review-format.ts";
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
/**
 *
 * #966 — the ledger's `passed` is derived from the RESOLVED verdict (via
 * `lensPassed` inside `writeLensLedgerEntry`), and every run shape that
 * fails, aborts or kills its lenses reaches this exit with a
 * REVIEW_INCOMPLETE verdict, so the `passed:true` path is protected by
 * construction: no caller feeds this exit a passing verdict for an
 * all-fail/all-abort run, and the "write nothing" path (no branch / no
 * patchId) is the only silent path that remains.
 */
function finish(
  summary: LensReviewSummary,
  threshold: Severity,
  cwd: string | undefined,
  branch: string | undefined,
): LensReviewSummary {
  void writeLensLedgerEntry(summary.verdict, threshold, cwd, branch);
  return summary;
}

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
   * #966 — the per-lens spawner (the real `runLensChild` by default;
   * tests inject a stub so an all-fail run is drivable offline, the issue's
   * "start a lens job with stub children" acceptance criterion).
   */
  lensChildFn?: typeof import("./lens-review-child.ts").runLensChild;
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
  const skillsCheck = skillsDirUsable(skillsDir);
  if (skillsCheck !== undefined) {
    // #872 — ONE skills-dir check before the fan-out (not per-lens checks):
    // a missing, empty, or no-`code-review-*`-skill dir blocks ALL lenses
    // with a single install message and no spawn is ever called. The roster
    // is empty exactly in those cases, so the two are one check now (#873
    // moved the "any lens skill present" test onto the parsed roster).
    // SINGLE EXIT PATH (item 5): the early return is the same `finish(...)`
    // (the deck bookkeeping lives in `runInstallBlock`, moved to
    // lens-review-skills.ts for the 500-line cap).
    const { lensResults, findings } = runInstallBlock(runId, skillsCheck, opts.extraFindings ?? []);
    const deduped = dedupeFindings(findings, []);
    return finish(
      {
        verdict: computeVerdict(deduped, lensResults, threshold),
        totalFindings: deduped.length,
        bySeverity: bySeverityCounts(deduped),
        lenses: lensResults,
        findings: deduped,
        usage: undefined,
        ...capKillSummary(lensResults),
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
  // #966 — an aborted signal is a user kill: every lens that never started
  // (or started and was killed) is recorded blocked, no children are spawned,
  // and the run proceeds to the SAME finish path as a non-aborted all-fail
  // run — verdict REVIEW_INCOMPLETE, one ledger write, nothing special. The
  // in-loop signal check inside runLensChild still governs children that
  // were already spawned before the abort arrived.
  if (opts.signal?.aborted) {
    const abortedRows = roster.map((e) => ({
      lens: e.name,
      ok: false,
      ms: 0,
      startMs: Date.now(),
      findings: [] as Finding[],
      attempts: 0,
      blocked: true,
      parseError: "aborted before start",
    }));
    const deduped = dedupeFindings([...(opts.extraFindings ?? [])], roster);
    return finish(
      {
        verdict: computeVerdict(deduped, abortedRows, threshold),
        totalFindings: deduped.length,
        bySeverity: bySeverityCounts(deduped),
        lenses: abortedRows,
        findings: deduped,
        usage: undefined,
      },
      threshold,
      opts.cwd,
      opts.branch,
    );
  }
  // #873 — blocked roster entries become blocked lens results (no spawn,
  // the named error as parseError) and feed REVIEW_INCOMPLETE via
  // computeVerdict; healthy entries fan out as before.
  const lensChildFn = opts.lensChildFn ?? runLensChild;
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
    lensChildFn({
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
