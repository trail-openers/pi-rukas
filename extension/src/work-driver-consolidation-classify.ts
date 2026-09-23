/**
 * work-driver-consolidation-classify — #777: classify a consolidated-tree
 * verify failure instead of parking on a generic "consolidated tree fails
 * verify".
 *
 * When the CONSOLIDATED tree (all workstreams' changes combined in one probe
 * tree at repoRoot) fails the project verify command while the workstreams
 * were verified in isolation, the failure is one of three shapes that need
 * different handoffs:
 *
 *   1. `consolidation-created` — each workstream passed its own verify; the
 *      combination broke a specific assertion that neither tree tripped
 *      alone. The combination is named. Two of these shapes are TRIVIAL and
 *      have a mechanical fix (`trivialFix: true`): the duplicate import the
 *      combination reintroduced, and the size-limit expectation the union of
 *      files pushes past. Everything else (e.g. the scaffolded-file biome
 *      shape, 14 of 14 historical instances) is parked with the specific
 *      assertion and both workstream ids named (resolved decision: no
 *      auto-fix for that shape).
 *
 *   2. `per-workstream-defect` — a workstream that was recorded as passed
 *      actually fails the same assertion it tripped in isolation. The
 *      distinguishing signal: the per-worktree failure text (keyed by
 *      workstream id) is present AND its specific assertion also appears in
 *      the consolidated failure. Not consolidation-created — it is a genuine
 *      per-worktree defect the develop gate should re-run.
 *
 *   3. `needs-human-decision` — neither of the above: the consolidated run
 *      failed on a shape the classifier cannot attribute to a trivial fix or
 *      to a per-workstream defect. Parked with the specific assertion.
 *
 * The N=1 invariant (resolved 2026-09-21): a single workstream is a no-op
 * consolidation. The classifier MUST NOT return `consolidation-created`
 * when `workstreamCount === 1` — the only valid outcomes there are
 * `per-workstream-defect` (re-run per-worktree verify) or
 * `needs-human-decision` (park). 7 of 14 historical instances were N=1.
 *
 * The classifier is pure: it takes the workstream count, the consolidated
 * failure text, and the per-worktree failure texts keyed by workstream id,
 * and returns a structured verdict. It does NOT run git, does NOT apply
 * fixes, does NOT touch the file system. The caller (work-driver-verify-
 * develop.ts) decides whether to apply the trivial fix and re-verify, based
 * on `trivialFix`.
 */

/** The three-way classification a consolidated-tree verify failure maps to. */
export type ConsolidationClassification =
  | "consolidation-created"
  | "per-workstream-defect"
  | "needs-human-decision";

/**
 * The verdict returned by `classifyConsolidatedVerifyFailure`. The caller
 * uses `classification` to route (trivial-fix-and-reverify vs park), and
 * `assertion` / `workstreamIds` for the handoff evidence.
 */
export interface ConsolidationFailureVerdict {
  classification: ConsolidationClassification;
  /**
   * The SPECIFIC failing assertion — the exact biome/tsc/test line, not
   * "exit 1". Extracted from the consolidated failure tail. Empty string
   * when no assertion could be parsed (the unattributed fallback).
   */
  assertion: string;
  /**
   * The workstream ids whose combination caused the failure. For
   * `consolidation-created` this is BOTH workstreams; for
   * `per-workstream-defect` it is the single failing workstream; for
   * `needs-human-decision` it is all workstreams (the combination is
   * unattributed).
   */
  workstreamIds: string[];
  /**
   * `true` when the classifier identified a TRIVIAL shape (duplicate
   * import / size-limit union) that has a mechanical fix. The caller
   * applies the fix and re-verifies; a re-verify failure parks with the
   * original classification + the fix attempt as evidence. `false` for
   * the scaffolded-file shape and everything else — the caller parks
   * directly with the assertion + workstream ids.
   */
  trivialFix: boolean;
  /**
   * The one-line reason for the classification, for the handoff.
   * Human-readable, not machine-parsed.
   */
  reason: string;
}

/**
 * #807 — the honest-absence sentinel. A tail with NO assertion-shaped line
 * (a bare `FAILED: <file>` marker, an echoed command, a truncated stream)
 * used to fall back to the first non-empty line — which is exactly how #746
 * reported `$ cd extension && bun run check` (an echoed, PASSING command)
 * as "the specific assertion". An explicit absence the operator can
 * recognise beats a confidently wrong specific; the tail is still shown
 * next to it by `consolidatedFailureMessage`.
 */
export const NO_SPECIFIC_ASSERTION = "(no specific assertion could be extracted)";

/**
 * #807 — a line that merely NAMES a failure, not an assertion: the smoke
 * loop's per-failure marker (`FAILED: smoke-tests/test-cancel.ts` — #798
 * reported this as the assertion, sending operators to a filename) and its
 * post-#804 summary (`FAILED: 2 test(s) — a.ts, b.ts`). The real assertion
 * sits beneath the marker; the summary carries the count.
 */
