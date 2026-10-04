import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as dispatchDeck from "./dispatch-deck.ts";
import { writeLensLedgerEntry } from "./lens-ledger.ts";
import { capKillSummary } from "./lens-review-capkill.ts";
import { runLensChild } from "./lens-review-child.ts";
import {
  blockedReviewSummary,
  blockedRowsForRoster,
  resolveReviewDiff,
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
import { postLensResidualDisclosure } from "./lens-review-residuals.ts";
import { installBlockRowsForRoster, skillsDirUsable } from "./lens-review-skills.ts";
import { CLAIM_SCAN, type RosterEntry, buildExpectedRoster } from "./lens-roster.ts";
import { computeRangeDiff } from "./review-diff.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

const execp = promisify(exec);
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
}

function piSkillsDir(): string {
  return process.env.PI_ENSEMBLE_SKILLS_DIR ?? path.join(os.homedir(), ".pi", "agent", "skills");
}

/**
 * The ONE exit path: writes the ledger entry and returns the summary.
 *
 * #966 — the ledger's `passed` is derived from the RESOLVED verdict (via
 * `lensPassed` inside `writeLensLedgerEntry`), and every run shape that
 * fails, aborts or kills its lenses reaches this exit with a
 * REVIEW_INCOMPLETE verdict, so the `passed:true` path is protected by
 * construction: no caller feeds this exit a passing verdict for an
 * all-fail/all-abort run, and the "write nothing" path (no branch / no
 * patchId) is the only silent path that remains.
 */
