/**
 * lean/handback — the step that tells the operator what the run still needs.
 *
 * A run reaches `handback` when its gate said red twice, when CI disagreed twice, when the
 * land gate refused, or when a handler threw. What is left is a sentence on the issue built
 * from the record: what failed, the frozen contract, and where the work is.
 *
 * It NEVER throws: a comment that failed to post is information in the record, not a reason
 * to change the verdict.
 */

import { execp } from "../exec.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { handbackHeads } from "./handback-heads.ts";
import {
  NO_HEAD,
  type Rewind,
  SWITCHED_OFF,
  originBranchHead,
  rewindToVerified,
} from "./handback-rewind.ts";
import { postHandback } from "./io.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP, validPrUrl } from "./state-outcome.ts";
import { type Outcome, REPORT_STATES, type Step } from "./state.ts";
import { budgetSentence, budgetTrio } from "./step-budget.ts";
import { fenceText, oneLine } from "./text-fence.ts";
import {
  leanHandbackNoHeadRecordEnabled,
  leanVerifiedHandbackEnabled,
} from "./verified-handback-switch.ts";
import { newestRedVerifyReason } from "./verify-deps.ts";

/** A reason line long enough to be a wall is not a comment a human reads. */
const REASON_CLIP = 2000;

/** The `Branch:` line, or nothing when the branch is not a printable ref. */
function branchLine(branch: string): string[] {
  try {
    assertSafeRef(branch);
  } catch {
    return [];
  }
  return [`Branch: \`${branch}\``];
}

/** How much of the frozen contract a comment lists; the full set lives in the step log. */
const FROZEN_LIST_CAP = 20;

/** How many conflicting files a cause line names; the rest live in the step log. */
const BLOCKED_LIST_CAP = 20;

/** The newest DECIDED step of one state whose outcome carries a reason. */
function newestReason(
  steps: Step[],
  state: "verify" | "ci",
  kind: "red" | "green",
): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== state || step.outcome?.kind !== kind) continue;
    const reason = step.outcome.reason ?? step.outcome.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    return reason;
  }
  return undefined;
}

/** Why the run is ending, in the record's own words. */
function terminalCause(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const oc = steps[i]?.outcome;
    if (oc?.kind !== "error") continue;
    const message = oc.message ?? oc.reason;
    if (typeof message !== "string" || message.trim() === "") continue;
    return message;
  }
  return undefined;
}

/**
 * The newest budget breach the log records, and FIRST in {@link neededFromLog}: the breach is why
 * the run stopped, and it counts only when nothing that did work is newer. Rendered through
 * {@link budgetTrio}, so a half-record falls through to the next cause.
 */
/** The newest step that was WORK — a report state is how a run ended, not work. */
function newestWorkStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && !REPORT_STATES.includes(step.state)) return step;
  }
  return undefined;
}

/** The newest WORK step's budget breach, if it carries a complete one. */
function budgetCause(steps: Step[]): string | undefined {
  const step = newestWorkStep(steps);
  const fired = step === undefined ? undefined : budgetTrio(step.outcome);
  if (step === undefined || fired === undefined) return undefined;
  // The step's own clause about the attempts it spent, kept if it made one.
  const used = step.outcome?.reason?.match(/after \d+ build attempts/)?.[0];
  return used === undefined
    ? budgetSentence(step.state, fired)
    : `${budgetSentence(step.state, fired)} ${used}`;
}

/**
 * The build step's named unsatisfiable contract, and FIRST in {@link neededFromLog}: the
 * builder's `blocked` verdict is the one cause that names the files and the contradiction.
 * Same positional test as {@link budgetCause}; rendered from the typed `blockedBy` map.
 */
function blockedCause(steps: Step[]): string | undefined {
  const step = newestWorkStep(steps);
  if (step?.state !== "build" || step.outcome?.kind !== "blocked") return undefined;
  const entries = Object.entries(step.outcome.blockedBy ?? {});
  if (entries.length === 0) return undefined;
  const named = entries
    .slice(0, BLOCKED_LIST_CAP)
    .map(
      ([file, why]) => `- ${oneLine(file, BLOCKED_PATH_CAP)}: ${oneLine(why, BLOCKED_REASON_CAP)}`,
    )
    .join("\n");
  const more =
    entries.length > BLOCKED_LIST_CAP ? `\n…and ${entries.length - BLOCKED_LIST_CAP} more` : "";
  return `the frozen tests cannot all pass together:\n${named}${more}`;
}

/**
 * Why the run is ending, in the record's own words. The order is the order of USEFULNESS,
 * not recency: what the run's own gate complained about is what a developer can act on.
 */
