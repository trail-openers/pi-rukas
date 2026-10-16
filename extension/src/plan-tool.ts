/**
 * plan-tool — the compiled `start_plan_driver` tool.
 *
 * `/plan` used to be a 473-line prose body sent into PM's context, which PM
 * then executed by hand — with a self-judged "triviality test" and no gate
 * between that self-judgment and `gh issue create`. The fix follows the
 * `start_work_driver` precedent (work-tool.ts): a compiled driver PM calls
 * instead of a prose flow PM re-implements, plus the mode-independent
 * issue-creation guard (issue-creation-guard.ts) that makes the replacement
 * safe by closing every other door.
 *
 * The driver (plan-driver.ts) runs the five-phase pipeline:
 *
 *   Phase 0  Classify   regex on the descriptor (or the `type` param)
 *   Phase 1  Inventory  vipune + `gh issue list` run by the driver; one
 *                       explore dispatch for duplicate risk
 *   Phase 2  Investigate type-specialised explore angles in parallel
 *   Phase 3  Draft      the driver assembles the structured body
 *   Phase 4  Gap gate   one adversarial-developer dispatch; CRITICAL gets
 *                       one corrective pass (CRITICAL-only terminal rule,
 *                       #664 transposed — HIGH/MEDIUM/LOW never re-draft),
 *                       then the residual findings travel with the spec
 *   Phase 5  File       `gh issue create --body-file` via execp
 *
 * **dryRun is the confirmation seam.** `dryRun: true` returns
 * `{ spec, gaps, priorContext, filed: false }` without filing; PM shows the
 * spec + gap disposition to the operator; on confirmation the driver is
 * re-called with `dryRun` omitted and files. Non-resumable by design (a
 * 2-5 minute flow; re-running is cheaper than a state file).
 *
 * #1043: an identical confirm of a FILEABLE dry run files the reviewed spec
 * verbatim (plan-confirm.ts) with no investigation, drafting or gate.
 *
 * The driver's own filing is a child-process exec — exempt from the
 * tool_call guard by construction, exactly like the work driver's
 * mechanized `gh pr create`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runPlanPipeline } from "./plan-driver.ts";
import { truncateForDisclosure } from "./plan-gap-disclosure.ts";
import {
  MAX_LABELS,
  MAX_MARKER_PAIRS,
  MAX_PROVENANCE_LINE,
  normalizeLabels,
  validateProvenance,
} from "./plan-provenance.ts";
import type { PlanDriverInput, PlanResult } from "./plan-types.ts";
import { trace } from "./trace.ts";
import { piSessionHost } from "./work-driver-host.ts";
import { resolveRepoRoot } from "./work-entry.ts";

/**
 * The shape of a registered `start_plan_driver` tool def — shared with the
 * test harness (plan-test-stubs.ts: invokePlanTool) so the dry-run e2e
 * blocks can drive the tool without the full ExtensionAPI surface.
 */
export interface RegisteredPlanTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...a: unknown[]) => Promise<unknown>;
}