async function finish(
  summary: LensReviewSummary,
  threshold: Severity,
  cwd: string | undefined,
  branch: string | undefined,
  ledger: { hasCritical?: boolean; headSha?: string } = {},
): Promise<LensReviewSummary> {
  void writeLensLedgerEntry(
    summary.verdict,
    threshold,
    cwd,
    branch,
    ledger.hasCritical,
    ledger.headSha,
  );
  // #973 — the residual-findings disclosure: posted ONLY when the verdict is
  // ISSUES_FOUND AND the branch's PR/MR resolves (see postLensResidual
  // for the trigger, the marker, and the fail-closed semantics). Awaited so
  // the tool result reports a failed post (the guard then refuses — fail
  // closed) before the summary is returned to the async job — the post is
  // best-effort but its failure must be VISIBLE in the tool result, and the
  // job's text is read once the summary resolves.
  if (summary.verdict === "ISSUES_FOUND" && branch) {
    summary.note = await postLensResidualDisclosure({
      summary,
      branch,
      cwd: cwd ?? process.cwd(),
    });
  }
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
   * #973 — the delta base: the `since` ref (a commit) the review's diff runs
   * from. An EXPLICIT `since` is used as-is. When absent and a branch is
   * named, `since` defaults to the branch's latest lens ledger entry's
   * `headSha` when that SHA is a strict ancestor of the reviewed head
   * (design decision 6 — the automatic delta base); otherwise the review is
   * FULL. `full: true` forces a full review. See resolveReviewDiff for the
   * full contract (empty delta = no-review, not an approval, not a block).
   */
  since?: string;
  /** #973 — force a full review (the automatic delta base is not consulted;
   * an explicit `since` still wins when given). */
  full?: boolean;
  /** #966 — the per-lens spawner (the real `runLensChild` by default;
   * tests inject a stub so an all-fail run is drivable offline). */
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
  // #973 — `since` (a delta base) overrides base+head: the lenses review
  // ONLY `git diff <since>..<head>`, with the full base...head range
  // supplied as context for orientation. An empty delta is not a block and
  // not an approval — it is the no-review outcome (see resolveReviewDiff).
  let delta: { since: string; head: string; auto?: boolean } | undefined;
  let diff = "";
  let context = opts.context ?? "";
  const resolved = await resolveReviewDiff({
    diff: opts.diff,
    since: opts.since,
    full: opts.full,
    base: opts.base,
    head: opts.head,
    branch: opts.branch,
    cwd: opts.cwd,
    runId,
    roster,
    extraFindings: opts.extraFindings,
    threshold,
  });
  if (resolved.kind === "ok") {
    diff = resolved.diff ?? "";
    if (resolved.delta) {
      delta = {
        since: resolved.delta.since,
        head: resolved.delta.head,
        ...(resolved.delta.auto ? { auto: true } : {}),
      };
      if (opts.base && opts.head) {
        const full = await computeRangeDiff(opts.cwd ?? process.cwd(), opts.base, opts.head);
        if (full.ok) {
          context += `\n\nFULL BRANCH DIFF (context only — the findings below cover the delta since ${resolved.delta.since} (auto: latest lens ledger headSha)):\n${full.diff}`;
        }
      }
    }
  }
  if (resolved.kind === "blocked") {
    const blockRows = blockedRowsForRoster(roster, resolved.problem);
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    return await finish(blocked, threshold, opts.cwd, opts.branch, { hasCritical: false });
  }
  if (resolved.kind === "noReview") {
    trace(
      `lens-review: delta review skipped — no changes since ${resolved.since} (${resolved.reason})`,
    );
    return {
      verdict: "APPROVED",
      totalFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      lenses: [],
      findings: [],
      usage: undefined,
      // #973 — decision 4: nothing changed since the last recorded lens run.
      note: `No changes since the last lens review (${resolved.since.slice(0, 8)}) — no re-review needed (nothing to review).`,
      deltaReview: { since: resolved.since, head: resolved.head },
    };
  }
  // #966 — the empty-roster guard: a skills dir that resolves to ZERO
  // lenses (missing dir, empty dir, no `code-review-*` skill, OR an
  // unreadable bundled expected set — the #970 CI incident where the
  // review ran with no lens skills installed at all) blocks the review on
  // the single finish path below. Without this the empty-roster shape fell
  // through to a fan-out over zero lenses and `computeVerdict` saw zero
  // rows, which every rule in the precedence table passes — an empty
  // review was APPROVED, the silent-approval class #966 exists to close.
  // A roster that is non-empty but fully-blocked (every entry carries an
  // error) must NOT take this path — the fan-out below converts those
  // entries into blocked rows and `computeVerdict` sees them (the #873
  // shape). This also subsumes the dead #872 install-block branch: the
  // cases `skillsDirUsable` flags are exactly the empty-roster cases, so
  // this guard IS the single install exit now.
  if (roster.length === 0) {
    const problem =
      skillsDirUsable(skillsDir) ?? `no usable code-review-* lens skills in ${skillsDir}`;
    // #966 — one blocked row per bundled lens (the #872 install-block shape,
    // routed through `installBlockRowsForRoster` so the named-row logic
    // lives in ONE place — the #872 doctrine, preserved here via the
    // #873/#966 guard rather than a second early exit that could drift
    // back into the empty-`computeVerdict` APPROVED hole; the removed #872
    // early exit was dead code, since this guard already diverts every
    // empty-roster shape to this single finish exit). Deck
    // bookkeeping (start → bump per row → clear) happens inside
    // `blockedReviewSummary` below, so the operator sees the same
    // one-batch-row-and-bumped-per-lens shape the old `runInstallBlock`
    // produced. The LENSES-fallback for an unreadable bundled dir is
    // inside the helper (same as `blockedRowsForRoster([])`'s single-row
    // shape, but with the install message as `parseError` rather than a
    // generic "no usable" fallback).
    const blockRows = installBlockRowsForRoster(problem);
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    return await finish(blocked, threshold, opts.cwd, opts.branch);
  }
  // #966 — an aborted signal is a user kill: every lens is recorded blocked,
  // no children are spawned, and the run proceeds to the SAME finish path as
  // a non-aborted all-fail run — verdict REVIEW_INCOMPLETE, one ledger write,
  // nothing special. Checked BEFORE `startPersistentBatch` so no deck batch
  // (and its ticker) is ever registered for a run that cannot start. The
  // in-loop signal check inside runLensChild still governs children that
  // were already spawned before an abort arrives mid-fan-out; the normal
  // fan-out path clears its batch via `clearBatchEntry(batchKey)` below.
  if (opts.signal?.aborted) {
    const blockRows = blockedRowsForRoster(roster, "aborted before start");
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    return await finish(blocked, threshold, opts.cwd, opts.branch);
  }
  // Persistent batch summary row (#139). Lets the user see "X/6 done"
  // throughout the run even as fast lenses drop out at 0s linger. Registered
  // BEFORE the per-lens entries so its seq sorts first on Pi's footer.
  const { batchKey, bumpBatch } = startPersistentBatch(runId, roster.length);
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
  // #973 — the round-cap rule's inputs for the ledger write: hasCritical
  // from the deduped findings, headSha from the ref the review actually
  // covered (the delta's head when this was a delta run, otherwise
  // opts.head or HEAD). Both are undefined on the full-review path when no
  // head is named (the ledger write omits them; a later round-cap check
  // fails closed on the missing field — conservative by design).
  const hasCritical = deduped.some((f) => f.severity === "CRITICAL");
  const reviewHead = delta ? delta.head : (opts.head ?? "HEAD");
  let headSha: string | undefined;
  try {
    const { stdout } = await execp(`git rev-parse ${reviewHead}`, {
      cwd: opts.cwd ?? process.cwd(),
      maxBuffer: 8 * 1024,
    });
    headSha = stdout.trim() || undefined;
  } catch {
    headSha = undefined;
  }
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
      ...(delta ? { deltaReview: { since: delta.since, head: delta.head } } : {}),
    },
    threshold,
    opts.cwd,
    opts.branch,
    { hasCritical, headSha },
  );
}
