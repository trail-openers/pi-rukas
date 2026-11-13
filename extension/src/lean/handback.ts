/**
 * lean/handback — the step that tells the operator what the run still needs.
 *
 * A run reaches `handback` when its own gate said red twice, when CI disagreed twice, when the land
 * gate refused the merge, or when a handler threw. The run is over and the only useful thing left is
 * a sentence on the issue that says what is missing, built from the record rather than from a
 * model's recollection.
 *
 * Three facts, each read out of the step log so a resumed run posts the same comment a crashed one
 * would have:
 *
 *   - **what failed** — the newest red `verify` reason, else the newest red `ci`, else the newest
 *     `error` the log holds;
 *   - **the frozen contract** — the acceptance tests the run was held to;
 *   - **where the work is** — the run's branch, and the PR URL if a publish step recorded one
 *     ("no PR yet" otherwise).
 *
 * It NEVER throws. The run is ending whatever this step says, and a comment that failed to post is
 * information in the record, not a reason to change the verdict — a refused publish comes back as
 * `done` with a reason that says the comment never went out.
 */

import { assertSafeRef } from "../worktree-loss.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { handbackHeads } from "./handback-heads.ts";
import { type Rewind, rewindToVerified } from "./handback-rewind.ts";
import { postHandback } from "./io.ts";
import { BLOCKED_PATH_CAP, BLOCKED_REASON_CAP, validPrUrl } from "./state-outcome.ts";
import { type Outcome, REPORT_STATES, type Step } from "./state.ts";
import { budgetSentence, budgetTrio } from "./step-budget.ts";
import { fenceText, oneLine } from "./text-fence.ts";
import { leanVerifiedHandbackEnabled } from "./verified-handback-switch.ts";
import { newestRedVerifyReason } from "./verify-deps.ts";

/** A reason line long enough to be a wall is not a comment a human reads. */
const REASON_CLIP = 2000;

/**
 * The `Branch:` line, or nothing when the branch is not a printable ref. A ref carrying a newline is
 * not a branch name — it is a line of the comment's markdown written by whoever set the field.
 * `assertSafeRef` is the same rule the git call sites apply; here it decides whether the line prints.
 */
function branchLine(branch: string): string[] {
  try {
    assertSafeRef(branch);
  } catch {
    return [];
  }
  return [`Branch: \`${branch}\``];
}

/**
 * How much of the frozen contract a comment lists. The full set lives in the step log and on the
 * branch; a wall of paths buries the line the operator came for.
 */
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
 * the run stopped; an earlier red is only why it was trying.
 *
 * A breach only counts when NOTHING that did work is newer than it — the one true test is position,
 * not prose. A `challenge` breach is a CONTINUATION the table routes on, so a budget step whose
 * verdict the table carried past is not why the run ended. `handback` and `decline` entries are
 * excluded from that scan: they are the run REPORTING how it ended, not work it went on to do.
 * A step with no outcome that is not a report still counts as newer — undecided work after a breach
 * means the breach did not end the run.
 *
 * Rendered from the typed fields (`limit` / `value` / `used`) through {@link budgetTrio}, the same
 * check every reader of a recorded breach makes, so a breach missing a field falls through to the
 * next cause rather than printing a half-sentence.
 */
/** The newest step that was WORK — a report state is how a run ended, not work. */
function newestWorkStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && !REPORT_STATES.includes(step.state)) return step;
  }
  return undefined;
}

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
 * The build step's named unsatisfiable contract, and FIRST in {@link neededFromLog}.
 *
 * The builder's `blocked` verdict is the one cause in the log that names the FILES and the
 * contradiction. Position decides whether it may speak, the same test {@link budgetCause} uses: the
 * cause counts only when the `blocked` step IS the newest working step. A stale `blockedBy` from a
 * round the run carried past is not the run's cause.
 *
 * Rendered from the typed `blockedBy` map, never from prose: a `blocked` step missing the map falls
 * through to the next cause rather than printing a fragment.
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
 * Why the run is ending, in the record's own words.
 *
 * The order is the order of USEFULNESS, not of recency: what the run's own gate complained about is
 * the thing a developer can act on, and it stays the answer even after a later round's CI red.
 */
export function neededFromLog(steps: Step[]): string {
  const reason =
    blockedCause(steps) ??
    budgetCause(steps) ??
    newestRedVerifyReason(steps) ??
    newestReason(steps, "ci", "red") ??
    // Nothing ever went red: the run ended for a reason only the log's own error steps carry, so
    // fall through to the last verdict of either gate before the cause.
    newestReason(steps, "verify", "green") ??
    newestReason(steps, "ci", "green") ??
    terminalCause(steps) ??
    "the run ended without recording why";
  return reason.length > REASON_CLIP ? `${reason.slice(0, REASON_CLIP)}…` : reason;
}

