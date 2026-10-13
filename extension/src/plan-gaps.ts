/**
 * plan-gaps — Phase-4 gap-gate parsing and cap routing for the compiled
 * /plan pipeline.
 *
 * Split out of plan-driver.ts at the same seam as forge-ci.ts / plan-draft.ts
 * (the 500-line hard limit, AGENTS.md §12). Owns:
 *
 *   - the GAP_RESOLUTION_PLACEHOLDER sentinel, exported for plan-writeback.ts
 *     to key branch-3 detection on the EXACT string parseGaps assigns (the
 *     edge-case pitfall: re-spelling the literal would silently flip the
 *     branch when the parser's placeholder changes),
 *   - `parseGaps`: the reviewer-reply parser (GAP: markers, UNGROUNDED:
 *     third-outcome lines since #638, the verdict line, and — since this split —
 *     a `verdictParsed` flag that keeps an ABSENT verdict from silently
 *     passing as READY when CRITICAL gaps are present (D3)).
 *   - the iteration cap: `evaluateGapGate` decides READY / one corrective
 *     round / cap-hit, and `capRouted` applies the routing policy — the
 *     TERMINAL RULE is CRITICAL-only (direct precedent: /work's adversarial
 *     gate #664, where the measured 83.7% of rejections sat on a verdict
 *     the doctrine called non-blocking, and the fix was a policy terminal
 *     rule, not a findings filter): at the cap, zero CRITICAL gaps FILE
 *     the spec with the residual HIGH/MEDIUM/LOW gaps disclosed in a
 *     "## Residual gap-gate findings" section (D2); CRITICAL remains → the
 *     spec is still filed, with each open CRITICAL listed under "## Open
 *     points" (#1132: the cap no longer refuses filing). With CRITICAL-only blocking, a
 *     ratcheting stream of fresh HIGH findings is structurally incapable of
 *     preventing filing — the findings travel, they are not deduped. The
 *     corrective round likewise fires only on CRITICAL: HIGH no longer
 *     triggers re-drafting, because the gate is non-deterministic on
 *     identical input and "fix the gaps and re-run" is not a convergent
 *     strategy.
 */
import { type GapGateParse, type GapGateVerdict, parseGaps } from "./plan-gap-parse.ts";
import type { PlanGap } from "./plan-types.ts";
import { trace } from "./trace.ts";

/**
 * The gaps that block filing: CRITICAL only. #664 transposed — the
 * terminal rule is a policy decision, not a findings filter: HIGH is the
 * severity the gap gate is non-deterministic on (same descriptor, zero
 * HIGH on one run, six the next), so letting HIGH block makes
 * "fix the gaps and re-run" a non-convergent strategy. HIGH findings
 * travel in the residual disclosure instead of blocking filing.
 *
 * #1132: any CRITICAL triggers the corrective re-draft, as before. No text
 * heuristic decides which CRITICAL counts; at the iteration cap every one still
 * open is listed as an open point in the filed body.
 */
export function blockingGaps(gaps: PlanGap[]): PlanGap[] {
  return gaps.filter((g) => g.severity === "CRITICAL");
}

/**
 * Decide what to do with one parsed gate round.
 *
 * READY — the reviewer said READY (or stayed silent with no CRITICAL gap)
 * AND nothing CRITICAL remains (the CRITICAL-only terminal rule, #664
 * transposed — see `blockingGaps`).
 * NEEDS_ITERATION — otherwise; if there are still corrective rounds left,
 * the driver re-drafts with the blocking (CRITICAL) gaps carried as
 * resolved open questions and re-reviews. A corrective round fires ONLY on
 * CRITICAL: HIGH no longer triggers re-drafting.
 */
