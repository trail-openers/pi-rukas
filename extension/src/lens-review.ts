import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as dispatchDeck from "./dispatch-deck.ts";
import { execp } from "./lens-exec.ts";
import { resolveLensReviewBranch } from "./lens-review-branch-resolve.ts";
import { capKillSummary } from "./lens-review-capkill.ts";
import { runLensChild } from "./lens-review-child.ts";
import {
  blockedReviewSummary,
  blockedRowsForRoster,
  buildDeltaFullContext,
  resolveReviewDiff,
  startPersistentBatch,
} from "./lens-review-diff.ts";
import { finishLensReview } from "./lens-review-finish.ts";
import {
  DEFAULT_REVIEW_THRESHOLD,
  LENS_PREFIX,
  type LensReviewSummary,
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
import { installBlockRowsForRoster, skillsDirUsable } from "./lens-review-skills.ts";
import { CLAIM_SCAN, type RosterEntry, buildExpectedRoster } from "./lens-roster.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult, DispatchUsage } from "./types.ts";

const execFileP = promisify(execFile);
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

export async function runLensReview(opts: {
  diff?: string;
  context?: string;
  cwd?: string;
  /** #859 — base ref for the tool-computed `git diff <base>...<head>` (with head). */
  base?: string;
  /** #859 — head ref for the tool-computed diff (with base). */
  head?: string;
  signal?: AbortSignal;
  /** #973 — the delta base (see resolveReviewDiff for the full contract). */
  since?: string;
  /** #973 — force a full review (the automatic delta base is not consulted;
   * an explicit `since` still wins when given). */
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
  // #980 — the ONE branch resolution for this run (shared helper,
  // review-branch.ts): explicit `branch` → a branch-named `head` ref →
  // `git rev-parse --abbrev-ref HEAD`. Every exit path (all five `finish`
  // calls and the noReview early return) keys the ledger write and the
  // residual-disclosure post on THIS SAME value, and the not-recorded /
  // not-posted note is derived from the same resolution outcome. Computed
  // here — synchronously before the fan-out — so the note can never lie
  // about a fire-and-forget write's outcome.
  const { branch: branchResolved, notRecorded } = await resolveLensReviewBranch(opts);
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
  let delta: { since: string; head: string; auto?: boolean } | undefined;
  let diff = "";
  let context: string;
  const resolved = await resolveReviewDiff({
    diff: opts.diff,
    since: opts.since,
    full: opts.full,
    base: opts.base,
    head: opts.head,
    branch: opts.branch,
    cwd: opts.cwd,
  });
  if (resolved.kind === "ok") {
    diff = resolved.diff ?? "";
    if (resolved.delta) {
      delta = {
        since: resolved.delta.since,
        head: resolved.delta.head,
        ...(resolved.delta.auto ? { auto: true } : {}),
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
  } else {
    context = opts.context ?? "";
  }
  if (resolved.kind === "blocked") {
    const blockRows = blockedRowsForRoster(roster, resolved.problem);
    const blocked = blockedReviewSummary(runId, opts.extraFindings, roster, blockRows, threshold);
    return await finishLensReview(blocked, threshold, opts.cwd, branchResolved, {
      hasCritical: false,
      head: opts.head,
    });
  }
  if (resolved.kind === "noReview") {
    trace(
      `lens-review: delta review skipped — no changes since ${resolved.since} (${resolved.reason})`,
    );
    // #980 — the noReview path bypasses `finish()`, so the not-recorded
    // note is set HERE (the spec clarification's explicit call-out). It
    // fires only when the branch could not be resolved — the review would
    // otherwise have been recorded had there been changes.
    const noReviewNote = `No changes since the last lens review (${resolved.since.slice(0, 8)}) — no re-review needed (nothing to review).`;
    return {
      verdict: "APPROVED",
      totalFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      lenses: [],
      findings: [],
      usage: undefined,
      // #973 — decision 4: nothing changed since the last recorded lens run.
      // #973 review — noReview: this is NOT an approval (the summary renders
      // "NO REVIEW — …", never "APPROVED"); every consumer branches on it.
      note: notRecorded ? `${noReviewNote}\n\n${notRecorded}` : noReviewNote,
      deltaReview: { since: resolved.since, head: resolved.head },
      noReview: true,
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
    const blocked = blockedReviewSummary(
      runId,
      opts.extraFindings,
      roster,
      installBlockRowsForRoster(problem),
      threshold,
    );
    return await finishLensReview(blocked, threshold, opts.cwd, branchResolved);
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
    return await finishLensReview(blocked, threshold, opts.cwd, branchResolved);
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
  const results = await Promise.all(
    healthy.map((lens) =>
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
  const verdict = computeVerdict(deduped, lensResults, threshold);
  // #973 — the round-cap rule's inputs for the ledger write: hasCritical
  // from the deduped findings, headSha from the ref the review actually
  // covered (the delta's head when this was a delta run, otherwise
  // opts.head or HEAD). Both are undefined on the full-review path when no
  // head is named (the ledger write omits them; a later round-cap check
  // fails closed on the missing field — conservative by design).
  const hasCritical = deduped.some((f) => f.severity === "CRITICAL");
  // #973 — the ledger write's headSha (the commit the review actually
  // covered). The DELTA arm uses `delta.head` — already a full OID by the
  // time we get here (resolveDeltaDiff resolved it: explicit `head` or the
  // cwd repo's HEAD, via execFile). The NON-DELTA arm rev-parses
  // `opts.head ?? "HEAD"` here (a caller-supplied ref, resolved via execFile
  // with a leading-dash rejection: a ref beginning with `-` would be parsed
  // by git as an option — argument injection — and is never a legitimate
  // ref name here, the same rule `refIsCommit` in review-diff.ts applies).
  const reviewHead = delta ? delta.head : (opts.head ?? "HEAD");
  let headSha: string | undefined;
  if (delta) headSha = delta.head || undefined;
  else if (!reviewHead.startsWith("-")) {
    try {
      const { stdout } = await execFileP(
        "git",
        ["-C", opts.cwd ?? process.cwd(), "rev-parse", reviewHead],
        {
          maxBuffer: 8 * 1024,
        },
      );
      headSha = stdout.trim() || undefined;
    } catch (err) {
      trace(
        `lens-review: headSha resolution failed for ${reviewHead}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      headSha = undefined;
    }
  }
  return finishLensReview(
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
    branchResolved,
    { hasCritical, headSha, head: opts.head },
  );
}