export function neededFromLog(steps: Step[]): string {
  const reason =
    blockedCause(steps) ??
    budgetCause(steps) ??
    newestRedVerifyReason(steps) ??
    newestReason(steps, "ci", "red") ??
    // Nothing ever went red: fall through to the last verdict of either gate before the cause.
    newestReason(steps, "verify", "green") ??
    newestReason(steps, "ci", "green") ??
    terminalCause(steps) ??
    "the run ended without recording why";
  return reason.length > REASON_CLIP ? `${reason.slice(0, REASON_CLIP)}…` : reason;
}

/**
 * A path with a control character is not a line the comment may print. The class is ASSEMBLED
 * from code points because suppressing `noControlCharactersInRegex` is the bypass AGENTS.md forbids.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/**
 * The frozen acceptance tests, from the same log `build` and `verify` read. A key with a control
 * character is dropped rather than clipped: the comment is markdown, so a `\n` in a path ends the bullet.
 */
function frozenList(steps: Step[]): string[] {
  return Object.keys(frozenFromLog(steps))
    .filter((f) => !CONTROL_CHARS.test(f))
    .sort()
    .map((f) => (f.length > BLOCKED_PATH_CAP ? `${f.slice(0, BLOCKED_PATH_CAP)}…` : f));
}

/** The PR URL the publish step recorded, or `undefined` when there is none. */
function prUrlFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "publish") continue;
    // `Outcome.prUrl` is the one field a publish step may carry a URL in, and `state.ts` refuses
    // to load one that is not https text. Re-checked here rather than trusted.
    const url = step.outcome?.prUrl;
    const valid = validPrUrl(url);
    if (valid === undefined) continue;
    return valid;
  }
  return undefined;
}

/** The frozen list as bullet lines, capped, with the remainder counted. */
function frozenLines(frozen: string[]): string {
  if (frozen.length === 0) return "- none were recorded";
  const kept = frozen.slice(0, FROZEN_LIST_CAP).map((f) => `- ${f}`);
  if (frozen.length <= FROZEN_LIST_CAP) return kept.join("\n");
  return [...kept, `- …and ${frozen.length - FROZEN_LIST_CAP} more`].join("\n");
}

/** The comment body: what is needed, what was frozen, and where the work is. */
export function handbackBody(
  issue: number,
  opts: { needed: string; frozen: string[]; branch: string; prUrl?: string; heads?: Heads },
): string {
  const tests = frozenLines(opts.frozen);
  return [
    `work-lean: issue #${issue} is handed back — this is still needed:`,
    "",
    fenceText(opts.needed, REASON_CLIP),
    "",
    ...(headLines(opts.heads) ?? []),
    "Frozen acceptance tests:",
    tests,
    "",
    ...branchLine(opts.branch),
    `PR: ${opts.prUrl ?? "no PR yet"}`,
  ].join("\n");
}

/**
 * The head lines of the comment, or `undefined` when this run has nothing to say about heads.
 * Where there IS a head, both halves are stated whether or not the rewind landed.
 */
function headLines(heads: Heads | undefined): string[] | undefined {
  if (heads === undefined) return undefined;
  const lines: string[] = [];
  if (heads.shippedHead !== undefined)
    lines.push(
      `Shipped head: \`${heads.shippedHead}\` (${heads.shippedVerified === true ? "verified" : "NOT verified"})`,
    );
  if (heads.unshippedHead !== undefined)
    lines.push(
      `Unshipped head: \`${heads.unshippedHead}\` — ${heads.unshippedReason ?? "not shipped"}`,
    );
  // A step that moved nothing still owes the operator why the head it shipped was never certified.
  if (heads.unshippedHead === undefined && heads.unshippedReason !== undefined)
    lines.push(`Why nothing was moved: ${heads.unshippedReason}`);
  if (lines.length === 0) return undefined;
  return [...lines, ""];
}

/** The head facts of one handback, in the shape the comment reads them. */
interface Heads {
  /** True when the rule spoke for this handback, whether or not it read a head. */
  render: boolean;
  /** The head origin's branch holds as this step read it, after any move. */
  shippedHead?: string;
  /** Whether that head is one the run's own gate certified. */
  shippedVerified?: boolean;
  /** The head the run left on origin that did NOT ship, when a move moved it off. */
  unshippedHead?: string;
  /** Why the head did not ship, or why nothing moved at all, in the rewind's words. */
  unshippedReason?: string;
}

/**
 * The head facts one handback records, from the head origin holds and what the rewind settled on.
 * `shippedHead` comes from the post-move read this step takes after the rewind, so it says where
 * origin stands now; `unshippedHead` is the rewind's own pre-move read — the head it displaced —
 * which this step could not have produced itself because it never saw origin before the move.
 * `render` is the renderer flag and travels to the body only; the four head fields are
 * `Outcome`'s, rebuilt on reload and judged by the validator.
 *
 * A rewind with no head to move records the head origin ACTUALLY holds under
 * `PI_ENSEMBLE_LEAN_HANDBACK_NOHEAD_RECORD`: off it records nothing; on it carries the rule's
 * reason, not the rewind's wording for a move that did not happen. `shippedVerified` is
 * `rewind.shipped` plus `alreadyAtVerified` — origin held the certified head already, so printing
 * it as `NOT verified` would send the operator to inspect bytes the gate certified.
 */
