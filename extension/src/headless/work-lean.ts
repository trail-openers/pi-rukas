/**
 * headless/work-lean — `pi-rukas-headless work-lean <issue>` (epic #1883): one
 * run of the lean /work engine (`runWorkLean`) on the headless DriverHost, so a
 * host that drives `work` can drive the lean pipeline the same way.
 *
 *   work-lean <issue> [--json]
 *
 * The verb adds no policy of its own: it parses one positional issue number,
 * calls the same entry point the `/work-lean` command calls, and reports the
 * run's own code. The engine is the authority on what "done" means — a run's
 * `code`/`state` come from its step log, and this module restates them rather
 * than deciding anything.
 *
 * `--json` is accepted and changes nothing, as with every other S6 subcommand.
 *
 * Exit codes, taken from the run:
 *   0   `landed`
 *  10   `handed-back`
 *  11   `not-ready`
 *  30   the run threw for any reason other than a held lock, with `error.code:
 *       "crash"`
 *  40   bad arguments, or a live run already holds this issue's lock
 *       (`error.code: "refused"`) — the same answer `work` gives a cycle it
 *       could not enter, and for the same reason: re-running it now only
 *       collides again.
 */

import { markLeanHeadless } from "../lean/child-opts.ts";
import { runWorkLean } from "../lean/command.ts";
import type { RunLeanResult } from "../lean/engine.ts";
import type { Step } from "../lean/state.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const WORK_LEAN_FLAGS = ["--json"] as const;

/**
 * The lock-held refusals, by the words `lean/lock.ts` writes. Every message
 * that module raises for a lock it will not take: a live (or foreign, or
 * unjudgeable) holder, an unreadable body, a `link` that failed for a reason
 * other than EEXIST, and a stale lock it could not clear. Read by message and
 * not by error class: the verb must not import a class hierarchy to recognise
 * a refusal, and a lock error that arrives wrapped in somebody else's Error is
 * the same fact. Anything else — a schema violation from `lean/state.ts`, a
 * git blow-up — is a crash.
 */
const LOCK_HELD =
  /run already in progress|lock unreadable|cannot lock |cannot clear the stale lock/;

/** What a run is described by once its document is built. */
export interface LeanRunOutcome {
  summary: string;
  result: RunLeanResult;
}

/** The run seam: the same signature `runWorkLean` has. */
export type RunLean = (repoRoot: string, issue: number) => Promise<LeanRunOutcome>;

/** Whether this throw is the engine refusing to start behind a live run. */
function lockHeld(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LOCK_HELD.test(message);
}

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * Mirrors `newestDecided`: the last decided step of the state is the answer,
 * and the walk never reaches past it to an older one. A newer `publish` that
 * decided without a URL therefore reports no URL — reading one from an earlier
 * publish would hand the host the address of a PR this run replaced.
 */
function prUrlOf(steps: Step[]): string | undefined {
  const decided = steps.filter((s) => s?.state === "publish" && s.outcome !== undefined);
  const url = decided[decided.length - 1]?.outcome?.prUrl;
  return typeof url === "string" && url !== "" ? url : undefined;
}

/** A reason line a host can print: clipped, and never the whole step log. */
function clip(text: unknown): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/**
 * Does this object have the shape `RunLeanResult` says it has? The engine's
 * return value is the host's document, so a field that is missing or of the
 * wrong type is reported as a crash rather than thrown at the caller.
 */
function wellFormed(outcome: unknown): outcome is LeanRunOutcome {
  const result = (outcome as LeanRunOutcome | undefined)?.result;
  return (
    result?.run?.steps !== undefined &&
    Array.isArray(result.run.steps) &&
    typeof result.code === "number" &&
    typeof result.state === "string"
  );
}

export async function runWorkLeanVerb(
  argv: readonly string[],
  ctx: VerbContext,
  run: RunLean = runWorkLean,
): Promise<VerbOutcome> {
  const p = parseFlags(argv, { bool: [...WORK_LEAN_FLAGS], value: [] });
  if ("error" in p) return badArguments(p.error);
  if (p.positional.length !== 1 || !/^\d+$/.test(p.positional[0] as string)) {
    return badArguments("usage: work-lean <issue> [--json]");
  }
  const issue = Number.parseInt(p.positional[0] as string, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    return badArguments("usage: work-lean <issue> [--json]");
  }
  ctx.host.sendUserMessage(`work-lean: #${issue} starting`, { deliverAs: "steer" });
  // #1883 — a headless lean run's children need the /work-cycle trust stamp,
  // or the headless permission path hard-denies their tool calls. Marked once
  // for the whole process here, because this module is the only entry point
  // that runs the engine without a UI; the interactive `/work-lean` command
  // never calls it, so those children stay unstamped as they were. Read by the
  // three dispatch sites (lean/child-opts.ts).
  markLeanHeadless();
  let outcome: LeanRunOutcome;
  try {
    const raw = await run(ctx.repoRoot, issue);
    if (!wellFormed(raw)) throw new Error("the run returned a malformed outcome");
    outcome = raw;
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    const refused = lockHeld(err);
    const exitCode = refused ? EXIT.refused : EXIT.crash;
    ctx.host.sendUserMessage(
      `work-lean: #${issue} ${refused ? "refused" : "crashed"} (exit ${exitCode}) — ${message}`,
      { deliverAs: "steer" },
    );
    return {
      exitCode,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode,
        error: { code: refused ? "refused" : "crash", message },
      },
    };
  }
  // Everything below reads the run's own record, so it sits inside the same
  // guard: a `summary` that is not a string or a step log that is not an array
  // is a malformed outcome, and the host still gets exactly one document with
  // exit 30 rather than a rejected promise.
  try {
    // `summary` is typed `string` and `code`/`state` were shape-checked above;
    // a value that arrives as neither (a null from a JSON round-trip, say) is
    // not a string this verb can print, and is reported rather than printed.
    const summary = clip(outcome.summary);
    if (typeof outcome.summary !== "string")
      throw new Error("the run returned a malformed outcome");
    const code = outcome.result.code;
    if (typeof code !== "number") throw new Error("the run returned a malformed outcome");
    ctx.host.sendUserMessage(`work-lean: ${summary}`, { deliverAs: "steer" });
    const prUrl = prUrlOf(outcome.result.run.steps);
    return {
      exitCode: code,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode: code,
        state: outcome.result.state,
        summary,
        steps: outcome.result.run.steps.length,
        ...(prUrl === undefined ? {} : { prUrl }),
      },
    };
  } catch (err) {
    const message = clip(err instanceof Error ? err.message : String(err));
    ctx.host.sendUserMessage(`work-lean: #${issue} crashed (exit ${EXIT.crash}) — ${message}`, {
      deliverAs: "steer",
    });
    return {
      exitCode: EXIT.crash,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode: EXIT.crash,
        error: { code: "crash", message },
      },
    };
  }
}
