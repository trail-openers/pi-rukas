import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dispatchDeck from "./dispatch-deck.ts";
import { execp } from "./exec.ts";
import { resolveBudgetKey } from "./lens-budget-key.ts";
import type { LensLedgerOutcome } from "./lens-ledger.ts";
import { withLensModelSlot } from "./lens-model-slots.ts";
import { partitionDecisions, renderPriorFindingsBlock } from "./lens-residuals.ts";
import { splitCarried } from "./lens-review-advisory.ts";
import { carriedSummary, noReviewSummary } from "./lens-review-auto-delta.ts";
import { resolveLensReviewBranch } from "./lens-review-branch-resolve.ts";
import { capKillSummary } from "./lens-review-capkill.ts";
import { runLensChild } from "./lens-review-child.ts";
import {
  type AutoDeltaInfo,
  blockedReviewSummary,
  blockedRowsForRoster,
  buildDeltaFullContext,
  deltaFallbackNote,
  deltaReviewOf,
  resolveReviewDiff,
  startPersistentBatch,
} from "./lens-review-diff.ts";
import { finishLensReview } from "./lens-review-finish.ts";
import {
  DEFAULT_REVIEW_THRESHOLD,
  LENS_PREFIX,
  type LensReviewSummary,
  type Severity,
  type Verdict,
  bySeverityCounts,
  computeVerdict,
  dedupeFindings,
  extractFindings,
  isSeverity,
  lensProducedEvidence,
  piSkillsDir,
  renderSummary,
} from "./lens-review-format.ts";
import { isReviewIncomplete } from "./lens-review-incomplete.ts";
import { installBlockRowsForRoster, skillsDirUsable } from "./lens-review-skills.ts";
import type { Finding, LensRunResult } from "./lens-review-types.ts";
import { CLAIM_SCAN, type RosterEntry, buildExpectedRoster } from "./lens-roster.ts";
import { readBranchRows, recordFindingRunOutcome } from "./review-findings-store.ts";
import { isFullCommitSha, resolveHeadSha } from "./review-head-sha.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";

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
  type LensReviewSummary,
};
import { aggregateLensUsage } from "./lens-review-usage.ts";
/** One roster entry — the shape a lens child receives per dispatch (#873:
 * the roster is data, so `LensDef` is the parsed entry type). */
export type LensDef = RosterEntry;
/** Re-exported so consumers of this module name the verdict here; the
 * definition lives in lens-review-format.ts. */
export type { Verdict, Severity } from "./lens-review-format.ts";
/** Re-exported from lens-review-types.ts (#1000: the per-lens result shape
 * moved there so this file stays under the 500-line limit while keeping its
 * origin/main jsdoc comments verbatim). No consumer import path changes. */
export type {
  Finding,
  FindingSource,
  LensName,
  LensRunResult,
  RawFinding,
} from "./lens-review-types.ts";
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

/** Max attempts per lens — 1 initial + 3 retries on spawn failure or non-zero
 * exit. Matches the opencode contract. Aborted lenses (user cancel) don't
 * retry. */
const MAX_LENS_ATTEMPTS = 4;
export { MAX_LENS_ATTEMPTS };

/** Backoff between retries (ms). Small fixed delay — these failures are
 * usually transient (process spawn pressure, provider-side rate limits). */
const LENS_RETRY_BACKOFF_MS = 1000;

