/**
 * work-driver-merge-authority — may this cycle merge?
 *
 * Merging is the one irreversible act in the cycle and was the least guarded.
 * Before this module:
 *
 *   - **No authority gate existed at all.** `grep -rniE "merge.?polic|allowed
 *     to merge|automerge|canMerge"` over `src/` returned nothing. The driver
 *     merged whenever the cycle reached the `merged` step, so auto-merge was
 *     effectively default-ON.
 *   - **Merging was decided by a substring in an LLM's reply** —
 *     `text.includes("ci-status: success")`. The driver never called
 *     `gh pr checks`, never read `mergeStateStatus`, never checked reviews.
 *
 * Two independent things have to be true now, and both default to "no":
 *
 *   1. **Authority** — someone explicitly permitted merging. Either the
 *      project's own documents say so, or the operator granted it for the run.
 *      Absent a grant the PR is opened and the cycle parks; a repo that never
 *      opted in never gets an auto-merge. Since #407 the documents are read by
 *      a judge child and its answer is citation-verified, rather than matched
 *      against three English regexes that got real files wrong in both
 *      directions — see `work-driver-policy.ts`.
 *   2. **Evidence** — required checks actually passed, per `gh`, not per an
 *      agent's narration. That half lives in `work-driver-merge-evidence.ts`
 *      (#1533 split: this file never reads a doctrine file and that one never
 *      reads a doctrine file); it is re-exported here so callers and their
 *      tests keep importing both halves from the gate they already know.
 *
 * No vendor auto-merges agent PRs today (Copilot's docs require a second
 * reviewer and explicitly do not count the agent's own approval), so there is
 * no gate-set to copy. This one is constructed, and deliberately conservative
 * in both directions.
 */

import type { DecisionWhere } from "./decision-seam.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import { MERGE_POLICY_QUESTION, type PolicyJudgeFn, askPolicy } from "./work-driver-policy.ts";
import type { DoctrineDoc } from "./work-driver-policy.ts";
import type { EvidenceFailureKind } from "./workflow-state-cap.ts";
import type { WorkEvent } from "./workflow-state.ts";

export type { EvidenceFailureKind } from "./workflow-state-cap.ts";

export {
  type MergeEvidence,
  gatherMergeEvidence,
  contradictsSuccess,
} from "./work-driver-merge-evidence.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = VerifyExecFn;

export type AuthoritySource =
  | "agents-md"
  | "doctrine"
  | "operator"
  | "none"
  /** The judge answered "permitted" but cited a sentence that is not in the file. */
  | "citation-failed";

export interface MergeAuthority {
  granted: boolean;
  source: AuthoritySource;
  /** Verbatim evidence of the grant, for the handoff and the merged event. */
  quote?: string;
  /** Operator-facing explanation — why granted, or why not. */
  reason?: string;
}

/**
 * #380 escape hatch: PI_ENSEMBLE_MERGE_AUTHORITY=0 restores the pre-#380
 * behaviour of merging without checking whether anyone allowed it.
 */
export function mergeAuthorityEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
  return v !== "0" && v !== "false";
}

/**
 * Resolve whether merging is permitted for this cycle.
 *
 * Two tiers, and only the first is repo-controlled:
 *
 *   1. **Durable, in code.** Default deny; the operator's `--merge` grant;
 *      `PI_ENSEMBLE_MERGE_AUTHORITY=0`. A repository cannot alter these — per
 *      the research, a checked-in file or a build step could otherwise inject
 *      its own allow rules.
 *   2. **Prose, judged and citation-verified.** The project's own documents
 *      may grant the exception, in any language, phrased however the operator
 *      likes. `askPolicy` puts the question to a judge child and honours the
 *      answer only if the sentence it quotes actually exists. See
 *      `work-driver-policy.ts` for why the judge is not trusted.
 *
 * Prose grants the exception; it can never grant the rule.
 *
 * The `docs` come from `readDoctrineAtBase` (#406) — doctrine as of the
 * cycle's base commit, never the working tree, which by this step contains
 * whatever the developer subagents wrote.
 */
export async function resolveMergeAuthority(
  judge: PolicyJudgeFn,
  docs: readonly DoctrineDoc[],
  operatorGrant?: boolean,
  where?: DecisionWhere,
): Promise<MergeAuthority> {
  return decideMergeAuthority(judge, docs, operatorGrant, where);
}

