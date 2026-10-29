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
 * The verb passes `{ headless: true }` to the engine: a headless run's children
 * need the /work-cycle trust stamp, and the mode belongs to THIS run rather
 * than to the process, so a second lean run in the same host is not stamped by
 * the first one's having come through here.
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

import { runWorkLean } from "../lean/command.ts";
import type { RunLeanResult } from "../lean/engine.ts";
import { LeanLockError } from "../lean/lock.ts";
import { PR_URL, PR_URL_MAX_CHARS } from "../lean/state-outcome.ts";
import { type Step, newestDecided } from "../lean/state.ts";
import { traceWarn } from "../trace.ts";
import { EXIT } from "./exit-code.ts";
import { type VerbContext, type VerbOutcome, badArguments, parseFlags } from "./verb.ts";

export const WORK_LEAN_FLAGS = ["--json"] as const;

/** What a run is described by once its document is built. */
export interface LeanRunOutcome {
  summary: string;
  result: RunLeanResult;
}

/** The run seam: the same signature `runWorkLean` has. */
export type RunLean = (
  repoRoot: string,
  issue: number,
  opts?: { headless?: boolean },
) => Promise<LeanRunOutcome>;

/**
 * Whether this throw is the engine refusing to start behind a live run.
 *
 * A TYPE test, not a message match: `lean/lock.ts` raises `LeanLockError` for
 * every refusal it makes, so "a run holds this issue" is a fact the class
 * carries rather than wording this verb has to keep in sync with another
 * module's prose. Anything else — a schema violation from `lean/state.ts`, a
 * git blow-up, a throw wrapped in somebody else's Error — is a crash, which is
 * the honest answer: this verb cannot tell a reworded refusal from a real
 * failure, and reporting a crash is the safe direction (a host that re-runs a
 * refused cycle collides again and sees 40 then).
 */
function lockHeld(err: unknown): boolean {
  return err instanceof LeanLockError;
}

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * `newestDecided` is the log's own rule (an outcome-less step is a crash
 * mid-step and has said nothing), so a newer `publish` that decided without a
 * URL reports no URL — reading one from an earlier publish would hand the host
 * the address of a PR this run replaced.
 *
 * The value is then re-checked with the load-time rule `handback` applies, not
 * trusted: the log a verb sees is a `Step[]`, and the loader is not the only
 * thing that hands one over. A URL that breaks the shape is not a link the host
 * should open, so the answer is the same as "no publish step recorded one".
 */
function prUrlOf(steps: Step[]): string | undefined {
  const url = newestDecided(steps, "publish")?.outcome?.prUrl;
  if (typeof url !== "string" || url === "") return undefined;
  if (url.length > PR_URL_MAX_CHARS) return undefined;
  return PR_URL.test(url) ? url : undefined;
}

/** A reason line a host can print: clipped, and never the whole step log. */
function clip(text: unknown): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

/** A multi-line value as one line: newlines escaped, so nothing splits a record. */
function oneline(text: string): string {
  return text.replaceAll("\n", "\\n");
}

/**
 * Does this object have the shape `RunLeanResult` says it has? The engine's
 * return value is the host's document, so a field that is missing or of the
 * wrong type is reported as a crash rather than thrown at the caller.
 *
 * `summary` and `code` are checked here rather than where they are printed:
 * both are typed non-optional and both are values this verb puts in front of a
 * host, so a `null` from a JSON round-trip is a malformed outcome, judged once
 * and before anything reads it.
 */
function wellFormed(outcome: unknown): outcome is LeanRunOutcome {
  const o = outcome as LeanRunOutcome | undefined;
  const result = o?.result;
  return (
    typeof o?.summary === "string" &&
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
  // ONE guarded region: everything from the call to the return of the document
  // sits here, so whatever the engine (or a malformed return from it) does, the
  // host gets exactly one document and one exit code rather than a rejection.
  // `fail` is the single shape both the refusal and the crash answer take —
  // they differ only in the code and the reason word, and were two copies of
  // the same body before.
  const fail = (err: unknown, refused: boolean): VerbOutcome => {
    const message = clip(err instanceof Error ? err.message : String(err));
    const exitCode = refused ? EXIT.refused : EXIT.crash;
    // The full error goes to the trace, not just the clipped line the document
    // carries: a crash whose stack is 20 KB is still diagnosable by whoever
    // reads the runner's stderr, and a clipped document is what the host parses.
    // Written as ONE line (newlines escaped): the headless stderr writer turns
    // every physical line into its own NDJSON record, so a raw stack would
    // arrive as a frame dump with the error name detached from it.
    if (!refused && err instanceof Error) {
      traceWarn(`work-lean: #${issue} crashed — ${err.name}: ${oneline(err.stack ?? err.message)}`);
    }
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
  };
  try {
    // #1883 — this run's children carry the /work-cycle trust stamp, or the
    // headless permission path hard-denies their tool calls. Passed per run
    // rather than marked on the process: an interactive `/work-lean` in the
    // same host stays unstamped, and so does a second headless run that does
    // not ask for it.
    const raw = await run(ctx.repoRoot, issue, { headless: true });
    if (!wellFormed(raw)) throw new Error("the run returned a malformed outcome");
    const summary = clip(raw.summary);
    ctx.host.sendUserMessage(`work-lean: ${summary}`, { deliverAs: "steer" });
    const prUrl = prUrlOf(raw.result.run.steps);
    return {
      exitCode: raw.result.code,
      doc: {
        subcommand: "work-lean",
        issue,
        exitCode: raw.result.code,
        state: raw.result.state,
        summary,
        steps: raw.result.run.steps.length,
        ...(prUrl === undefined ? {} : { prUrl }),
      },
    };
  } catch (err) {
    return fail(err, lockHeld(err));
  }
}