/**
 * A path holding a control character is not a path anyone skims — and it is not a line the comment
 * may print. The class is ASSEMBLED from code points rather than written as a regex literal with the
 * bytes in it, because suppressing `noControlCharactersInRegex` is the bypass AGENTS.md forbids.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/**
 * The frozen acceptance tests, from the same log `build` and `verify` read.
 *
 * A key with a control character in it is dropped rather than clipped: the comment is markdown, so a
 * `\n` inside a path ends the bullet and starts a new line of the poster's choosing. This list is the
 * last place a key is looked at before a human reads it.
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
    // `Outcome.prUrl` is the one field a publish step may carry a URL in, and `state.ts` refuses to
    // load one that is not https text. Nothing is scraped out of a reason line.
    const url = step.outcome?.prUrl;
    // Re-checked here with the load-time rule rather than trusted: the loader is not the only thing
    // that hands a `Step[]` over, and a value that broke the shape would be a line of markdown.
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
 * The head lines of the comment, or `undefined` when this run has nothing to say
 * about heads. A handback that moved nothing and left no unverified head behind
 * prints no head section at all: an empty one would read as an answer about a
 * move nobody made.
 *
 * Both halves are stated whether or not the rewind landed — which head shipped,
 * whether verify saw it, and which head was left with its reason — because the
 * case the operator needs is the one where the shipped head is NOT the verified
 * one.
 */
function headLines(heads: Heads | undefined): string[] | undefined {
  if (heads === undefined || heads.shippedHead === undefined) return undefined;
  const lines = [
    `Shipped head: \`${heads.shippedHead}\` (${heads.shippedVerified === true ? "verified" : "NOT verified"})`,
  ];
  if (heads.unshippedHead !== undefined)
    lines.push(
      `Unshipped head: \`${heads.unshippedHead}\` — ${heads.unshippedReason ?? "not shipped"}`,
    );
  return [...lines, ""];
}

/**
 * The head facts of one handback, in the shape the record and the comment both read.
 *
 * One shape for both surfaces because they are ONE fact: the comment the forge is
 * handed and the body the host is handed are the same string, and the step's typed
 * fields are that string's evidence.
 */
interface Heads {
  shippedHead?: string;
  shippedVerified?: boolean;
  unshippedHead?: string;
  unshippedReason?: string;
}

/**
 * The head facts one handback records, from what its rewind settled on.
 *
 * A handback the rule does not touch records nothing: no head fields, so the
 * comment carries no head section. The rewind's own answer is the whole input —
 * the head origin holds is the shipped head whatever the move did, and whether
 * it was verified is the question the rule exists to answer.
 */
function headFacts(applies: boolean, rewind: Rewind): Heads {
  if (!applies) return {};
  // Origin's branch as the step read it. When the rewind landed that sha IS the
  // verified head (the step checked origin holds it), and when it refused the run
  // shipped exactly what it left — unverified, which `shippedVerified` says.
  const shippedHead = rewind.unshippedHead;
  return {
    ...(shippedHead === undefined ? {} : { shippedHead }),
    shippedVerified: rewind.shipped,
    ...(rewind.shipped || rewind.unshippedHead === undefined
      ? {}
      : { unshippedHead: rewind.unshippedHead }),
    ...(rewind.reason === undefined ? {} : { unshippedReason: rewind.reason }),
  };
}

/**
 * The `handback` step. Always `done`; never throws.
 *
 * `post` is the seam the test drives: production hands it `postHandback`, which goes through the
 * forge adapter and the public-hygiene check. On the host channel the caller passes a post that
 * posts nothing, and `posted` is then false with `channel: "host"` on the step — a run that reported
 * a comment it never sent would double the report a host posts itself.
 *
 * `report` carries the comment either way, so the host channel is handed the run's actual report.
 */
export async function handbackOutcome(
  ctx: HandlerCtx,
  post: (repoRoot: string, issue: number, body: string) => Promise<void>,
  rewind: (verifiedHead: string) => Promise<Rewind> = async () => ({ shipped: false }),
): Promise<Outcome> {
  let body: string | undefined;
  try {
    // Inside the try: this step's contract is that it never throws, and a body
    // that failed to build has to be reported the same way a refused post is.
    const prUrl = prUrlFromLog(ctx.steps);
    const heads = handbackHeads(ctx.steps);
    // The rewind happens BEFORE the body is built, so the comment states where
    // origin's branch stands after the move rather than where it stood before it.
    // The switch is read here, at call time, and a disabled rule moves nothing.
    const moved =
      heads.applies && leanVerifiedHandbackEnabled() && heads.verifiedHead !== undefined
        ? await rewind(heads.verifiedHead)
        : heads.applies
          ? { shipped: false, reason: heads.reason ?? "the rule did not move origin's branch" }
          : { shipped: false };
    const facts = headFacts(heads.applies, moved);
    body = handbackBody(ctx.issue, {
      needed: neededFromLog(ctx.steps),
      frozen: frozenList(ctx.steps),
      branch: ctx.run.branch,
      ...(prUrl === undefined ? {} : { prUrl }),
      ...(facts.shippedHead === undefined ? {} : { heads: facts }),
    });
    await post(ctx.repoRoot, ctx.issue, body);
    // `posted: true` is the only place the claim lives: the kind is `done` either way, so without the
    // field a refused post and a delivered one are the same record to a later reader.
    return {
      kind: "done",
      reason: "handback comment posted",
      posted: true,
      report: body,
      ...facts,
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
