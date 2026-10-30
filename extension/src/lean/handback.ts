/**
 * lean/handback — the step that tells the operator what the run still needs.
 *
 * A run reaches `handback` when its own gate said red twice, when CI disagreed
 * twice, when the land gate refused the merge, or when a handler threw. In every
 * one of those cases the run is over and the only useful thing left is a
 * sentence on the issue that says what is missing. That is this step's whole
 * job: one comment, built from the record rather than from a model's recollection.
 *
 * Three facts, each read out of the step log so a resumed run posts the same
 * comment a crashed one would have:
 *
 *   - **what failed** — the newest red `verify` reason, else the newest red
 *     `ci`, else the newest `error` the log holds;
 *   - **the frozen contract** — the acceptance tests the run was held to, so a
 *     reader can run them without digging through the log;
 *   - **where the work is** — the run's branch, and the PR URL if a publish
 *     step recorded one ("no PR yet" otherwise, which is the answer that makes
 *     a pre-publish handback readable).
 *
 * It NEVER throws. The run is ending whatever this step says, and a comment
 * that failed to post is information in the record, not a reason to change the
 * verdict — so a refused publish comes back as `done` with a reason that says
 * the comment never went out, exactly as `decline` reports its own `
 * report-failed` without moving the exit code.
 */

import { assertSafeRef } from "../worktree-loss.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { postHandback } from "./io.ts";
import { validPrUrl } from "./state-outcome.ts";
import type { Outcome, Step } from "./state.ts";
import { fenceText } from "./text-fence.ts";
import { newestRedVerifyReason } from "./verify.ts";

/** A reason line long enough to be a wall is not a comment a human reads. */
const REASON_CLIP = 2000;

/**
 * The `Branch:` line, or nothing when the branch is not a printable ref.
 *
 * `run.branch` is a string the run was seeded with, and a ref carrying a
 * newline is not a branch name — it is a line of the comment's markdown written
 * by whoever set the field. `assertSafeRef` is the same rule the git call sites
 * apply before a ref reaches a command line; here it decides whether the line
 * is printed at all rather than whether a command runs.
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
 * How much of the frozen contract a comment lists. The full set lives in the
 * step log and on the branch; a handback with hundreds of paths is a wall of
 * text that buries the one line the operator came for.
 */
const FROZEN_LIST_CAP = 20;

/** A path long enough to be a blob is not a line anyone skims. */
const FROZEN_PATH_CAP = 200;

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
 * The newest budget breach the log records, and FIRST in {@link neededFromLog}:
 * the breach is why the run stopped; an earlier red is only why it was trying.
 *
 * Rendered from the typed fields (`limit` / `value` / `used`), not from the
 * step's `reason` prose: those three are what `assertRun` validated on load, so
 * the sentence the operator reads is built from checked data rather than from
 * free text whatever handler (or hand-edited file) wrote. A breach missing a
 * field is not a breach this function will describe, and falls through to the
 * next cause rather than printing a half-sentence. The `kind` test is what makes
 * that field check meaningful rather than decorative, so it stays: it also means
 * a caller that reads the log without going through `assertRun` still cannot get
 * a half-sentence out of here.
 */
function budgetCause(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const oc = steps[i]?.outcome;
    if (oc?.kind !== "budget") continue;
    const { limit, value, used } = oc;
    if (limit === undefined || typeof value !== "number" || typeof used !== "number") continue;
    return `${steps[i]?.state ?? "the step"} stopped: ${limit} budget ${String(value)} exceeded (used ${String(used)})`;
  }
  return undefined;
}

/**
 * Why the run is ending, in the record's own words.
 *
 * The order is the order of USEFULNESS, not of recency: what the run's own gate
 * complained about is the thing a developer can act on, and it stays the answer
 * even after a later round's CI red (which says the pipeline disagreed, not what
 * to fix). A red `ci` with no red gate is the next thing down, then the newest
 * `error` the log holds — a handler that threw stamps its message on the step
 * itself, which is a closer account of the failure than the summary the engine
 * later writes into `run.result`.
 */