export function registerPlanTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_plan_driver",
    label: "Start /plan Driver",
    description:
      "Run the compiled /plan pipeline (classify → inventory → type-specialised investigation → draft → adversarial gap gate → file) and file the resulting GitHub issue. This is the ONLY way to create a GitHub issue: direct `gh issue create` (and `gh api` POST to the issues collection) is structurally refused for every role in every mode — the refusal names this tool. Call with dryRun:true FIRST to return { spec, gaps, priorContext, filed:false } without filing; show the spec + gap dispositions to the operator, and on their confirmation re-call with dryRun omitted to file. The result includes issueUrl on success. A dry run reports a reviewedDigest; re-calling with identical inputs (same descriptor, context, type and origin/<default> commit, within the expiry — 2 hours by default) and that digest files the reviewed spec VERBATIM, with no investigation, drafting or gap gate (the result says FILED FROM REVIEWED DRY RUN). Any other call — a changed input, a missing or wrong digest, an expired or non-fileable dry run — runs the full pipeline, which reuses the investigation and re-runs the gate; when that call carried a reviewedDigest and the pipeline drafts a different spec, nothing is filed and the result says THE REVIEWED SPEC CHANGED — show the new spec and ask again. Epic sub-issues at depth >= 3 get a minimal body with a depth-limit note. Gap gate: runs for bug/feature/epic; chore/spike get deterministic validation only. A too-thin descriptor (below the word floor, no code identifier, no context) returns needs-clarification questions without dispatching anything — answer them and re-call. Non-resumable: a failed run is re-run, not resumed.",
    parameters: Type.Object({
      descriptor: Type.String({
        description: "Ticket descriptor — one or two sentences describing the intended change.",
      }),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("bug"),
            Type.Literal("feature"),
            Type.Literal("epic"),
            Type.Literal("chore"),
            Type.Literal("spike"),
          ],
          {
            description:
              "Override the type classification (default: inferred from the descriptor).",
          },
        ),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Prior /research findings or session facts to treat as established (not re-investigated). Typed directive blocks are the trusted channel: a heading (ACCEPTANCE CRITERIA, PITFALLS/EDGE CASES, OUT OF SCOPE, TEST SURFACE, DECOMPOSITION/SUB-ISSUES, NEVER CLAIM/FORBIDDEN — plain, ##, ===, ** or *-wrapped, ':' optional) opens a block whose bulleted or contiguous lines become that section's items verbatim. A block ends at the next heading, an END fence ('TEST SURFACE END' or a bare END line; BEGIN fences are consumed, never items), or a blank line followed by a non-bullet line — trailing prose after a block stays plain context. NEVER CLAIM items are verbatim forbidden phrases: each structured investigation item whose normalized text contains one as an exact normalized substring is dropped before drafting (disclosed, never silent), the phrases are threaded into every investigation and gap-gate prompt, and the drafted body is asserted phrase-free outside the Prior context inventory section.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Return the structured spec + gap dispositions WITHOUT filing. Call first; on operator confirmation, re-call with dryRun omitted.",
        }),
      ),
      reviewedDigest: Type.Optional(
        Type.String({
          description:
            "The reviewedDigest a dry run reported. Echo it on the confirming call to file that exact reviewed spec verbatim; without it, or on a mismatch, the full pipeline runs. The digest also covers labels and provenance: a confirm that changes either is a digest mismatch and files nothing.",
        }),
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: `Labels to create the filed issue with, in the same single forge call — so they are on the issue from its first moment (a follow-up edit leaves a window where an auto-filed ticket reads as manual work to everything watching the tracker). At most ${MAX_LABELS}; each 1-50 chars matching ^[A-Za-z0-9][A-Za-z0-9:._ /-]*$ (spaces and ':' allowed, no comma). Invalid input is refused BEFORE any dispatch with an invalid-input error naming what is wrong. Every label must already exist on the target repo: a missing one halts filing with filingFailure.reason "label-missing" and NOTHING is filed — the driver never creates a label as a side effect of filing. The result gains issueNumber alongside issueUrl. Omit for today's behaviour exactly.`,
        }),
      ),
      provenance: Type.Optional(
        Type.Object(
          {
            line: Type.String({
              description: `One line of at most ${MAX_PROVENANCE_LINE} chars, rendered as the FIRST line of the issue body in italics followed by a blank line. Any '@', '<', '>', backtick, CR or LF is REJECTED (not escaped, not stripped), so the line can never mention an account, inject markup, or open a heading of the body the driver did not write.`,
              // The schema MIRRORS `FORBIDDEN_LINE_CHARS` rather than relying on
              // it alone: the validators in plan-provenance.ts are the authority
              // (they produce the named `invalid-input` problems), and this is
              // the second net — a caller reading the tool schema sees the shape
              // it must send, and a caller that bypasses the validators (a future
              // in-process path) still cannot get a newline into the first line.
              // A `\n` here is a heading-injection: `"ok\n## Open points"` files a
              // section the driver never wrote, under the heading the /work intent
              // gate reads for blocking gaps.
              pattern: "^[^@<>`\\r\\n]+$",
              maxLength: MAX_PROVENANCE_LINE,
            }),
            marker: Type.Record(Type.String(), Type.String(), {
              description: `Structured pairs, rendered as the LAST line of the body as \`<!-- pi-rukas:provenance v1 k1=v1 k2=v2 ... -->\` in sorted key order. At most ${MAX_MARKER_PAIRS}; keys match ^[a-z][a-z0-9_-]{0,31}$, values match ^[A-Za-z0-9._,:/#@+=-]{1,200}$ (no spaces or newlines; '@' IS allowed in a value — the account prohibition is on \`line\` only). Written by code after drafting, never by an LLM stage, and reserved out of the body budget so compaction cannot trim it.`,
            }),
          },
          {
            description:
              "Mark a filed issue as machine-filed: an italic line atop the body and an HTML-comment marker at its foot. Both are appended by code after drafting.",
          },
        ),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      // Pi hands the tool a JSON value. Widening to `Record<string, unknown>`
      // says exactly that — "fields not yet examined" — and every field is then
      // narrowed by a validator before use: `descriptor`/`dryRun`/`reviewedDigest`
      // by the guards here, `labels` by `normalizeLabels` (which rejects a
      // non-array, a non-string member and a sparse array), `provenance` by
      // `validateProvenance` (which requires a plain object with own string
      // keys). An earlier shape-named cast here claimed a `labels: string[]`
      // that nothing had checked yet, which is how a malformed caller would
      // reach the create call with bytes this module never examined.
      const params = raw as Record<string, unknown>;
      const descriptor = params.descriptor;
      if (typeof descriptor !== "string" || descriptor.trim().length === 0) {
        return {
          content: [{ type: "text", text: "start_plan_driver requires a non-empty descriptor." }],
          details: { started: false },
        };
      }
      const dryRun = params.dryRun === true;
      // #1377: labels and provenance are validated here, BEFORE any dispatch.
      // A caller that mistypes a label name gets a named error for the cost of
      // one tool call, not a five-minute pipeline that then halts at the forge;
      // and nothing can reach the create call with bytes this module did not
      // check (a label with a comma would break glab's comma-separated list, a
      // '@' or a newline in the line would name an account or open a heading in
      // visible text).
      const labelCheck = normalizeLabels(params.labels ?? []);
      if (!labelCheck.ok) {
        return invalidInput("labels", labelCheck.problems);
      }
      const provenanceCheck =
        params.provenance === undefined
          ? { ok: true as const, provenance: undefined }
          : validateProvenance(params.provenance);
      if (!provenanceCheck.ok) {
        return invalidInput("provenance", provenanceCheck.problems);
      }
      const labels = labelCheck.labels;
      const provenance = provenanceCheck.provenance;
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      trace(
        `start_plan_driver → descriptor="${descriptor.slice(0, 60)}" type=${String(params.type ?? "inferred")} dryRun=${dryRun} labels=${labels.length} provenance=${provenance ? "yes" : "no"} repoRoot=${repoRoot}`,
      );
      try {
        const result = await runPlanPipeline(
          piSessionHost(pi),
          // The typed view of the call: the four fields the driver reads by
          // name, with the three the validators just narrowed substituted. The
          // cast carries no unchecked field into the driver — `type` is the only
          // one left as the caller wrote it, and the driver re-classifies an
          // unrecognised value.
          {
            ...(params as Omit<PlanDriverInput, "labels" | "provenance" | "descriptor">),
            descriptor,
            labels,
            provenance,
          },
          repoRoot,
        );
        return {
          content: [
            {
              type: "text",
              text: renderPlanResult(result, dryRun),
            },
          ],
          details: resultDetails(result, dryRun),
        };
      } catch (err) {
        trace(`start_plan_driver failed: ${(err as Error).message}`);
        return {
          content: [
            {
              type: "text",
              text: `start_plan_driver failed: ${(err as Error).message}`,
            },
          ],
          details: { started: false, error: (err as Error).message },
        };
      }
    },
  });
}