async function decideMergeAuthority(
  judge: PolicyJudgeFn,
  docs: readonly DoctrineDoc[],
  operatorGrant: boolean | undefined,
  where: DecisionWhere | undefined,
): Promise<MergeAuthority> {
  // Tier 1 — durable, in code. The escape hatch is not a thing a repository can
  // write into its own documents, so it is answered before any document is read.
  if (!mergeAuthorityEnabled()) {
    return {
      granted: true,
      source: "doctrine",
      reason: "PI_ENSEMBLE_MERGE_AUTHORITY=0: the authority gate is disabled for this process.",
    };
  }
  // Tier 1 — the operator's in-session grant. It is the human's own answer, so
  // like the escape hatch it is answered WITHOUT consulting the judge: asking an
  // LLM whether a human is allowed to allow something is not a question that
  // can veto the human, and the judge child would be spawned on every `--merge`
  // run for nothing.
  if (operatorGrant === true) {
    return {
      granted: true,
      source: "operator",
      quote: "operator granted merge for this run",
    };
  }

  // Tier 2 — prose, judged. A repository may grant the exception in its own
  // words; nothing it writes can create the rule.
  const verdict = await askPolicy(judge, MERGE_POLICY_QUESTION, docs, where);
  // A judge that claimed a grant whose quote did not verify. This is tested
  // FIRST and on `citationFailed` alone, because `PolicyDecision.permitted` is
  // false in exactly this case by construction — `policyOutcome` marks the
  // grant failed and never returns `permitted: true` alongside it. Reading
  // `permitted` here made the whole branch unreachable, so a fabricated quote
  // was reported as plain "the documents say nothing" (#407's own canary is
  // what caught this: an unverified grant and an absent rule must not look the
  // same to the operator, or a hallucinated permission is invisible in the
  // handoff).
  if (verdict.citationFailed) {
    return {
      granted: false,
      source: "citation-failed",
      ...(verdict.quote ? { quote: verdict.quote } : {}),
      reason:
        verdict.reason ??
        `The judge reported a merge grant, but the sentence it quoted was not found in ${verdict.sourceFile ?? "the file it named"} — treating it as no grant.`,
    };
  }
  if (verdict.permitted) {
    return {
      granted: true,
      // `doctrine` is the source a PROSE grant has always reported, and the
      // merged event records it: `source: "agents-md"` is the escape-hatch /
      // no-judgment answer. Renaming it here would silently change what the
      // state file says about how a merge was authorised.
      source: "doctrine",
      ...(verdict.quote ? { quote: verdict.quote } : {}),
      reason: verdict.reason ?? `The project's own documents permit merging: "${verdict.quote}".`,
    };
  }
  return {
    granted: false,
    source: "none",
    ...(verdict.quote ? { quote: verdict.quote } : {}),
    reason:
      verdict.reason ??
      "No merge grant found: this project's documents do not permit an agent to merge, and no --merge grant was given for this run.",
  };
}

/**
 * The #745 tooling-vs-CI annotation, written once and consumed by every
 * renderer that renders a merge hold (explainMergeHold, mergeHoldAction, the
 * chat and markdown handoff surfaces, and the queue summary).
 *
 * A refusal whose own `gh` call errored is not a CI verdict — the operator
 * must not go inspect a healthy green CI while the fault is the driver's
 * query — but the tag is only meaningful when authority WAS granted (the
 * no-authority line already points at the right place), so non-tooling and
 * ungranted refusals return nothing.
 */
export function mergeHoldToolingNote(granted: boolean, failureKind?: EvidenceFailureKind): string {
  return granted && failureKind === "tooling"
    ? "The gh invocation itself failed — no check data was read, so the fault is the driver's query, not the checks. Check the gh setup first."
    : "";
}

/** What the merged step's head verification recorded, for the renderers.
 *
 * The three fields a parked cycle carries on `pipelineState.mergeHold` about the
 * head check. Declared structurally (not imported from the state schema) because
 * the renderers hand this module a subset, and the queue's summary record and the
 * state file are two different objects that both carry these three fields.
 */
export interface MergeHeadHold {
  /** Why the head check refused, in the step's own words. */
  headCheckReason?: string;
  /** The OID the cycle's lens review recorded. */
  reviewedHead?: string;
  /** The head found at merge time. */
  headAtMerge?: string;
}

/** The head-check sentence, or "" when the hold was not about the head.
 *
 * One sentence, one owner: every surface that explains a merge hold renders this
 * so an operator reading the chat, the markdown handoff, the queue or the
 * checkpoint sees the SAME two SHAs and the same reason (#760's rule, extended
 * to the #1533 fields). Without the SHAs an operator has to go find them, and a
 * park that reads "the head was not the reviewed one" without naming either is
 * not actionable.
 */
export function mergeHeadHoldNote(head: MergeHeadHold | undefined): string {
  if (!head?.headCheckReason) return "";
  const reviewed = head.reviewedHead ? head.reviewedHead.slice(0, 8) : "unknown";
  const atMerge = head.headAtMerge ? head.headAtMerge.slice(0, 8) : "unknown";
  return (
    `The head check refused: ${head.headCheckReason} ` +
    `(reviewed head ${reviewed}, head at merge ${atMerge}).`
  );
}