function headFacts(
  applies: boolean,
  rewind: Rewind,
  originHead: string | undefined,
  noHeadRecords: boolean,
): Heads {
  if (!applies) return { render: false };
  const shippedHead = originHead ?? rewind.unshippedHead;
  // The arm with nothing to move: the rule fired, the log named no green head, and origin keeps
  // the head the fix wave pushed.
  if (rewind.unshippedHead === undefined && !rewind.shipped) {
    if (!noHeadRecords || originHead === undefined) return { render: false };
    // The rule's words: the operator's question is why what shipped was never certified.
    const why = rewind.noHeadReason ?? rewind.reason;
    return {
      render: true,
      shippedHead: originHead,
      // Nothing moved, so origin holds what the fix wave left and the gate never certified it.
      shippedVerified: false,
      // This step displaced nothing.
      ...(why === undefined ? {} : { unshippedReason: why }),
    };
  }
  const leftBehind =
    rewind.unshippedHead !== undefined && rewind.unshippedHead !== shippedHead
      ? rewind.unshippedHead
      : undefined;
  return {
    render: true,
    shippedHead,
    shippedVerified: rewind.shipped || rewind.alreadyAtVerified === true,
    ...(leftBehind === undefined ? {} : { unshippedHead: leftBehind }),
    ...(rewind.reason === undefined ? {} : { unshippedReason: rewind.reason }),
  };
}

/**
 * The `handback` step. Always `done`; never throws.
 *
 * `post` is the seam the test drives: production hands it `postHandback`, which goes through the
 * forge adapter and the public-hygiene check. On the host channel the caller passes a post that
 * posts nothing, so `posted` is false with `channel: "host"` on the step. `report` carries the
 * comment either way.
 */
export async function handbackOutcome(
  ctx: HandlerCtx,
  post: (repoRoot: string, issue: number, body: string) => Promise<void>,
  rewind: (verifiedHead: string) => Promise<Rewind> = async () => ({ shipped: false }),
  /** Where origin's branch stands, read by this step. Seam for the test to drive. */
  readOrigin: (
    ctx: Pick<HandlerCtx, "repoRoot" | "issue" | "run">,
  ) => Promise<string | undefined> = (ctx) => originBranchHead(execp, ctx),
): Promise<Outcome> {
  let body: string | undefined;
  try {
    // This step never throws, so a body that failed to build is reported like a refused post.
    const prUrl = prUrlFromLog(ctx.steps);
    const heads = handbackHeads(ctx.steps);
    // ONE read of the switch, so the arm that moves origin and the arm that only reports agree.
    const ruleOn = heads.applies && leanVerifiedHandbackEnabled();
    // The rewind runs BEFORE the body is built, so the comment states where origin stands after it.
    const moved =
      ruleOn && heads.verifiedHead !== undefined
        ? await rewind(heads.verifiedHead)
        : ruleOn
          ? // `NO_HEAD`'s own `reason` describes a push that did not run; this answers a
            // different question — why what shipped was never certified.
            { ...NO_HEAD, noHeadReason: heads.reason }
          : SWITCHED_OFF;
    // Read AFTER the rewind, so it is origin's post-move value; a handback the rule never touched
    // reads nothing.
    const originHead = ruleOn ? await readOrigin(ctx) : undefined;
    const facts = ruleOn
      ? headFacts(heads.applies, moved, originHead, leanHandbackNoHeadRecordEnabled())
      : { render: false };
    const { render, ...record } = facts;
    body = handbackBody(ctx.issue, {
      needed: neededFromLog(ctx.steps),
      frozen: frozenList(ctx.steps),
      branch: ctx.run.branch,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(render ? { heads: facts } : {}),
    });
    await post(ctx.repoRoot, ctx.issue, body);
    // `posted: true` is the only place the claim lives: the kind is `done` either way.
    // `record` is LAST and `render` is stripped — the record carries only what `Outcome` declares.
    return {
      kind: "done",
      reason: "handback comment posted",
      posted: true,
      report: body,
      ...record,
    };
  } catch (err) {
    // The run ends here either way; the record says whether anyone was told.
    return {
      kind: "done",
      posted: false,
      reason: `handback comment NOT posted: ${(err as Error)?.message || String(err)}`,
      ...(body === undefined ? {} : { report: body }),
    };
  }
}
