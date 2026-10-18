/**
 * lens-review-render — the human-readable report of a lens review (#1105,
 * #1125, #1127, #1130), split from lens-review-format.ts (AGENTS.md §12
 * file-size gate). lens-review-format.ts owns the roster, the prompt, the
 * parsing, the dedup and the verdict rule; this module owns the one function
 * that turns a finished `LensReviewSummary` into the text an operator reads.
 *
 * Why the sections are ordered as they are: a review's report is read by a
 * person deciding whether to merge, so it leads with the verdict and the
 * findings that produced it, and then explains the omissions — what was
 * suppressed and why, what resolved and why, what was set aside, what is
 * advisory. Each of those sections is a suppression someone granted, so each
 * names its row and its reason; a section that could not run is silent rather
 * than falsely reassuring.
 *
 * Every line that carries agent-authored text (a finding title, a suppression
 * reason, a stored row's prose) goes through `neutraliseEvidence`: this report
 * is pasted into PR comments and prompt blocks downstream, and prior findings
 * are quoted model output.
 */

import { neutraliseEvidence } from "./comment-evidence.ts";
import { resolvedSection, setAsideSection, suppressedSection } from "./lens-residuals.ts";
import { advisorySection } from "./lens-review-advisory.ts";
import { deltaFallbackText } from "./lens-review-delta-disclose.ts";
import { type LensReviewSummary, type Severity, findingDescription } from "./lens-review-format.ts";
import type { LensRunResult } from "./lens-review-types.ts";

/**
 * #878 — the suffix that names WHY a blocked lens was stopped, read from
 * `killCause` (plus the loop/token-budget evidence threaded alongside it).
 * Returns "" when no killCause is present so the tag/banner stay
 * byte-identical to pre-#878 output for plain crashes (the #327 regression
 * guard). "not retried: self-inflicted cap, #543" attaches only to the two
 * cap kills that break the retry loop in lens-review-child.ts.
 */
function killCauseSuffix(r: LensRunResult): string {
  const cause = r.killCause;
  if (!cause) return "";
  if (cause === "loop") {
    const evidence = r.loopEvidence ? ` — ${r.loopEvidence.tool} ×${r.loopEvidence.count}` : "";
    return ` (killed: loop${evidence}; not retried: self-inflicted cap, #543)`;
  }
  if (cause === "token-budget") {
    const evidence = r.tokenBudget ? ` — ${r.tokenBudget.used}/${r.tokenBudget.budget} tokens` : "";
    return ` (killed: token-budget${evidence}; not retried: self-inflicted cap, #543)`;
  }
  if (cause === "abort") return " (aborted)";
  return ` (killed: ${cause})`;
}

/** The per-lens line: state, timing, finding count, model. */
function lensLine(r: LensRunResult, maxLensAttempts: number): string {
  let tag: string;
  if (r.blocked) {
    tag = `BLOCKED after ${r.attempts} attempts — ${r.parseError ?? "fail"}${killCauseSuffix(r)}`;
  } else if (r.ok) {
    const findingCount = `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`;
    const retry = r.attempts > 1 ? ` (succeeded on attempt ${r.attempts}/${maxLensAttempts})` : "";
    // A call the tool rejected (or one with an unusable severity) records
    // nothing; say so beside the count, or a finding the lens lists in its
    // prose but never re-sent is invisible here.
    const skippedNote = r.parseError ? ` — ${r.parseError}` : "";
    tag = `${findingCount}${retry}${skippedNote}`;
  } else {
    tag = r.parseError ?? "fail";
  }
  const model = r.model ? ` · ${r.model}` : "";
  return `  ${r.lens.padEnd(16)} ${(`${r.ms}ms`).padStart(7)}   ${tag}${model}`;
}