/** Operator-facing explanation for a cycle that stopped at the merge step. */
export function explainMergeHold(
  authority: MergeAuthority,
  evidence: MergeEvidence | undefined,
  prNumber: number | undefined,
  head?: MergeHeadHold,
): string {
  const pr = prNumber ? `PR #${prNumber}` : "the PR";
  if (!authority.granted) {
    const why = authority.reason
      ? ` ${authority.reason[0]?.toUpperCase()}${authority.reason.slice(1)}.`
      : " Nothing in this project's documents permits an agent to merge, and no operator grant was given for this run.";
    // A failed citation is a different event from an absent grant, and the
    // operator should hear about it: the judge asserted a permission and then
    // could not point at it.
    const hallucinated =
      authority.source === "citation-failed"
        ? " That is a citation failure, not a missing rule — if the grant really is in your documents, quote it exactly and re-run."
        : "";
    // Always name where a grant would live. An operator told only "not
    // permitted" has to go and find that out; one sentence here saves it.
    return `${pr} is open and ready, but the driver is not permitted to merge it.${why}${hallucinated} Merging is the driver's job once the gate passes: add a grant to this project's AGENTS.md (one sentence, any language — e.g. "Agents may merge a PR to main once CI is green") and re-run, or pass --merge for a single run.`;
  }
  const why = evidence?.reason ?? "no evidence gathered";
  const tooling = mergeHoldToolingNote(true, evidence?.failureKind);
  const headNote = mergeHeadHoldNote(head);
  return `${pr} is open and merging is permitted, but the evidence gate refused: ${why}. ${tooling ? `${tooling} ` : ""}${headNote ? `${headNote} ` : ""}The driver merges on what \`gh\` reports, never on a subagent's claim.`;
}

/**
 * The single source for the no-authority recovery sentence.
 *
 * #760: this sentence used to be duplicated near-verbatim in three surfaces
 * (the queue summary, the merge-hold action, the handoff recovery steps) with
 * slightly different wording — the exact mechanism that produced cross-surface
 * disagreement in review. Call sites keep their own framing (a chat line, a
 * queue notification, a numbered recovery step) but share this sentence.
 *
 * `pr` is the PR label the caller already has ("#42" or "the PR for #7").
 * Returns a sentence fragment (no leading article, no trailing period) so
 * each surface can place it in its own grammatical context.
 */
export function mergeHoldGrantAction(pr: string): string {
  return `grant the driver authority to merge ${pr} — no merge grant exists for this run; add one sentence to AGENTS.md (the durable form) or pass --merge for this run`;
}

/**
 * The human action for the queue summary.
 *
 * `failureKind` is the tag #745 threads from the state file: when the gate's
 * own `gh` call errored, telling the operator to "check the checks" sends
 * them to a healthy green CI while the fault is the driver's query, so the
 * action says it is a tooling failure instead. Untagged state (or a
 * `ci`-tagged state) keeps the CI-flavoured line.
 */
export function mergeHoldAction(
  authority: MergeAuthority,
  prNumber?: number,
  failureKind?: EvidenceFailureKind,
  head?: MergeHeadHold,
): string {
  // `prNumber` comes from the state file's `prNumber?: number` at every call
  // site, so the optional marker (rather than `number | undefined`) is the
  // honest signature: a bare `number` is never expected.
  const pr = prNumber ? `#${prNumber}` : "the PR";
  if (!authority.granted) {
    return mergeHoldGrantAction(pr);
  }
  // The head check first: an operator told to go chase failing checks on a PR
  // whose CI is green — and whose real fault is an unreviewed commit — goes
  // looking in the wrong place. Same reason #745 tags a tooling refusal.
  const headNote = mergeHeadHoldNote(head);
  if (headNote) return `${headNote} Nothing may merge what the review did not cover.`;
  const tooling = mergeHoldToolingNote(true, failureKind);
  if (tooling) return `the merge evidence gate for ${pr} ${tooling}`.replace("first.", "first");
  // Names the driver as the actor: a human was never going to merge anyway.
  return `check the failing/incomplete required checks on ${pr}, then re-run with --merge once the gate passes`;
}

/**
 * Did the review round cap route this cycle here with findings outstanding?
 *
 * A round cap that routed to `ci` reaches the merge gate carrying review
 * findings nobody resolved. Every grant this module honours is conditioned on
 * the quality gates having been met — this repo's own reads *"If all project
 * quality gates have been met (code reviews, CI, linters, type checks etc)"* —
 * and a review loop that exhausted its rounds with findings open is precisely
 * the gate that was not met. Deciding on the event rather than on the wording
 * keeps behaviour uniform: a project cannot opt into merging unreviewed work by
 * phrasing its doctrine more loosely than it meant to.
 *
 * This costs the cycle nothing that routing to `ci` bought it. The PR exists,
 * CI ran, and the residual findings are posted on it — the operator gets a
 * reviewable PR instead of a re-run. It simply is not merged for them.
 *
 * A separate exported predicate rather than a clause inside the guard, so the
 * decision can be tested directly; inlined, the only available check was a grep
 * for the guard's own source text.
 *
 * #1742 — the review-loop budget module's `lens-review-timeout` → `ci` route is
 * held by the same rule. It discloses residuals and carries on exactly like the
 * round cap, so a wall-clock cap that reached `ci` must not merge either; the
 * `nextStep === "ci"` condition keeps the ordinary wall-clock park (which routes
 * to `handoff`) out of it — that cycle never reaches this gate.
 */
export function heldByUnresolvedReview(eventLog: WorkEvent[]): boolean {
  return eventLog.some(
    (e) =>
      e.kind === "cap-hit" &&
      e.nextStep === "ci" &&
      (e.cap === "round-cap" || e.cap === "lens-review-timeout"),
  );
}