const IS_MARKER_LINE = /^FAILED:/;
/** #807 — an ECHOED shell command (the verify-cmd chain's `$ …` output, #746). */
const IS_ECHOED_COMMAND = /^\$ /;
/** #807 — a line that carries ACTUAL failure content (priority: `✗` first). */
const IS_ASSERTION_LINE =
  /^✗\s|^error:?\s|^Error:|error\[E\d+\]|\bTS\d{4,}\b|exit 0 \(got 1\)|zero findings \(got 1\)/;

/**
 * #807 — a token-shape secret guard: the extracted assertion reaches a
 * GitHub comment (cap evidence + handoff body), so a line that looks like
 * credential material is skipped in favour of the next qualifying line.
 */
const LOOKS_LIKE_SECRET =
  /(api[_-]?key|access[_-]?token|bearer\s|password|passwd|secret[_-]?key)\s*[=:]\s*\S{8,}/i;

/** #807 — a line that is neither an assertion nor usable evidence. */
function isNonAssertionLine(line: string): boolean {
  return IS_MARKER_LINE.test(line) || IS_ECHOED_COMMAND.test(line) || LOOKS_LIKE_SECRET.test(line);
}

/**
 * Extract the specific failing assertion from a consolidated-verify failure
 * tail. The tail comes from `extractAttributedTail` — when `attributed:
 * true` it starts at a `FAILED:` marker (post-#804 the LAST one, the
 * summary, which is why a marker alone is never a valid answer); when
 * `false` it is the last 800 chars of the combined output (the biome/tsc
 * chain-stage shape, which emits no marker and may carry an echoed `$ …`
 * command line from a passing earlier stage).
 *
 * #807 — the assertion is the FIRST line of the tail that carries actual
 * failure content, preferring a `✗` assertion (smoke loop / biome /
 * scaffold), then a compiler/linter error (tsc `error TS…`, biome
 * diagnostic, `error:`/`Error:`/`error[E…]:`). Marker lines (`FAILED: …`,
 * including the `FAILED: <n> test(s) — …` summary), echoed shell command
 * lines (`$ …`), and secret-shaped lines are NEVER selected. When no line
 * qualifies, `NO_SPECIFIC_ASSERTION` is returned instead of the first
 * non-empty line (the #746 defect): a field that reports absence honestly
 * beats one that sometimes holds a filename and sometimes a command echo.
 *
 * Multi-failure (post-#804) decision, pinned in test-work-driver-verify-
 * extract-assertion.ts: "the specific assertion" is the FIRST real
 * assertion; the count is the summary marker's job, so it is not
 * duplicated into the extracted field.
 */
export function extractSpecificAssertion(failureTail: string): string {
  const lines = failureTail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    if (isNonAssertionLine(line)) continue;
    if (/^✗\s/.test(line)) return line;
  }
  for (const line of lines) {
    if (isNonAssertionLine(line)) continue;
    if (IS_ASSERTION_LINE.test(line)) return line;
  }
  return NO_SPECIFIC_ASSERTION;
}

/**
 * #807 — true when `per` is a genuine assertion that also appears verbatim
 * in `consolidated`, for the classifier's root-cause match. Extracted
 * assertions are compared (the #798 fix): both sides reduced to a marker
 * or an echo used to make a marker-vs-marker match (or a marker-vs-text
 * miss) where the identical `✗ …` line sat invisibly underneath. The
 * sentinel never matches — absence on either side is not evidence of a
 * shared cause.
 */
function sharesAssertion(consolidated: string, per: string): boolean {
  return per !== NO_SPECIFIC_ASSERTION && per.length > 0 && consolidated.includes(per);
}

/**
 * True when the failure text shows the DUPLICATE-IMPORT shape: the
 * combination reintroduced an import/symbol that both workstreams added.
 * One of the two trivial shapes.
 */
function isDuplicateImportShape(failureTail: string): boolean {
  return (
    /duplicate\s+(import|declaration|identifier)/i.test(failureTail) ||
    /already\s+(been\s+)?declared/i.test(failureTail) ||
    /has already been used/i.test(failureTail)
  );
}

/**
 * True when the failure text shows the 500-LINE-CAP UNION shape: the
 * consolidated tree has more files (or a larger file) than either
 * per-workstream tree, pushing one past the size-limit ratchet. The second
 * trivial shape.
 */
function isSizeCapUnionShape(failureTail: string): boolean {
  return /500[- ]?line|hard limit|file size limit/i.test(failureTail);
}

/**
 * Classify a consolidated-tree verify failure.
 *
 * @param workstreamCount — the number of workstreams in the cycle (N). N=1
 *   is a no-op consolidation; `consolidation-created` is never returned.
 * @param workstreamIds — all workstream ids, in order. Used to name the
 *   combination for the handoff.
 * @param consolidatedFailure — the consolidated-verify failure text (the
 *   `detail` from `runConsolidatedVerify` — the attributed tail + restore
 *   claim, or "verify command exited non-zero").
 * @param perWorktreeFailuresByWs — the per-worktree verify failure texts,
 *   keyed by workstream id. When a per-worktree failure's specific
 *   assertion also appears in the consolidated failure, the classification
 *   is `per-workstream-defect` (case 2), not `consolidation-created`.
 */
