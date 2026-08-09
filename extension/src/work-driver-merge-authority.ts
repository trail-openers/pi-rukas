/**
 * work-driver-merge-authority — may this cycle merge, and is it safe to?
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
 *      agent's narration.
 *
 * No vendor auto-merges agent PRs today (Copilot's docs require a second
 * reviewer and explicitly do not count the agent's own approval), so there is
 * no gate-set to copy. This one is constructed, and deliberately conservative
 * in both directions.
 */

import {
  type DoctrineDoc,
  MERGE_POLICY_QUESTION,
  type PolicyJudgeFn,
  askPolicy,
} from "./work-driver-policy.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

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
): Promise<MergeAuthority> {
  if (operatorGrant === true) {
    return { granted: true, source: "operator", quote: "operator granted merge for this run" };
  }
  const decision = await askPolicy(judge, MERGE_POLICY_QUESTION, docs);
  if (decision.permitted) {
    return { granted: true, source: "doctrine", quote: decision.quote, reason: decision.reason };
  }
  return {
    granted: false,
    source: decision.citationFailed ? "citation-failed" : "none",
    quote: decision.quote,
    reason: decision.reason,
  };
}

export interface MergeEvidence {
  ok: boolean;
  /** Why not, when `ok` is false — operator-facing. */
  reason?: string;
  mergeStateStatus?: string;
  failing: string[];
  /** Required checks reporting `skipped`/`neutral` — green to GitHub, not to us. */
  inconclusive: string[];
}

interface PrCheckRow {
  name?: string;
  state?: string;
  bucket?: string;
  isRequired?: boolean;
}

/**
 * Gather executed evidence that a PR is genuinely mergeable.
 *
 * Fails CLOSED, unlike most gates in this driver. Everywhere else an
 * unavailable signal means "proceed and let a later gate catch it"; here the
 * next step is irreversible, so an unreadable answer means do not merge.
 *
 * `skipped` and `neutral` are treated as NOT passing. GitHub's own docs say
 * *"Successful check statuses are `success`, `skipped`, and `neutral`"* and
 * warn to *"avoid requiring workflows that can be skipped"* — so a workflow
 * that gains a `paths-ignore:` silently becomes a required gate that always
 * reports green. That is a gate that cannot fail, which is the exact class of
 * defect this project has been removing.
 */
export async function gatherMergeEvidence(
  execFn: ExecFn,
  repoRoot: string,
  prNumber: number,
): Promise<MergeEvidence> {
  let state: { mergeStateStatus?: string; mergeable?: string; state?: string };
  try {
    const { stdout } = await execFn(
      `gh pr view ${prNumber} --json mergeStateStatus,mergeable,state`,
      { cwd: repoRoot, maxBuffer: 256 * 1024 },
    );
    state = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read PR state: ${(err as Error).message?.slice(0, 160)}`,
      failing: [],
      inconclusive: [],
    };
  }

  if (state.state && state.state !== "OPEN") {
    return {
      ok: false,
      reason: `PR is ${state.state}, not OPEN`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
    };
  }

  // BLOCKED covers failing required checks, missing reviews and unresolved
  // conversations — GitHub has already applied the repo's own rules, which is
  // a stronger statement than anything the driver can compute itself.
  const blocking = ["BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"];
  if (state.mergeStateStatus && blocking.includes(state.mergeStateStatus)) {
    return {
      ok: false,
      reason: `mergeStateStatus is ${state.mergeStateStatus}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
    };
  }

  let rows: PrCheckRow[] = [];
  try {
    const { stdout } = await execFn(
      `gh pr checks ${prNumber} --json name,state,bucket,isRequired`,
      { cwd: repoRoot, maxBuffer: 512 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout || "[]");
    if (Array.isArray(parsed)) rows = parsed as PrCheckRow[];
  } catch (err) {
    // `gh pr checks` exits non-zero when checks are failing OR when there are
    // none at all. Both are "no positive evidence", and this gate fails closed.
    return {
      ok: false,
      reason: `could not read PR checks: ${(err as Error).message?.slice(0, 160)}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
    };
  }

  const required = rows.filter((r) => r.isRequired !== false);
  const norm = (r: PrCheckRow) => (r.bucket ?? r.state ?? "").toLowerCase();
  const failing = required
    .filter((r) => ["fail", "failure", "cancelled", "timed_out", "error"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const pending = required
    .filter((r) => ["pending", "queued", "in_progress", "waiting"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const inconclusive = required
    .filter((r) => ["skipping", "skipped", "neutral"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");

  if (failing.length > 0) {
    return {
      ok: false,
      reason: `required checks failing: ${failing.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing,
      inconclusive,
    };
  }
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `required checks still running: ${pending.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
    };
  }
  if (inconclusive.length > 0) {
    return {
      ok: false,
      reason: `required checks reported skipped/neutral, which GitHub counts as success but this driver does not: ${inconclusive.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
    };
  }
  if (required.length === 0) {
    return {
      ok: false,
      reason: "no required checks reported — refusing to merge on the absence of evidence",
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
    };
  }
  return { ok: true, mergeStateStatus: state.mergeStateStatus, failing: [], inconclusive: [] };
}

/**
 * Does executed evidence positively contradict a narrated "CI is green"?
 *
 * Used by the `ci` step, where the rule is deliberately weaker than at the
 * merge gate: **narration cannot promote, only evidence can demote.** An
 * unreadable `gh` at the `ci` step must not burn the retry budget on a run
 * that genuinely passed, and the merge gate — which fails closed — is the one
 * that has to be right. So this returns a reason only when `gh` actually
 * reported something failing, pending or skipped.
 */
export function contradictsSuccess(evidence: MergeEvidence): string | undefined {
  if (evidence.ok) return undefined;
  if (evidence.failing.length > 0) return `required checks failing: ${evidence.failing.join(", ")}`;
  if (evidence.inconclusive.length > 0) {
    return `required checks skipped/neutral: ${evidence.inconclusive.join(", ")}`;
  }
  if (evidence.reason?.startsWith("required checks still running")) return evidence.reason;
  if (evidence.reason?.startsWith("mergeStateStatus is")) return evidence.reason;
  return undefined;
}

/** Operator-facing explanation for a cycle that stopped at the merge step. */
export function explainMergeHold(
  authority: MergeAuthority,
  evidence: MergeEvidence | undefined,
  prNumber: number | undefined,
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
    return `${pr} is open and ready, but the driver is not permitted to merge it.${why}${hallucinated} Merging is opt-in by design: review and merge it yourself, or say so plainly in this project's AGENTS.md (one sentence, any language — e.g. "Agents may merge a PR to main once CI is green") and re-run, or pass --merge for a single run.`;
  }
  return `${pr} is open and merging is permitted, but the evidence gate refused: ${evidence?.reason ?? "no evidence gathered"}. The driver merges on what \`gh\` reports, never on a subagent's claim.`;
}

/** The human action for the queue summary. */
export function mergeHoldAction(authority: MergeAuthority, prNumber: number | undefined): string {
  const pr = prNumber ? `#${prNumber}` : "the PR";
  return authority.granted
    ? `check the failing/incomplete required checks on ${pr}, then merge`
    : `review and merge ${pr} yourself (agent merging is not permitted in this project)`;
}