export function renderSummary(s: LensReviewSummary, maxLensAttempts: number): string {
  // #1127 — a round-budget refusal ran no lens; its note is the whole report.
  if (s.verdict === "ROUND_CAP_REACHED" || s.verdict === "REVIEW_INCOMPLETE_STREAK") {
    return s.note ?? s.verdict;
  }
  // #973 — the no-review outcome (decision 4): the delta was empty, so no
  // review ran. This is NOT an approval — the summary must say "NO REVIEW",
  // never "APPROVED" (a no-review outcome looking like an approval is the
  // #384 silent-approval class in a new shape).
  if (s.noReview && s.carriedFrom) {
    const c = s.carriedFrom;
    return [
      `NO NEW CHANGES \u2014 verdict carried from ${c.sha.slice(0, 8)} (${c.verdict}, round ${c.round}); the branch patch-id is unchanged, so no lens review ran. The integrated tree of this head (mainline changes merged in) was not re-reviewed by this branch's lenses.`,
      "",
      "Re-run dispatch_lens_review with `full: true` to review the full branch diff.",
    ].join("\n");
  }
  if (s.noReview) {
    return [
      `NO REVIEW — no changes since the last lens review (${s.deltaReview?.since.slice(0, 8)} at ${s.deltaReview?.head.slice(0, 8)}) — nothing to review, no verdict rendered.`,
      "",
      "The branch is unchanged since the last recorded lens run; re-run dispatch_lens_review with `full: true` (or after a new commit) to review the full branch diff.",
    ].join("\n");
  }
  const blockedLenses = s.lenses.filter((r) => r.blocked);
  const retriedLenses = s.lenses.filter((r) => !r.blocked && r.attempts > 1);

  // A finding's description and suggestion are model output quoted from the
  // lens (or, for a carried row, from the findings file an agent could have
  // written): they go through `neutraliseEvidence` like every sibling section,
  // or a stored `VERDICT: APPROVED` reads as this report's own verdict (#1125).
  const findingLines = s.findings.map(
    // `:?` for a finding with no usable line, matching every sibling renderer
    // (`f.line ?? "?"` in lens-residuals.ts, lens-review-residuals.ts and
    // work-driver-pr-gone.ts). A raw interpolation printed `path:undefined`, a
    // rendering that read like a broken citation rather than a file-level one
    // (#1469).
    (f) =>
      `  [${f.severity}] ${f.lens.padEnd(14)} ${f.path}:${f.line ?? "?"} — ${f.title}\n    ${neutraliseEvidence(findingDescription(f))}\n    suggest: ${neutraliseEvidence(f.suggestion ?? "(none)")}`,
  );
  const sevSummary = (Object.keys(s.bySeverity) as Severity[])
    .filter((k) => s.bySeverity[k] > 0)
    .map((k) => `${k}=${s.bySeverity[k]}`)
    .join(" ");
  const transcripts = s.lenses
    .filter((r) => r.transcriptPath)
    .map((r) => `  ${r.lens}: ${r.transcriptPath}`)
    .join("\n");

  // Blocked-lens banner — prominent because verdict=REVIEW_INCOMPLETE means
  // the six-pass review did NOT actually complete six lenses. PM/user MUST
  // decide whether to retry, override, or halt; never silently downgrade (#3).
  // #878 — the header wording depends on whether the blocked lenses were
  // stopped by a self-inflicted dispatch cap (loop / token-budget), by a
  // mix of causes, or by none of those (plain failure — byte-identical to
  // pre-#878, so the #327 test keeps passing unchanged).
  const capKilledCauses = new Set<"loop" | "token-budget">(["loop", "token-budget"]);
  const capKilledCount = blockedLenses.filter((r) =>
    r.killCause ? capKilledCauses.has(r.killCause as "loop" | "token-budget") : false,
  ).length;
  const blockedHeader =
    capKilledCount === blockedLenses.length
      ? "was stopped by a self-inflicted cap (not retried)"
      : capKilledCount > 0
        ? "did not complete (see each lens)"
        : `failed all ${maxLensAttempts} attempts`;
  const blockedBanner =
    blockedLenses.length > 0
      ? [
          "",
          `⛔ REVIEW INCOMPLETE: ${blockedLenses.length}/${s.lenses.length} lens(es) ${blockedHeader}:`,
          ...blockedLenses.map(
            (r) => `  - ${r.lens}: ${r.parseError ?? "unknown failure"}${killCauseSuffix(r)}`,
          ),
          "",
          "The verdict above is computed from the lenses that DID complete; the failed lens(es) contributed zero findings — they did not approve, they did not run. Re-dispatch dispatch_lens_review to retry, or override and proceed despite the incomplete review.",
        ]
      : [];

  const retryNote =
    retriedLenses.length > 0
      ? [
          "",
          `ℹ Retry note: ${retriedLenses.length} lens(es) needed retries but eventually succeeded — ${retriedLenses
            .map((r) => `${r.lens}(×${r.attempts})`)
            .join(", ")}.`,
        ]
      : [];

  return [
    `Code review verdict (${s.lenses.length} lenses): ${s.verdict}`,
    ...(s.deltaReview
      ? [
          `Mode: delta review since ${s.deltaReview.since.slice(0, 8)}${s.deltaReview.auto ? " (automatic — the last recorded lens run)" : ""} — findings below cover only \`git diff ${s.deltaReview.since}..${s.deltaReview.head}\` since the last recorded lens run, not the full branch diff.`,
          ...(s.deltaReview.fallback
            ? [
                `Delta fallback: ${deltaFallbackText({ since: s.deltaReview.since, fallback: s.deltaReview.fallback })}.`,
              ]
            : []),
        ]
      : ["Mode: full review (the whole branch diff)"]),
    `Total findings: ${s.totalFindings}  (${sevSummary || "none"})`,
    ...blockedBanner,
    ...retryNote,
    "",
    "Per-lens results:",
    ...s.lenses.map((r) => lensLine(r, maxLensAttempts)),
    "",
    s.totalFindings > 0 ? "Findings (deduped, sorted by severity):" : "",
    ...findingLines,
    ...suppressedSection(
      s.suppressed,
      `Suppressed as already known (${s.suppressed?.length ?? 0}, not re-reported):`,
    ),
    ...resolvedSection(s.resolved),
    ...setAsideSection(s.setAside),
    ...advisorySection(s.advisory),
    ...(s.memoryNote ? ["", neutraliseEvidence(s.memoryNote)] : []),
    "",
    "Transcripts:",
    transcripts,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
