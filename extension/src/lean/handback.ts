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
 *     `ci`, else the terminal cause the engine stamped;
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

import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { postHandback } from "./io.ts";
import type { Outcome, Step } from "./state.ts";
import { newestRedVerifyReason } from "./verify.ts";

/** A reason line long enough to be a wall is not a comment a human reads. */
const REASON_CLIP = 2000;

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

/**
 * Why the run is ending, in the record's own words.
 *
 * The order is the order of USEFULNESS, not of recency: what the run's own gate
 * complained about is the thing a developer can act on, and it stays the answer
 * even after a later round's CI red (which says the pipeline disagreed, not what
 * to fix). A red `ci` with no red gate is the next thing down, and the terminal
 * cause the engine stamped is what is left when a handler threw and nothing else
 * was ever recorded.
 */
export function neededFromLog(steps: Step[], terminalCause?: string): string {
  const reason =
    newestRedVerifyReason(steps) ??
    newestReason(steps, "ci", "red") ??
    // Nothing ever went red: the run ended for a reason only the stamp holds,
    // so fall through to the last verdict of either gate before the cause.
    newestReason(steps, "verify", "green") ??
    newestReason(steps, "ci", "green") ??
    terminalCause ??
    "the run ended without recording why";
  return reason.length > REASON_CLIP ? `${reason.slice(0, REASON_CLIP)}…` : reason;
}

/** The frozen acceptance tests, from the same log `build` and `verify` read. */
function frozenList(steps: Step[]): string[] {
  return Object.keys(frozenFromLog(steps)).sort();
}

/** The fields a publish step may have used to record its URL. */
const PR_URL_FIELDS = ["prUrl", "url", "htmlUrl"] as const;

/** The PR URL one publish step recorded, or `undefined`. */
function prUrlOf(step: Step): string | undefined {
  const outcome = step.outcome;
  if (outcome === undefined) return undefined;
  // `Outcome` is a closed interface — a handler cannot add a scratch field — so
  // the URL fields are read through an explicit record view rather than opened
  // up: a publish step that recorded `prUrl` is what this looks for, and a
  // field nobody declared stays a compile error at the writer.
  const fields = outcome as unknown as Record<string, unknown>;
  for (const field of PR_URL_FIELDS) {
    const value = fields[field];
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  }
  const reason = outcome.reason;
  if (typeof reason !== "string") return undefined;
  // A publish step's reason line often IS the URL it printed; a bare number is
  // not a link and is not pasted here.
  const match = reason.match(/https?:\/\/\S+/);
  return match === null ? undefined : match[0];
}

/** The PR URL a publish step recorded, or `undefined` when there is none. */
function prUrlFromLog(steps: Step[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.state !== "publish" || step.outcome === undefined) continue;
    const url = prUrlOf(step);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** The comment body: what is needed, what was frozen, and where the work is. */
export function handbackBody(
  issue: number,
  opts: { needed: string; frozen: string[]; branch: string; prUrl?: string },
): string {
  const tests =
    opts.frozen.length > 0 ? opts.frozen.map((f) => `- ${f}`).join("\n") : "- none were recorded";
  return [
    `work-lean: issue #${issue} is handed back — this is still needed:`,
    "",
    opts.needed,
    "",
    "Frozen acceptance tests:",
    tests,
    "",
    `Branch: \`${opts.branch}\``,
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
  const prUrl = prUrlFromLog(ctx.steps);
  const body = handbackBody(ctx.issue, {
    needed: neededFromLog(ctx.steps, ctx.run.result?.reason),
    frozen: frozenList(ctx.steps),
    branch: ctx.run.branch,
    ...(prUrl === undefined ? {} : { prUrl }),
  });
  try {
    await post(ctx.repoRoot, ctx.issue, body);
    return { kind: "done", reason: "handback comment posted" };
  } catch (err) {
    // The run ends here either way; the record says whether anyone was told.
    return {
      kind: "done",
      reason: `handback comment NOT posted: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}