export function evaluateGapGate(parsed: GapGateParse, iterations: number, maxIterations: number) {
  const blocking = blockingGaps(parsed.gaps);
  // D3: an ABSENT verdict with a CRITICAL gap present must not pass.
  // The reviewer either stopped mid-reply (mtsn8vox: full review, 4 HIGH
  // gaps, no verdict line) or chose to leave the call open (mtsn8exs — 99 output tokens, stopped mid-reply).
  // Treat the silence as "another round" — the corrective round either
  // gets a real verdict or burns into the cap, which D2 then routes.
  const effectiveVerdict: GapGateVerdict =
    !parsed.verdictParsed && blocking.length > 0 ? "NEEDS_ITERATION" : parsed.verdict;
  const ready = effectiveVerdict === "READY" && blocking.length === 0;
  if (ready) return { ready: true, blocking: [] };
  const corrective = iterations < maxIterations;
  return { ready: false, blocking, corrective, capHit: !corrective };
}

// ---------------------------------------------------------------------------
// runGapGateLoop — the Phase-4 gate loop, extracted from plan-driver.ts
// ---------------------------------------------------------------------------

/**
 * The ACTUAL reason the gap-gate loop stopped. Declared ONCE here and
 * referenced by `PlanResult.capReason` (plan-types.ts) — a member added on
 * either side is forced onto the other (the same single-declaration
 * convention plan-filing.ts carries for FilingFailure).
 */
export type GapGateLoopCapReason =
  | "residual-medium-low"
  | "residual-high"
  | "unresolved-blocking"
  | "verdict-absent"
  | "gate-unavailable"
  /**
   * The reviewer's dispatch SUCCEEDED but its reply carried neither a GAP:
   * line nor a verdict (or a bare NEEDS_ITERATION with nothing to iterate
   * on) — after one strict-contract retry. Nothing was reviewed; the spec
   * must not file. Distinct from gate-unavailable (dispatch failed) and
   * from a genuine clean (VERDICT: READY parsed, zero gaps).
   */
  | "review-unparseable";

export interface GapGateLoopResult {
  gaps: PlanGap[];
  capHit: boolean;
  capReason?: GapGateLoopCapReason;
  residualForDisclosure: PlanGap[];
  /** #1132: the CRITICAL gaps still unresolved at the cap, listed as open points in the filed body. */
  openPoints: PlanGap[];
  /**
   * The head of the raw reply that could not be parsed (review-unparseable
   * only) — a parse failure is a signal about the parser or the reviewer
   * prompt, and discarding it silently means the bug recurs indefinitely.
   */
  rawUnparsedHead?: string;
}

/**
 * Run the gap-gate loop: dispatch the reviewer, parse the reply, decide
 * READY / corrective / cap, and accumulate non-blocking findings across
 * rounds (the residual disclosure is the UNION, not just the last round).
 *
 * Two fixes from the CRITICAL-only terminal rule follow-up:
 *
 * 1. NO-OP ROUND ELIMINATED: a corrective round fires only when blocking
 *    is non-empty (CRITICAL present). With zero CRITICAL, the corrective
 *    branch would iterate over an empty array, push nothing to openQuestions,
 *    and call draftSpec again producing a byte-identical body — a provably
 *    useless second round. The gate goes straight to the cap/file path.
 *
 * 2. UNION DISCLOSURE: non-blocking findings are accumulated across rounds
 *    (deduped by the FULL description string only — no fuzzy matching), so
 *    the residual section discloses what the reviewer found across ALL
 *    rounds, not just the last.
 */
/**
 * The gap-gate dispatch seam the loop runs against.
 *
 * `pi` is deliberately ABSENT from this signature (it was the unbounded
 * generic `P` on the old `runGapGateLoop<P>` — "opaque, threaded
 * opaquely," a type that said nothing). The loop never inspects the
 * dispatch function's `pi` argument — it was threaded through but never
 * used. Removing it makes the seam honest: the loop's contract is
 * "call dispatch with a spec and an optional label" — nothing more.
 *
 * The call site adapts: `dispatchCore` (which DOES take `pi: ExtensionAPI`
 * as its first arg) is wrapped in a closure that binds `pi` outside the
 * loop's seam type. The one-line wrapper at the call site is the "adjust
 * the one call site" the finding asked for.
 */
export type GapGateDispatch = (
  spec: { role: string; prompt: string },
  opts?: { label: string },
) => Promise<{
  ok: boolean;
  errorStop?: unknown;
  text: string;
  toolUses: unknown[];
}>;

