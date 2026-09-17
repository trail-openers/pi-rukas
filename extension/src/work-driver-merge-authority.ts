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

import { mergeEvidenceViewCmd, prChecksCmd } from "./forge-commands.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import {
  type DoctrineDoc,
  MERGE_POLICY_QUESTION,
  type PolicyJudgeFn,
  askPolicy,
} from "./work-driver-policy.ts";
import type { EvidenceFailureKind } from "./workflow-state-cap.ts";
import type { WorkEvent } from "./workflow-state.ts";

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

/**
 * Why the merge-evidence gate refused. `tooling` means the gate could not
 * even READ what it is supposed to judge — the `gh` invocation itself
 * errored, or its output was not the shape the gate consumes. That is a
 * different event from a CI verdict: rendering it as "incomplete required
 * checks" pointed the operator at a healthy, green CI while the real fault
 * was an unsupported field in the driver's own query (#745). Renderers
 * must keep the two kinds textually distinct.
 */
// The `tooling`/`ci` vocabulary is declared once in workflow-state-cap.ts
// (neutral module: the state schema and this module both need it without
// importing each other, and a grown vocabulary must not drift between the
// persisted field and the runtime type).
export type { EvidenceFailureKind } from "./workflow-state-cap.ts";

export interface MergeEvidence {
  ok: boolean;
  /** Why not, when `ok` is false — operator-facing. */
  reason?: string;
  /** When the refusal is a tooling failure, says so distinctly from a CI verdict. */
  failureKind?: EvidenceFailureKind;
  mergeStateStatus?: string;
  failing: string[];
  /** Required checks reporting `skipped`/`neutral` — green to GitHub, not to us. */
  inconclusive: string[];
}

interface PrCheckRow {
  name?: string;
  state?: string;
  bucket?: string;
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
 *
 * The `--json` fields requested here are pinned to gh 2.98.0 by
 * `smoke-tests/test-gh-argv.ts`; the per-check required/optional flag is not
 * among them (`isRequired` is not a field `gh pr checks` supports — #745),
 * so the per-check rows only supply the failing/pending/skipped names, while
 * the pass/not-pass verdict is `mergeStateStatus`: it already encodes the
 * repo's own branch-protection rules.
 */
export async function gatherMergeEvidence(
  execFn: ExecFn,
  repoRoot: string,
  prNumber: number,
): Promise<MergeEvidence> {
  let state: { mergeStateStatus?: string; state?: string };
  try {
    const { stdout } = await execFn(mergeEvidenceViewCmd(prNumber), {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(stdout) as { mergeStateStatus?: unknown; state?: unknown };
    state = {
      // `mergeStateStatus` is a string the CLI passes through; it lands
      // verbatim in operator-facing handoffs, so bound it on read — every
      // downstream renderer inherits the cap.
      mergeStateStatus:
        typeof parsed.mergeStateStatus === "string"
          ? parsed.mergeStateStatus.slice(0, 64)
          : undefined,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      failureKind: "tooling",
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
  let rowsRead = false;
  // Set when the invocation exited 0 but its stdout was not check data: an
  // exit-0 call cannot be a tooling failure, and the operator needs the raw
  // output to see what actually came back (a partial/HTML error page, a gh
  // version that changed its output shape).
  let malformedStdout = "";
  try {
    const { stdout } = await execFn(prChecksCmd("github", prNumber), {
      cwd: repoRoot,
      maxBuffer: 512 * 1024,
    });
    // Empty/whitespace-only stdout is NO DATA, not an empty check list: a
    // `rowsRead` here would let the gate say "no checks reported" (a CI
    // verdict) when the invocation answered with nothing at all.
    if (stdout.trim()) {
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        rows = parsed as PrCheckRow[];
        rowsRead = true;
      } else {
        malformedStdout = stdout;
      }
    }
  } catch (err) {
    // The catch conflates two shapes only when it hides which one happened:
    // a non-zero exit (tooling — the invocation failed before answering) and
    // a successful invocation whose stdout did not parse (a data regression
    // the operator needs to see, not "fix your tooling").
    if (err instanceof SyntaxError && !malformedStdout)
      malformedStdout = "(output was not valid JSON)";
    rows = [];
  }

  const norm = (r: PrCheckRow) => (r.bucket ?? r.state ?? "").toLowerCase();
  const failing = rows
    .filter((r) => ["fail", "failure", "cancelled", "timed_out", "error"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const pending = rows
    .filter((r) => ["pending", "queued", "in_progress", "waiting"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const inconclusive = rows
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
  // `mergeStateStatus` is the authoritative verdict — it already encodes the
  // repo's own required-check rules — while the rows above only name what is
  // wrong. A CLEAN PR with an unreadable checks list fails closed: the gate
  // has no evidence of a green check list, and this step is irreversible.
  if (state.mergeStateStatus !== "CLEAN") {
    return {
      ok: false,
      reason: `mergeStateStatus is ${state.mergeStateStatus ?? "unreadable"}, not CLEAN`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
    };
  }
  if (!rowsRead) {
    if (malformedStdout) {
      // An exit-0 invocation whose output was not usable check data. The
      // raw output is shown when we captured it (JSON parsed but was not an
      // array); a parse failure gets the placeholder so the operator can
      // still tell "the CLI answered but the shape is wrong" from "the CLI
      // never answered".
      return {
        ok: false,
        reason: `the gh pr checks invocation returned data the gate could not read as a check list${
          malformedStdout.startsWith("(") ? "" : ` — got: ${malformedStdout.slice(0, 160)}`
        }. Fix the gh setup or the checks configuration, then re-run.`,
        mergeStateStatus: state.mergeStateStatus,
        failing: [],
        inconclusive: [],
      };
    }
    return {
      ok: false,
      failureKind: "tooling",
      reason:
        "the gh pr checks invocation failed before returning check data — this is a tooling failure, not a CI verdict (no check data was read). Fix the gh setup, then re-run.",
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      reason: "no checks reported — refusing to merge on the absence of evidence",
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
    return `${pr} is open and ready, but the driver is not permitted to merge it.${why}${hallucinated} Merging is the driver's job once the gate passes: add a grant to this project's AGENTS.md (one sentence, any language — e.g. "Agents may merge a PR to main once CI is green") and re-run, or pass --merge for a single run.`;
  }
  const why = evidence?.reason ?? "no evidence gathered";
  const tooling = mergeHoldToolingNote(true, evidence?.failureKind);
  return `${pr} is open and merging is permitted, but the evidence gate refused: ${why}. ${tooling ? `${tooling} ` : ""}The driver merges on what \`gh\` reports, never on a subagent's claim.`;
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
): string {
  // `prNumber` comes from the state file's `prNumber?: number` at every call
  // site, so the optional marker (rather than `number | undefined`) is the
  // honest signature: a bare `number` is never expected.
  const pr = prNumber ? `#${prNumber}` : "the PR";
  if (!authority.granted) {
    return mergeHoldGrantAction(pr);
  }
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
 */
export function heldByUnresolvedReview(eventLog: WorkEvent[]): boolean {
  return eventLog.some((e) => e.kind === "cap-hit" && e.cap === "round-cap" && e.nextStep === "ci");
}
