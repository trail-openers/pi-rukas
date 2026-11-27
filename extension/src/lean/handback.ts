/**
 * lean/handback — the step that tells the operator what the run still needs.
 *
 * A run reaches `handback` when its gate said red twice, when CI disagreed twice, when the land gate refused,
 * when `specify`'s child could not prove a criterion red, or when a handler threw. What is left is a sentence
 * on the issue built from the record: what failed, the frozen contract, and where the work is.
 *
 * It NEVER throws: a comment that failed to post is information in the record, not a reason to change the
 * verdict.
 */
import { execp } from "../exec.ts";
import { frozenFromLog } from "../lean-log.ts";
import { repairCause } from "../oracle-repair-disclose.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { HandlerCtx } from "./engine.ts";
import { NO_GATE_VERDICT, handbackHeads, newestDecidedWorkStep } from "./handback-heads.ts";
import { NO_HEAD, type Rewind, originBranchHead } from "./handback-rewind.ts";
import { RED_TEST_GAP } from "./specify-gap-switch.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP } from "./state-outcome-maps.ts";
import { validPrUrl } from "./state-outcome.ts";
import type { Outcome, Step } from "./state.ts";
import { budgetSentence, budgetTrio } from "./step-budget.ts";
import { fenceText, oneLine } from "./text-fence.ts";

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

/** How much of the frozen contract a comment lists, and how many conflicting files a cause line names; the
 * full sets live in the step log. */
const LIST_CAP = 20;

/** The newest DECIDED step of `state` whose outcome carries a reason. */
function newestReason(steps: Step[], state: "verify" | "ci", kind: "red" | "green") {
  let found: string | undefined;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== state || step.outcome?.kind !== kind) continue;
    const reason = step.outcome.reason ?? step.outcome.message;
    if (typeof reason !== "string" || reason.trim() === "") continue;
    found = reason;
    break;
  }
  return found;
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
 * The newest WORK step's budget breach. The breach is why the run stopped, and it counts
 * only when nothing that did work is newer.
 */
function budgetCause(steps: Step[]): string | undefined {
  const step = newestDecidedWorkStep(steps);
  const fired = step === undefined ? undefined : budgetTrio(step.outcome);
  if (step === undefined || fired === undefined) return undefined;
  // The step's own clause about the attempts it spent, kept if it made one.
  const used = step.outcome?.reason?.match(/after \d+ build attempts/)?.[0];
  return used === undefined
    ? budgetSentence(step.state, fired)
    : `${budgetSentence(step.state, fired)} ${used}`;
}

/** The build step's named unsatisfiable contract — the one cause that names files; counts only at the newest
 * WORK step, like {@link budgetCause}. */
function blockedCause(steps: Step[]): string | undefined {
  const step = newestDecidedWorkStep(steps);
  if (step?.state !== "build" || step.outcome?.kind !== "blocked") return undefined;
  const entries = Object.entries(step.outcome.blockedBy ?? {});
  if (entries.length === 0) return undefined;
  const named = entries
    .slice(0, LIST_CAP)
    .map(
      ([file, why]) => `- ${oneLine(file, BLOCKED_PATH_CAP)}: ${oneLine(why, BLOCKED_REASON_CAP)}`,
    )
    .join("\n");
  const more = entries.length > LIST_CAP ? `\n…and ${entries.length - LIST_CAP} more` : "";
  return `the frozen tests cannot all pass together:\n${named}${more}`;
}

/** The other reading of a test that passed on the base, which the gap's evidence cannot rule out. */
const GAP_READING =
  "A test that passes on the base may also mean the criterion already holds there.";
/** `specify`'s child left a criterion with no red test: each rule once, the per-file evidence, and the
 * second reading only where a test really passed on the base. */
function gapCause(steps: Step[]): string | undefined {
  const oc = newestDecidedWorkStep(steps)?.outcome;
  if (oc?.kind !== RED_TEST_GAP) return undefined;
  const rules = oc.failedRules ?? [];
  const reason = oc.reason ?? "";
  const lead = [...rules.filter((r) => !reason.includes(r)), reason];
  const reading = reason.includes("exited 0 on base") ? [GAP_READING] : [];
  return [...lead, ...reading].filter((s) => s !== "").join("\n");
}

/**
 * Why the run is ending, in the record's own words. The order is the order of USEFULNESS, not
 * recency: what the run's own gate complained about is what a developer can act on.
 */
export function neededFromLog(steps: Step[]): string {
  const reason =
    repairCause(steps) ??
    blockedCause(steps) ??
    gapCause(steps) ??
    budgetCause(steps) ??
    exhaustedCause(steps) ??
    newestReason(steps, "verify", "red") ??
    newestReason(steps, "ci", "red") ??
    newestReason(steps, "verify", "green") ??
    newestReason(steps, "ci", "green") ??
    // A gate that never decided leaves no verdict to quote; the rule's finding is all this can say.
    (handbackHeads(steps).reason === NO_GATE_VERDICT ? NO_GATE_VERDICT : undefined) ??
    terminalCause(steps) ??
    "the run ended without recording why";
  return reason.length > REASON_CLIP ? `${reason.slice(0, REASON_CLIP)}…` : reason;
}