export async function runGapGateLoop(
  dispatch: GapGateDispatch,
  // The 1-based round number: round 1 is the full GAP DETECTION review;
  // round 2 (fires only after a CRITICAL corrective re-draft) is the
  // SCOPED VERIFICATION of the carried resolutions (plan-gate-prompt.ts —
  // multi-round full re-review measurably adds noise, arXiv:2603.16244).
  makeGatePrompt: (iteration: number) => string,
  maxIterations: number,
  onCorrective: (blocking: PlanGap[]) => void,
): Promise<GapGateLoopResult> {
  let openPoints: PlanGap[] = [];
  let iterations = 0;
  let ready = false;
  let capHit = false;
  let capReason: GapGateLoopCapReason | undefined;
  let lastGaps: PlanGap[] = [];
  let lastParse: GapGateParse | undefined;
  let rawUnparsedHead: string | undefined;
  // One strict-contract retry per LOOP (not per round): most parse misses
  // are format drift, and one retry is far cheaper than a bad filing.
  let unparseableRetryUsed = false;
  // Problem 2: accumulate non-blocking findings across rounds (union, deduped
  // by exact description string only — no fuzzy matching).
  const seenDescriptions = new Set<string>();
  const allNonBlocking: PlanGap[] = [];

  while (iterations < maxIterations && !ready) {
    iterations++;
    let gate = await dispatch(
      { role: "adversarial-developer", prompt: makeGatePrompt(iterations) },
      { label: `plan-gap-gate-${iterations}` },
    );
    if (!gate.ok || gate.errorStop) {
      capHit = true;
      capReason = "gate-unavailable";
      break;
    }
    lastParse = parseGaps(gate.text);

    // REVIEW-UNPARSEABLE (fail closed — operator bug report 2026-09-09):
    // zero GAP: lines AND (no verdict line, or a bare NEEDS_ITERATION with
    // nothing to iterate on) means NOTHING WAS REVIEWED — that is a fact
    // about the review, not a finding about the spec, and it must never
    // ride the severity ladder to a pass. Retry once with a strict output
    // contract; a second miss stops the loop with its own cap reason.
    // (Zero gaps + a parsed READY verdict is a GENUINE clean and falls
    // through to evaluateGapGate as before.)
    const unreviewed = (p: GapGateParse) =>
      p.gaps.length === 0 &&
      p.ungrounded.length === 0 &&
      (!p.verdictParsed || p.verdict === "NEEDS_ITERATION");
    if (unreviewed(lastParse)) {
      if (!unparseableRetryUsed) {
        unparseableRetryUsed = true;
        trace(
          `plan-gaps: round ${iterations} reply unparseable (no gaps, verdictParsed=${lastParse.verdictParsed}) — one strict-contract retry; raw head: ${gate.text.slice(0, 200).replace(/\n/g, " \\n ")}`,
        );
        gate = await dispatch(
          {
            role: "adversarial-developer",
            prompt: `${makeGatePrompt(iterations)}\n\nSTRICT OUTPUT CONTRACT (your previous reply could not be parsed): output ONLY lines that start with "GAP: " plus the final VERDICT line — no headings, no prose between them. If you found no gaps at all, reply with exactly one line: VERDICT: READY`,
          },
          { label: `plan-gap-gate-${iterations}r` },
        );
        if (!gate.ok || gate.errorStop) {
          capHit = true;
          capReason = "gate-unavailable";
          break;
        }
        lastParse = parseGaps(gate.text);
      }
      if (unreviewed(lastParse)) {
        capHit = true;
        capReason = "review-unparseable";
        rawUnparsedHead = gate.text.slice(0, 300);
        trace(
          `plan-gaps: review unparseable after retry — not filing (raw head: ${rawUnparsedHead.replace(/\n/g, " \\n ")})`,
        );
        break;
      }
    }
    lastGaps = lastParse.gaps;

    // Problem 2: accumulate non-blocking findings (CRITICAL travels via the
    // blocking path; HIGH/MEDIUM/LOW accumulate here for the residual union).
    // The dedupe keys on the FULL description: two distinct findings that
    // share a 300-char prefix are NOT the same finding, and silently
    // dropping the second from the disclosure is exactly what the D2
    // guarantee forbids (lens review, PR #637 finding 1). Truncation
    // happens only at the render sites (truncateForDisclosure).
    for (const g of lastGaps) {
      if (g.severity !== "CRITICAL" && !seenDescriptions.has(g.description)) {
        seenDescriptions.add(g.description);
        allNonBlocking.push({ ...g });
      }
    }

    const evald = evaluateGapGate(lastParse, iterations, maxIterations);
    ready = evald.ready;
    if (!ready && evald.corrective && evald.blocking.length > 0) {
      // Problem 1: corrective round fires ONLY when blocking is non-empty.
      // With zero CRITICAL, the corrective branch would iterate over an
      // empty array, push nothing to openQuestions, and call draftSpec again
      // producing a byte-identical body — a provably useless second round.
      // Go straight to the cap/file path instead.
      // #639 DECISION B: the blocking gaps are passed through PLAIN (no
      // field tagging, no copy). The old spread-copy of the gap with its
      // resolved marker attached existed ONLY to protect that marker field
      // from mutation — a field with zero consumers — and is deleted with
      // it (the decision record is the structured resolvedDecisions parameter
      // draftSpec takes, built by the caller's onCorrective closure via
      // plan-writeback.ts).
      onCorrective(evald.blocking);
    } else if (!ready) {
      // Two cases reach here:
      // (a) at the cap (corrective is false) — the iteration budget is
      //     exhausted; apply the routing policy.
      // (b) zero CRITICAL (blocking is empty) — the corrective round would
      //     be a no-op (empty array, byte-identical body); go straight
      //     to the cap/file path.
      capHit = true;
      // D2 (#1132 addendum): the cap ROUTES, it does not only stop. The driver
      // files the spec: every CRITICAL still unresolved here is an open point
      // listed in the filed body (with its proposal, when the gate gave one), and
      // the non-blocking findings travel as the residual disclosure. The cap's
      // job is to make the unresolved points visible on the issue; the /work
      // intent gate decides later whether the issue is buildable.
      openPoints = evald.blocking;
      // D3: an ABSENT verdict on this terminal round is recorded HERE (it
      // used to be recorded post-loop, but the no-op round elimination made
      // that path unreachable: a zero-CRITICAL single round sets capHit=true
      // in-branch, and a CRITICAL round routes unresolved-blocking instead).
      // The D3 guarantee ("an absent verdict must not silently pass") still
      // lives in evaluateGapGate's override — an absent verdict with a
      // CRITICAL gap routes NEEDS_ITERATION there, never READY. This only
      // qualifies the operator-visible reason.
      capReason =
        !lastParse.verdictParsed && evald.blocking.length === 0
          ? "verdict-absent"
          : evald.blocking.length > 0
            ? "unresolved-blocking"
            : lastGaps.some((g) => g.severity === "HIGH")
              ? "residual-high"
              : "residual-medium-low";
      // The gate has produced its routing decision. Stop here — a second
      // dispatch would be a provably useless no-op (case b) or a cap
      // overrun (case a).
      break;
    }
  }

  // Problem 2: the residual disclosure is the UNION of all non-blocking
  // findings across all rounds (deduped by exact description string).
  const residualForDisclosure = capHit ? allNonBlocking : [];

  return {
    gaps: lastGaps,
    capHit,
    capReason,
    residualForDisclosure,
    openPoints,
    ...(rawUnparsedHead !== undefined ? { rawUnparsedHead } : {}),
  };
}

/**
 * Export seam for tests: `parseGaps` is also exported directly; this alias is
 * kept for existing test imports (the driver runs it directly on the gate
 * child's reply — the parsing logic now lives in plan-gaps.ts). The smoke
 * test reaches it through this alias.
 */
export function parseGapsForTest(reply: string) {
  return parseGaps(reply);
}