export function neededFromLog(steps: Step[]): string {
  const reason =
    budgetCause(steps) ??
    newestRedVerifyReason(steps) ??
    newestReason(steps, "ci", "red") ??
    // Nothing ever went red: the run ended for a reason only the log's own
    // error steps carry, so fall through to the last verdict of either gate
    // before the cause.
    newestReason(steps, "verify", "green") ??
    newestReason(steps, "ci", "green") ??
    terminalCause(steps) ??
    "the run ended without recording why";
  return reason.length > REASON_CLIP ? `${reason.slice(0, REASON_CLIP)}…` : reason;
}

/**
 * A path holding a control character is not a path anyone skims — and it is not
 * a line the comment may print. The class is ASSEMBLED from code points rather
 * than written as a regex literal with the bytes in it, the shape
 * `work-driver-verify-report-file.ts` uses: the set is identical either way, the
 * literal is what biome's `noControlCharactersInRegex` flags, and suppressing a
 * rule that exists to catch a mistyped control byte is the bypass AGENTS.md
 * forbids.
 */
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

/**
 * The frozen acceptance tests, from the same log `build` and `verify` read.
 *
 * A key with a control character in it is dropped rather than clipped: the
 * comment is markdown, so a `\n` inside a path ends the bullet and starts a new
 * line of the poster's choosing — a heading, a second "Frozen acceptance tests:"
 * section, anything. The load-time validator checks the digests, not the keys,
 * and this list is the last place a key is looked at before a human reads it.
 */
function frozenList(steps: Step[]): string[] {
  return Object.keys(frozenFromLog(steps))
    .filter((f) => !CONTROL_CHARS.test(f))
    .sort()
    .map((f) => (f.length > FROZEN_PATH_CAP ? `${f.slice(0, FROZEN_PATH_CAP)}…` : f));
}

/** The PR URL the publish step recorded, or `undefined` when there is none. */
function prUrlFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "publish") continue;
    // `Outcome.prUrl` is the one field a publish step is allowed to carry a URL
    // in, and `state.ts` refuses to load one that is not https text. Nothing
    // is scraped out of a reason line: a comment that quotes a URL nobody
    // recorded is a link to a PR that may not exist.
    const url = step.outcome?.prUrl;
    // Re-checked here with the load-time rule rather than trusted: the log this
    // reads is a `Step[]`, and the loader is not the only thing that hands one
    // over. A value that broke the shape would be a line of markdown, not a
    // link, so the answer is the same as "no publish step recorded one".
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
  opts: { needed: string; frozen: string[]; branch: string; prUrl?: string },
): string {
  const tests = frozenLines(opts.frozen);
  return [
    `work-lean: issue #${issue} is handed back — this is still needed:`,
    "",
    fenceText(opts.needed, REASON_CLIP),
    "",
    "Frozen acceptance tests:",
    tests,
    "",
    ...branchLine(opts.branch),
    `PR: ${opts.prUrl ?? "no PR yet"}`,
  ].join("\n");
}

/**
 * The `handback` step. Always `done`; never throws.
 *
 * `post` is the seam the test drives: production hands it `postHandback`, which
 * goes through the forge adapter and the public-hygiene check.
 */
export async function handbackOutcome(
  ctx: HandlerCtx,
  post: (repoRoot: string, issue: number, body: string) => Promise<void>,
): Promise<Outcome> {
  let body: string;
  try {
    // Inside the try: this step's contract is that it never throws, and a body
    // that failed to build has to be reported the same way a refused post is.
    const prUrl = prUrlFromLog(ctx.steps);
    body = handbackBody(ctx.issue, {
      needed: neededFromLog(ctx.steps),
      frozen: frozenList(ctx.steps),
      branch: ctx.run.branch,
      ...(prUrl === undefined ? {} : { prUrl }),
    });
    await post(ctx.repoRoot, ctx.issue, body);
    return { kind: "done", reason: "handback comment posted" };
  } catch (err) {
    // The run ends here either way; the record says whether anyone was told.
    return {
      kind: "done",
      reason: `handback comment NOT posted: ${(err as Error)?.message || String(err)}`,
    };
  }
}
