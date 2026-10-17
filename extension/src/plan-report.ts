/**
 * plan-report — the operator-facing rendering of a completed /plan run.
 *
 * Since #1044 this text is NOT the tool's return: the tool returns a launch
 * notice and the run's rendered result travels as one `[ensemble:async]` steer
 * (async-jobs.ts `reportKind: "driver"`). These are the same bytes the blocking
 * tool used to hand back, which is what the plan smoke tests read out of the
 * delivered steer — so the section markers here are a contract with
 * `plan-report-read.ts`, and a rewording is a test failure, not a cosmetic edit.
 *
 * Split out of plan-tool.ts at the AGENTS.md §12 size cap; the prose in each
 * branch carries the incident that produced it.
 */
import { DROPPED_ARTIFACT } from "./plan-dropped-budget.ts";
import { truncateForDisclosure } from "./plan-gap-disclosure.ts";
import type { PlanResult } from "./plan-types.ts";
import { FORGE_BODY_MAX } from "./plan-validate.ts";

/**
 * The head of the dry-run rendering: the sentence the operator-facing result
 * opens with when nothing was filed and the review completed. Shared with
 * `launchNotice` (plan-tool.ts) so the launch text and the eventual steer
 * promise the SAME thing — PM must not be told to "show the spec" to a spec
 * that has not been drafted yet.
 */
export const DRY_RUN_HEAD =
  "PLAN DRY-RUN (nothing filed). Show this spec to the operator. reviewedDigest:";

/** Human-readable duration: sub-minute in seconds, else m+s. */
export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
}