/**
 * #1377: the pre-dispatch rejection of malformed labels / provenance. A NAMED
 * error (`invalid-input`) with every problem listed, and `started: false` so a
 * caller can tell a refused call from a run that filed nothing.
 */
function invalidInput(field: string, problems: string[]) {
  const text = `start_plan_driver refused: invalid ${field}. ${problems.join("; ")}`;
  trace(`start_plan_driver: invalid ${field} — ${problems.join("; ")}`);
  return {
    content: [{ type: "text" as const, text }],
    details: { started: false, error: `invalid-input: ${field}`, problems },
  };
}

function renderPlanResult(r: PlanResult, dryRun: boolean): string {
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
        ? `PLAN DRY-RUN (nothing filed). Show this spec to the operator. reviewedDigest: ${r.reviewedDigest} — on their confirmation re-call start_plan_driver with dryRun omitted and reviewedDigest: "${r.reviewedDigest}" to file this exact spec verbatim.`
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
      f.reason === "body-too-large"
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
    ? "\n\nCOMPACTED: the body was deterministically compacted to fit the forge's 65,536-char limit (a disclosure line inside the body says how; full findings live in the run transcripts)."
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

/** Human-readable duration: sub-minute in seconds, else m+s. */
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
}

function resultDetails(r: PlanResult, dryRun: boolean): Record<string, unknown> {
  const d: Record<string, unknown> = {
    started: true,
    type: r.type,
    title: r.title,
    filed: r.filed,
    dryRun,
    gapCount: r.gaps.length,
    capHit: r.capHit ?? false,
    residualForDisclosure: r.residualForDisclosure,
  };
  if (r.issueUrl) d.issueUrl = r.issueUrl;
  // #1377: the number the driver parsed from the created issue's URL, so an
  // automated caller does not have to. Absent when the URL carried no number.
  if (typeof r.issueNumber === "number") d.issueNumber = r.issueNumber;
  if (r.capReason) d.capReason = r.capReason;
  if (r.filingFailure) d.filingFailure = r.filingFailure;
  if (r.failedAngles) d.failedAngles = r.failedAngles;
  if (r.compacted) d.compacted = true;
  if (r.investigationReused) d.investigationReused = r.investigationReused;
  if (r.reviewedDigest) d.reviewedDigest = r.reviewedDigest;
  if (r.filedFromDryRun) d.filedFromDryRun = r.filedFromDryRun;
  if (r.reviewedSpecChanged) d.reviewedSpecChanged = r.reviewedSpecChanged;
  if (r.timings) d.timings = r.timings;
  return d;
}