/** The exhausted builder's own account, at the newest WORK step only — the {@link budgetCause} position. */
function exhaustedCause(steps: Step[]): string | undefined {
  const step = newestDecidedWorkStep(steps);
  if (step?.state !== "build" || step.outcome?.kind !== "exhausted") return undefined;
  const reason = step.outcome.reason ?? step.outcome.message;
  return typeof reason === "string" && reason.trim() !== "" ? reason : undefined;
}

/**
 * A path with a control character is not a line the comment may print. The class is ASSEMBLED from code points
 * because suppressing `noControlCharactersInRegex` is the bypass AGENTS.md forbids.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/**
 * The frozen acceptance tests, from the same log `build` and `verify` read. A key with a control character is
 * dropped rather than clipped: the comment is markdown, so a `\n` in a path ends the bullet.
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
    // `Outcome.prUrl` is the one field a publish step may carry a URL in, and `state.ts` refuses to load one
    // that is not https text. Re-checked here rather than trusted.
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
  const kept = frozen.slice(0, LIST_CAP).map((f) => `- ${f}`);
  if (frozen.length <= LIST_CAP) return kept.join("\n");
  return [...kept, `- …and ${frozen.length - LIST_CAP} more`].join("\n");
}

/**
 * The newest review fix wave's range, from the saved pre-fix head to the head the wave pushed, or nothing when
 * no review recorded one. A resumed attempt whose own pass pushed no wave still carries the saved head with no
 * wave head of its own, so its range runs to the branch's head.
 */
function fixRangeLines(steps: Step[]): string[] {
  const oc = [...steps]
    .reverse()
    .find((s) => s.state === "review" && s.outcome?.preFixHead !== undefined)?.outcome;
  const pre = oc?.preFixHead;
  if (pre === undefined) return [];
  const head = oc?.review?.waves.at(-1)?.head;
  return [
    `Pre-fix head: \`${pre}\` — fix range \`${pre}..${head ?? ""}\`${head ? "" : " (to the branch's head)"}`,
    "",
  ];
}

/** The comment body: what is needed, what was frozen, and where the work is. */
export function handbackBody(
  issue: number,
  opts: {
    needed: string;
    frozen: string[];
    branch: string;
    prUrl?: string;
    heads?: Heads;
    fixRange?: string[];
  },
): string {
  const tests = frozenLines(opts.frozen);
  return [
    `work-lean: issue #${issue} is handed back — this is still needed:`,
    "",
    fenceText(opts.needed, REASON_CLIP),
    "",
    ...(headLines(opts.heads) ?? []),
    ...(opts.fixRange ?? []),
    "Frozen acceptance tests:",
    tests,
    "",
    ...branchLine(opts.branch),
    `PR: ${opts.prUrl ?? "no PR yet"}`,
  ].join("\n");
}

/**
 * The head lines of the comment, or `undefined` when this run has nothing to say about heads. Where there IS a
 * head, both halves are stated whether or not the rewind landed.
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
 * The head facts one handback records, from the head origin holds and what the rewind settled on. `render`
 * is the renderer flag and travels to the body only. Called only where the rule applies.
 *
 * A rewind with no head to move records the head origin ACTUALLY holds, uncertified. `shippedVerified`
 * includes `alreadyAtVerified`, where the rewind's pre-move `unshippedHead` is withheld rather than printed
 * as a head this step moved.
 */
function headFacts(rewind: Rewind, originHead: string | undefined): Heads {
  const shippedHead = originHead ?? rewind.unshippedHead;
  // The arm with nothing to move: origin keeps the head the fix wave pushed, uncertified.
  if (rewind.unshippedHead === undefined && !rewind.shipped) {
    if (originHead === undefined) return { render: false };
    const why = rewind.noHeadReason ?? rewind.reason;
    return {
      render: true,
      shippedHead: originHead,
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
 * `post` is the seam the test drives: production hands it `postHandback`. On the host channel the caller passes
 * a post that posts nothing, so `posted` is false with `channel: "host"`.
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
    // The rewind runs BEFORE the body is built, so the comment states where origin stands after it. The
    // draft-publish arm takes none: nothing moved, and origin is never asked.
    let moved: Rewind | undefined;
    let originHead: string | undefined;
    if (heads.applies && heads.shippedHead === undefined) {
      moved =
        heads.verifiedHead === undefined
          ? // `NO_HEAD`'s `reason` describes a push that did not run; this answers why the shipped head
            // was never certified.
            { ...NO_HEAD, noHeadReason: heads.reason }
          : await rewind(heads.verifiedHead);
      // Read AFTER the rewind, so it is origin's post-move value.
      originHead = await readOrigin(ctx);
    }
    // The draft-publish arm's facts are the run's own publish record, so an unreadable origin cannot swallow
    // the line that says the head is unverified.
    const facts: Heads = heads.shippedHead
      ? { render: true, shippedHead: heads.shippedHead, shippedVerified: false }
      : moved === undefined
        ? { render: false }
        : headFacts(moved, originHead);
    const { render, ...record } = facts;
    body = handbackBody(ctx.issue, {
      needed: neededFromLog(ctx.steps),
      frozen: frozenList(ctx.steps),
      branch: ctx.run.branch,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(render ? { heads: facts } : {}),
      fixRange: fixRangeLines(ctx.steps),
    });
    await post(ctx.repoRoot, ctx.issue, body);
    // `posted: true` is the only place the claim lives: the kind is `done` either way. `record` is spread
    // LAST and `render` is stripped — the record carries only what `Outcome` declares.
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