export async function runLensReview(opts: {
  diff?: string;
  context?: string;
  cwd?: string;
  /** #859 — base ref for the tool-computed `git diff <base>...<head>` (with head). */
  base?: string;
  /** #859 — head ref for the tool-computed diff (with base). */
  head?: string;
  signal?: AbortSignal;
  processGroup?: boolean;
  /** #973 — the delta base (see resolveReviewDiff for the full contract). */
  since?: string;
  /** #973 — force a full review (the automatic delta base is not consulted; an explicit `since` still wins when given). */
  full?: boolean;
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
  pi?: import("./async-jobs-lifecycle.ts").DispatchHost;
  /** Blocking bar; defaults to MEDIUM. See `DEFAULT_REVIEW_THRESHOLD`. */
  threshold?: Severity;
  /**
   * #912 — caller-supplied branch for the review-ledger write (the driver
   * worktrees are detached, so `git rev-parse --abbrev-ref HEAD` cannot
   * recover it). When absent the writer recovers the branch from `HEAD`
   * and skips (traces) on a detached head.
   */
  branch?: string;
  /** #973 — the PR/MR number for the residual-findings disclosure post. */
  pr?: number;
  /** #1127 — the operator bypassed the tool-side round budget; recorded on the ledger entry. */
  overrideCap?: boolean;
  /** #1127 — receives the run's ledger-write promise once the run has finished;
   * the caller holds its round reservation until it settles. */
  onLedgerWrite?: (ledgerWrite: Promise<LensLedgerOutcome>) => void;
  /** #1127 — the round-budget key the tool admitted this run under (lens-budget-key.ts);
   * keys the ledger entry when no branch resolves. */
  ledgerKey?: string;
}): Promise<LensReviewSummary> {
  const runId = makeRunId();
  const skillsDir = piSkillsDir();
  // The RESOLVED threshold (computed once; both the verdict and the ledger
  // write apply the same bar).
  const threshold = opts.threshold ?? DEFAULT_REVIEW_THRESHOLD;
  // #980 — the ONE branch resolution for this run (shared helper,
  // review-branch.ts): explicit `branch` → a branch-named `head` ref →
  // `git rev-parse --abbrev-ref HEAD`. Every exit path (all five `finish`
  // calls and the noReview early return) keys the ledger write and the
  // residual-disclosure post on THIS SAME value, and the not-recorded /
  // not-posted note is derived from the same resolution outcome. Computed
  // here — synchronously before the fan-out — so the note can never lie
  // about a fire-and-forget write's outcome.
  const { branch: branchResolved } = await resolveLensReviewBranch(opts);
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
  let delta: AutoDeltaInfo | undefined;
  let diff = "";
  let context: string;
  // #1128 — the automatic delta reads the SAME ledger key the round cap
  // budgets under (lens-budget-key.ts). The delta is found when the head
  // commit sits on exactly one local branch (or a PR is given); a purely
  // detached head keyed `detached:<sha>` changes key on every commit, so
  // it gets a full review.
  const budgetKey = await resolveBudgetKey({
    cwd: opts.cwd ?? process.cwd(),
    head: opts.head,
    pr: opts.pr,
  });
  const resolved = await resolveReviewDiff({
    diff: opts.diff,
    since: opts.since,
    full: opts.full,
    base: opts.base,
    head: opts.head,
    branch: budgetKey.key ?? branchResolved,
    cwd: opts.cwd,
  });
  if (resolved.kind === "ok") {
    diff = resolved.diff ?? "";
    if (resolved.delta) {
      delta = {
        since: resolved.delta.since,
        head: resolved.delta.head,
        ...(resolved.delta.auto ? { auto: true } : {}),
        ...(resolved.delta.fallback ? { fallback: resolved.delta.fallback } : {}),
      };
    }
    // #973 review — a delta review with an explicit base+head appends the
    // full base...head range as context for orientation, capped at 100 KB
    // (buildDeltaFullContext: bound + truncation notice).
    context =
      resolved.kind === "ok" && resolved.delta && opts.base && opts.head
        ? await buildDeltaFullContext(
            opts.context ?? "",
            opts.cwd,
            opts.base,
            opts.head,
            resolved.delta.since,
            resolved.delta.auto === true,
          )
        : (opts.context ?? "");
    context += deltaFallbackNote(delta);
  } else {
    context = opts.context ?? "";
  }
  // #1039 — resolve the headSha ONCE, before any early return, so every
  // ledger write (blocked, empty-roster, aborted, normal) carries the
  // resolved 40-char SHA. The delta arm's head is normally already a full
  // SHA (resolveDeltaDiff resolves it via the shared resolver), but the
  // resolver can fall back to the raw caller ref on a git failure — and a
  // raw ref must never reach the ledger (it is matched by string equality
  // against a PR head OID, and a branch name there corrupts the round-cap
  // comparison). The shape check keeps the invariant on every path; a
  // non-SHA delta head leaves headSha undefined (the ledger write omits
  // it; the round-cap check fails closed — conservative by design). The
  // non-delta arm goes through the shared `resolveHeadSha` (review-head-sha.ts)
  // for `opts.head ?? "HEAD"`; an unresolvable ref leaves headSha undefined
  // there too.
  let headSha: string | undefined;
  if (resolved.kind === "ok" && resolved.delta) {
    if (isFullCommitSha(resolved.delta.head)) {
      headSha = resolved.delta.head;
    } else {
      trace(
        `lens-review: delta head ${resolved.delta.head.slice(0, 40)} is not a 40-char SHA — headSha omitted (the round-cap check fails closed on the absent field)`,
      );
    }
  } else if (resolved.kind === "ok") {
    headSha = await resolveHeadSha(opts.cwd ?? process.cwd(), opts.head ?? "HEAD", execp);
  } else {
    // blocked or noReview: no headSha (no commit was reviewed).
    headSha = undefined;
  }
  // #1000 — the single finish path for every exit of this run: the identical
  // `finishLensReview(...)` call (threshold, cwd, the ONE resolved branch,
  // the resolved headSha, the caller's head ref, and the #973 residual-
  // disclosure `pr`) at every return site, so the ledger write and the
  // disclosure post can never drift from a copy that was missed in a
  // refactor. `hasCritical` is per-site (the blocked exits carry no
  // findings; the normal exit carries the deduped findings' bar).
  const finishWith = async (
    s: LensReviewSummary,
    hasCritical = false,
  ): Promise<LensReviewSummary> => {
    const finished = await finishLensReview(
      s,
      threshold,
      opts.cwd,
      branchResolved,
      {
        hasCritical,
        headSha,
        head: opts.head,
        overrideCap: opts.overrideCap,
        ledgerKey: opts.ledgerKey,
      },
      opts.pr,
    );
    // #1127 review — the caller's round reservation is held until this write
    // settles (see lens-round-cap.ts `release`); the write is NOT awaited here.
    opts.onLedgerWrite?.(finished.ledgerWrite);
    return finished.summary;
  };
  if (resolved.kind === "blocked") {
    const blockRows = blockedRowsForRoster(roster, resolved.problem);
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    // #984 — the ledger write's promise is discarded (fire-and-forget in
    // production; the await seam is for tests, not for the driver).
    return finishWith(blocked);
  }
  if (resolved.kind === "carry") {
    // #1176 — the carried entry was written AND awaited by the resolver
    // (lens-review-diff.ts emptyAutoDelta); no review runs. The round
    // reservation settles on that recorded outcome.
    opts.onLedgerWrite?.(Promise.resolve(resolved.written));
    return carriedSummary(resolved.from, resolved.head, resolved.prev, resolved.verdict);
  }
  if (resolved.kind === "noReview") {
    // #980 — the noReview path records nothing: no ledger write, no #973
    // disclosure post (see noReviewSummary).
    return noReviewSummary(resolved.since, resolved.head, resolved.reason);
  }
  // Exhaustive over ReviewDiffOutcome: a new variant must be handled above.
  if (resolved.kind !== "ok") {
    const unhandled: never = resolved;
    throw new Error(`lens review: unhandled diff outcome ${JSON.stringify(unhandled)}`);
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
    const blocked = blockedReviewSummary(
      runId,
      opts.extraFindings,
      roster,
      installBlockRowsForRoster(problem),
      threshold,
    );
    return finishWith(blocked);
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
    return finishWith(
      blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold),
    );
  }
  // Persistent batch summary row (#139). Lets the user see "X/6 done"
  // throughout the run even as fast lenses drop out at 0s linger. Registered
  // BEFORE the per-lens entries so its seq sorts first on Pi's footer.
  const { batchKey, bumpBatch } = startPersistentBatch(runId, roster.length);
  // #1105 — the branch's open and accepted findings from earlier rounds, as a
  // fenced DATA block every lens receives (empty on a first review).
  const priorFindings =
    branchResolved && headSha
      ? renderPriorFindingsBlock(await readBranchRows(opts.cwd ?? process.cwd(), branchResolved))
      : "";
  // #873 — blocked roster entries become blocked lens results (no spawn,
  // the named error as parseError) and feed REVIEW_INCOMPLETE via
  // computeVerdict; healthy entries fan out as before.
  const lensChildFn = opts.lensChildFn ?? runLensChild;
  const blocked = roster.filter((e) => e.error !== undefined);
  const healthy = roster.filter((e) => e.error === undefined);
  const results = await Promise.all(
    healthy.map((lens) =>
      withLensModelSlot(
        lens.name,
        () =>
          lensChildFn({
            lens,
            runId,
            skillsDir,
            context,
            roster,
            opts: { ...opts, diff: diff ?? "", priorFindings },
            bumpBatch,
            ...(opts.pi ? { pi: opts.pi } : {}),
          }),
        opts.signal,
      ),
    ),
  );
  const blockedRows = blocked.map(
    (e): LensRunResult => ({
      lens: e.name,
      ok: false,
      ms: 0,
      startMs: Date.now(),
      findings: [],
      attempts: 0,
      blocked: true,
      parseError: e.error ?? "",
    }),
  );
  const lensResults = [...results, ...blockedRows];
  dispatchDeck.clearBatchEntry(batchKey);
  // Deterministic findings are merged BEFORE dedup and verdict so they are
  // indistinguishable downstream from a lens's own — same precedence rules,
  // same threshold, same rendering. They are findings, not a side channel.
  const all = [...lensResults.flatMap((r) => r.findings), ...(opts.extraFindings ?? [])];
  const deduped = dedupeFindings(all, roster);
  // #1105 — record the round against the findings memory: suppressed findings
  // leave the review, and a complete full review resolves rows it no longer reports.
  const review = delta ? "delta" : isReviewIncomplete(lensResults) ? "incomplete" : "full";
  const recorded =
    branchResolved && headSha
      ? await recordFindingRunOutcome({
          cwd: opts.cwd ?? process.cwd(),
          branch: branchResolved,
          headSha,
          findings: deduped,
          ...(delta ? { deltaDiff: diff } : {}),
          review,
        })
      : undefined;
  // Fail open: an unrecorded round reports every finding, and the summary and
  // the residual comment say why memory was not used.
  const memoryNote =
    recorded && !recorded.ok ? `findings memory unavailable: ${recorded.reason}` : undefined;
  const decisions = recorded?.ok ? recorded.decisions : undefined;
  const { kept, suppressed } = partitionDecisions(deduped, decisions);
  // #1105 — open rows this round did not re-report, whose cited code is
  // unchanged, still stand: a lens omitting a known finding is not a fix.
  // They are reported alongside this round's findings. #1140 — a carried row
  // on a file outside the PR's diff is advisory (lens-review-advisory.ts).
  const carried = await splitCarried(recorded, opts.cwd, opts.base, headSha);
  const reported = [...kept, ...carried.blocking];
  const verdict = computeVerdict(reported, lensResults, threshold);
  // #973 — the round-cap rule's inputs for the ledger write: hasCritical
  // from the deduped findings, headSha from the ref the review actually
  // covered (the delta's head when this was a delta run, otherwise
  // opts.head or HEAD). Both are undefined on the full-review path when no
  // head is named (the ledger write omits them; a later round-cap check
  // fails closed on the missing field — conservative by design).
  const hasCritical = reported.some((f) => f.severity === "CRITICAL");
  // #1039 — headSha was resolved once, before any early return (see the
  // block above). The ledger write carries it through to all paths.
  // #984 — the ledger write's promise is discarded (fire-and-forget in
  // production; the await seam is for tests, not for the driver).
  return finishWith(
    {
      verdict,
      totalFindings: reported.length,
      bySeverity: bySeverityCounts(reported),
      lenses: lensResults,
      findings: reported,
      ...(suppressed.length > 0 ? { suppressed } : {}),
      ...(recorded?.ok && recorded.resolved.length > 0 ? { resolved: recorded.resolved } : {}),
      ...(memoryNote ? { memoryNote } : {}),
      ...carried.fields,
      usage: aggregateLensUsage(lensResults),
      // #543 — a dispatch-cap kill on any lens child (loop detector / token
      // budget) is surfaced on the summary so the driver emits the fixed-literal
      // cap-hit (F4g) instead of a silent 1-of-6 loss.
      ...capKillSummary(lensResults),
      ...(delta ? { deltaReview: deltaReviewOf(delta) } : {}),
    },
    hasCritical,
  );
}
