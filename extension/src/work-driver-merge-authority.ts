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
 *      project's `AGENTS.md` says so, or the operator granted it for the run.
 *      Absent a grant the PR is opened and the cycle parks; a repo that never
 *      opted in never gets an auto-merge.
 *   2. **Evidence** — required checks actually passed, per `gh`, not per an
 *      agent's narration.
 *
 * No vendor auto-merges agent PRs today (Copilot's docs require a second
 * reviewer and explicitly do not count the agent's own approval), so there is
 * no gate-set to copy. This one is constructed, and deliberately conservative
 * in both directions.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; shell?: string },
) => Promise<{ stdout: string; stderr?: string }>;

export type AuthoritySource = "agents-md" | "operator" | "none";

export interface MergeAuthority {
  granted: boolean;
  source: AuthoritySource;
  /** Verbatim evidence of the grant, for the handoff and the merged event. */
  quote?: string;
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
 * Sentences in an AGENTS.md that constitute a grant.
 *
 * Deliberately narrow and affirmative. A permissive matcher here is the worst
 * possible failure — it would invent permission that nobody gave — so anything
 * ambiguous is treated as no grant. The first pattern matches this repo's own
 * §9, "LLMs are allowed to squash merge PRs".
 */
const GRANT_PATTERNS: RegExp[] = [
  /\b(?:LLMs?|agents?|bots?)\b[^.\n]{0,80}\b(?:are\s+)?allowed\s+to\s+(?:squash[\s-]?)?merge\b/i,
  /\bmay\s+(?:squash[\s-]?)?merge\s+(?:their\s+own\s+)?PRs?\b/i,
  /\bauto[-\s]?merge\s*:\s*(?:true|yes|enabled|allowed)\b/i,
];

/** Explicit prohibitions win over any grant found elsewhere in the file. */
const DENY_PATTERNS: RegExp[] = [
  /\bauto[-\s]?merge\s*:\s*(?:false|no|disabled|forbidden)\b/i,
  /\b(?:never|do\s+not|don't|must\s+not)\s+(?:auto[-\s]?)?merge\b/i,
];

/**
 * Strip fenced code blocks and inline-code spans before matching.
 *
 * Found the hard way: adding a sentence to this repo's own AGENTS.md that
 * *described* the deny matcher — quoting the phrase "never merge" — flipped
 * the repo from granted to denied. A file that documents this mechanism will
 * inevitably contain the phrases the mechanism looks for, and a matcher that
 * cannot tell a rule from a description of a rule is unusable in exactly the
 * files it has to read. Backticks are the available "I am quoting, not
 * asserting" marker in Markdown, so text inside them is not a directive.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Resolve whether merging is permitted for this cycle.
 *
 * Order matters: an explicit denial anywhere in AGENTS.md beats a grant, and
 * an absent or unreadable AGENTS.md means no grant. The operator override is
 * checked first because a human saying "yes, merge this run" is the most
 * direct evidence of intent there is.
 */
export async function resolveMergeAuthority(
  repoRoot: string,
  operatorGrant?: boolean,
): Promise<MergeAuthority> {
  if (operatorGrant === true) {
    return { granted: true, source: "operator", quote: "operator granted merge for this run" };
  }
  let text: string;
  try {
    text = await fs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8");
  } catch {
    // No AGENTS.md is not a grant. A project that never said anything about
    // merging has not permitted it.
    return { granted: false, source: "none" };
  }
  const prose = stripCode(text);
  for (const deny of DENY_PATTERNS) {
    const m = prose.match(deny);
    if (m) {
      trace(`merge-authority: AGENTS.md explicitly forbids merging ("${m[0].slice(0, 60)}")`);
      return { granted: false, source: "none", quote: m[0].trim().slice(0, 200) };
    }
  }
  for (const grant of GRANT_PATTERNS) {
    const m = prose.match(grant);
    if (m) return { granted: true, source: "agents-md", quote: m[0].trim().slice(0, 200) };
  }
  return { granted: false, source: "none" };
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
    const why = authority.quote
      ? ` This project's AGENTS.md explicitly forbids it ("${authority.quote}").`
      : " Nothing in this project's AGENTS.md permits an agent to merge, and no operator grant was given for this run.";
    return `${pr} is open and ready, but the driver is not permitted to merge it.${why} Merging is opt-in by design: review and merge it yourself, or grant the authority and re-run.`;
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