export function renderPlanResult(r: PlanResult, dryRun: boolean): string {
  // #1541 review (MEDIUM) — a cancelled run reports what it was, not the
  // outcome it never reached: `dispatch_kill` and session shutdown now abort
  // the job, and the steer must not render a half-built draft under a
  // "PLAN FILED" / "PLAN DRY-RUN" head the run never earned.
  if (r.cancelled) {
    return `PLAN CANCELLED — killed by ${r.cancelled.by}${r.cancelled.phase ? ` during the ${r.cancelled.phase} phase` : ""}; nothing was filed${dryRun ? " (this was a dry run)" : ""}. Re-call start_plan_driver to run it again.`;
  }
  // The head must NEVER invite filing a halted draft (vipune fixture run,
  // C1: a draft-invalid halt on a dryRun rendered as a clean pass and the
  // head said "re-call with dryRun omitted to file" — the session read it
  // as the gate approving a spec with zero acceptance criteria). Any
  // filingFailure means the spec is not fileable as-is, dryRun or not.
  const halted = !r.filed && !!r.filingFailure;
  const baseHead = halted
    ? `PLAN ${dryRun ? "DRY-RUN — " : ""}NOT FILEABLE AS-IS (${r.filingFailure?.reason}). Nothing was filed${dryRun ? ", and re-calling without dryRun would NOT file this spec either" : ""} — see the FILING STATUS section below before showing this to the operator.`
    : dryRun
      ? r.reviewedDigest
        ? `${DRY_RUN_HEAD} ${r.reviewedDigest} — on their confirmation re-call start_plan_driver with dryRun omitted and reviewedDigest: "${r.reviewedDigest}" to file this exact spec verbatim.`
        : "PLAN DRY-RUN (nothing filed). Show this spec to the operator; on their confirmation re-call start_plan_driver with dryRun omitted to file."
      : r.filed
        ? r.filedFromDryRun
          ? `PLAN FILED FROM REVIEWED DRY RUN (age ${fmtMs(r.filedFromDryRun.ageMs)}) — ${r.issueUrl}. The spec below is the dry run's reviewed body, filed verbatim: no investigation, drafting or gap gate ran. NOT re-checked: the duplicate-risk check against live forge state, and the NEVER CLAIM directives.`
          : `PLAN FILED — ${r.issueUrl}`
        : "PLAN COMPLETED — filing failed or was blocked; see the FILING STATUS section below. The spec is still valid to review.";
  // #1224: the confirmation covered the reviewed spec, not this re-drafted one.
  const changed = r.reviewedSpecChanged
    ? `PLAN NOT FILED — THE REVIEWED SPEC CHANGED. The reviewed dry run could not be filed verbatim (${r.reviewedSpecChanged.reason}), so the full pipeline re-ran and drafted a DIFFERENT spec (below). Nothing was filed: the operator's confirmation does not cover this spec — show it to them and ask again.${r.reviewedDigest ? ` On their confirmation re-call start_plan_driver with dryRun omitted and reviewedDigest: "${r.reviewedDigest}" to file this exact spec verbatim.` : ""}`
    : "";
  const head = !changed ? baseHead : halted ? `${changed}\n\n${baseHead}` : changed;
  const gaps =
    r.gaps.length > 0
      ? r.gaps.map((g) => `- [${g.severity}] ${g.description} → ${g.resolution}`).join("\n")
      : "- (none)";
  const prior =
    r.priorContext.length > 0
      ? r.priorContext
          .slice(0, 10)
          .map((p) => `- [${p.source}] ${p.fact}`)
          .join("\n")
      : "- (none — cold start)";
  // D1: the cap message names the ACTUAL cause (discriminated capReason),
  // instead of the old "unresolved CRITICAL/HIGH gaps remain" which was
  // false when a MEDIUM-only NEEDS_ITERATION verdict burned the rounds.
  // #664 transposed: the terminal rule is CRITICAL-only — residual-high
  // (HIGH findings travel in the disclosure) and residual-medium-low both
  // mean the spec FILED; only unresolved-blocking (CRITICAL remains) does
  // not.
  // Adversarial follow-up: the wording is round-count-agnostic. The no-op
  // round elimination means a MEDIUM-only or HIGH-only NEEDS_ITERATION
  // terminates after a SINGLE dispatch — the old text claimed "the
  // reviewer asked for another iteration" / "fresh findings each round",
  // both false when one round ran. Lead with the load-bearing fact (the
  // spec WAS filed), same defect class D1 fixed. The inline list uses the
  // UNION (residualForDisclosure) to match the filed body's residual
  // section, which also uses the union — the old last-round-only list
  // could omit a round-1 finding the body discloses (2-round
  // CRITICAL-then-HIGH case).
  // The old `&& r.gaps.length > 0` guard made gate-unavailable — whose
  // parse yields ZERO gaps — invisible on a dryRun. capHit alone earns the
  // block (vipune fixture run, C1 follow-up).
  let cap = "";
  if (r.capHit) {
    // The inline list renders the SAME union as the filed body's residual
    // section, through the SAME single truncation (truncateForDisclosure) —
    // the two render sites cannot drift (lens review, PR #637 finding 1;
    // the PERFORMANCE lens flagged the drift risk specifically).
    const residual = (r.residualForDisclosure ?? [])
      .map((g) => `[${g.severity}] ${truncateForDisclosure(g.description)}`)
      .join(", ");
    if (r.capReason === "unresolved-blocking") {
      cap = `\n\nGAP GATE CAP HIT: after the iteration cap, unresolved CRITICAL gaps remain (listed under GAP DISPOSITIONS). ${r.filed ? "The spec was FILED with them under '## Open points' in the issue body; the /work intent gate decides whether the issue is buildable." : "Nothing was filed (dry run): a confirmed run files them under '## Open points'."}`;
    } else if (r.capReason === "residual-high") {
      cap = `\n\nGAP GATE CAP HIT: the reviewer returned HIGH findings alongside MEDIUM/LOW items (${residual}); with no CRITICAL gap the spec is FILED with the residual findings disclosed in the issue body (see '## Residual gap-gate findings'). HIGH findings travel in that disclosure — the terminal rule is CRITICAL-only.`;
    } else if (r.capReason === "residual-medium-low") {
      cap = `\n\nGAP GATE CAP HIT: the reviewer returned only MEDIUM/LOW findings (${residual}); with no CRITICAL gap the spec is FILED with the residual findings disclosed in the issue body (see '## Residual gap-gate findings').`;
    } else if (r.capReason === "verdict-absent") {
      cap =
        "\n\nGAP GATE NOTE: the reviewer never wrote a verdict line; no CRITICAL gap was found, so the spec proceeded — but the absence is recorded here (the gate did not explicitly say READY).";
    } else if (r.capReason === "gate-unavailable") {
      cap =
        "\n\nGAP GATE UNAVAILABLE: the gap-gate dispatch itself failed, so no reviewer ever saw the spec. It was NOT filed — the spec above is still valid to review, but re-run start_plan_driver after the gate failure is addressed (see the FILING STATUS below).";
    } else if (r.capReason === "review-unparseable") {
      cap =
        "\n\nGAP GATE REVIEW UNPARSEABLE: the reviewer replied, but its output carried no structured findings and no verdict — even after one strict-contract retry. The spec was NOT reviewed and is NOT fileable (distinct from a clean review, which renders '(none)' below). Re-run start_plan_driver to retry the gate.";
    } else {
      cap = "\n\nGAP GATE CAP HIT: the iteration cap was reached. See the gap dispositions below.";
    }
  }
  // D7: the filing failure reason is DISCRIMINATED and surfaced — the
  // forge stderr (when there is one) reaches the operator without
  // PI_ENSEMBLE_DEBUG. Rendered on dryRun too (C1): the halt reasons are
  // set BEFORE filing would happen, and hiding them behind !dryRun is what
  // made a rejected draft look like a clean pass.
  let filingStatus = "";
  if (!r.filed && r.filingFailure) {
    const f = r.filingFailure;
    if (
      f.reason === "gate-unavailable" ||
      f.reason === "needs-clarification" ||
      f.reason === "draft-invalid" ||
      f.reason === "duplicate-risk" ||
      f.reason === "review-unparseable" ||
      f.reason === "body-too-large" ||
      // #1541 — a cancellation is neither a policy skip nor a forge fault, but
      // it is not a filing failure either; the head already says CANCELLED.
      f.reason === "cancelled"
    ) {
      // Deliberate skip (not a failure): the cap routed to surface (a
      // CRITICAL gap remains — CRITICAL-only blocks, #664 transposed; HIGH
      // findings travel in the residual disclosure instead), the gap gate
      // never ran (no reviewer saw the spec — re-run after the gate failure
      // is addressed), the deterministic precheck asked for clarification
      // before any dispatch, or the drafted body failed deterministic
      // validation. The spec is not filed by policy; no forging happened.
      filingStatus = `\n\n=== FILING STATUS ===\nNot filed (by policy): ${f.detail}`;
    } else {
      filingStatus = `\n\n=== FILING STATUS ===\nFiling did not complete. Reason: ${f.reason}${f.detail ? ` — ${f.detail}` : ""}. The spec above is still valid to review and can be re-run after the cause is addressed.`;
    }
  }
  // Failed investigation angles surface HERE too, not only inside the spec
  // body — the operator must see the hole without reading the whole draft.
  const investigation =
    r.failedAngles && r.failedAngles.length > 0
      ? `\n\n=== INVESTIGATION STATUS ===\n${r.failedAngles.length} angle(s) FAILED — their surface is uninvestigated:\n${r.failedAngles.map((a) => `- ${a.name}: ${a.detail}`).join("\n")}`
      : "";
  const reusedNote = r.investigationReused
    ? `\n\n=== INVESTIGATION REUSED ===\nThe duplicate-risk and angle investigation (and the inventory) was reused from the confirmed dry run ${fmtMs(r.investigationReused.ageMs)} ago — the descriptor, context, type and origin/<default> commit are unchanged. The working tree was NOT compared: uncommitted edits made after the dry run are not reflected in the reused investigation. Drafting, validation and the gap gate re-ran.`
    : "";
  const baseNote = r.baseFallback
    ? `\n\n=== BASE FALLBACK ===\nInvestigators read the local checkout, not origin/<default>: ${r.baseFallback}. The investigation cache was not used for this run.`
    : "";
  const compactedNote = r.compacted
    ? `\n\nCOMPACTED: the body was deterministically compacted to fit the forge's ${FORGE_BODY_MAX}-char limit (a disclosure line inside the body says how; full findings live in ${r.droppedListFile ?? DROPPED_ARTIFACT}).`
    : "";
  const timingsLine =
    r.timings && r.timings.length > 0
      ? `\n\n=== TIMINGS ===\n${r.timings.map((t) => `${t.phase} ${fmtMs(t.ms)}`).join(" · ")}`
      : "";
  return `${head}

Title: ${r.title}
Type: ${r.type}

=== SPEC (the issue body) ===
${r.spec}

=== GAP DISPOSITIONS ===
${gaps}

=== PRIOR CONTEXT ATTRIBUTION ===
${prior}${reusedNote}${investigation}${baseNote}${cap}${filingStatus}${compactedNote}${timingsLine}`;
}