export function classifyConsolidatedVerifyFailure(
  workstreamCount: number,
  workstreamIds: string[],
  consolidatedFailure: string,
  perWorktreeFailuresByWs: Record<string, string>,
): ConsolidationFailureVerdict {
  const assertion = extractSpecificAssertion(consolidatedFailure);

  // N=1 invariant: a single workstream is a no-op consolidation. The
  // failure is by definition a per-workstream defect (the workstream's own
  // verify should have caught it) or an unattributable case-3 park.
  // `consolidation-created` is never the answer for N=1 (resolved AC).
  if (workstreamCount <= 1) {
    const perFailure = Object.values(perWorktreeFailuresByWs)[0] ?? "";
    const perAssertion = extractSpecificAssertion(perFailure);
    if (perFailure && perAssertion && sharesAssertion(consolidatedFailure, perAssertion)) {
      return {
        classification: "per-workstream-defect",
        assertion,
        workstreamIds: workstreamIds.slice(0, 1),
        trivialFix: false,
        reason: `single-workstream cycle: the consolidated failure matches the per-worktree failure (${perAssertion}) — this is a genuine per-workstream defect, not a combination artifact; re-run that workstream's verify`,
      };
    }
    return {
      classification: "needs-human-decision",
      assertion,
      workstreamIds: workstreamIds.slice(0, 1),
      trivialFix: false,
      reason:
        "single-workstream cycle: the consolidated failure cannot be attributed to a per-workstream defect — park as needs-human with the specific assertion",
    };
  }

  // Case 2 (N>1): a per-workstream defect the develop gate missed.
  // Distinguishing signal: the per-worktree failure's specific assertion
  // also appears in the consolidated failure. This is the 7-of-14 shape.
  for (const wsId of workstreamIds) {
    const perFailure = perWorktreeFailuresByWs[wsId];
    if (!perFailure) continue;
    const perAssertion = extractSpecificAssertion(perFailure);
    if (perAssertion && sharesAssertion(consolidatedFailure, perAssertion)) {
      return {
        classification: "per-workstream-defect",
        assertion,
        workstreamIds: [wsId],
        trivialFix: false,
        reason: `workstream '${wsId}' was recorded as passed but its per-worktree assertion (${perAssertion}) also appears in the consolidated failure — a genuine per-workstream defect the develop gate missed; re-run that workstream's verify before treating this as a combination defect`,
      };
    }
  }

  // Case 1 (N>1): consolidation-created. The combination broke an assertion
  // neither workstream tripped alone. Two trivial shapes get a mechanical
  // fix; everything else (including the scaffolded-file shape) parks.
  const isTrivial =
    isDuplicateImportShape(consolidatedFailure) || isSizeCapUnionShape(consolidatedFailure);
  return {
    classification: "consolidation-created",
    assertion,
    workstreamIds,
    trivialFix: isTrivial,
    reason: isTrivial
      ? `the combination of workstreams ${workstreamIds.join(" + ")} created a trivial defect (${assertion}) that neither workstream tripped alone — the mechanical fix applies and re-verify will confirm it`
      : `the combination of workstreams ${workstreamIds.join(" + ")} created a defect (${assertion}) that neither workstream tripped alone — this is a consolidation-created failure that needs a human design decision; park with the specific assertion and both workstream ids named`,
  };
}

/**
 * Build the per-worktree failures keyed by workstream id from the
 * changedWorktrees array and the per-worktree failure array.
 *
 * The per-worktree verify loop in `verifyDevelopOutcome` pushes failures
 * into an array indexed by the order of `changedWorktrees` (which is a
 * subset of `Object.entries(worktrees)` in iteration order). This helper
 * maps each failure back to its workstream id so the classifier can name
 * the specific workstream.
 */
export function buildPerWorktreeFailuresByWs(
  worktrees: Record<string, string>,
  changedWorktrees: string[],
  perWorktreeVerifyFailures: string[],
): Record<string, string> {
  const byWs: Record<string, string> = {};
  for (const [id, cwd] of Object.entries(worktrees)) {
    const idx = changedWorktrees.indexOf(cwd);
    if (idx >= 0 && perWorktreeVerifyFailures[idx]) {
      byWs[id] = perWorktreeVerifyFailures[idx];
    }
  }
  return byWs;
}

/**
 * The failure message for the handoff. Names (a) the SPECIFIC failing
 * assertion, (b) BOTH workstream ids (for consolidation-created), and
 * (c) the classification label. This replaces the generic "consolidated
 * tree fails verify" / "each workstream passed alone" text.
 */
export function consolidatedFailureMessage(
  verdict: ConsolidationFailureVerdict,
  cmd: string,
): string {
  const ids = verdict.workstreamIds.join(" + ");
  const which =
    verdict.classification === "per-workstream-defect"
      ? `workstream(s) ${ids}`
      : `workstream combination ${ids}`;
  return (
    `[${verdict.classification}] verify command \`${cmd}\` failed on the CONSOLIDATED tree — ` +
    `specific assertion: ${verdict.assertion || "(no assertion parsed)"} — ` +
    `${which}. ${verdict.reason}`
  );
}
